-- ---------------------------------------------------------------------
-- `job_book_section.computed_pct` is a cache, and it was lying.
--
-- The completion percentage is derived: a pure function of the records,
-- the declared scope and the section weights. The Fortress-facing screens
-- run that function on every request, so they were always right. The
-- stored column, however, is what `client_section_v` returns — and nothing
-- ever wrote it. Every row sat at the 0.00 default.
--
-- That is a two-audience divergence: staff opened a book at 90% while the
-- operator's own view of the same data reported 0%. For a turnover tool
-- that is worse than showing no figure at all, because both parties
-- believe they are reading the record.
--
-- The fix is not to compute the score in SQL — the engine is a tested
-- TypeScript module and having a second implementation in plpgsql would
-- guarantee the two drift. It is to make the cache honest: stamp it when
-- it is written, and never serve a number that cannot say how old it is.
-- ---------------------------------------------------------------------

alter table job_book_section
  add column computed_at timestamptz;

comment on column job_book_section.computed_pct is
  'Cache of the derived completion score. Authoritative source is the '
  'scoring engine; this column exists for readers that do not run it, '
  'chiefly client_section_v. Always written together with computed_at.';

comment on column job_book_section.computed_at is
  'When computed_pct was last written. Null means never computed, which '
  'readers must render as "not yet scored" rather than as 0%.';

-- A percentage with no timestamp is indistinguishable from a current one,
-- so the two move together or not at all.
alter table job_book_section
  add constraint computed_pct_is_stamped
  check ((computed_pct = 0 and computed_at is null) or computed_at is not null);

-- Writing the score is the only thing that may stamp it. A hand-edited
-- percentage with a fresh timestamp would be indistinguishable from a
-- computed one, so the timestamp is set here rather than by the caller.
create or replace function set_section_score(
  p_section_id uuid,
  p_pct        numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pct < 0 or p_pct > 100 then
    raise exception 'computed_pct must be between 0 and 100, got %', p_pct;
  end if;
  update job_book_section
     set computed_pct = round(p_pct, 2),
         computed_at  = now()
   where id = p_section_id
     and can_write_job_book(job_book_id);
  if not found then
    raise exception 'section % not found or not writable', p_section_id;
  end if;
end;
$$;

revoke all on function set_section_score(uuid, numeric) from public;
grant execute on function set_section_score(uuid, numeric) to authenticated;

-- The client view carries the timestamp too. An operator reading a
-- percentage is entitled to know when it was last worked out.
drop view if exists client_section_v;
create view client_section_v with (security_invoker = true) as
  select id, job_book_id, section_definition_id, status, na_reason,
         approved_at, computed_pct, computed_at
    from job_book_section;

comment on view client_section_v is
  'Client/inspector projection of job_book_section: internal notes and the
   reviewer identities are absent by construction. computed_pct is a cache
   and ships with computed_at so its age is visible.';

grant select on client_section_v to authenticated;
