-- ---------------------------------------------------------------------
-- Somewhere for a failure to land.
--
-- There was no error reporting of any kind: no service, no boundary,
-- nothing logged deliberately. A page that threw showed the framework's
-- generic "a server-side exception has occurred" and the only person
-- who knew was whoever hit it. That is how the NDE outage was found —
-- by hand, by the one person using the system. With a crew on it, a
-- silent failure is a tool nobody trusts.
--
-- WHY A GROUP RATHER THAN A LOG. A broken page does not throw once; it
-- throws for everybody who opens it. A flat log of occurrences is a
-- flood, and a flood is read exactly as often as silence. Rows here are
-- one per distinct fault, with a count, so a page broken for the whole
-- morning is one row that says 240 rather than 240 rows.
--
-- WHY `anon` MAY CALL IT. The most valuable error to hear about is the
-- one that stops somebody signing in, and that caller has no session by
-- definition. The function takes no identity from its arguments — it
-- records whoever `current_app_user()` says is there, or nobody — so
-- being callable without a session does not let a caller claim to be
-- one.
--
-- WHAT IT DELIBERATELY DOES NOT STORE. No request body, no parameters,
-- no cookies. A job book error message can carry a weld number and a
-- filename and that is wanted; nothing here should be able to carry a
-- credential or a person's data into a table with a wider audience than
-- the book it came from.
-- ---------------------------------------------------------------------

create table if not exists error_report (
  id             uuid primary key default gen_random_uuid(),
  -- The grouping key, computed by the application: the shape of the
  -- fault with the particulars normalised out.
  fingerprint    text not null unique,
  -- What a person reads out when they ring up. Derived from the
  -- fingerprint, so it leads to the group rather than one occurrence.
  reference      text not null,
  error_name     text not null,
  message        text not null,
  route          text,
  app_frame      text,
  occurrences    integer not null default 1,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- Last time this group was emailed. Null means never, which is what
  -- makes a new fault always worth reporting.
  notified_at    timestamptz,
  -- Who hit it most recently, when there was a session. Not an
  -- accusation; it is who to ask what they were doing.
  last_user_id   uuid references app_user (id),
  resolved_at    timestamptz,
  resolved_by    uuid references app_user (id)
);

create index if not exists error_report_last_seen on error_report (last_seen_at desc);
create index if not exists error_report_open
  on error_report (last_seen_at desc) where resolved_at is null;

comment on table error_report is
  'One row per distinct fault, with a count. Grouped by the application '
  'so a page broken for everybody is one row rather than one per visit.';

alter table error_report enable row level security;
alter table error_report force row level security;

-- Fortress staff may read it; it is their own operational record and
-- names no client data. Nobody writes through the API — the function
-- below is the only way in.
drop policy if exists error_report_read on error_report;
create policy error_report_read on error_report for select
  using (is_fortress_staff());

revoke all on error_report from anon, authenticated;
grant select on error_report to authenticated;

-- ---------------------------------------------------------------------
-- Recording one.
--
-- Upsert on the fingerprint: first occurrence inserts, the rest bump the
-- count and the timestamp. Returns whether this group is due an email,
-- so the caller does not have to re-read the row to find out.
-- ---------------------------------------------------------------------
create or replace function report_error(
  p_fingerprint text,
  p_reference   text,
  p_error_name  text,
  p_message     text,
  p_route       text default null,
  p_app_frame   text default null,
  p_notify_after_minutes integer default 60
)
returns table (reference text, occurrences integer, should_notify boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_actor uuid; v_row error_report;
begin
  if coalesce(btrim(p_fingerprint), '') = '' then
    raise exception 'an error report needs a fingerprint' using errcode = '23514';
  end if;

  -- Whoever is actually signed in, never what the caller claims.
  select id into v_actor from current_app_user();

  insert into error_report as e (
    fingerprint, reference, error_name, message, route, app_frame, last_user_id
  )
  values (
    p_fingerprint, p_reference, left(coalesce(p_error_name, 'Error'), 200),
    left(coalesce(p_message, ''), 2000), left(p_route, 300),
    left(p_app_frame, 300), v_actor
  )
  on conflict (fingerprint) do update
    set occurrences  = e.occurrences + 1,
        last_seen_at = now(),
        last_user_id = coalesce(v_actor, e.last_user_id),
        -- A fault that comes back after being marked resolved is open
        -- again. Leaving it closed is how a reappearing bug goes unseen.
        resolved_at  = null,
        resolved_by  = null
  returning * into v_row;

  return query select
    v_row.reference,
    v_row.occurrences,
    (v_row.notified_at is null
      or now() - v_row.notified_at >= make_interval(mins => p_notify_after_minutes));
end $function$;

-- Callable without a session on purpose: an error that stops somebody
-- signing in is the one most worth hearing about.
revoke all on function report_error(text, text, text, text, text, text, integer)
  from public;
grant execute on function report_error(text, text, text, text, text, text, integer)
  to anon, authenticated;

-- ---------------------------------------------------------------------
-- Marking one dealt with.
-- ---------------------------------------------------------------------
create or replace function resolve_error_report(p_id uuid)
returns error_report
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_actor app_user; v_row error_report;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role not in ('fortress_admin', 'qaqc_manager') then
    raise exception 'only a manager or admin may close an error' using errcode = '42501';
  end if;

  update error_report
     set resolved_at = now(), resolved_by = v_actor.id
   where id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such error report' using errcode = 'P0002';
  end if;
  return v_row;
end $function$;

revoke all on function resolve_error_report(uuid) from public, anon;
grant execute on function resolve_error_report(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Stamping a group as reported, for the alerter to call back.
-- ---------------------------------------------------------------------
create or replace function mark_error_notified(p_fingerprint text)
returns void
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  update error_report set notified_at = now() where fingerprint = p_fingerprint;
$function$;

revoke all on function mark_error_notified(text) from public, anon, authenticated;
