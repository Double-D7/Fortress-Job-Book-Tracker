# Greeley Crescent DP-318 — source fixtures

## What is here

`torque-log.dump.txt` — `14. Detailed Torque Log/DP-318 Detail Torque Log
Revised.xlsx`, as a tab-separated cell dump from the Microsoft Graph
connector. Held as a fixture so the import is reproducible and testable
without a live OneDrive connection. `src/lib/import/cellDump.ts` parses it
back into rows and hands them to the same importer that SheetJS feeds when
a user uploads the file through the app.

## What is missing, and why

**`12. Detailed Weld Log/DP-318 Weld Log UPDATED 6.16.xlsm` could not be
read.** The Microsoft Graph connector rejects the macro-enabled MIME type
`application/vnd.ms-excel.sheet.macroenabled.12`:

```
VALIDATION_ERROR: MIME type '...macroenabled.12' is not allowed
```

Plain `.xlsx` is on its allow-list; `.xlsm` is not. This is a limitation of
the read-only OneDrive route, **not of the application** — `.xlsm` is an
OOXML package like any other and the app's own upload path reads it fine.

The only other copy in the book is `DP-318 Weld Log UPDATED.pdf`, which is
a single page holding the overview sheet. That page *was* read, and is the
source of the welder roster, the WPQ expiry dates and the per-welder weld
and NDE counts now in the seed. It does not contain the 1,259 detail rows.

### Consequences

Six sections cannot be scored, worth **63 of 100** weight points:

| § | Section | Needs |
|---|---|---|
| 10 | NDT Job Logs and Films | per-weld NDE tickets and results |
| 12 | Detailed Weld Log | the 1,259 weld rows |
| 15 | Material Test Reports | heat numbers referenced by welds |
| 17 | Pressure Testing Results | which welds each test pack covers |
| 21 | Isometric Weld and X-Ray Map | isometrics referenced by the weld log |
| 22 | Isometric Heat Number and Torque Map | the same |

The inspection-tier calculation is implemented and unit-tested, but cannot
be run against this book: it needs the per-weld pipe size, grade and design
pressure that live in those rows. The same applies to the workbook's
`NPS and Dimensions` sheet — `src/lib/domain/engineering.ts` currently
carries ASME B36.10M standard dimensions instead, and `loadNpsTable`
replaces them once the sheet is importable.

## The bigger gap: nothing walks the folder tree

The weld log is not the main reason DP-318 scored 14%. The book holds
roughly 700 files across 20 populated sections, and only 15 of them had
been loaded — the app had an upload dropzone and no bulk path at all.

`src/lib/import/folderTree.ts` is that path now. It matches folders to
sections by their leading number, because the titles on disk read
"Ultrasonic Testion", "Facilty Only", "Certifed Welding Inspector" and
"Non- Destructive" — a matcher built on titles drops four sections on
spelling alone.

### Unread is not the same as empty

The application used to report both as 0% with the words "section absent",
which for section 17 was simply false: it holds 41 MB of pressure test
packs, every pack opened carrying the Crystal nVision recorder calibration
certificate the section is named for, and several carrying the result
document too. A turnover report claiming that section is missing would send
a crew to redo work already finished.

`job_book_section.ingestion_status` now distinguishes three states, and the
overall percentage is labelled a lower bound while any weight is unread.

Verified from the tree (`folder-tree.txt`):

- sections **16, 18, 19** are genuinely empty — their folders exist and
  hold 0 bytes
- section **17 is NOT empty** — 22 test packs, 41 MB. Sampled packs:
  #1 and #2 hold gauge, recorder and PSV certificates; #8 adds the test
  workbook; #9 adds the result PDF as well. Consistent with 8 packs holding
  a result document and 13 holding certificates only
- section 17 holds 22 test packs: #1-#13, #19, #20, #21, #27 as folders and
  #14-#18 as unexpanded ZIPs; #22-#26 are absent entirely
- section 21 is organised into 15 construction-area folders, nesting again
  by isometric beneath that
- section 2 and section 11 are byte-identical in size, and section 4 and
  section 5 likewise — consistent with the reference's finding that one
  holds a copy of the weld log PDF and the other duplicates the WPS

## To unblock

Either is a few seconds of work and needs doing only once.

1. **Save a copy as `.xlsx`.** Open the weld log, File → Save As, choose
   *Excel Workbook (.xlsx)*, keep it in the same folder. Macros are dropped,
   which does not matter — the importer reads values, not code. This is the
   cleaner option: it leaves a permanently readable copy in the book.

2. **Upload it through the app.** The app's own importer handles `.xlsm`
   directly, so dragging the original file into section 12 works today. It
   just cannot be reached from this session.

Once either is done, `npm run verify:greeley` reports every remaining
figure against `greeley-crescent-import.json`.
