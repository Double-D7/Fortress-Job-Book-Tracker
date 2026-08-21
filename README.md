# Fortress Job Book Tracker

QA/QC turnover documentation tracking for oil & gas flowline and facility
construction. Answers the question a folder tree of PDFs cannot: *how
complete is this job book right now, and what exactly is wrong with it?*

Built against the `DP452 FLOWLINE JOB BOOK` turnover package (315 files,
~402 MB, 13 delivered sections) and the `Facility/Flow Line Job Book
Checklist` that governs it.

```bash
npm install
npm run dev          # http://localhost:3000 — runs on the DP452 reference book
npm test             # 173 tests, including the §11 acceptance criteria
npm run seed:verify     # DP452 figures against the source brief
npm run verify:greeley  # DP-318 figures against greeley-crescent-import.json
```

No database is needed to run or test: the app ships with two books as an
in-memory provider, and every screen runs the same scoring and flag code
the persistent provider will.

### The two books are not the same kind of thing

**DP452 is synthetic.** It is generated — `makeRng`, `fakeSha`, no
filesystem access at all — to reproduce the figures quoted in the original
build brief: 2,476 weld credits, 631 X-rays, 616 torque connections, 315
files. It is an excellent *fixture*, because it exercises every rule with
known-correct answers, and it is the basis of the acceptance tests. It is
not evidence that ingestion works, because nothing was ingested.

**DP-318 Greeley Crescent is real.** It reads an actual workbook off disk
and reports what is genuinely there. That is why it looks worse: a
generated book is complete by construction, and a real one is only as
complete as what has been read into it.

Anyone comparing the two should read DP452's 80.6% as "the engine computes
correctly" and DP-318's 14.4% as "ingestion is the unfinished half of this
project".

---

## What it does

The DP452 book **is not complete**, and the application says so without a
human opening a folder. Against its own governing checklist it scores
**80.6%**, and drilling in names the reasons:

| Finding | How it is surfaced |
|---|---|
| Sections 16, 17 and 18 entirely absent | Overview lists them as missing; those 14 weight points cap the book at 86% before any record-level gap |
| Wrench `1304` calibrated `2025-07-10` against December 2024 work | Critical flag, and the wrench roster table reads *"calibration postdates 49 of its connections"* |
| `PT REPORT DP425` filed in a DP452 book | Critical flag, twice — once from the report's own facility/pad, once from the filename |
| 278 torque connections dated after the log's as-of date | Critical flag, grouped as one decision rather than 278 |
| Wrench `0284` on 2 connections, on no roster and no certificate | Warning, with `0289` offered as the likely transcription — *suggested, never auto-corrected* |
| Certificates on file for wrenches `0934` and `4206`, never used | Info; roster (9), usage (11) and certificates (12) reconciled as three different sets |
| All 616 connections recording actual torque exactly equal to required | Warning — no single row is wrong, the *pattern* is the finding |
| 17 heat numbers referenced by welds with no MTR | Critical, with the weld count behind each |
| MTRs on file that no weld references | Info — the other half of the reconciliation an auditor spot-checks |
| Three unexpanded ZIP bundles (100 MB) | Info: contents invisible to indexing, hashing and every reconciliation report here |
| Duplicate files by SHA-256 | Warning, marked in the document library where they sit |
| Four spellings of one welder's name | Never arises — welders are keyed by initials + qualification record, with the misspellings as aliases |

Run `npm run seed:verify` to see all of it against the source figures.

---

## Book types

**Flowline** (DP452) and **facility** (Greeley Crescent DP-318) share one
schema and one scoring engine. A facility book differs in five ways, each
of them data rather than a branch in code:

- sections 19–22 are active, where a flowline book delivers them as one
  combined map section; section 23 · Coating Inspection is **optional and
  off-checklist** — scored when a job enables it, out of the denominator
  when it does not
- work is organised by **construction area and equipment tag**, not by line
- welds carry **one welder stamp**, not four pass assignments
- required torque is a **range** (`130-260`), so "in spec" is a containment
  test rather than a percentage tolerance
- inspection obligation is **derived per weld from pipe engineering**
  rather than set as a flat job-wide percentage

### The inspection tier

