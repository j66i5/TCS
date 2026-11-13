---
name: finish-milestone
description: Finish a TCS session or milestone slice - full checks, independent review, documents, pull request and the plain-language report to the owner. Use before ending any session that changed code or data.
---
# Finish a session / milestone slice

Do every step; report evidence (commands and their output), not claims.

1. **Checks**: `npm run check` (typecheck, lint, tests incl. determinism, golden replays, architecture guards,
   performance floor, data lint). All green.
2. **Golden replays**: if a golden hash changed, decide: bug (fix it) or intended change (record it in
   `docs/DECISIONS.md`, then `npm run golden:update`).
3. **Labs / batch**: run the sim labs relevant to the slice and, for behaviour changes, `npm run batch` (see the
   balance-report skill). Paste the tables.
4. **Visual changes**: `npm run screenshot` and LOOK at every image in `screenshots/` before calling it working.
   Say plainly what looks wrong or ugly.
5. **Independent review**: launch the `spec-reviewer` agent with the diff range and the milestone's acceptance
   criteria. Fix confirmed correctness gaps or architecture-rule breaks; list the rest in STATE.md.
6. **Documents**: update `docs/STATE.md` (handover), `docs/ROADMAP.md` (status), `docs/DECISIONS.md` (dated
   entries), `docs/HOW_IT_WORKS.md` (guided tour), `docs/ARCHITECTURE.md` (if interfaces changed), and
   `CLAUDE.md` gotchas, and the "current version" next to the play link in `README.md` (milestone name, date and time of the merge, in UTC).
7. **Ship**: commit in small commits, push the branch, open a pull request; once CI is green, merge so `main`
   deploys to GitHub Pages. Check the deploy job.
8. **Report to the owner** (plain language, no unexplained jargon):
   - "What was built and how it works"
   - evidence (commands, outputs, tables, screenshots)
   - what is weak or unfinished, bluntly
   - exactly what to open (URL) and what to try on the phone
   - the questions you need answered next (multiple choice)
