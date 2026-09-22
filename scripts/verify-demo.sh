#!/usr/bin/env bash
#
# Apply the demo seed to a throwaway Postgres carrying every migration,
# then apply the delete script and assert nothing is left behind.
#
# The point is to find schema mismatches here rather than against the live
# project: `job_assignment` has no id column, and the first version of the
# seed found that out the expensive way.
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PORT=${PGPORT:-55433}
SOCK=${PGSOCK:-/tmp}
DATA=${PGDATA_DIR:-${TMPDIR:-/tmp}/fjb-demo-pgdata}

cleanup() { su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true; }
trap cleanup EXIT

rm -rf "$DATA"; mkdir -p "$DATA"; chown postgres:postgres "$DATA" 2>/dev/null || true; chmod 700 "$DATA"
su postgres -c "PATH=$PGBIN:\$PATH initdb -D $DATA -A trust" >/dev/null
su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $DATA -o '-p $PORT -k $SOCK' -l $DATA/server.log start" >/dev/null
sleep 2
DB="postgres://postgres@localhost:$PORT/fjb?host=$SOCK"
psql "postgres://postgres@localhost:$PORT/postgres?host=$SOCK" -qc "create database fjb;" >/dev/null

psql "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
create extension if not exists pgcrypto; create extension if not exists citext;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null,
  public boolean not null default false, file_size_limit bigint);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text not null, owner uuid,
  created_at timestamptz default now());
alter table storage.objects enable row level security;
SQL

for f in supabase/migrations/*.sql; do psql "$DB" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null; done
echo "migrations applied"

psql "$DB" -v ON_ERROR_STOP=1 -q -f supabase/demo/seed-demo.sql
echo "seed applied"

psql "$DB" -v ON_ERROR_STOP=1 -t -A -F' ' <<'SQL'
select 'books', count(*) from job_book where id::text like 'd0d0d0d0-%'
union all select 'sections', count(*) from job_book_section where id::text like 'd0d0d0d0-%'
union all select 'welds', count(*) from weld where id::text like 'd0d0d0d0-%'
union all select 'torque', count(*) from torque_connection where id::text like 'd0d0d0d0-%'
union all select 'documents', count(*) from document where id::text like 'd0d0d0d0-%'
union all select 'gates', count(*) from gate_review where id::text like 'd0d0d0d0-%'
union all select 'flags', count(*) from compliance_flag where id::text like 'd0d0d0d0-%';
SQL

# The stored percentage must equal what the engine computes. This is the
# assertion the whole generator exists to keep true.
psql "$DB" -v ON_ERROR_STOP=1 -t -A <<'SQL'
select b.job_number || ' ' ||
  round(sum(s.computed_pct * sd.weight) / nullif(sum(sd.weight), 0), 2) || '%'
from job_book b
join job_book_section s on s.job_book_id = b.id
join section_definition sd on sd.id = s.section_definition_id
where b.id::text like 'd0d0d0d0-%' and s.status <> 'na' and sd.weight > 0
group by b.job_number, b.created_at order by b.created_at;
SQL

psql "$DB" -v ON_ERROR_STOP=1 -q -f supabase/demo/delete-demo.sql
LEFT=$(psql "$DB" -t -A -c "
  select coalesce(sum(n),0) from (
    select count(*) n from job_book where id::text like 'd0d0d0d0-%'
    union all select count(*) from weld where id::text like 'd0d0d0d0-%'
    union all select count(*) from document where id::text like 'd0d0d0d0-%'
    union all select count(*) from client_org where id::text like 'd0d0d0d0-%'
    union all select count(*) from app_user where id::text like 'd0d0d0d0-%'
    union all select count(*) from job_assignment
      where job_book_id::text like 'd0d0d0d0-%' or user_id::text like 'd0d0d0d0-%'
  ) x")
echo "rows left after delete: $LEFT"
[ "$LEFT" = "0" ] || { echo "FAILED: delete-demo.sql left rows behind"; exit 1; }
echo "seed applies and deletes cleanly"
