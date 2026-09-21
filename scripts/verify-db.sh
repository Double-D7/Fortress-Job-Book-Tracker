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
SQL

echo "Applying migrations…"
for f in supabase/migrations/*.sql; do
  printf '  %s ' "$(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  echo "ok"
done

# Supabase grants these to anon/authenticated by default; RLS is what
# actually decides visibility, and the migrations' own REVOKEs on
# audit_event must be re-applied after any blanket grant.
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;
revoke update, delete, truncate on audit_event from anon, authenticated;
SQL

echo ""
echo "Asserting the database's guarantees…"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/security.sql
