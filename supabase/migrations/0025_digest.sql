-- ---------------------------------------------------------------------
-- What the daily digest reads, and what stops it sending twice.
--
-- The digest has to read every recipient's unread notes to send each of
-- them their own, so it cannot run under any one person's session. The
-- usual answer is the service-role key, and DEPLOY.md says the opposite
-- in as many words: "If a SUPABASE_SERVICE_ROLE_KEY is already set on
-- the deployment from an earlier setup, clear it. An unused secret is
-- still a secret sitting somewhere it is not needed."
--
-- So the digest runs as a Supabase Edge Function on a pg_cron schedule
-- rather than from the web deployment. The key stays inside Supabase,
-- Vercel never holds it, and that rule survives intact.
--
-- Two additions here.
--
--   1. `digested_at` on `notification`, so a note is emailed once. Read
--      alongside `read_at`: somebody who has already seen a note in the
--      app does not need an email about it, which is the difference
--      between a digest and a nag.
--
--   2. `digest_rows()`, which returns exactly what the message needs and
--      nothing else — and applies the recipient rule itself rather than
--      trusting its caller to. A digest that leaves the building with
--      the wrong note in it cannot be recalled.
-- ---------------------------------------------------------------------

alter table notification
  add column digested_at timestamptz;

comment on column notification.digested_at is
  'When this was included in a daily digest. Set once; a note is emailed '
  'at most once however many runs see it.';

-- The digest query filters on exactly this, so it is the index.
create index notification_pending_digest on notification (user_id)
  where read_at is null and digested_at is null;

-- ---------------------------------------------------------------------
-- The rows one digest run needs.
--
-- SECURITY DEFINER and deliberately NOT granted to `authenticated`: it
-- reads across every recipient, which is precisely what no signed-in
-- caller may do. Only the service role reaches it, and only from inside
-- Supabase.
--
-- `p_min_age_minutes` exists so a note written two minutes before the
-- run is not emailed to somebody still reading it in the app. The
-- default is an hour.
-- ---------------------------------------------------------------------
create or replace function digest_rows(
  p_min_age_minutes integer default 60
) returns table (
  recipient_id    uuid,
  recipient_email text,
  recipient_name  text,
  recipient_role  user_role,
  job_book_id     uuid,
  job_number      text,
  facility_name   text,
  note_id         uuid,
  severity        note_severity,
  section_number  text,
  author_name     text,
  body            text,
  created_at      timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    u.id, u.email::text, u.full_name, u.role,
    b.id, b.job_number, b.facility_name,
    c.id, c.severity, sd.section_number,
    author.full_name, c.body, n.created_at
  from notification n
    join app_user u on u.id = n.user_id
    join inspector_comment c on c.id = n.note_id
    join job_book b on b.id = n.job_book_id
    join app_user author on author.id = c.author_id
    left join job_book_section s on s.id = c.section_id
    left join section_definition sd on sd.id = s.section_definition_id
  where n.read_at is null
    and n.digested_at is null
    and n.created_at < now() - make_interval(mins => p_min_age_minutes)
    -- Switched-off and deleted accounts get no mail. An account closed
    -- on Friday must not receive Monday's digest.
    and u.is_active
    and u.deleted_at is null
    -- The recipient rule, applied here rather than left to the caller.
    -- 0024's trigger already scopes who gets a notification row; this is
    -- the second lock on the door that opens outward.
    and u.role in ('fortress_admin', 'qaqc_manager', 'qaqc_tech')
    and b.deleted_at is null
  order by u.id, b.job_number, n.created_at
$$;

revoke all on function digest_rows(integer) from public, anon, authenticated;

comment on function digest_rows is
  'Every unread, un-emailed note old enough to digest, with the recipient '
  'it belongs to. Reads across all users, so it is reachable only by the '
  'service role from inside Supabase — never from the web deployment.';

-- ---------------------------------------------------------------------
-- Marking a batch sent.
--
-- Takes the note ids for ONE recipient rather than a whole run, and is
-- called after that person's message is accepted by the provider. A run
-- that dies halfway therefore re-sends nobody's mail and loses nobody's:
-- the people already sent are marked, the rest are still pending.
-- ---------------------------------------------------------------------
create or replace function mark_digested(
  p_user_id uuid,
  p_note_ids uuid[]
) returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  update notification
     set digested_at = now()
   where user_id = p_user_id
     and note_id = any(p_note_ids)
     and digested_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function mark_digested(uuid, uuid[]) from public, anon, authenticated;

comment on function mark_digested is
  'Mark one recipient''s notes as emailed, after their message is away. '
  'Per-recipient so a failed run neither double-sends nor drops anyone.';

-- ---------------------------------------------------------------------
-- A record of each run.
--
-- Not for the app — nothing reads this on screen. It is so that "did
-- anybody get Tuesday's digest" has an answer other than asking people.
-- ---------------------------------------------------------------------
create table digest_run (
  id           uuid primary key default gen_random_uuid(),
  ran_at       timestamptz not null default now(),
  recipients   integer not null default 0,
  notes        integer not null default 0,
  skipped      integer not null default 0,
  failed       integer not null default 0,
  error        text
);

alter table digest_run enable row level security;
alter table digest_run force row level security;

-- Fortress staff may read the run log. Nobody may write it from a
-- session: rows come from the Edge Function under the service role.
create policy digest_run_read on digest_run for select using (
  is_fortress_staff()
);

comment on table digest_run is
  'One row per digest run. Exists so that "did the digest go out" is a '
  'question with an answer.';
