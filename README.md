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
npm test             # 91 tests, including the §11 acceptance criteria
npm run seed:verify  # prints the seed's figures against the source brief
```

No database is needed to run or test: the app ships with the DP452
reference book as an in-memory provider, and every screen runs the same
scoring and flag code the persistent provider will.

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

**Working end to end**

Schema, RLS and audit migrations · the complete domain engine · DP452 seed
reproducing every stated figure · both Excel importers with per-row
validation and round-trip verification · 13 screens on the dark theme · 91
tests.

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
  enforced in the database already.
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
