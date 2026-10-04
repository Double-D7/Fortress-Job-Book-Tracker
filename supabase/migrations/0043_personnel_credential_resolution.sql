-- ---------------------------------------------------------------------
-- Resolution, in both directions.
--
-- A person working a book before their card arrives must resolve when
-- the card is uploaded; a card uploaded before they are put on a book
-- must be found when they are. Either one alone leaves somebody
-- re-checking by hand, which is the work this exists to remove.
--
-- Split from 0042 so a timeout on one plpgsql body cannot leave the
-- table half-built. Safe to re-run.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Pulling one person's live cards into one book.
--
-- Deterministic id, derived from the book and the card, so running this
-- twice writes the same row twice and lands once. That is what lets
-- every trigger below be fired as often as the data changes without
-- stacking duplicates in the register.
--
-- A card is pulled only while it is live and only into a live book. A
-- certificate already filed by hand against this book is left alone:
-- the unique index keys on `credential_library_id`, so a hand-filed row
-- (whose link is null) never collides with a pulled one, and a person
-- who typed a card in themselves keeps what they typed.
-- ---------------------------------------------------------------------
create or replace function pull_credentials_into_book(
  p_job_book_id uuid, p_subject_type cert_subject_type, p_subject_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_job_book_id is null or p_subject_id is null then return; end if;

  insert into certificate (
    id, job_book_id, subject_type, subject_id, cert_type, issuing_body,
    issue_date, expiry_date, ndt_methods, document_id, credential_library_id
  )
  select
    (md5(p_job_book_id::text || pc.id::text))::uuid,
    p_job_book_id, pc.subject_type, pc.subject_id, pc.cert_type, pc.issuing_body,
    pc.issue_date, pc.expiry_date, pc.ndt_methods, null, pc.id
  from personnel_credential pc
  where pc.subject_type = p_subject_type
    and pc.subject_id = p_subject_id
    and pc.deleted_at is null
  on conflict (id) do nothing;
end $$;

revoke execute on function pull_credentials_into_book(uuid, cert_subject_type, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- A CWI signs a weld. An NDT technician signs a report.
--
-- These are the facts that put a person on a book, and they are facts
-- the book already records, so nobody maintains a roster that goes
-- stale. AFTER rather than BEFORE: the row has to exist before a
-- certificate can reference its book.
-- ---------------------------------------------------------------------
create or replace function weld_pulls_cwi_credentials() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.cwi_id is not null then
    perform pull_credentials_into_book(new.job_book_id, 'cwi', new.cwi_id);
  end if;
  return null;
end $$;

drop trigger if exists weld_pulls_cwi_credentials on weld;
create trigger weld_pulls_cwi_credentials
  after insert or update of cwi_id on weld
  for each row execute function weld_pulls_cwi_credentials();

revoke execute on function weld_pulls_cwi_credentials() from public, anon, authenticated;

create or replace function nde_pulls_technician_credentials() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.technician_id is not null then
    perform pull_credentials_into_book(new.job_book_id, 'ndt_technician', new.technician_id);
  end if;
  return null;
end $$;

drop trigger if exists nde_pulls_technician_credentials on nde_report;
create trigger nde_pulls_technician_credentials
  after insert or update of technician_id on nde_report
  for each row execute function nde_pulls_technician_credentials();

revoke execute on function nde_pulls_technician_credentials()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- A card arriving for somebody who has been working for a month.
--
-- Finds every book they already signed something on and pulls it in,
-- which is the half that stops this being a feature you have to
-- remember to use in the right order.
-- ---------------------------------------------------------------------
create or replace function backfill_books_for_credential() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_book uuid;
begin
  if new.subject_type = 'cwi' then
    for v_book in
      select distinct w.job_book_id from weld w
       where w.cwi_id = new.subject_id and w.deleted_at is null
    loop
      perform pull_credentials_into_book(v_book, 'cwi', new.subject_id);
    end loop;
  else
    for v_book in
      select distinct r.job_book_id from nde_report r
       where r.technician_id = new.subject_id and r.deleted_at is null
    loop
      perform pull_credentials_into_book(v_book, 'ndt_technician', new.subject_id);
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists credential_backfills_books on personnel_credential;
create trigger credential_backfills_books
  after insert on personnel_credential
  for each row execute function backfill_books_for_credential();

revoke execute on function backfill_books_for_credential()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- A card withdrawn must not leave books claiming it is on file.
--
-- Soft delete, matching the library itself: §15 retention outlives the
-- correction, and a register entry that vanished without trace is worse
-- than one marked withdrawn. Only the pulled entries are touched; a
-- certificate somebody filed by hand is theirs.
-- ---------------------------------------------------------------------
create or replace function withdraw_pulled_credentials() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update certificate
       set deleted_at = new.deleted_at
     where credential_library_id = new.id
       and deleted_at is null;
  end if;
  return null;
end $$;

drop trigger if exists credential_withdrawal_unfiles on personnel_credential;
create trigger credential_withdrawal_unfiles
  after update of deleted_at on personnel_credential
  for each row execute function withdraw_pulled_credentials();

revoke execute on function withdraw_pulled_credentials()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Who may see a card.
--
-- Fortress staff: the whole library, because the point of it is to find
-- a card before knowing which job wants it.
--
-- An operator or an inspector: only a card pulled onto a book they can
-- already read. These are people's personal records and the library is
-- cross-client; the list of everybody Fortress has ever certified is
-- not something one client is entitled to browse.
-- ---------------------------------------------------------------------
alter table personnel_credential enable row level security;
alter table personnel_credential force row level security;

drop policy if exists personnel_credential_read on personnel_credential;
create policy personnel_credential_read on personnel_credential for select using (
  is_fortress_staff()
  or exists (
    select 1 from certificate c
     where c.credential_library_id = personnel_credential.id
       and c.deleted_at is null
       and c.job_book_id is not null
       and can_read_job_book(c.job_book_id)
  )
);

drop policy if exists personnel_credential_write on personnel_credential;
create policy personnel_credential_write on personnel_credential for all
  using (is_fortress_writer()) with check (is_fortress_writer());

-- The audit trigger, on the same terms as every other compliance table.
do $$
begin
  execute 'create trigger audit_personnel_credential after insert or update or delete '
       || 'on personnel_credential for each row execute function audit_trigger()';
exception when duplicate_object then null;
end $$;
