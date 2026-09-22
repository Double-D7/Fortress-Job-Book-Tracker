-- ---------------------------------------------------------------------
-- Administering people.
--
-- `invite_user()` has existed since 0011 and nothing has ever called it.
-- There is no screen for it, no provider method, and no way to change a
-- role or switch an account off once created — the only path to a new
-- user has been an admin with a SQL console. That is the shape of bug
-- this codebase keeps producing: complete, careful code with no route
-- from a person to a row.
--
-- Three things here.
--
--   1. invite_user() is wrong about inspectors. It refuses any non
--      client_user carrying an operator, but the table's own
--      `client_user_has_org` constraint explicitly PERMITS a
--      third_party_inspector to carry one. So the function is stricter
--      than the schema it is meant to state, and an admin inviting an
--      operator's own inspector — the ordinary case, since a Client
--      Inspector usually works for somebody — is refused for a reason
--      that is not a rule. The constraint is right: an inspector reaches
--      books by grant regardless, so the operator on their row is
--      reporting, not access.
--
--   2. set_user_role() and set_user_active(), because a role assigned
--      once and never changeable is not an access model. People are
--      promoted, leave, and are hired by the operator they used to
--      inspect for.
--
--   3. A guard against removing the last admin, on both. Nothing else in
--      this schema can be undone from outside it: `app_user_write` is
--      admin-only, and `invite_user()` is admin-only, so an estate with
--      no active admin has no way back in short of the service role. The
--      two ways to reach that state are demoting the last admin and
--      switching them off, and both are one click on a screen that did
--      not exist until now.
--
-- All three run as SECURITY DEFINER functions rather than as direct
-- writes under the `app_user_write` policy. The policy answers "may this
-- caller write to app_user" — it cannot see that the row being written
-- is the last admin, nor that the org about to be attached suits the
-- role. Same division as everywhere else here: RLS governs who may
-- write, a function governs what the row may say.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Would this leave the estate with no way in?
--
-- Counts admins OTHER than the one being changed. Deliberately counts
-- `is_active and deleted_at is null`, because a deactivated admin cannot
-- sign in and a soft-deleted one resolves to no role — neither is a way
-- back.
-- ---------------------------------------------------------------------
create or replace function other_active_admins(p_excluding uuid)
  returns integer
language sql stable security definer set search_path = public, pg_temp
as $$
  select count(*)::integer from app_user
   where role = 'fortress_admin'
     and is_active
     and deleted_at is null
     and id <> p_excluding
$$;

