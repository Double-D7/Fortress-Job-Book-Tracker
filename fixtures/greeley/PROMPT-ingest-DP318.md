# Ingestion Prompt — Greeley Crescent DP-318

**Paste this into Claude Code in the Job Book Tracker repo.**
Everything below was read directly out of the DP-318 source files — column names, formulas, cell addresses, vocabularies, and counts are transcribed, not inferred. Where something is an assumption, it says so.

---

## 0. What you are doing

Load the complete **Greeley Crescent DP-318** job book into the application alongside the existing DP452 book. DP-318 is a **Chevron facility book, still in progress** — this is the first facility book in the system, so part of this task is extending the schema to support facility work before any data lands.

DP-318 is 1,109 files and 830 MB across 23 numbered sections plus one unnumbered Hydro Test folder. Four spreadsheets carry the measurable data; everything else is documents.

Do not report this complete until every figure in §9 reproduces.

---

## 1. Source files

Root: `<job book root>/1. Greeley Crescent Job book/`

| Purpose | Path |
|---|---|
| **Weld log** | `12. Detailed Weld Log/DP-318 Weld Log UPDATED 6.16.xlsm` |
| **Torque log** | `14. Detailed Torque Log/DP-318 Detail Torque Log Revised.xlsx` |
| **Heat register** | `15. Material Test Reports/Heat Number Tracker.xlsx` |
| **Pressure test hold data** | `17. Pressure Testing Results.../Testing Times and Pressures.xlsx` |
| **Governing checklist** | `1. Job Book Checklist/JOB BOOK CHECK LIST.pdf` |

Three weld-log versions and three torque-log versions exist in those folders. Use the ones named above — `UPDATED 6.16` and `Revised` — and register the others as superseded rather than ignoring them.

---

## 2. Schema work required first

This is the first facility book. Confirm each of these exists before importing; add what is missing.

1. **Sections 19–22 active.** Flowline books supply them as one combined map section; facility books use all four separately.
2. **Section 23 · Coating Inspection** as an **optional, off-checklist section** — enabled for this job, excluded from the scoring denominator when disabled for another. It is not on the operator's checklist.
3. **Work units as construction areas and equipment tags**, nested, replacing lines. Facility books organise spatially, not by line.
4. **One welder stamp per weld.** The flowline model has four pass assignments (Root/Hot/Fill/Cap); facility populates one. Keep the 1..n model and write a single assignment.
5. **Required torque as a range** — `min` / `max`. The facility log stores `130-260`; the flowline log stores `150`. A point value sets both.
6. **`.xlsm` support** in the weld log importer.
7. **An isometric drawing entity** with a two-stage markup sign-off (see §6).
8. **Pressure test and hydro test package entities** (see §7).

---

## 3. Weld log — `DP-318 Weld Log UPDATED 6.16.xlsm`

Six sheets: `Project Overview` · `Weld Log` · `Data Validation` · `NPS and Dimensions` · `Project Total Pivot Tables` · `Inspection Reqmt's Pivot Tables`.

### 3.1 Job header — `Project Overview`

Read these exact cells:

| Cell | Field | Value in this book |
|---|---|---|
| `M2` | Location Name | `DP-318` |
| `U2` | Date | `2025-09-01` |
| `M3` | Project Type | `FACILITY` (vocabulary also allows `Pre-Fab`) |
| `U3` | Operator PIC — labelled `Noble Energy PIC:` | `SCOTT GREEN` |
| `M4` | Welding Company QA/QC Representative | `ANTONIO BRITO` |
| `U4` | Welding Company | `FORTRESS` |
| `G7` | **Stated job inspection requirement** | `Project Totals- Requirement- 100% visual & 10% NDE` |

`G7` matters — see §5.

### 3.2 Welder roster — `Project Overview` rows 9–18

