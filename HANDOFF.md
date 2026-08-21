# Running this locally

This session runs in a cloud container that reaches your OneDrive through
a connector with three limits that do not exist on your own machine:

- it refuses `.xlsm` on MIME type, so the DP-318 weld log is unreadable
- it cannot list a folder recursively — one API call per folder, and the
  Greeley tree is four deep in places
- its search counts matches, not files, so it cannot even tell you how many
  documents a section holds

None of that is true of a local session. There, a macro-enabled workbook is
just a file and a folder tree is just a folder tree.

**The conversation does not move — this one stays where it is.** What moves
is the repository, which is already pushed, and the ingest step below,
which is one command.

---

## 1. Get the files genuinely on disk

OneDrive Files On-Demand leaves online-only placeholders that look like
files but are not. Before anything else:

- **Windows** — right-click `1. Greeley Crescent Job book` →
  **Always keep on this device**, and wait for the green tick
- **macOS** — right-click → **Download Now**

Skipping this is the most common way an ingest silently under-reads a book.

## 2. Set up the repo

```bash
git clone https://github.com/Double-D7/Fortress-Job-Book-Tracker.git
cd Fortress-Job-Book-Tracker
git checkout claude/fortress-job-book-tracker-qtzjr1
npm install
```

Needs Node 20 or newer (`node -v`).

## 3. Ingest the job book

```bash
npm run ingest -- "C:/Users/<you>/OneDrive - Gusher Oil Field Services/05 - Projects/Fortress Job Book Tracker/1. Greeley Crescent Job book"
```

Quote the path — it contains spaces. Use forward slashes on Windows too.

It walks the whole tree, finds the four workbooks by content rather than by
filename (they get renamed on every revision), parses them, and writes
fixtures to `fixtures/ingested/`. It never writes to the source folder.

You should see something like:

```
Walking … 
  703 files, 264 folders, 909 MB

Files by section
  §1        1 files       0.1 MB
  §12       2 files       0.8 MB
  §21     169 files      90.9 MB
  …

Weld log — sheet "Weld Log"
  1259 welds
  welder stamps: KT(378), MR(246), LC(176), …
  % SMYS: 1065 below threshold, 166 at or above, max 56.63%
  tier: 166 require NDE, 76 met, 90 short
```

If the weld log parses to **0 rows**, its column headers did not match the
importer's synonym list. The script writes the first thirty rows to
`fixtures/ingested/weld-log-headers.json` for exactly that case — send me
that file and I will extend the mapping.

## 4. Send the result back

```bash
git add fixtures/ingested
git commit -m "Ingest DP-318 from the source folder"
git push
```

Then either carry on in a local Claude Code session, or tell me it is
pushed and I will pick it up from here.

---

## Continuing the work locally instead

If you would rather keep going on your own machine:

```bash
npm install -g @anthropic-ai/claude-code
cd Fortress-Job-Book-Tracker
claude
```

Claude Code only reads what it has been given access to. To let it see the
job book folder as well as the repo, run `/add-dir` inside the session and
paste the job book path. The desktop app has the same command.

## What this does not fix

Ingesting the tree makes every section score on real evidence. It does not
settle whether the book *should* score what it then scores. DP-318's own
reference figures put a fully-loaded book at 59.1%, and this engine
independently reaches 59.08% — sections 16, 18 and 19 are genuinely empty
and sections 21 and 22 have real drawing gaps. If a finished book ought to
read higher than that, the disagreement is about scope rather than about
data, and it needs a QA/QC decision rather than another import.
