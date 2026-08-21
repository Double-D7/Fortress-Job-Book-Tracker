# Claude Code task — add Greeley Crescent DP-318

Paste the block below into Claude Code in your app repo. Put `greeley-crescent-import.json` in the repo root first, and make sure the job book folder is reachable from that machine.

---

Add a second job book to the app: **Greeley Crescent DP-318**, a Chevron facility book that is still in progress. DP452 is already loaded; this one must sit alongside it, not replace it.

`greeley-crescent-import.json` in the repo root holds the verified reference figures for this book — job header, section scores, weld and torque counts, welder roster, materials, isometrics, pressure tests, and the flags that should fire. Every number in it was computed directly from the source workbooks, so treat it as the correctness bar, not as the data source.

The source files live at:

```
<job book root>/1. Greeley Crescent Job book/
  12. Detailed Weld Log/DP-318 Weld Log UPDATED 6.16.xlsm
  14. Detailed Torque Log/DP-318 Detail Torque Log Revised.xlsx
  15. Material Test Reports/Heat Number Tracker.xlsx
  17. Pressure Testing Results with Recorder Calibration Certificates/Testing Times and Pressures.xlsx
```

Work in this order:

**1. Facility support.** This is the first facility book in the system, so check what the schema is missing before importing anything. A facility book differs from a flowline book in five ways:

- Sections 19–22 are active (flowline books supply them as one combined map section), and section 23 · Coating Inspection is an **optional, off-checklist** section — enabled for this job, excluded from the denominator when disabled.
- Work is organised by **construction area and equipment tag**, not by line. The 14 areas are listed in the JSON.
- Welds carry **one welder stamp**, not four pass assignments.
- Required torque is a **range** (`130-260`), not a single value. Store min/max; a point value sets both.
- The weld log is **`.xlsm`**, macro-enabled.

**2. The engineering calculation.** The facility weld log derives each weld's inspection requirement from pipe engineering rather than a flat job-wide percentage. Implement it as pure functions, server-side, recomputed whenever an input changes:

```
pipe_od_in, wall_thickness_in  ← lookup on (pipe_size_schedule) in the NPS reference table
                                  (37 rows on the workbook's 'NPS and Dimensions' sheet — import it)
hoop_stress_psi = design_pressure_psi * pipe_od_in / (2 * wall_thickness_in)      -- Barlow
smys_psi        = { 'Gr. B': 35000, 'X42': 42000, 'X52': 52000 }[pipe_grade]
pct_smys        = hoop_stress_psi / smys_psi
required_inspection_tier ← from pct_smys, at the 20% SMYS break point
```

Tiers are `Random Visual`, `100% Visual`, `100% Visual and 15% NDT`. **Put the tier thresholds in a configurable rule table, not in an `if` statement** — the 20% break point is inferred and still needs QA/QC confirmation.

Verify against the workbook to four decimal places, then confirm 1,065 welds fall below 20% SMYS and 166 at or above, maximum 56.63%.

**3. Import.** Read the four workbooks. The weld log's data is an Excel Table named `Table1` on the `Weld Log` sheet; the torque log's header is row 17. Imports must be **idempotent** — running twice adds nothing the second time — and must show a change preview before committing.

**4. Verify against the JSON.** Do not report the task complete until the app shows:

- 1,259 welds — Butt 1,074 / O-Let 174 / Socket 11
- 221 NDE examined (RT 194, PT 27) = 17.6%
- the ten welder stamps with the weld and NDE counts in the JSON, plus 3 welds with no stamp
- 718 torque connections, 716 complete, 211 with an inspection date
- 165 heats recorded, 161 with MTRs
- 244 distinct isometrics across both logs
- **overall completion of 59.1%**, using the section weights in the JSON

If your section weights differ from the JSON's, that is fine — say so and show me both numbers rather than bending one to match the other.

**5. Flags.** The JSON lists 15 flags that should fire on this book. The four critical ones matter most; check each actually raises. In particular, 289 connections were torqued with wrenches that have no calibration certificate — if that rule does not exist yet, add it.

Two things to tell me when you are done: which parts of the schema you had to change to support a facility book, and any figure where your import disagrees with the JSON.

---

## While you are in there — two things from the DP452 screen

**123 critical flags on a delivered book looks like over-firing.** Check whether a rule is raising one flag per record where it should aggregate. "90 welds below their required tier" is one finding an inspector can act on; ninety separate criticals is a list nobody reads. Aggregate by rule and show the count, keeping the per-record detail on drill-down.

**"508 days past target" means the target turnover date is wrong.** DP452 was delivered in early 2025, so it is almost certainly defaulting to the created-at date. Make `target_turnover_date` nullable and render "no target set" when it is empty — a delivered book should not read as overdue.
