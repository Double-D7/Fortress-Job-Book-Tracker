-- ---------------------------------------------------------------------
-- Telling somebody.
--
-- 0023 gave the Client Inspector a note. It did not give anyone a reason
-- to look at it: the note landed in `inspector_comment` and sat there
-- until a Fortress person happened to open the Notes tab. "Weld 42's
-- radiograph is illegible" is worth nothing as a row nobody reads, and
-- this is the same failure the rest of this schema keeps producing — a
-- record with no path from it to a person.
--
-- Two additions.
--
--   1. A severity on the note, so the author can say how loudly. NOT the
--      §11 vocabulary. Critical/Major/Minor mean a classified defect on
--      the findings register with a deduction attached, and reusing
--      those words for something an inspector typed would invite the
--      belief that typing one changes the score. It does not, it must
--      not, and the separate vocabulary is the reminder.
--
--   2. A `notification` table and a trigger that fans a note out to the
--      people who own the book: the §5 Custodian for everything, and
--      everyone else assigned for anything that is not an observation.
--
-- THE RULE THIS FILE EXISTS TO HOLD. A notification may not carry a note
-- to somebody who could not have read the note. `inspector_comment_read`
-- withholds an internal note from the operator and from the inspector;
-- a notification that named one of them would hand back what the policy
-- withheld — a side channel around the visibility column, opened by the
-- feature meant to make notes useful. The trigger therefore selects
-- recipients from Fortress staff only, and re-checks the visibility
-- rather than assuming the role filter covered it.
--
-- Deliberately NOT here: notifying the inspector when Fortress replies.
-- It is a reasonable thing to want, and it is a different recipient set
-- with a different visibility question — an inspector must never be told
-- about an internal note, and the check that stops it is not the one
-- above. It belongs in its own migration with its own tests.
-- ---------------------------------------------------------------------

create type note_severity as enum ('critical', 'warning', 'info');

alter table inspector_comment
  add column severity note_severity not null default 'info';

comment on column inspector_comment.severity is
  'How loudly the author asked to be heard. A routing signal only: it '
  'decides who is notified and never touches the §11 findings register '
  'or the score. An inspector marking a note Critical does not raise a '
  'Critical finding — a Fortress person still has to do that.';

-- ---------------------------------------------------------------------
-- One person's unread marker for one note.
--
-- A row per recipient rather than a read-receipt table keyed by note:
-- "what have I not read" is the question every render asks, and it
-- should be an index seek on one user rather than a scan of everybody's.
-- ---------------------------------------------------------------------
create table notification (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user(id) on delete cascade,
  job_book_id uuid not null references job_book(id) on delete cascade,
  note_id     uuid not null references inspector_comment(id) on delete cascade,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  -- One notification per person per note. Re-running the trigger, or a
  -- later backfill, must not multiply what somebody sees.
  unique (user_id, note_id)
);

create index notification_unread on notification (user_id, read_at)
  where read_at is null;
create index notification_book on notification (job_book_id);

comment on table notification is
  'An unread marker: person X has not yet read note Y. Carries no copy '
  'of the note body — the note is read through inspector_comment, under '
  'its own policy, so a notification can never show more than the note.';

-- ---------------------------------------------------------------------
-- The fan-out.
--
-- AFTER INSERT rather than BEFORE: the note must exist before anything
-- can reference it, and a failure to notify must not lose the note.
-- ---------------------------------------------------------------------
-- May somebody in this role be told about a note with this visibility?
--
-- The rule in ONE place, because the version of this that had it in two
-- places had it in one and a half: the recipient query already filtered
-- to Fortress roles, so a second clause re-checking the visibility
-- against those same roles was a tautology that read like a safeguard.
-- A check that cannot fail is worse than no check, because the next
-- person trusts it.
--
-- So the visibility rule is this function, the recipient query calls it,
-- and widening the recipients later means meeting it rather than
-- editing around it.
create or replace function may_be_notified_of(
  p_role user_role, p_visibility doc_visibility
) returns boolean
language sql immutable security definer set search_path = public, pg_temp
as $$
  select case
    -- Fortress staff read both kinds, so both kinds may reach them.
    when p_role in ('fortress_admin', 'qaqc_manager', 'qaqc_tech') then true
    -- Everyone else: never an internal note. `inspector_comment_read`
    -- withholds it, and a notification naming them would hand back what
    -- the policy withheld.
    when p_visibility = 'internal' then false
    -- A shared note MAY reach an external reader — but nothing creates
    -- such a notification yet, and the recipient query below does not.
    -- Telling an inspector that Fortress replied is a real feature with
    -- its own recipient set; it gets its own migration and its own test.
    else false
  end
