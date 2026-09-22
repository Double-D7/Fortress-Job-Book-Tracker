-- ---------------------------------------------------------------------
-- Client Inspector access, and the notes it exists to enable.
--
-- `inspector_grant` and `inspector_comment` have been in the schema since
-- 0001 with complete RLS since 0003, and no application code has ever
-- read or written either one. So a Client Inspector cannot be given a
-- book, and cannot add a note to one — the two things the role is for.
--
-- Four corrections, all of the same kind: a policy answers "may this
-- caller write here", and each of these is a question about what the row
-- SAYS, which a policy cannot reach.
--
--   1. A grant may name anyone. `inspector_grant_write` asks only whether
--      the caller is a manager or an admin. Nothing stops a grant naming
--      a client_user — and `project_read` consults
--      has_live_inspector_grant() for EVERY role, not just inspectors, so
--      such a grant would show that user a project row their own branch
--      of the predicate withholds. The grant table would become a way to
--      widen access sideways, from a screen whose purpose is the
--      opposite. Restricted to inspectors by trigger.
--
--   2. A note may point at another book's section. `section_id` and
--      `document_id` are plain references with nothing tying them to
--      `job_book_id`, so a note filed against book A could cite a section
--      of book B — and the reader, who can see A, would be shown the
--      citation. Checked by trigger.
--
--   3. Every note is visible to the client. `inspector_comment_read` is
--      `can_read_job_book(job_book_id)`, which is true for the operator
--      and for the inspector. A QA/QC tech writing what they think is a
--      working note — about a disputed weld, or about the inspector —
--      would be publishing it. That is a trap rather than a feature, so
--      notes now carry a visibility, defaulting to internal, and an
--      external author must write a shared one.
--
--   4. A Fortress writer may annotate a book they cannot read. The insert
--      policy's staff branch is `is_fortress_writer()`, which says
--      nothing about WHICH book — so a tech could file notes on a book
--      §5 never assigned them. Now gated on can_read_job_book() as well,
--      which for a tech means assigned.
--
-- Notes stay append-only, as they were: there is no UPDATE or DELETE
-- policy on `inspector_comment` and none is added. A note is somebody's
-- contemporaneous statement about a record, which §15 keeps; the way to
-- withdraw one is to write the correction underneath it.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. A grant names an inspector.
-- ---------------------------------------------------------------------
create or replace function enforce_grant_is_for_inspector() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_role user_role;
begin
  select role into v_role from app_user where id = new.user_id;

  if v_role is null then
    raise exception 'inspector grant names %, who is not a known user', new.user_id;
  end if;

  if v_role <> 'third_party_inspector' then
    raise exception
      'an inspector grant may only name a Client Inspector; % is a %',
      new.user_id, v_role
      using hint =
        'Fortress staff reach books by assignment and Client Management by operator; '
        'a grant would widen their access rather than describe it.';
  end if;

  return new;
end $$;

create trigger inspector_grant_names_an_inspector
  before insert or update of user_id on inspector_grant
  for each row execute function enforce_grant_is_for_inspector();

comment on function enforce_grant_is_for_inspector() is
  'Refuses an inspector grant naming anyone but a Client Inspector. RLS '
  'governs who may ISSUE a grant; this governs who it may NAME.';

revoke execute on function enforce_grant_is_for_inspector()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2 and 3. Notes: a visibility, and citations that belong to the book.
-- ---------------------------------------------------------------------

-- Reusing doc_visibility rather than minting a second enum that means the
-- same thing. Only two of its three values make sense on a note:
-- 'internal' is Fortress-only, 'client' is everyone who can read the book
-- — which includes the inspector, since a note the inspector cannot see
-- is not a reply to them. 'inspector' would mean visible to the inspector
-- and not to the operator, which is a distinction nobody has asked for
-- and which would be read as a private channel it is not.
alter table inspector_comment
  add column visibility doc_visibility not null default 'internal';

alter table inspector_comment
  add constraint note_visibility_is_internal_or_shared
  check (visibility in ('internal', 'client'));

comment on column inspector_comment.visibility is
  'internal: Fortress staff only. client: everyone who can read the book, '
  'which is the operator and any granted inspector. Defaults to internal '
  'so that a note written without a decision is not published by accident.';

create or replace function enforce_note_citation() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.section_id is not null
     and not exists (select 1 from job_book_section s
                      where s.id = new.section_id
                        and s.job_book_id = new.job_book_id) then
    raise exception 'that section belongs to a different job book';
  end if;

  if new.document_id is not null
     and not exists (select 1 from document d
                      where d.id = new.document_id
                        and d.job_book_id = new.job_book_id) then
    raise exception 'that document belongs to a different job book';
  end if;

  return new;
end $$;

create trigger note_cites_its_own_book
  before insert or update of section_id, document_id, job_book_id
  on inspector_comment
  for each row execute function enforce_note_citation();

comment on function enforce_note_citation() is
  'Refuses a note whose cited section or document belongs to another book.';

