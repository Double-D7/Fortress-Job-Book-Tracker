-- ---------------------------------------------------------------------
-- Operators, creatable from inside the application.
--
-- `client_org` has always been writable by an admin — the RLS policy
-- `client_org_write` says so — but nothing in the application ever wrote
-- it. Every operator in the database was inserted by hand against the
-- database, which meant the first field of the new-book form could not
-- be filled in for a new client without someone opening a SQL editor.
-- A job book cannot be created without an operator, so that one gap
-- blocked the whole application for any new client.
--
-- Two functions rather than a bare insert, matching `invite_user` and
-- `set_user_role`: the admin actions in this system are named, audited
-- and refuse in one transaction with the write. `client_org` already
-- carries the audit trigger, so both of these land in `audit_event`
-- without anything further.
--
-- WHY A UNIQUE INDEX ON THE NAME. The operator name is what a person
-- picks from a list, and it is printed on every book that belongs to it.
-- Two rows called "Oxy" are indistinguishable in that list, and the day
-- somebody picks the wrong one the book is filed against the wrong
-- client. Case-insensitive, because "Oxy" and "oxy" have the same
-- problem, and partial on live rows so a name can be reused after an
-- operator is retired.
--
-- WHY THERE IS NO DELETE. An operator with books behind it cannot be
-- removed without orphaning them, and one without books costs nothing to
-- leave. Retiring an operator is a soft delete, which is a different
-- conversation and needs a rule for what happens to its books; until
-- somebody needs it, offering it would be offering a trap.
-- ---------------------------------------------------------------------

create unique index if not exists client_org_name_live
  on client_org (lower(name))
  where deleted_at is null;

-- ---------------------------------------------------------------------
create or replace function create_client_org(p_name text)
returns client_org
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_actor app_user; v_name text; v_existing text; v_new client_org;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role <> 'fortress_admin' then
    raise exception 'only a Fortress Admin may add an operator' using errcode = '42501';
  end if;

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    raise exception 'an operator needs a name' using errcode = '23514';
  end if;

  -- Named back rather than reported as a constraint violation: the
  -- usual cause is the operator already existing under a slightly
  -- different capitalisation, and seeing it spelled out is the answer.
  select name into v_existing from client_org
   where lower(name) = lower(v_name) and deleted_at is null;
  if v_existing is not null then
    raise exception '% is already on the operator list, as "%"', v_name, v_existing
      using errcode = '23505';
  end if;

  insert into client_org (name) values (v_name) returning * into v_new;
  return v_new;
end $function$;

-- ---------------------------------------------------------------------
create or replace function rename_client_org(p_id uuid, p_name text)
returns client_org
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_actor app_user; v_name text; v_existing text; v_updated client_org;
begin
  select * into v_actor from current_app_user();
  if v_actor.id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_actor.role <> 'fortress_admin' then
    raise exception 'only a Fortress Admin may rename an operator' using errcode = '42501';
  end if;

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    raise exception 'an operator needs a name' using errcode = '23514';
  end if;

  if not exists (select 1 from client_org where id = p_id and deleted_at is null) then
    raise exception 'no such operator' using errcode = 'P0002';
  end if;

  -- Excludes itself, so correcting the capitalisation of a name is a
  -- rename rather than a collision with the row being renamed.
  select name into v_existing from client_org
   where lower(name) = lower(v_name) and deleted_at is null and id <> p_id;
  if v_existing is not null then
    raise exception 'another operator is already called "%"', v_existing
      using errcode = '23505';
  end if;

  update client_org set name = v_name where id = p_id returning * into v_updated;
  return v_updated;
end $function$;

revoke all on function create_client_org(text) from public, anon;
revoke all on function rename_client_org(uuid, text) from public, anon;
grant execute on function create_client_org(text) to authenticated;
grant execute on function rename_client_org(uuid, text) to authenticated;