revoke execute on function other_active_admins(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- The org rule, in one place.
--
-- Was stated twice — once as `client_user_has_org` on the table, once as
-- two raises inside invite_user() — and the two disagreed. Stated once
-- here, as a sentence rather than a constraint violation, and called
-- from every function that sets a role.
-- ---------------------------------------------------------------------
create or replace function check_org_for_role(p_role user_role, p_org uuid)
  returns void
language plpgsql immutable security definer set search_path = public, pg_temp
as $$
begin
  -- Without an operator, current_client_org_id() is null and the
  -- client_user branch of can_read_job_book() matches nothing.
  if p_role = 'client_user' and p_org is null then
    raise exception 'Client Management accounts must belong to an operator'
      using errcode = '23514';
  end if;

  -- A Fortress account carrying an operator would be filtered down to a
  -- single client by any future predicate that reads the column.
  -- third_party_inspector is exempt: they reach books by grant, so the
  -- operator on their row is reporting rather than access, and the
  -- table's own constraint permits it.
  if p_role not in ('client_user', 'third_party_inspector')
     and p_org is not null then
    raise exception
      'a Fortress account may not belong to an operator (% carries one)', p_role
      using errcode = '23514';
  end if;
end $$;

revoke execute on function check_org_for_role(user_role, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Invite. Same contract as 0011, minus the inspector mistake.
-- ---------------------------------------------------------------------
create or replace function invite_user(
  p_email     citext,
  p_full_name text,
  p_role      user_role,
  p_client_org_id uuid default null
) returns app_user
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor app_user; v_new app_user;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role <> 'fortress_admin' then
    raise exception 'only a Fortress Admin may invite a user' using errcode = '42501';
  end if;

  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'a user needs a name' using errcode = '23514';
  end if;

  perform check_org_for_role(p_role, p_client_org_id);

  -- The email is the invitation's identity: link_app_user_to_auth()
  -- matches on it, and app_user.email is unique and citext. A duplicate
  -- would otherwise surface as a raw constraint name on screen.
  if exists (select 1 from app_user where email = p_email) then
    raise exception '% has already been invited', p_email using errcode = '23505';
  end if;

  insert into app_user (email, full_name, role, client_org_id)
  values (p_email, trim(p_full_name), p_role, p_client_org_id)
  returning * into v_new;
  return v_new;
end $$;

revoke all on function invite_user(citext, text, user_role, uuid) from public, anon;
grant execute on function invite_user(citext, text, user_role, uuid) to authenticated;

comment on function invite_user is
  'Grant a person access. Admin-only. The app_user row is the invitation; '
  'it links to their account by email the moment either side appears. A '
  'Client Inspector may carry an operator; a Fortress account may not.';

-- ---------------------------------------------------------------------
-- Change a role.
--
-- Takes the org alongside the role because the two are one decision:
-- promoting a Client Management user to a Client Inspector may keep the
-- operator, and moving anyone to a Fortress role must drop it. Passing
-- the role without the org would leave the row in a state the table's
-- constraint refuses, and the caller would read a constraint name.
-- ---------------------------------------------------------------------
create or replace function set_user_role(
  p_user_id uuid,
  p_role    user_role,
  p_client_org_id uuid default null
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
    raise exception 'only a Fortress Admin may change a role' using errcode = '42501';
  end if;

  select * into v_target from app_user where id = p_user_id and deleted_at is null;
  if v_target.id is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  perform check_org_for_role(p_role, p_client_org_id);

  if v_target.role = 'fortress_admin' and p_role <> 'fortress_admin'
     and other_active_admins(p_user_id) = 0 then
    raise exception
      'this is the last active Fortress Admin; appoint another before changing this role'
      using errcode = '23514';
  end if;

  update app_user
     set role = p_role, client_org_id = p_client_org_id
   where id = p_user_id
  returning * into v_updated;
  return v_updated;
end $$;

revoke all on function set_user_role(uuid, user_role, uuid) from public, anon;
grant execute on function set_user_role(uuid, user_role, uuid) to authenticated;

comment on function set_user_role is
  'Change a person''s role and operator together. Admin-only. Refuses to '
  'remove the last active admin, which nothing outside this schema could undo.';

-- ---------------------------------------------------------------------
-- Switch an account on or off.
--
-- Not a delete. The audit log names `app_user.id` on every row it has
-- ever written, §15 keeps records for the retention period, and a weld
-- inspected in 2024 must still name who inspected it in 2031. So an
-- account that should no longer sign in is deactivated, and the person
-- stays legible everywhere they appear.
-- ---------------------------------------------------------------------
create or replace function set_user_active(
  p_user_id uuid,
  p_active  boolean
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
    raise exception 'only a Fortress Admin may deactivate a user' using errcode = '42501';
  end if;

  select * into v_target from app_user where id = p_user_id and deleted_at is null;
  if v_target.id is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  if not p_active and v_target.role = 'fortress_admin'
     and other_active_admins(p_user_id) = 0 then
    raise exception
      'this is the last active Fortress Admin; appoint another before switching this account off'
      using errcode = '23514';
  end if;

  -- Deactivating an inspector leaves their grants standing, and
  -- has_live_inspector_grant() does not read is_active. Revoke here so
  -- that switching the account off actually closes the door, rather than
  -- closing it only at the sign-in page.
  if not p_active then
    update inspector_grant
       set revoked_at = now()
     where user_id = p_user_id and revoked_at is null;
  end if;

  update app_user set is_active = p_active where id = p_user_id
  returning * into v_updated;
  return v_updated;
end $$;

revoke all on function set_user_active(uuid, boolean) from public, anon;
grant execute on function set_user_active(uuid, boolean) to authenticated;

comment on function set_user_active is
  'Switch an account on or off, and revoke its inspector grants on the way '
  'off. Admin-only. Never a delete: the audit log names this id forever.';
