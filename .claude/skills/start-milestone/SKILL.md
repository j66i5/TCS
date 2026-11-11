---
name: start-milestone
description: Start a work session or a new milestone slice on TCS. Use at the beginning of every session, or when the owner says "continue" / asks for the next slice.
---
# Start a session / milestone slice

1. Read `CLAUDE.md`, `docs/STATE.md`, and the current milestone in `docs/ROADMAP.md`. Skim `docs/DECISIONS.md` for recent entries.
2. Run `npm ci` if `node_modules` is missing, then `npm run check` to confirm the baseline is green. If it is red, fixing that is the first task.
3. Propose ONE slice that fits a single session:
   - what will be built (in plain language),
   - its acceptance checks (tests, lab tables, screenshots, numbers),
   - which SPEC sections and architectural rules (SPEC 4.3) and foundation requirements (SPEC 9) it touches.
4. Design questions (anything the player will notice, domain realism, priorities) go to the owner as
   multiple-choice questions with a recommended option first. Do not ask him software questions:
   decide those and record them in `docs/DECISIONS.md`.
5. If the slice touches several systems, write a short plan first and check it against SPEC 4.3.
6. Work on a branch for the slice. Never start the next milestone uninvited. Never add a SPEC 8/9 feature early.
