#!/usr/bin/env bash
#
# Apply every migration to a throwaway Postgres and assert the database's
# own guarantees: client isolation, the append-only audit trail, and
# two-person approval.
#
# These are the promises the vitest suite cannot make, because Postgres
# enforces them rather than application code. Running them needs a real
# server — `supabase/tests/security.sql` holds the assertions.
#
# Usage:  npm run verify:db
#         DB_URL=postgres://... npm run verify:db     # against an existing server
set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PORT=${PGPORT:-55432}
SOCK=${PGSOCK:-/tmp}
DATA=${PGDATA_DIR:-${TMPDIR:-/tmp}/fjb-verify-pgdata}
OWN_SERVER=0

cleanup() {
  if [ "$OWN_SERVER" = "1" ]; then
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -z "${DB_URL:-}" ]; then
  command -v "$PGBIN/initdb" >/dev/null 2>&1 || {
    echo "Postgres 16 not found at $PGBIN."
    echo "Install it (apt-get install postgresql-16), or set DB_URL to a server to test against."
    exit 1
  }
  echo "Starting a throwaway Postgres on port $PORT…"
  rm -rf "$DATA"; mkdir -p "$DATA"
  chown postgres:postgres "$DATA" 2>/dev/null || true
  chmod 700 "$DATA"
  su postgres -c "PATH=$PGBIN:\$PATH initdb -D $DATA -A trust" >/dev/null
  su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $DATA -o '-p $PORT -k $SOCK' -l $DATA/server.log start" >/dev/null
  OWN_SERVER=1
  sleep 2
  DB_URL="postgres://postgres@localhost:$PORT/fjb?host=$SOCK"
  psql "postgres://postgres@localhost:$PORT/postgres?host=$SOCK" -qc "create database fjb;" >/dev/null
fi

echo "Installing the pieces Supabase provides (auth schema, roles, grants)…"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
create extension if not exists pgcrypto;
create extension if not exists citext;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
-- Supabase resolves the signed-in user from the JWT; this is the same
-- contract, driven by a session setting so tests can switch identity.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  create role anon;          exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role;  exception when duplicate_object then null; end $$;

-- Supabase Storage. Stubbed to the shape the migrations touch so the
-- document-bucket policies can be applied and checked here too; the real
-- thing carries far more, none of which these migrations depend on.
-- Supabase grants on NEW objects through ALTER DEFAULT PRIVILEGES, which
-- applies at CREATE time. Setting it here rather than blanket-granting
-- after the migrations is what makes a REVOKE inside a migration mean
-- something: a blanket grant afterwards would silently undo every one of
-- them, and this suite would then certify a locked-down RPC surface that
-- is in fact wide open. 0015 shipped exactly that mistake.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text not null, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
SQL

echo "Applying migrations…"
for f in supabase/migrations/*.sql; do
  printf '  %s ' "$(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  echo "ok"
done

# Schema usage only. The per-object grants came from the default
# privileges set before the migrations ran, so each migration's own
# REVOKEs survive — see the note above.
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants these on the storage schema; RLS is what decides which
-- objects are actually visible.
grant usage on schema storage to anon, authenticated;
grant all on all tables in schema storage to anon, authenticated;
SQL

echo ""
echo "Asserting the database's guarantees…"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/security.sql
