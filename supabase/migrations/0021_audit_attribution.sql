-- ---------------------------------------------------------------------
-- Who an audit may be attributed to.
--
-- Found reviewing 0020 against its own callers. `record_peer_audit()`
-- enforces §10.2 properly — not the book's own Custodian, JB-3 or above
-- — but Tier 1 and Tier 3 have no function of their own, so they go in
-- as direct INSERTs governed only by the RLS write policy. That policy
-- asks whether the CALLER may write to the book. It says nothing about
-- who the row names as the auditor, and `auditor_id` arrives from the
-- client.
--
-- Two consequences, both real:
--
--   1. A qaqc_tech could file a `tier_3_manager` verification attributed
--      to the QA/QC Manager. Gate 4's `g4.tier3` criterion reads exactly
--      that row and reports met, so the tech would have cleared a gate
--      criterion that §10 reserves to the Manager — without the Manager
--      touching it.
--
--   2. Any audit could be attributed to a client user or an inspector.
--      §10 is Fortress checking Fortress; an audit signed by the
--      operator is a different document with a different meaning.
--
-- A CHECK constraint cannot see `app_user`, so this is a trigger. It
-- runs on the table rather than in the provider because the provider is
-- where the two implementations already drifted: the in-memory one
-- refused a tech's Tier 3 and the Supabase one did not, which is the
-- kind of difference nobody notices until it is in production.
--
-- Deliberately NOT enforced here: that the auditor is the caller. A
-- Custodian who audits their own book on paper and has the QA/QC tech
-- enter it afterwards is ordinary, and §8 already measures how late the
-- entry was. Attribution is about who did the work, not who typed it.
-- ---------------------------------------------------------------------

create or replace function enforce_audit_attribution() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_role user_role;
begin
  -- An audit in progress need not have an auditor yet; the table's own
  -- constraint requires one before it can be completed.
  if new.auditor_id is null then
    return new;
  end if;

  select role into v_role from app_user where id = new.auditor_id;

  if v_role is null then
    raise exception 'audit auditor % is not a known user', new.auditor_id;
  end if;

  -- §10 is Fortress checking Fortress. A client user or a third-party
  -- inspector may read a book; they do not perform its internal audits.
  if v_role not in ('fortress_admin', 'qaqc_manager', 'qaqc_tech') then
    raise exception
      'an audit must be attributed to Fortress staff; % is a %',
      new.auditor_id, v_role;
  end if;

  -- §10: Tier 3 is the QA/QC Manager's verification, and Gate 4 reads it
  -- as satisfying g4.tier3. Anyone else filing one clears a criterion
  -- the program reserves to the Manager.
  if new.tier = 'tier_3_manager'
     and v_role not in ('fortress_admin', 'qaqc_manager') then
    raise exception
      'Tier 3 verification is performed by the QA/QC manager or an admin (FDS-JBMP-001 §10); % is a %',
      new.auditor_id, v_role;
  end if;

  return new;
end $$;

create trigger job_book_audit_attribution
  before insert or update of auditor_id, tier on job_book_audit
  for each row execute function enforce_audit_attribution();

comment on function enforce_audit_attribution() is
  'Refuses an audit attributed to a non-Fortress user, and a Tier 3 '
  'verification attributed to anyone but the QA/QC manager or an admin. '
  'RLS governs who may WRITE the row; this governs who it may NAME.';

-- A trigger function needs EXECUTE granted to nobody: Postgres runs it as
-- the table owner when the trigger fires. Left callable it appears on the
-- REST surface as an RPC — harmless in itself, because plpgsql refuses a
-- trigger function invoked outside a trigger, but 0012 established the
-- rule for exactly this reason and `authenticated` belongs in the list.
revoke execute on function enforce_audit_attribution()
  from public, anon, authenticated;