```
od, wall        ← NPS lookup on (size, schedule)
hoop_stress     = design_pressure × od / (2 × wall)      -- Barlow, OD basis
pct_smys        = hoop_stress / SMYS[grade]
tier            ← the rule table band containing pct_smys
```

The tier thresholds live in `inspection_tier_rule`, a table, **not in an
`if` statement** — the 20% SMYS break point is inferred from the DP-318
weld log rather than quoted from a code clause, and `is_confirmed` is
false until QA/QC sign off. Moving it to 30% for a different operator is a
row edit and a recomputation, not a deploy.

Derived values are never stored. Hoop stress, % SMYS and the tier are
recomputed from the inputs on every read, so changing a design pressure or
a threshold cannot leave a stale obligation behind in a column.

## Starting a new job book

`/books/new` — a four-step setup that scaffolds all 22 checklist sections at
once, with facility-only sections auto-marked N/A and the reason recorded.

1. **Job identity** — the header block the Noble weld log repeats on every
   line sheet: facility, drill pad, wells, operator PIC, welding company,
   CWIs, pipe size/schedule/grade.
2. **Dates and thresholds** — construction window, target turnover, and the
   operator's compliance minimums (X-ray %, torque inspection %, torque
   tolerance, cert expiry warning). Also the split-pass X-ray credit rule,
   which changes every per-welder percentage in the book.
3. **Scope** — how many joints, flanged connections, heat numbers, welders,
   wrenches, NDE reports, pressure tests and CP points this job is expected
   to produce, taken off the drawing set. Optionally the weld lines with
   joints per line, which also scaffolds the line sheets.
4. **Review** — then create.

### Why step 3 is the one that matters

Every percentage in this application is a fraction, and the denominator has
to come from somewhere. Score against the rows entered so far and a book
lies to you early: **100 joints typed out of a real 2,342, every one of them
complete, reads as 100%.** The section looks finished when the job has
barely started.

Declaring the scope up front makes the same section read 4.3%, and the
overview say *"100 of 2,342 expected joints entered · 100 complete"* — entry
progress and record completeness as two separate numbers, because mid-job
they answer different questions.

The declared quantity is a **floor, not a cap**. Enter more than scoped and
the denominator follows the real count upward, so a section can never exceed
100%, and a scope guessed low can never make a half-finished section look
finished. Per-line joint counts and the book-wide figure resolve the same
way — the larger wins, so scaffolding two of thirty lines cannot shrink the
denominator to those two.

Estimates are fine, everything stays editable, and a section left blank
falls back to scoring against whatever gets entered. A section scoped to
**0** is marked N/A with the reason recorded, rather than parked at 0%
forever.

A brand-new book reports **0%**, and every headline tile reads `—` rather
than a vacuous 100% — "0 of 0" is arithmetically complete and would be the
exact false reassurance this whole mechanism exists to remove.

## Architecture

```
src/lib/domain/     pure TypeScript — no I/O, no framework, fully testable
  checklist.ts        the 22 sections, verbatim; weights; template builder
  scoring.ts          weighted hybrid completion (§5)
  completeness.ts     record-level completeness (§5.2)
  welders.ts          X-ray percentage engine, continuity, name resolution
  torque.ts           inspection rate, wrench validity, roster reconciliation
  certificates.ts     valid-on-work-date logic
  reconcile.ts        heat/MTR, NDE, CP reconciliation reports
  flags.ts            the full compliance rule set (§6)
src/lib/import/     Noble weld and torque log parsers with per-row validation
src/lib/data/       provider interface; DP452 seed; server-side redaction
supabase/migrations/  schema, append-only audit, RLS, generated templates
```

Everything downstream of `domain/` is a consumer. The scoring engine does
not know what a database is, which is why the seed provider and the
Supabase provider produce identical numbers.

### Three decisions worth knowing about

**Weld credits are not joints.** The Noble template's per-welder columns
credit a split-pass joint to every welder on it, so the credited total
(2,476) exceeds the physical joint count (2,342) by 5.7%. Both are computed
and both are labelled; mixing them is how audit findings start.

**Certificate validity is evaluated against the work date, not today.** A
technician whose card expired last month is fine for reports written while
it was live; a report dated after expiry is a finding even after the card is
renewed. Both directions produce findings, and they are different findings.

