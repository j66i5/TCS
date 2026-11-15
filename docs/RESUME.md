# Resume here (paused 2026-11-15 ~12:40 UTC, usage limit)

Everything on `main` is merged, checked and deployed. Open work, in order:

1. **M10 Medical: review and fix pass (last step of M10).**
   - All 16 build slices are done and merged except the last one, M10.8 (review tabs, medical statistics,
     balance report). M10.8 is on `claude/new-session-avoifd` (pushed, clean, CI-ready) and not yet merged.
   - The four reviews (spec, behaviour, code, UX) ran; their fix pass was interrupted. Its unchecked edits are
     on branch `claude/wip-medical-review-fixes` (may not build).
   - Resume: merge `claude/new-session-avoifd` to main (PR), then either finish the WIP fixes or re-run the
     four reviews and a fix pass. Workflow script:
     `~/.claude/projects/-home-user-TCS/<session>/workflows/scripts/m10-medical-wf_6af9ba65-68d.js`
     (run `wf_3a4dc31c-6be`; resume re-runs only the unfinished review/fix agents). Mark M10 done in ROADMAP.
2. **Morale rework (owner request 2026-11-15)**, not started. Owner answers (binding):
   - Problem: morale is "almost always at 100, even when wounded, saw buddies die" — too high.
   - Drivers (all four): leadership and cohesion; losses and wounded; fire and danger; success and support.
   - States graded and recoverable: steady -> shaken -> pinned -> panicked/fleeing; recovery when the leader
     rallies or fire stops.
   - Differences by quality, experience, fatigue and leadership from unit data, never by nationality.
   - Plan: audit (what the UI shows vs what the sim uses; measured distributions) -> design -> build on
     `claude/morale-rework` -> behaviour and code reviews -> fixes. Workflow script `morale-rework-wf_dd28daac-955.js`.
3. **Realistic line of sight** (owner: after all current improvements). Ask him first what feels wrong
   (multiple choice: seeing too far, vegetation and crops, terrain and buildings, posture and movement).
4. **Parallel cloud sessions** (asked to stop at a clean point):
   - "TCS parallel: ambulances + hand smoke": M7.6c wheeled carriers (slice 41) — a PR or
     `claude/wip-wheeled-carriers`. Next: slice 42.
   - "TCS parallel: M8 smoke and call for fire": D4a infantry tactics (reserve, base of fire bounding, 16 m
     rushes) — a PR or `claude/wip-d4-tactics`. Next: D4b (owner win-rate band still open).
5. **Waiting on the owner**:
   - phone numbers from `?perf=1` (photo and flat): they decide whether the sim moves to a worker;
   - Leutnant vs Oberleutnant for the Zugführer;
   - tank balance notes (Leopard never lost; T-72 losses only from Puma 30 mm);
   - low-confidence values listed in STATE.md and `docs/research/low-confidence.md`.
6. **Planned, not built**: military police and prisoners of war (ROADMAP, under M11).

How to work (see CLAUDE.md): one branch per line of work; merge main before each PR; resolve DECISIONS/STATE
conflicts by keeping both entries; regenerate goldens after merges that touch data; update the README version
and time after each merge.
