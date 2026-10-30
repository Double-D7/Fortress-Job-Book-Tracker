-- ---------------------------------------------------------------------
-- 0048 — recording a competency assessment
--
-- `app_user.competency_level` has existed since 0015 and gates three
-- things: being named §5 Custodian (JB-2 or above), performing a §10.2
-- Tier 2 peer audit (JB-3 or above), and the Gate 0 criterion that
-- reads the Custodian's level.
--
-- Nothing has ever been able to set it. The column was written by the
-- demo seed and by the security tests and by nothing else, so every
-- real account carries null — which the domain correctly treats as
-- "not assessed", and therefore as unqualified. The practical effect
-- was that no book could be given a Custodian and no Tier 2 audit
-- could be recorded by anybody, whatever their role. A QA/QC Manager
-- setting up a flowline book hit exactly that wall.
--
-- This is the missing half: an admin-only function, in the same shape
-- as `set_user_role` and `set_user_active`, so the control lives in
-- the database rather than in a screen.
--
-- ## Why an assessment is not a self-service field
--
-- FDS-JBMP-004 competency is an assessment somebody performs on
-- somebody else. A person recording their own JB-4 and then peer-
-- auditing on the strength of it defeats §10.2 in precisely the way the
-- Custodian exclusion already guards against — `canPeerAudit` refuses
-- the book's own Custodian for the same reason.
--
-- So the function refuses to let an actor set their own level. With
-- several admins that costs nothing; with one it means appointing a
-- second before assessing the first, which is the correct answer to
-- "who assessed the assessor".
--
-- `competency_granted_at` and `competency_granted_by` have also existed
-- since 0015 and have never been written. They are set here, so the
-- record says who assessed and when rather than carrying a bare level
-- from nowhere.
-- ---------------------------------------------------------------------

create or replace function set_user_competency(
  p_user_id uuid,
  p_level   competency_level default null
) returns app_user
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor app_user; v_target app_user; v_updated app_user;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role <> 'fortress_admin' then
    raise exception 'only a Fortress Admin may record a competency assessment'
      using errcode = '42501';
  end if;

  select * into v_target from app_user where id = p_user_id and deleted_at is null;
  if v_target.id is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  -- The independence rule. See the header: an assessment is performed
  -- on somebody, not claimed by them.
  if v_target.id = v_actor.id then
    raise exception
      'a competency assessment is recorded by somebody else; ask another Fortress Admin'
      using errcode = '42501';
  end if;

  -- Competency is a Fortress job-book competency. A client's staff and
  -- a third-party inspector are never Custodians and never peer-audit,
  -- so a level on their account would be a number that means nothing
  -- and reads as though it does.
  if p_level is not null
     and v_target.role not in ('fortress_admin', 'qaqc_manager', 'qaqc_tech',
                               'fortress_read_only') then
    raise exception
      'competency applies to Fortress staff; % holds a client role', v_target.full_name
      using errcode = '23514';
  end if;

  update app_user
     set competency_level = p_level,
         -- Clearing the level clears its provenance with it. A date and
         -- an assessor left behind on a null level would describe an
         -- assessment that no longer stands.
         competency_granted_at = case when p_level is null then null else current_date end,
         competency_granted_by = case when p_level is null then null else v_actor.id end
   where id = p_user_id
  returning * into v_updated;
  return v_updated;
end $$;

revoke all on function set_user_competency(uuid, competency_level) from public, anon;
grant execute on function set_user_competency(uuid, competency_level) to authenticated;

comment on function set_user_competency is
  'Record an FDS-JBMP-004 competency assessment against a Fortress '
  'account, with the assessor and the date. Admin-only, and never on '
  'oneself: an assessment is performed by somebody else, and a '
  'self-recorded JB-3 would defeat the §10.2 independence rule it '
  'unlocks. Passing null clears the assessment and its provenance.';
