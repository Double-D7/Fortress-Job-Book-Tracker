-- ---------------------------------------------------------------------
-- The allowlist belongs in the database, not in a dashboard toggle.
--
-- 0011 made `app_user` an invitation list and linked it to an auth account
-- by email. What it did not account for is that a first sign-in has to
-- CREATE that auth account — and the application asked for the link with
-- `shouldCreateUser: false` while the project had signups disabled. Two
-- locks on the same door, and the invitation on the other side of it.
-- Result: zero auth accounts, and no path to a first one. Not even for the
-- admin who set the system up.
--
-- Turning signups back on would fix the deadlock and lose the allowlist,
-- which is not a trade worth making: this holds one operator's records
-- next to another's.
--
-- So the rule moves here. Signups are enabled at the project level, and
-- Postgres refuses to create an account for an address nobody invited.
-- That is better than the toggle in both directions — it survives someone
-- flipping a dashboard setting, and it lets an invited person in.
-- ---------------------------------------------------------------------

create or replace function enforce_signup_allowlist() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (
    select 1 from app_user
     where lower(email) = lower(new.email)
       and deleted_at is null
  ) then
    return new;
  end if;

  -- Deliberately the same wording the sign-in screen shows, so a person
  -- who reaches it by a different route reads the same sentence.
  raise exception
    'That address has not been invited to this system. Ask a Fortress admin to add you.'
    using errcode = '42501';
end $$;

comment on function enforce_signup_allowlist is
  'Refuses an auth account for an address with no app_user invitation. The '
  'allowlist is enforced here rather than by the project''s signup toggle, '
  'so it survives that toggle being changed.';

drop trigger if exists enforce_signup_allowlist_on_auth_users on auth.users;
create trigger enforce_signup_allowlist_on_auth_users
  before insert on auth.users
  for each row execute function enforce_signup_allowlist();

revoke execute on function enforce_signup_allowlist() from public, anon, authenticated;