$$;

revoke execute on function may_be_notified_of(user_role, doc_visibility)
  from public, anon, authenticated;

create or replace function fan_out_note_notifications() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into notification (user_id, job_book_id, note_id)
  select distinct u.id, new.job_book_id, new.id
    from app_user u
    join job_book b on b.id = new.job_book_id
   where u.deleted_at is null
     and u.is_active
     -- The whole of the visibility rule, and the only statement of it.
     and may_be_notified_of(u.role, new.visibility)
     -- Being notified of your own note teaches people to dismiss
     -- notifications without reading them.
     and u.id <> new.author_id
     and (
       -- The §5 Custodian owns the book and hears everything on it.
       u.id = b.custodian_id
       -- Everyone else assigned hears anything that is not merely an
       -- observation. An info note still reaches the Custodian, and
       -- still reaches everyone in the daily digest, which reads the
       -- notes rather than this table.
       or (new.severity <> 'info'
           and exists (select 1 from job_assignment a
                        where a.job_book_id = new.job_book_id
                          and a.user_id = u.id))
     )
  on conflict (user_id, note_id) do nothing;

  return null;
end $$;

create trigger note_notifies_the_book
  after insert on inspector_comment
  for each row execute function fan_out_note_notifications();

comment on function fan_out_note_notifications() is
  'Tells the Custodian about every note on their book, and everyone else '
  'assigned about anything that is not an observation. Never tells '
  'somebody about a note they could not read.';

revoke execute on function fan_out_note_notifications()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Reading them.
--
-- A person sees their own notifications and nobody else's. Not even an
-- admin: what a colleague has not got round to reading is not a
-- compliance record, and the audit log already holds who read which
-- document, which is the question §15 actually asks.
-- ---------------------------------------------------------------------
alter table notification enable row level security;
alter table notification force row level security;

create policy notification_read on notification for select using (
  user_id = current_app_user_id()
);

-- Marking as read is the only write, and it is yours alone.
--
-- The policy is genuinely required rather than belt-and-braces: RLS is
-- FORCEd on this table, so `mark_notifications_read()` — which runs as
-- the owner — is subject to it like anybody else.
--
-- Which means a caller can also PATCH their own rows directly, and
-- un-read them. That is fine and worth saying plainly rather than
-- claiming a protection that is not here: a notification is one
-- person's own to-do marker, not a compliance record. What §15 actually
-- asks — who read which document — is answered by `log_document_access`
-- in the append-only audit log, which no policy here can touch.
--
-- There is no INSERT policy. Rows arrive only from the trigger.
create policy notification_mark on notification for update using (
  user_id = current_app_user_id()
) with check (
  user_id = current_app_user_id()
);

create or replace function mark_notifications_read(
  p_job_book_id uuid default null
) returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_me uuid; v_count integer;
begin
  v_me := current_app_user_id();
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update notification
     set read_at = now()
   where user_id = v_me
     and read_at is null
     and (p_job_book_id is null or job_book_id = p_job_book_id);

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function mark_notifications_read(uuid) from public, anon;
grant execute on function mark_notifications_read(uuid) to authenticated;

comment on function mark_notifications_read is
  'Mark this caller''s unread notifications read, on one book or all of '
  'them. Yours only, and it cannot un-read.';

-- The audit trigger, on the same terms as every other table carrying
-- compliance data. 0002 attaches it by name to a fixed list, so a table
-- added later has to ask.
do $$
begin
  execute 'create trigger audit_notification after insert or update or delete '
       || 'on notification for each row execute function audit_trigger()';
exception when duplicate_object then null;
end $$;