Columns: `B` Welder Name · `C` Welder Stamp · `D` Date WPQ Expires · `E` WPQ Submitted?
(`G`–`K` are calculated: # of Welds, Visual %, NDT %, Failed Visuals, Failed NDT — recompute these, do not import them.)

| Name | Stamp | WPQ expires |
|---|---|---|
| TYLER WALKER | TW3 | 2026-11-07 |
| JOSE PAREDES | JAP | 2026-09-24 |
| MITCH HOFFMEN | MH | 2026-03-14 |
| JOSHUA PEARMAN | JP | 2026-10-22 |
| EVAN CLAVER | EC | 2026-07-15 |
| LEONEL CARBAJAL | LC | 2026-02-07 |
| MIGUEL RODRIGUEZ | MR | 2026-07-09 |
| KEITH TAYLOR | KT | 2025-12-30 |
| MIGUEL RODRIGUEZ LEO C | MR LC | *(none — combined stamp)* |
| ALEX GUZMAN | AG | 2026-10-15 |

`MR LC` is two welders sharing one stamp. Model it as a combined assignment resolving to both people, not as an eleventh welder. `MITCH HOFFMEN` here is spelled `Mitch Hoffman` on his qualification file — resolve to one managed welder record.

### 3.3 CWI and NDT roster — `Project Overview` N11:U18

Columns: `N` Name · `R` Qualification Level · `U` Documentation Submitted?

`Alex Emig` (CWI) · `Kole Kid` (CWI) · `Blertint Mulliqi` (NDT) · `Brendan LeCompte` (NDT) · `Daivd Castenada` (NDT) · `Jose Flores` (NDT)

Three of these are misspelled against their credential files — `Kole Kid` is **Wallace K. Kidd**, `Blertint` is **Blerint**, `Daivd` is **David**. Resolve to managed personnel records; keep the source spelling in the import mapping only.

### 3.4 Weld rows — `Weld Log`

An Excel Table named **`Table1`**, range **`B3:U1322`**, header on **row 3**. Read the table by name, not by fixed range — it will grow.

Columns in order:

```
Weld Number · Weld Date · Welder Stamp · Isometric Number · Pipe Size/SCH ·
Pipe Grade · Design Pressure (psi) · Test # · Weld Type · CWI Initials ·
CWI Pass/Fail · NDT Ticket # · NDT Method · NDT Pass/Fail · Comments ·
Column1 · Pipe OD (in) · Wall Thickness (in) · Hoop Stress (psi) · % of SMYS
```

`Column1` is an unnamed artefact — ignore it. The final four are **calculated** — recompute them (§5), do not trust the cached values.

**1,259 weld rows.**

### 3.5 Controlled vocabularies — `Data Validation`

Seed these as reference tables. Cell addresses given so you can re-read them if the sheet changes.

| Field | Cells | Values |
|---|---|---|
| Weld Type | `D5:D9` | `Butt` · `O-Let` · `Socket` · `Seal` · `Fillet` |
| Pass/Fail | `F5:F6` | `Pass` · `Fail` |
| Pipe Grade | `H5:H7` | `Gr. B` · `X42` · `X52` |
| Inspection Requirement | `J5:J7` | `Random Visual` · `100% Visual` · `100% Visual and 15% NDT` |
| Pipe Size/SCH | `L5:L41` | 37 values — seed from `NPS and Dimensions`, below |

Only `Butt`, `O-Let`, and `Socket` appear in this job. `Seal` and `Fillet` are valid and must be seeded.

### 3.6 Pipe dimension reference — `NPS and Dimensions`

Range `B4:F40`, **37 rows**, columns: `Pipe Size/SCH` · `OD (in)` · `ID (in)` · `Nominal Wall Thickness` · `NPS`. Seed as a reference table — the engineering calculation depends on it.

```
1/2" - SCH 80. XS      0.84    0.546   0.147   0.5
1/2" - SCH. 160        0.84    0.466   0.187   0.5
1/2" - XX-STG.         0.84    0.252   0.294   0.5
3/4" - SCH 80. XS      1.05    0.742   0.154   0.75
3/4" - SCH. 160        1.05    0.614   0.218   0.75
3/4" - XX-STG.         1.05    0.434   0.308   0.75
1" - SCH 80. XS        1.315   0.957   0.179   1
1" - SCH. 160          1.315   0.815   0.25    1
1" - XX-STG.           1.315   0.599   0.358   1
1-1/2" - SCH 80. XS    1.9     1.5     0.2     1.5
1-1/2" - SCH. 160      1.9     1.338   0.281   1.5
1-1/2" - XX-STG.       1.9     1.1     0.4     1.5
2" - SCH. 40, STD      2.375   2.067   0.154   2
2" - SCH 80. XS        2.375   1.939   0.218   2
2" - SCH. 160          2.375   1.689   0.343   2
2" - XX-STG.           2.375   1.503   0.436   2
3" - SCH 40,STD        3.5     3.068   0.216   3
3" - SCH 80. XS        3.5     2.9     0.3     3
3" - SCH. 160          3.5     2.624   0.438   3
3" - XX-STG.           3.5     2.3     0.6     3
4" - SCH 40,STD        4.5     4.026   0.237   4
4" - SCH 80. XS        4.5     3.826   0.337   4
4" - SCH. 160          4.5     3.438   0.531   4
4" - XX-STG.           4.5     3.152   0.674   4
6" - SCH 40,STD        6.625   6.065   0.28    6
6" - SCH 80. XS        6.625   5.761   0.432   6
6" - SCH. 160          6.625   5.189   0.718   6
6" - XX-STG.           6.625   4.897   0.864   6
8" - SCH 40,STD        8.625   7.981   0.322   8
8" - SCH. 60           8.625   7.813   0.406   8
8" - SCH 80. XS        8.625   7.625   0.5     8
8" - SCH. 160          8.625   6.813   0.906   8
8" - XX-STG.           8.625   6.875   0.875   8
10" - SCH 40,STD       10.75   10.02   0.365   10
10" - SCH 60, XS       10.75   9.75    0.5     10
10" - SCH. 80          10.75   9.564   0.593   10
10" - SCH. 160         10.75   8.5     1.125   10
```

Note the label inconsistency between the two sheets: the dimension table says `2" - SCH. 40, STD` while the validation list says `2" - SCH.40, STD`. **Match on a normalized key** (strip spaces and punctuation), or ~28 welds will fail to resolve a wall thickness.

---

## 4. Torque log — `DP-318 Detail Torque Log Revised.xlsx`

Sheet `Torque Log`. Header block at top, wrench roster rows 6–13, **column header on row 17**, data from row 18.

### 4.1 Header

`Date: 2025-09-01` · `Location Name: DP-318` · `CHVERON PIC: SCOTT GREEN` *(sic)* · `Construction Company: FORTRESS DS`

Summary cells: `Total Flanges 718` · `# of Flanges Inspected 205` · `Inspection Percentage 0.28551…`

**Do not import those summary cells.** Recompute from rows — they disagree with the data (§8).

### 4.2 Wrench roster — rows 7–13

One free-text string per wrench, formatted `<serial> <short ID> (<capacity range>)`:

```
12511 5125 (30-250 LB)      last cal 2025-06-25   cert on file: Yes
12511 5155 (30-250 LB)      last cal 2025-05-02   cert on file: Yes
122360 O480 (100-600 LB)    last cal 2025-05-01   cert on file: Yes
10240 4463 (20-250 LB)      last cal 2025-06-25   cert on file: Yes
032460 0808 (200-1000 LB)   last cal 2025-02-04   cert on file: Yes
0224900 0218 (50-250 LB)    last cal 2024-12-04   cert on file: Yes
```

Parse into `serial`, `wrench_id`, `capacity_min_ft_lb`, `capacity_max_ft_lb`. Note `O480` is written with a letter O where the connection rows use `0480` — normalize.

The roster lists six wrenches. **The connection rows use ten.** Do not treat the roster as authoritative; build the wrench list from actual usage and flag roster gaps.

### 4.3 Connection rows — header row 17

```
ISO Flange # · ISO Number · Flange Pipe Size (in) · Bolt Diameter (in) · # of Bolts ·
Required Torque (ft-lbs) · Actual Torque (ft-lbs) · Wrench ID # · Torque Date ·
Employee Initials · Inspection Date · Inspector Initials
```

**718 connections.** `Required Torque` is a **range string** (`130-260`, `100-150`, `60-80`) — parse to min/max.

There is **no `CP TEST ON FLANGE` column** in the facility template, though the flowline template has one and cathodic protection is checklist item 18 for both. The app must supply that link.

Rows continue past the data as a pre-numbered empty template — stop at the last row with content.

---

## 5. The engineering calculation

Implement as pure functions in `lib/engineering/`, server-side, recomputed whenever an input changes. These are the workbook's own calculated-column formulas, verbatim:

```
Pipe OD (in)        = VLOOKUP([Pipe Size/SCH], 'NPS and Dimensions'!$B$4:$F$40, 2)
Wall Thickness (in) = VLOOKUP([Pipe Size/SCH], 'NPS and Dimensions'!$B$4:$F$40, 4)

Hoop Stress (psi)   = [Design Pressure (psi)] * [Pipe OD (in)] / (2 * [Wall Thickness (in)])

% of SMYS           = IF([Pipe Grade]="Gr. B", [Hoop Stress]/35000,
                      IF([Pipe Grade]="X42",  [Hoop Stress]/42000,
                      IF([Pipe Grade]="X52",  [Hoop Stress]/52000)))
```

Hoop stress is Barlow's formula. SMYS constants: **Gr. B 35,000 · X42 42,000 · X52 52,000 psi.** Match the workbook to four decimal places.

### The inspection requirement — read this carefully

An earlier reading of this book assumed `% of SMYS` drives a three-tier inspection requirement at a 20% break point. **The workbook does not support that.** Two facts:

- Cell `G7` states the job requirement plainly: **`100% visual & 10% NDE`** — a flat job-wide rule, same shape as a flowline book.
- The three-tier vocabulary (`Random Visual` / `100% Visual` / `100% Visual and 15% NDT`) exists on the `Data Validation` sheet but **no column in the weld log uses it**. It is seeded for jobs specified that way; this job is not one of them.

So implement **both**, and let the job decide:

```
job.inspection_rule = 'flat'    → required_visual_pct, required_nde_pct  (DP-318: 100 / 10)
job.inspection_rule = 'tiered'  → per-weld tier from pct_smys against a configurable threshold table
```

Default DP-318 to `flat` at 100% / 10%. Compute and store `pct_smys` regardless — it is real engineering data and belongs on the record whether or not it governs inspection. **Never hard-code the 20% threshold**; if the tiered rule is ever switched on, its break points come from a rule table the QA/QC managers own.

For reference, the SMYS distribution here is 1,065 welds below 20%, 166 at or above, maximum 56.63%. Two welds have no pipe grade so `pct_smys` is null — flag them rather than defaulting.

---

## 6. Isometric drawings — sections 21 and 22

The isometric number is the join key for the whole book. It appears in the weld log (`Isometric Number`), the torque log (`ISO Number`), and every drawing filename.

- Weld log references **133** distinct isometrics
- Torque log references **196**
- Union: **244**
- Section 21 drawings resolve to **131** distinct isometrics
- Section 22 drawings resolve to **87**

Parse the line number from filenames matching `SIZE-SERVICE-LINENO-SPEC[_options]_Rev N` — e.g. `4-CO-31050-ACM-1.5FP_ET_Rev 0`, `2-PF-2031101A-DCN`, `16-PG-80001-BCMB`. Service codes seen: `CO FG IA PF PG PO PW VG CD HL`. Specs: `ACM ACL BCM BCL DCN DCL`.

Some filenames carry a `FLG ` prefix, a `(THRD)` suffix, `- Copy`, `UPDATED`, doubled periods (`..pdf`), and one or two literal `✔︎` characters. Strip all of that to get the line number; keep the original filename.

### The checkmark convention → real fields

The folder and file names encode a two-stage sign-off. Convert it, do not preserve it:

- **Section 21** folders/files carry a single `✔︎` → `xray_markup_complete`
- **Section 22** carries `✔︎✔︎` → `heat_torque_markup_complete`
- A `Stamped` subfolder holds the final stamped drawing → `stamped`
- `COMPLETED` in an area folder name → area-level completion
- Trailing underscores (`✔︎_`, `✔︎✔︎_____`) carry no meaning found — treat as noise
- `Construction Area 7200 ✔︎MIKE` embeds a person's name — capture `MIKE` as the sign-off owner if a matching user exists, otherwise drop it and flag

Import the sign-offs as booleans with `by` and `at` unknown. Do not fabricate timestamps.

### Work units

Seed from the section 21/22 folder trees. Areas, with equipment tags nested beneath:

| Area | Equipment tags |
|---|---|
| 2100 | 1101A · 1101B · 1102A · 1102B · 1103A · 1103B |
| 2200 | V-2202 (has a `THRD` subfolder) · V-2203 |
| 2400 | — *(area marked `(THRD)`)* |
| 3100 | — |
| 3400 | C-3401 · C-3403 |
| 4100 | — |
| 7200 | C-6303 · C-6305 · V-7001 · Water Lact |
| 8000 | — |
| 8400 | — |
| 9070 | — |
| 9400 | — *(marked `(THRD)`)* |
| 9500 | — |
| 9600 | — |
| REDLINE | RED LINE HEATER T V-2202 |

`(THRD)` marks threaded rather than welded construction — store as a boolean field, not a name suffix.

---

## 7. Pressure and hydro tests

### 7.1 Hold data — `Testing Times and Pressures.xlsx`

Sheet `Sheet1`, range `C12:U59`. A grid of 7-row test blocks, four blocks across:

- Column groups start at **C, H, M, R** (label/value/elapsed/delta)
- Row groups start at **12, 20, 28, 36, 44**
- Column C holds tests 1–5, H holds 6–10, M holds 11–15, R holds 16–20
- A separate `IA Test` block sits at `C53`

Each block:

```
row +0   Test #n          | date
row +1   Time             | clock       | Temp | °F
row +2   Start            | clock       | elapsed
row +3   End              | clock       | elapsed | hold duration
row +5   Start PSI        | psi         |         | delta
row +6   End PSI          | psi
```

Store `test_date`, `ambient_temp_f`, `hold_start`, `hold_end`, `hold_duration_min`, `start_psi`, `end_psi`.

**Hold data exists for tests 1–13 and the IA test.** Tests 14–20 are present as zero-filled blocks — import them as *not run*, never as a 0 PSI test.

Derive result from pressure change over the hold, **with ambient temperature in view**. Seven of the thirteen tests recorded a pressure *gain* (Test 1: 1129 → 1156 over 11 min at 80 °F; Test 7: 2221 → 2244 at 73 °F). That is thermal expansion, not a fault. Do not flag a gain as a failure.

### 7.2 Test packages — section 17

21 test folders (`Test #1 B-Spec` … `Test #21 D-Spec`, plus `Test #27 A-Spec`), 5 unextracted ZIPs (`Test #14`–`#18`), plus `psv` and `IA Testing` folders. Spec classes: A, B, D.

Each folder holds some combination of a gauge certificate, a recorder certificate (`Crystal nVision 10kpsi - 506738.pdf`), a PSV certificate, and sometimes a result `.xlsx` or `.pdf`.

**Reference certificates, do not copy them.** The same recorder certificate is physically duplicated into 14 folders; the same gauge into 8. One certificate record, many test references. This removes a large share of the section's bulk and makes expiry tracking possible.

Expand the five ZIPs and index their contents. They are the only record of tests 14–18.

### 7.3 Hydro test packages — `DP-318 Hydro Test`

21 packages (384 files), each with ISOs, a weld log, and an `MTRS` subfolder. **The MTRs inside duplicate section 15.** Model the package as *referencing* `material_heat` records, never owning copies — otherwise MTR coverage is computed against an inflated denominator.

Known gaps: Hydro Test 17 has no weld log; Tests 2, 7, and 8 have no MTRs; Test 11's folder is named `MTR` not `MTRS`; root files alternate between `TEST n ISOS.pdf` and `Hydro Test n ISOS.pdf`.

---

## 8. Materials and documents

### 8.1 Heat register — `Heat Number Tracker.xlsx`

Sheet `Sheet1`. Columns: `Number` · `Heat Number` · `NPS` · `Description` · `FOUND MTRS`.

**165 heats entered**, of which **161** are marked `FOUND`. The sheet is a pre-numbered template running to slot 560, so 395 slots are empty — import only rows with a heat number, and record the template size as context, not as a denominator.

`FOUND MTRS` is a hand-maintained flag. Import it once to seed status, then **generate it** from actual MTR attachments and retire the column.

The facility weld log has **no heat number column**, so there is no way to reconcile this register against welds. Record that as a known limitation on the section rather than reporting 97.6% coverage as if it were verified.

### 8.2 Document import

File counts per section, for verification after import:

```
 1 Job Book Checklist                 1     13 Torque Wrench Cal Certs        6
 2 Facility Overview                  1     14 Detailed Torque Log            3
 3 Chevron Piping Specification       1     15 Material Test Reports        337
 4 Welding Procedure Specification    1     16 Pressure Testing Procedure     0
 5 Welding Procedure Qual Record      1     17 Pressure Testing Results      64
 6 Welder Performance Quals          14     18 Cathodic Protection            0
 7 CWI Credentials                    2     19 Ultrasonic Testing             0
 8 NDT Technician Credentials         5     20 As-Built P&IDs                 1
 9 NDT Procedures                     3     21 ISO Weld and X-Ray Map       154
10 NDT Job Logs and Films            12     22 ISO Heat Number/Torque Map   100
11 Weld Log Overview Sheet            1     23 Coating Inspection             2
                                            -- DP-318 Hydro Test            384
```

Handling rules:

- **Exclude** `desktop.ini` (12 of them) and `~$*` Word lock files from counts and from the library entirely. Section 1's only "document" is a 162-byte orphaned lock file — the cover page template is genuinely absent.
- **Hash everything** (SHA-256) and flag duplicates. Section 2's file is byte-identical to section 11's; section 5's matches section 4's.
- **Normalize filenames** on import, preserving originals. Section 13's certificates are named as bare serial numbers (`0808.jpg`, `1583.jpg`, `Wrench 5125.jpeg`) with no wrench ID or date in the name.
- **Register the superseded versions** of the weld and torque logs rather than dropping them.
- Section titles contain typos — `Certifed` (7), `Testion` / `Facilty` (19), `Non- Destructive` (10). Map source folder → canonical section number; display corrected titles.

---

## 9. Acceptance criteria

Do not report complete until all of these reproduce. Import twice and confirm the second run creates nothing.

**Welds**
- 1,259 rows · Butt 1,074 · O-Let 174 · Socket 11
- Grade: `Gr. B` 1,257, missing 2
- NDE: 221 examined (RT 194, PT 27) = 17.6%; all 221 carry an NDT ticket and a result
- CWI: 1,259 `Pass`, 0 `Fail`
- Welder stamps — KT 378 / MR 246 / LC 176 / MH 159 / TW3 128 / JAP 83 / JP 41 / MR LC 27 / EC 17 / AG 1, plus **3 rows with no stamp**
- NDE by stamp — KT 69 / MR 38 / MH 33 / LC 32 / TW3 24 / JAP 12 / JP 6 / MR LC 3 / EC 3 / AG 1
- 133 distinct isometric numbers; `Test #` values 0–14, 16–21, 27
- Recomputed `% of SMYS`: 1,065 below 20%, 166 at or above, max 56.63%, 2 null
- Against the stated 100% visual / 10% NDE rule: **every welder passes** (lowest is MR LC at 11.1%)
- Field-complete welds: **1,226 of 1,259**

**Torque**
- 718 connections, 716 field-complete, 2 missing an actual torque value
- **211 rows carry an inspection date** — the sheet's own summary cell says 205. Report both and flag the discrepancy; do not silently pick one.
- 10 distinct wrench IDs in use: 5155 (287) · 5125 (85) · 0480 (74) · 0218 (63) · 4463 (59) · 0216 (45) · 0808 (39) · 0719 (28) · 5123 (20) · 9125 (18)
- 6 certificates on file: 0808, 1583, 3282, 5155, 9125, 5125
- **289 connections used a wrench with no certificate** (0216, 0218, 0480, 0719, 4463, 5123)
- 196 distinct isometric numbers

**Materials** — 165 heats imported, 161 with MTRs, 395 empty template slots skipped

**Isometrics** — 244 distinct across both logs; section 21 resolves 131, section 22 resolves 87

**Pressure tests** — hold data for tests 1–13 plus IA; tests 14–20 imported as not-run; 8 of 22 referenced tests have a result document

**Score** — overall completion **60.1%** using the facility section weights, with section 12 at 97.4%, section 21 at 53.7%, section 22 at 35.7%, sections 16/18/19 at 0%.

If your weights or completeness definitions differ, **show me both numbers and explain the difference** rather than adjusting one to match.

---

## 10. Flags that must fire

**Critical**
1. 289 torque connections used a wrench with no calibration certificate on file
2. Sections 16, 18, 19 are empty — three checklist items with no documents
3. 3 welds have no welder stamp; 2 have no pipe grade, so `% of SMYS` and inspection requirement are undefined
4. 4 wrenches in use (0216, 0719, 5123, 9125) appear on no roster row

**Warning**
5. Section 20 holds an IFR (Issued For Review) drawing in an As-Built section
6. Section 5 PQR is byte-identical to the Section 4 WPS
7. Section 22 covers 44 fewer isometrics than Section 21
8. 13 of 21 populated pressure test folders hold certificates but no result document
9. Section 2 contains a copy of the weld log rather than a facility overview
10. Keith Taylor's WPQ expires 2025-12-30 and the job runs into 2026 — no welds recorded after expiry yet
11. Five pressure tests (14–18) exist only as unextracted ZIP archives
12. Section 1's cover page template exists only as an orphaned Word lock file

**Info**
13. All 1,259 CWI visual inspections recorded `Pass` — a zero-defect rate worth confirming
14. Torque log summary cell (205) disagrees with its own rows (211)
15. Weld log references tests 0–14, 16–21, 27; the folder tree holds 1–21, 27 — they disagree about test 15
16. Heat register denominator unverifiable — the facility weld log has no heat number column
17. Certificates on file for wrenches 1583 and 3282, which appear on no connection

---

## 11. Report back

When you finish, tell me:

1. **What schema changes you made** to support facility books.
2. **Every figure where your import disagrees** with §9, and why.
3. **Anything in the source files that contradicts this prompt** — I read these files carefully, but the books change and the prompt does not.
4. **What you had to guess.** Anything you inferred rather than read should be a configurable value with a note, not a hard-coded assumption.
