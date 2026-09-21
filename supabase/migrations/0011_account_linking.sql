-- ---------------------------------------------------------------------
-- Connecting a signed-in account to its app_user row.
--
-- Every security predicate in this schema starts from `app_user`:
-- current_app_role(), current_app_user_id(), can_read_job_book(). A person
-- who authenticates but has no app_user row resolves to no role and no
-- org, so RLS shows them nothing — correct, but it meant that on a fresh
-- deployment the first person to sign in bounced between the sign-in page
-- and a middleware redirect forever. Nobody could get in at all.
--
-- The link is by email, and it is an ALLOWLIST rather than a sign-up.
-- A row in `app_user` is an invitation created by an admin, carrying the
-- role and, for a client user, the operator they belong to. Authenticating
-- with an email nobody has invited creates nothing and grants nothing,
-- which is the property that matters: this application holds one
-- operator's construction records next to another's, and self-service
-- sign-up would make "who are you" a question the visitor answers.
-- ---------------------------------------------------------------------

create or replace function link_auth_user() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Claim the invitation matching this address, if there is one, and only
  -- if it is unclaimed. `auth_user_id is null` makes this idempotent and
  -- stops a second account taking over an existing person's row.
  update app_user
     set auth_user_id = new.id
   where lower(email) = lower(new.email)
     and auth_user_id is null
     and deleted_at is null;

  -- No match is not an error. The account exists in Supabase Auth and
  -- resolves to no role, which every policy already handles by showing
  -- nothing.
  return new;
end $$;

drop trigger if exists link_auth_user_on_signup on auth.users;
create trigger link_auth_user_on_signup
  after insert on auth.users
  for each row execute function link_auth_user();

-- An invitation created after the person already authenticated — the
-- ordinary case, since someone usually tries to sign in before anyone has
-- set them up — links on insert rather than waiting for a second sign-up
-- that will never come.
create or replace function link_app_user_to_auth() returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_auth uuid;
begin
  if new.auth_user_id is null then
    select id into v_auth from auth.users where lower(email) = lower(new.email) limit 1;
    new.auth_user_id := v_auth;
  end if;
  return new;
end $$;

drop trigger if exists link_app_user_on_insert on app_user;
create trigger link_app_user_on_insert
  before insert on app_user
  for each row execute function link_app_user_to_auth();

-- ---------------------------------------------------------------------
-- Inviting people.
--
-- Creating an app_user row is granting access, so it is an admin action
-- and goes through a function that says so, rather than through a table
-- policy that would have to re-state the same rule.
-- ---------------------------------------------------------------------
create or replace function invite_user(
  p_email     citext,
  p_full_name text,
  p_role      user_role,
  p_client_org_id uuid default null
) returns app_user
language plpgsql security definer set search_path = public
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

  -- The same constraint the table carries, raised here as a sentence: a
  -- client user without an org would see every operator's books, and a
  -- Fortress user with one would be filtered down to a single client.
  if p_role = 'client_user' and p_client_org_id is null then
    raise exception 'a client user must belong to an operator' using errcode = '23514';
  end if;
  if p_role <> 'client_user' and p_client_org_id is not null then
    raise exception 'only a client user may belong to an operator' using errcode = '23514';
  end if;

  insert into app_user (email, full_name, role, client_org_id)
  values (p_email, p_full_name, p_role, p_client_org_id)
  returning * into v_new;
  return v_new;
end $$;

revoke all on function invite_user(citext, text, user_role, uuid) from public;
grant execute on function invite_user(citext, text, user_role, uuid) to authenticated;

comment on function invite_user is
  'Grant a person access. Admin-only. The app_user row is the invitation; '
  'it links to their account by email the moment either side appears.';