**N/A leaves both sides of the division.** Marking a section N/A can never
raise or lower the score — only change what the score is about. Facility-only
sections are scaffolded into a flowline book and marked N/A with a recorded
reason rather than omitted, so an operator can see they were considered.

### Security

Enforced in the database, on the assumption that the API will be probed
directly. `src/test/security.test.ts` asserts the structure holds — most
usefully, that a table added later cannot skip it.

- **RLS `ENABLE` *and* `FORCE`** on every table. `FORCE` matters as much as
  `ENABLE`: without it the table owner — which is what a migration or a
  `SECURITY DEFINER` function runs as — bypasses every policy.
- **Append-only audit log**, protected twice: `REVOKE UPDATE, DELETE` from
  the API roles, and rules rewriting `UPDATE`/`DELETE` to no-ops so a role
  that somehow held the privilege still cannot rewrite history.
- **Two-person section approval** in `approve_section()` *and* as a table
  constraint, so it holds for any caller rather than only for the UI.
- **Server-side redaction.** Internal notes and unapproved documents are
  projected out by `client_*_v` views and by `redactForViewer()`, never
  hidden in the browser.
- **Signed, expiring document URLs**, with the audit row written *before*
  the URL is issued — "who was given access" is the question, not "who
  finished downloading".

---

## Status

**The honest summary:** the calculation engine is finished and verified.
The ingestion path is not. Every figure DP-318 cannot show is a file that
has not been read, not a rule that has not been written — and
`verify:greeley` demonstrates that by reaching 59.08% against the
reference's 59.1% once the missing figures are credited.

**Working end to end**

Schema, RLS and audit migrations · the complete domain engine · DP452 seed
reproducing every stated figure · both Excel importers with per-row
validation and round-trip verification · job book setup with declared
scope · facility book support with the SMYS inspection-tier engine · 14
screens on the dark theme · 173 tests.

**Scaffolded, not implemented** — these are UI and wiring, with no engine
behind them yet:

- **Auth.** `DEMO_VIEWER` in `lib/data/provider.ts` is a hardcoded QA/QC
  manager. `lib/supabase/server.ts` has the real `getViewer()` against
  `app_user`; the sign-in page is a shell and Entra ID is not configured.
- **The Supabase provider.** Migrations and the client are written; the
  `DataProvider` implementation that queries them is not, so
  `DATA_PROVIDER=supabase` has no effect yet.
- **Export.** The turnover screen renders the checklist exactly as it will
  export and computes every figure the completeness report needs; the PDF
  assembly and ZIP generation are not built.
- **Write paths.** Upload, approve, and flag resolution are inert controls.
  The rules behind them (two-person approval, required resolution note) are
  enforced in the database already. Job book *creation* is the exception —
  it works end to end, but against the in-memory provider, so a created book
  survives navigation and not a server restart. `create_job_book()` in
  migration 0005 is the persistent equivalent and scaffolds the sections in
  the same transaction as the book, so one cannot exist without the other.
- **Mobile field entry** and offline-tolerant drafts (§7) are not started.
  The screens are responsive but were not designed for one-handed entry.

**Assumption flagged for review.** The brief states a welder-credit total of
2,476, a per-welder breakdown, 955 joint rows in the Flow Lines workbook,
and a ~5.7% credit overstatement. Those four hold together only if the two
workbooks carry 2,342 joints between them, so the Gas Lift workbook is
modelled at 1,387 joints. If it is actually smaller, the credit total and
the 5.7% figure in the brief do not reconcile and the joint split needs
revisiting — the per-welder table, which is the audited number, is
unaffected either way. See the header of `src/lib/data/seed/dp452.ts`.

Welder names for `KR`, `VL`, `GQ`, `JM` and `SV` are placeholders; the brief
gives only their initials. Replace them from the WPQ records before this
book is shown to anyone.

## Deployment

Vercel, with Supabase for Postgres, Auth and Storage. Apply
`supabase/migrations/` in order. `0004_seed_templates.sql` is generated —
edit `src/lib/domain/checklist.ts` and run `npx tsx
scripts/gen-template-migration.ts`; a test fails if the two drift.