revoke execute on function enforce_note_citation()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- The two policies, restated.
-- ---------------------------------------------------------------------
drop policy if exists inspector_comment_read on inspector_comment;
create policy inspector_comment_read on inspector_comment for select using (
  can_read_job_book(job_book_id)
  and (visibility <> 'internal' or is_fortress_staff())
);

drop policy if exists inspector_comment_insert on inspector_comment;
create policy inspector_comment_insert on inspector_comment for insert with check (
  -- As yourself. Attribution on a compliance record is the record.
  author_id = current_app_user_id()
  -- On a book you can actually see. For a tech that means assigned; for
  -- an inspector it means granted, which the branch below re-checks for
  -- the separate question of whether they may write as well as read.
  and can_read_job_book(job_book_id)
  and (
    is_fortress_writer()
    or (
      -- An external author writes in the open or not at all. A shared
      -- thread with a hidden half would be worse than no thread.
      visibility <> 'internal'
      and exists (select 1 from inspector_grant g
                   where g.job_book_id = inspector_comment.job_book_id
                     and g.user_id = current_app_user_id()
                     and g.can_comment
                     and g.revoked_at is null
                     and (g.expires_at is null or g.expires_at > now()))
    )
  )
);

-- ---------------------------------------------------------------------
-- 4. Issuing and withdrawing a grant.
--
-- `inspector_grant_write` already permits a manager or an admin, so these
-- exist for what the policy cannot express: that re-issuing a grant to
-- somebody who already has one should extend it rather than collide with
-- `unique (job_book_id, user_id)`, and that `granted_by` should record
-- the caller rather than whatever the caller typed.
-- ---------------------------------------------------------------------
create or replace function issue_inspector_grant(
  p_job_book_id uuid,
  p_user_id     uuid,
  p_expires_at  timestamptz default null,
  p_can_comment boolean default false
) returns inspector_grant
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor app_user; v_grant inspector_grant;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role not in ('fortress_admin', 'qaqc_manager') then
    raise exception 'only a QA/QC Manager or an Admin may grant access to a book'
      using errcode = '42501';
  end if;

  if not exists (select 1 from job_book where id = p_job_book_id and deleted_at is null) then
    raise exception 'no such job book' using errcode = 'P0002';
  end if;

  -- A grant that has already expired is almost certainly a typed date in
  -- the wrong year, and it would present on screen as access granted.
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'that expiry has already passed' using errcode = '23514';
  end if;

  -- The inspector check is the trigger's; this reaches the same answer
  -- earlier so the caller reads a sentence rather than a trigger name.
  if not exists (select 1 from app_user
                  where id = p_user_id
                    and role = 'third_party_inspector'
                    and deleted_at is null) then
    raise exception 'only a Client Inspector can be granted a book'
      using errcode = '23514';
  end if;

  if not exists (select 1 from app_user
                  where id = p_user_id and is_active and deleted_at is null) then
    raise exception 'that account is switched off' using errcode = '23514';
  end if;

  insert into inspector_grant
    (job_book_id, user_id, expires_at, can_comment, granted_by)
  values (p_job_book_id, p_user_id, p_expires_at, p_can_comment, v_actor.id)
  on conflict (job_book_id, user_id) do update
    set expires_at  = excluded.expires_at,
        can_comment = excluded.can_comment,
        granted_by  = excluded.granted_by,
        granted_at  = now(),
        -- Re-issuing a withdrawn grant reopens it. The audit log holds
        -- both acts, so the history is not lost by the row moving on.
        revoked_at  = null
  returning * into v_grant;

  return v_grant;
end $$;

revoke all on function issue_inspector_grant(uuid, uuid, timestamptz, boolean)
  from public, anon;
grant execute on function issue_inspector_grant(uuid, uuid, timestamptz, boolean)
  to authenticated;

comment on function issue_inspector_grant is
  'Give a Client Inspector one book, optionally until a date, optionally '
  'with the right to add notes. Manager or Admin. Re-issuing extends.';

create or replace function revoke_inspector_grant(
  p_job_book_id uuid,
  p_user_id     uuid
) returns inspector_grant
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor app_user; v_grant inspector_grant;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role not in ('fortress_admin', 'qaqc_manager') then
    raise exception 'only a QA/QC Manager or an Admin may withdraw access'
      using errcode = '42501';
  end if;

  update inspector_grant
     set revoked_at = now()
   where job_book_id = p_job_book_id
     and user_id = p_user_id
     and revoked_at is null
  returning * into v_grant;

  if v_grant.id is null then
    raise exception 'no live grant to withdraw' using errcode = 'P0002';
  end if;

  -- Notes the inspector already wrote stay. They were true when written,
  -- and §15 keeps the record; withdrawing access is not a correction.
  return v_grant;
end $$;

revoke all on function revoke_inspector_grant(uuid, uuid) from public, anon;
grant execute on function revoke_inspector_grant(uuid, uuid) to authenticated;

comment on function revoke_inspector_grant is
  'Withdraw a Client Inspector''s access to one book, now. Manager or '
  'Admin. Their notes remain: they were true when written.';
