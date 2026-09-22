# Demo job books

Five job books at five stages of completion, for showing the application
end to end without touching a real one.

| Job | Type | Complete | Gate | Timeliness | The one thing it shows |
|---|---|---|---|---|---|
| DEMO-CW-14-2 Cottonwood 14-2 | flowline | 38% | G0 passed | 50% | A book just past Gate 0: procedures and certificates filed, almost no field records yet |
| DEMO-SD-B Sage Draw Pad B | flowline | 53% | G1 conditional | 84% | A Conditional Pass running against §7's ten-day clock |
| DEMO-MR-CTB Mesa Ridge CTB | facility | 70% | G2 passed | 92% | A torque wrench whose calibration lapses mid-job |
| DEMO-JF-CPF Juniper Flats | facility | 94% | G3 passed | 97% | Three welds with no welder stamp — §11.1 Critical |
| DEMO-AP-9-1 Antelope Point 9-1 | flowline | 100% | G4 passed | 95% | A finished book: every section complete, zero open Criticals |

## Running it

```
npm run seed:demo      # regenerate seed-demo.sql and delete-demo.sql
npm run verify:demo    # apply both to a throwaway Postgres and assert they hold
```

Then apply `seed-demo.sql` to the project — the Supabase SQL Editor, or
`psql "$DB_URL" -f supabase/demo/seed-demo.sql`. Every statement is
`on conflict do nothing`, so running it twice changes nothing.

## Removing it

```
psql "$DB_URL" -f supabase/demo/delete-demo.sql
```

Every demo id begins `d0d0d0d0-`, which no application-created row can
have — ids come from `gen_random_uuid()`. The delete is scoped to that
prefix and cannot reach a real book. The audit trail is deliberately left
alone: it is append-only, and the record that these books existed and were
removed is what an append-only trail is for.

## Why it is generated rather than written

The percentages are real. Each book is built as domain objects, run
through the same `scoreBook` the application runs, and the scores it
returns are what gets written to `computed_pct`. A hand-written
`computed_pct = 58` asserts a number nothing produced, and the first
person to open the section breakdown finds it disagrees with the evidence
underneath — which teaches them that the percentage on the dashboard is
decorative.

`verify:demo` closes the loop: it applies the seed to a real Postgres
carrying every migration, recomputes each book's weighted completion in
SQL from the stored per-section values, and prints it for comparison with
what the generator reported. They match.

## What the demo books do not have

Document rows exist so the document sections score, but no files were
uploaded to storage behind them — a download on a demo book will fail.
Everything else is real data the application computes against.
