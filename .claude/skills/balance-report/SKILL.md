---
name: balance-report
description: Run a batch of headless battles over many seeds and summarise outcomes (win rates, casualties, ammunition, duration) for tuning or to catch behaviour regressions in TCS.
---
# Balance report

1. Pick the scenario (`npm run headless -- --scenario <name>` lists the description; scenarios live in
   `packages/tools/src/scenarios.ts`).
2. Run: `npm run batch -- --scenario <name> --runs 200 --seconds <game seconds>`.
   The report is written to `reports/batch-<name>-<timestamp>.md` and `.json` (reports are not committed).
3. To compare before/after a change: run the same seeds (`--seed <first>`) on both versions and compare
   the summary lines. Changes in behaviour should be explained by the change you made.
4. Paste the summary table into the session report. Call out anything implausible (for example attackers
   in the open beating a prepared defence most of the time - SPEC M4 acceptance).
5. Until M2/M4 there is no combat: casualty and win statistics are zero by construction.
