# TCS roadmap plan: from M7.5e to M15+ (2026-11-14, revised after critique)

Sources: seven research notes in this folder (medical, m8, m9, m11, m12-13, m14-15, debt), the critique
(`critique.md`), SPEC sections 3, 6-9, 11-13, ROADMAP, STATE, ARCHITECTURE §17, DECISIONS up to 2026-11-14 (M7.5e
step "clear"), and the owner's binding medical answers (the medical answers in DECISIONS.md). This is a proposal. Nothing in the
repo has been changed.

**Effort.** Every numbered slice is one agent session (SPEC 11). S = a short session, M = a full session. Work that
needs two sessions is split into two slices (a and b). Totals are rough.

**Confidence.** Web facts in the notes come from search extracts only: medium confidence at most. Data from them is
marked medium or low.

---

## Part 1: Overview for the owner

**Where we are.**
- The infantry and vehicle battle is built and playable on the phone: Germany against Russia, Firefight-style
  controls, the photo look, houses with rooms and upper floors. The app's battle lasts 40 minutes.
- The AI is learning to use buildings (M7.5e). Three steps are done (defend, leave, clear). One is left (polish).

**What comes next, in your order.**

1. **Finish "AI uses buildings"** (M7.5e polish). 1-2 sessions.
2. **The medical system** (M10, which you pulled forward). It starts straight after M7.5e. About 15-17 sessions.
   - The first session is a kick-off: your questions in short multiple-choice screens, the roadmap documents
     updated, speed and test clean-up.
   - Then your full chain, step by step: self-aid, buddy aid, the squad's Einsatzersthelfer, the platoon
     Sanitäter, carrying, the Verwundetennest, the armoured ambulance, the aid station off the map.
   - Combat vehicles take wounded back when they are going back anyway.
   - The laws of war: mostly honest mistakes, rare deliberate breaches, shown only in the after-action review.
   - Two small extras inside M10: hand smoke grenades (if you want them now, so men can screen a casualty
     drag), and a tidy-up of the after-action review before the medical pages are added to it.
   - The ambulances (Boxer SanKfz, BMM) are wheeled. They will be our first German and Russian wheeled vehicles,
     so they need one data session of their own.
3. **Two quality steps after medical.**
   - A phone pass: speed measured on your own phone, and the leftover interface items.
   - An infantry tactics pass: the fire base moves up, the attacker keeps a reserve, better fire distribution,
     shorter rushes, and the missing standing orders (ambush, smoke).
4. **Mortars, artillery and smoke** (M8). About 9-11 sessions.
5. **Night, sensors, guided missiles and reconnaissance drones** (M9). About 10-12 sessions.
6. **More vehicles and units** (M7.6, placement your choice): main battle tanks, the Boxer and BTR carriers with
   the Jäger and BTR platoons, the Russian assault group. About 4-5 sessions.
7. **Logistics** (M11). It reuses the medical carrying, rear points and off-map vehicles. 6-10 sessions.
8. **The persistent company** (M12): men, wounds and recovery carry over between linked battles. 6-7 sessions.
9. **The dynamic campaign** (M13): a map of sectors, an enemy commander at the operational level, and battles
   you either fight or let the computer play out. 9-10 sessions.
10. **Modern layer two** (M14): radio nets, jamming, FPV drones, loitering munitions, active protection.
    9-10 sessions.
11. **Breadth** (M15+): weather and seasons, more factions, editors, sound, multiplayer, an installable app.

**What I would change in the official roadmap** (your decision is in Part 4).
- Show medical as next. You already decided this; the documents just need updating.
- Give tanks, wheeled carriers and the missing unit types (Jäger, BTR platoon, assault group) a home (M7.6).
- Logistics: decide after measuring how much ammunition a 40-minute battle really uses (M11.1 first).

**What stays true throughout.**
- One short clean-up session after every milestone.
- A speed check whenever per-soldier work is added. The vehicle benchmark has only about 20 % headroom.
- Balance is reported at every step but re-tuned only in named balance slices, so numbers you accepted do not
  drift silently.
- Questions come as multiple-choice screens of at most four questions, recommended answer first, with "accept all
  recommended" on the first screen.

---

## Part 2: Rules this plan respects

**Order.**
- Medical comes immediately after M7.5e (owner, 2026-11-14). The clean-up session is M10's first slice, not a
  slice in between.
- No SPEC 8 or 9 feature is built before its milestone, except what the owner pulled forward (M10, and earlier
  the M6.5c mortars and smoke). Items that would break this are marked **[pull-forward]** and carry an owner
  question. Only one remains: the installable web app (PK1).
- SPEC 6 foundation items that are still missing (hand smoke, ambush order, scenario kinds) are not pull-forwards:
  they are debt and go where they are needed.

**Owner questions.**
- Only domain and gameplay questions go to the owner (SPEC 12). Software choices are decided, recorded in
  DECISIONS and mentioned in the report.
- Each round is split into screens of at most four questions with two to four options each (AskUserQuestion),
  recommended option first. The first screen of a round offers "accept all recommended".
- Content rules (SPEC 3) apply to every option: public sources only, no faction framed as worse in conduct, values
  marked medium or low.

**Foundations** (ARCHITECTURE §17).
- Every slice keeps its guard tests green.
- Stale rows (4.3.10, 4.4, 9.1 physiology, 9.1 medical events, 9.3 generator, 9.5 contacts) are refreshed in M10.0
  and flipped to ✅ in the slice that completes them.
- New guards proposed: contact sharing only through `ctx.comms` (M10.0); environment save and load mid-battle
  (M10.0); medical events for every intervention, carry and evacuation (M10.2-10.6); whole-battle item
  conservation (M11.1); cross-browser hash probe (D3); 4 km map check (D3); scenario kinds generate and run (M12.0b);
  person conservation across the campaign (M13.4).

**Every slice ends with** the finish-milestone skill: the full check run alone; a golden update with a DECISIONS
line whenever data changes; screenshots for any visual change; a plain-language report; a pull request.
`packages/tools/golden/no-interiors/*` is never touched until the decision in M10.0.

**Performance gate.** A slice that adds per-tick work per man or per vehicle runs `npm run test:perf` alone twice.
Floors: `bench-vehicles` 8×, `spotting` 8×, `bench-combined` 3×. Gates are marked **[perf]** below.

**Balance protocol.**
- Batches before and after: platoon, platoon-ru, platoon-vehicles, platoon-ru-vehicles, at the agreed length
  (currently 1200 s, 15-20 seeds; 2400 s at milestone ends), plus the scenario the slice adds.
- Win rates are reported, not re-tuned, until a named balance slice (10.8, D4, 8.5, 9.6, 11.8, 14.6).
- Latest known (attacker wins): village 3/20, farmland 10/20, mounted 7/15 (1200 s, M7.5e clear, 2026-11-14);
  Russian mounted 0/10 (900 s, 2026-11-13). The owner accepted a harder village. **The binding baseline is
  re-taken at the end of M7.5e polish.**

---

## Part 3: The sequence, as numbered slices

Each slice: what is built · acceptance · effort · dependencies · owner questions (screens of ≤ 4, recommended first).

### Phase 0: finish the current milestone

**1. M7.5e polish** (M; plan `docs/plans/m7.5e-ai-buildings.md` step 4). Steps defend, leave and clear are done.
- **Built:** scenario `house-clear`, screenshots, docs (HOW_IT_WORKS chapter), the balance report, the owner's
  answers applied.
- **Acceptance:**
  - Batches at 1200 s on the four scenarios: recorded as **the M10 baseline**.
  - `bench-vehicles` measured alone twice and recorded. Below 9×, M10.3a starts with a profiler pass.
- **Owner (one screen, DECISIONS 3544 and 3629):**
  - Player squads leave a house on their own (trap, enemy inside, cut off): (a) yes, as the AI [as built]
    (b) only when the house is a trap (c) never.
  - An AI squad that had to leave a house: (a) re-sited outdoors [as built] (b) may take another house.
  - A Clear button for the player: (a) yes, in the squad's actions (b) no.
  - Which houses the AI attacker clears in the objective's ring: (a) every house while the ring is defended
    [as built] (b) only houses with a known enemy.

### Phase 1: M10 Medical (owner pull-forward)

Follows `medical.md`, with large slices split. About 15-17 sessions.

**Cross-cutting rules (recorded in DECISIONS at 10.0; software decisions, no owner question):**
- Carrying, rear points and off-map vehicles take generic payloads (an entity with mass; a point with a `kind`:
  medical or supply), so M11 reuses them instead of building a second transport system.
- A new `medical` RNG stream, created on first use; battles without care never draw from it.
- A `--no-medical` rules switch (BattleRules) for A/B batches.
- `medicalSystem` runs at 1 Hz per side, staggered, and does nothing while nobody needs care.
- Breach propensity comes from unit quality, stress and losses, never from faction data (SPEC 3, owner answer 5).
- "Verwundetennest" is the interface word (owner); documents note the Bundeswehr terms
  "Verwundetensammelstelle / -sammelpunkt".

**2. M10.0 Kick-off and clean slate** (M). Depends on M7.5e merged.
- **Built:**
  - Owner rounds A (backlog) and M10-1 (below), answers in DECISIONS.
  - ROADMAP and SPEC §11 show M10 next, with these slices. ROADMAP M6.5 closed ("Russian attack carried to
    M8.5/M9.3") or kept open per answer A4.
  - ARCHITECTURE §17 refreshed; rows reserved for M10; new guards: contact sharing only through comms, environment
    save and load mid-battle. `windY` comment fixed (code and tests use south).
  - Tests: shared map cache for map-heavy tests, `isolate:false` for pure packages, `npm run test:quick`.
  - Software decisions (recorded, told to the owner): the six skipped pre-interiors goldens are deleted (they have
    tested nothing since 2026-11-13; STATE lists this as open, so the report invites an objection) and the CLAUDE.md
    gotcha updated; one short debt slot after every milestone.
  - STATE.md cut to 20 KB or less (stale "weak" list rewritten); a performance baseline recorded.
- **Acceptance:** `npm test` ≤ 120 s, full check ≤ 4 min; 0 skipped tests; no golden change unless A2 (b).
- **Owner round A** (two screens):
  - Screen 1:
    - A1 Values built by the overnight AI and M7.5e work: (a) accept all as built (b) accept all but the ones I
      name (c) one by one.
    - A2 Squad rushes: (a) 3-5 s bounds of 15-20 m, done in D4 with the other tactics (b) 15 m now (c) keep 30 m.
    - A3 Balance battle length: (a) 1200 s routinely, 2400 s (the app's battle) at milestone ends (b) always
      2400 s (c) 900 s.
    - A4 Russian mounted attack (0 of 20): (a) leave until mortars (M8.5) and missiles (M9.3) give it fire
      support (b) tune the AI now (c) a bigger attacking force in the scenario.
  - Screen 2:
    - A5 Hand smoke grenades (German and Russian types from research): (a) a small slice inside M10, before
      care under fire (b) with the new smoke in M8.1 (c) none.
    - Q7c Where tanks, wheeled carriers and the missing unit types go (Phase 5).
    - Q7d Stage C order after medical (Part 4 d).
- **Owner round M10-1** (data and numbers; one screen; the numbers table itself is shown for information, as you
  decided: research defaults now, your review after playing):
  - Q-1b Who may do needle decompression and IV/IO: (a) per national training found: DE Einsatzersthelfer B airway
    relief and IV; RU стрелок-санитар dressings and tourniquets; medics everything (b) medics only (c) every first
    responder.
  - Q-1c Medical people on the map: (a) DE: one man in each Gruppe trained as Einsatzersthelfer B (no extra man),
    plus a Sanitäter added to the Zug HQ; RU: one стрелок-санитар per platoon; company medics, bearers and
    ambulances from off the map (b) also the company medic team on the map (c) medics only.
  - Q-1d Russian rubber tourniquet and hemostatic powder (UK reports, medium): (a) slower and less effective
    (×1.4 time, ×0.8 success) (b) same as the CAT.
  - Q-1e An ambulance needs 10-20 min; the app battle lasts 40 min, batches 15-20 min: (a) realistic delays, and
    whoever is still waiting at the end is settled by an end-of-battle roll (b) delays cut to a third.
- (Q-1f air evacuation moves to round M10-3; SPEC 9.1 lists it "where the scenario allows", so deferring it is a
  SPEC note.)

**3. M10.1 Medical data and the new physiology** (M). Depends on 10.0.
- **Built:** `core/medical.json` with schema, sources and confidence per value; medical items for DE, RU and xf (the
  `*-ifak` placeholder becomes its counted contents at the same mass); first-responder and medic bags; roles with
  `medicalLevel` (first responder, medic, stretcher bearer, ambulance crew) and an emblem item for marked men;
  templates per Q-1c; physiology model "medical" (default): tension pneumothorax with onset delay, tourniquet
  ischaemia clock, hypothermia, fluids, head-injury deterioration, burn fluid loss, fracture flag. State schema
  +1. Nobody treats anyone yet. SPEC/ARCH change: `PhysiologyModel.step` gets an optional environment argument.
- **Acceptance:** casualty lab untreated deaths at 10 and 60 min within ±3 points of the table the owner accepted
  on 2026-11-11, plus a "dead by 120 min" column; a unit test per condition; data lint with nothing above medium;
  the xf fixture battle runs; golden update with a DECISIONS line.

**4. M10.2 Interventions; self-aid and buddy aid** (M). Depends on 10.1.
- **Built:** generic `treat` action (casualty's own kit first; success from level, skill, stress, item;
  interruptible); pure `nextIntervention()` in MARCH order; under fire only a tourniquet or a drag; `TreatmentRecord`
  and `medical.treated` events; self-aid; buddy aid by the nearest man within 3 m; debug overlay line.
- **Acceptance:** `lab -- treatment` (300 trials per cell) matches the data; self-applied tourniquets cut limb-bleed
  deaths at 10 min to a third or less; items conserved; determinism and save/load mid-action.

**5. D1 Hand smoke grenades** (S; only if A5 (a)). Depends on 10.2. SPEC 6.6 foundation, not a pull-forward.
- **Built:** hand smoke items (research, add-data-entry skill), the throw reusing the grenade action and today's
  smoke volume; the squad "Smoke" order; break-contact drill throws smoke; AI uses it on withdrawals.
- **Acceptance:** a hand smoke cloud blocks sight across 20 m for 45 s or more (lab row); items conserved; golden
  update.

**6. M10.3a Who helps: carers and first responders** (M). Depends on 10.2 (and 5 if built), round M10-2.
- **Built:** `medicalSystem`; per-casualty need; carer assignment (first responder for casualties who look T1,
  else the nearest willing comrade; willingness from morale, suppression, doctrine `casualtyCarePriority`, same
  team, exposure); a cap on carers per squad in contact (Q-2a); a downed man with a carer beside him does not
  surrender; same rules for player and AI. Starts with a profiler pass if slice 1 measured below 9×. **[perf]**
- **Acceptance:** batch (platoon and platoon-vehicles, 10 seeds): median time to first intervention ≤ 3 min where a
  carer is available; 70 % or more of casualties get some care; the squad cap holds; fire volume and win rates
  reported against `--no-medical`.

**7. M10.3b Triage, care under fire, "Medic!"** (M). Depends on 10.3a.
- **Built:** triage by first responder or medic with honest errors (`SoldierState.triage`, `medical.triaged`);
  the one-man drag to cover under fire, tourniquet only; "Medic!" and "Man down, treating" radio keys; triage tag on
  the map and on the man's card (Q-2b); debug overlay reasons ("too exposed", "no kit").
- **Acceptance:** preventable deaths 40 % or more lower than `--no-medical`; triage error rates per level match the
  data; UI tests and phone screenshots.
- **Owner round M10-2** (before 10.3a; two screens):
  - Screen 1: Q-2a men leaving the fight in contact: (a) the first responder plus one comrade per casualty (b)
    anyone willing (c) only first responders treat, the rest only drag. Q-2b triage display: (a) tag on the map
    and the card (b) card and list only (c) not shown. Q-2c wounded list: (a) a sidebar tab (b) the map only.
    Q-2d enemy casualties: (a) only what your men see (b) shown in full.
  - Screen 2: Q-2e stretcher bearers: (a) riflemen tasked by the platoon leader (b) a dedicated four-man team.
    Q-2f bearers under attack: (a) take cover with the casualty, fire only in self-defence (b) keep going (c) drop
    him and fight.

**8. M10.4a Carrying as a movement mode** (M). Depends on 10.3b.
- **Built:** generic `carry` store; walking wounded, drag, fireman carry, two-man carry, four-man litter (set-up
  time); carriers leave the fight and never fire; routes through `routeBetween` including stairs; a pinned party
  puts the casualty down in cover; `medical.carried` events.
- **Acceptance:** `lab -- carry` within ±10 % of the data on flat ground, slope, a house and stairs; casualty never
  more than 1.5 m from a carrier; save/load mid-carry. ARCH row "carrying as a movement mode" ✅. **[perf]**

**9. M10.4b Carrying to and into vehicles** (M). Depends on 10.4a.
- **Built:** `loadCasualty` extended (carried to an exit from anywhere, lying and sitting places, unloading);
  sprite frames for casualty and stretcher; a `bench-medical` perf case (its floor is a software decision).
- **Acceptance:** loading and unloading tests with capacity; `--scene medical` screenshots; flat and classic looks
  byte-identical apart from the new frames; `bench-vehicles` and `bench-medical` at their floors, alone, twice.
  **[perf]**

**10. D2 Battle record and `main.ts` split** (M). Depends on 10.3b; it must come before 10.5, which adds the
player's medical orders and the wounded list.
- **Built:** a pure `battleRecord(events, result)` used by the app and the batch tool; the review in tabs with
  empty Medical and Conduct tabs; `main.ts` cut to 600 lines or less (AAR model, timeline strings, save/load and
  debug hooks moved out).
- **Acceptance:** the app and the batch report agree on 5 seeds; no sim or golden change.

**11. M10.5 Verwundetennest and platoon medic** (M). Depends on 10.4b and 10.
- **Built:** generic rear-point store (`kind = medical`); automatic siting 100-200 m back, in cover, reachable by
  vehicles, moving when threatened; bearer flow, T1 first; the medic's advanced care and re-triage; orders
  `casualtyPoint` and `evacuate` (owner answer 4); a red-cross marker the player drags; the Wounded sidebar list
  (Q-2c); the AI commander counts carriers as committed men. **[perf]**
- **Acceptance:** 60 % or more of living, uncaptured casualties reach the nest by battle end (2400 s); re-triage
  corrects 50 % or more of wrong tags; UI tests and phone screenshots.

**12. M10.6-data Wheeled ambulance hulls** (M). Depends on round M10-3 (Q-4).
- **Built (add-data-entry skill):** Boxer (base hull and SanKfz variant) for DE and BMM (BTR-80 base) for RU: the
  first German and Russian wheeled vehicles; drive data checked in `lab -- drive` rows (wheeled steering bands so
  far only tested on xf); armour per public figures (medium/low); crews; lying and sitting places; an xf ambulance.
- **Acceptance:** drive lab rows inside their bands; data lint; golden update. M7.6b later reuses the Boxer base.

**13. M10.6a Off-map vehicles and ambulance runs** (M). Depends on 11 and 12. SPEC/ARCH change: off-map entity state.
- **Built:** `VehicleState.offMap`, skipped first in every vehicle loop; ambulance and crew exist off map from tick
  0; requests (automatic or the player's `callAmbulance`); arrival after the delay (Q-6), road route from the own
  edge, loading within capacity, leaving; casualties become "evacuated"; `medical.evacuated` events.
- **Acceptance:** `lab -- medevac` arrival within delay plus drive time ±10 %; capacity never exceeded; men and
  items conserved; roster round trip with "evacuated"; `bench-vehicles` floor holds; screenshots. **[perf]**

**14. M10.6b Combat vehicles' rear run; Role 1; roster** (M). Depends on 13.
- **Built:** a "rear run" task (casualties now, ammunition in M11); the player order "evacuate with this vehicle"
  (Q-9); Role 1 outcome at hand-over (died-of-wounds chance and recovery days, Q-16); end-of-battle settlement
  (Q-1e, Q-10); `SoldierRecord` gains "evacuated", `recoveryDays`, `diedOfWoundsTick` (SPEC roster change).
- **Acceptance:** share of T1 reaching Role 1 within 60 min reported per side; died-of-wounds timing histogram;
  roster round trip keeps wounds, treatments and status; no rear run starts while the squad assaults.
- **Owner round M10-3** (before 12; two screens):
  - Screen 1: Q-4 ambulances: (a) new Boxer SanKfz and BMM hulls (one data session) (b) marked versions of the
    current carriers (c) unarmoured. Q-6 ambulance delay: (a) 10-15 min plus drive time (b) 5 min (c) 20-30 min.
    Q-9 combat vehicles taking wounded: (a) only when going back or idle; you can order any vehicle (b) the
    squad's vehicle goes back for any T1. Q-10 wounded left at the end: (a) the side holding the ground evacuates;
    wounded on enemy-held ground are captured and treated (b) each side evacuates its own.
  - Screen 2: Q-7 you order fire at a recognised protected target: (a) allowed, recorded as an "ordered" breach in
    the review (b) allowed after a confirm prompt (c) refused. Q-8 incidental hits: (a) a separate list in the
    review (b) counted as misidentification (c) not listed. Q-16 recovery for the campaign: (a) days from wound
    severity and treatment (b) only back or not back. Q-1f air evacuation: (a) later (ground only in M10) (b) an
    off-map helicopter where the scenario allows.

**15. M10.7a Recognition and respect** (M). Depends on 11 and 13.
- **Built:** recognition inside the existing contact scan (no new scan): emblem size, eye or optics, light, smoke,
  stress; contact flags `marked`, `carrying`, `atPoint`; fire choice, decisions and AI fire missions spare
  recognised protected targets (owner answer 6). **[perf]**
- **Acceptance:** `lab -- protection` recognition table (day, night, smoke, eye, optics) matches the data; a
  recognised ambulance is never engaged except by a deliberate draw; architecture test (no faction literals);
  `spotting` floor holds.

**16. M10.7b Breaches, medic self-defence, prisoners' care** (M). Depends on 15.
- **Built:** `law.breach` events: "misidentified" (unrecognised protected target engaged), "deliberate" (small chance
  per fire decision, raised by own losses, low unit quality and panic), "ordered" (Q-7); medics fire only in self-
  defence of themselves and the wounded, otherwise lose protection for 120 s (owner answer 8); captors treat
  prisoners per their capacity; nothing shown live (owner answer 7).
- **Acceptance:** misidentification rises at night and in smoke; deliberate breaches stay near the base rate unless
  losses or panic raise them; identical rules for both sides from the same unit quality (test); UI test: nothing live.

**17. M10.8 Review, statistics, balance** (M).
- **Built:** Medical and Conduct tabs filled (times to first intervention, nest, evacuation; died of wounds with
  timing; preventable deaths with the missing step; breaches with circumstances, both sides); batch "medical"
  block; HOW_IT_WORKS chapter; ARCHITECTURE rows 4.3.10, 9.1 flipped to ✅; balance report on four scenarios with and
  without `--no-medical`; re-tuning allowed here.
- **Acceptance:** statistics deterministic per seed; the owner reviews the numbers table and plays a battle on his
  phone.
- **Owner (after playing):** (a) keep the numbers (b) adjust the ones I name (c) make care faster for gameplay.

### Phase 2: quality after medical (the debt slot after M10)

**18. D3 Phone pass** (M). Depends on M10.
- **Built:** `?perf=1` read-out; leftover UI items (vehicle gun and ammunition on the card, unit list overlapping
  the card, "no line of fire" warning on release, drag ghosts, casualties in the pixel look); roof atlas off the
  main thread; F2 cross-browser probe (shootout golden in Chromium, Firefox and WebKit, compared by hash; report
  only); F3 4 km map check (generation and navigation grids, time and memory).
- **Acceptance:** your phone shows p95 ≤ 33 ms while panning; no sim or golden change; probe table and 4 km numbers
  in DECISIONS.
- **Software decision:** if the phone numbers show the sim on the main thread is the problem, move the sim into a
  worker here (M13.0 moved forward; architecture, not a SPEC 8/9 feature).
- **Request to the owner (not a decision):** open `?perf=1` on your phone and send the numbers.

**19. D4a Infantry tactics pass 2: the attack** (M). Depends on M10.
- **Built:** the fire base bounds forward when the assault masks it; the attacker keeps a reserve and commits it
  (SPEC 6.9 "reserve"); 3-5 s rushes if A2 (a).
- **Acceptance:** supported-attack lab not worse; "support masked" time down 50 % or more; reserve committed in 50 %
  or more of attacks that take an objective.

**20. D4b Infantry tactics pass 2: fire and the missing SPEC 6.6 orders** (M). Depends on 19.
- **Built:** fire distribution (MGs and marksmen on the most dangerous enemy); heard or reported contacts aimed at
  0.2-0.5 m, not 0.9 m; SPEC 6.6 gaps: an `ambush` order (hold fire until the enemy is inside a set range or the
  first shot), "defend an arc" as an explicit order, order hesitation for shaken men (refusal exists); "deploy
  crew-served weapon" reserved for M8.3 / M9.3b; balance re-tuning allowed (medical load included).
- **Acceptance:** batches at 1200 s and 2400 s before and after, win rates in the band the owner agrees; ambush
  lab row (first volley inside the set range).
- **Owner (one screen, before 19):** attack AI: (a) base of fire moves up and the attacker keeps a reserve (b) only
  the base of fire moves up (c) leave it. Fire distribution: (a) spread, MGs on the most dangerous enemy (b)
  nearest enemy, as now. Aiming at heard or reported enemies: (a) low, 0.2-0.5 m (b) 0.9 m, as now. Win-rate band
  for attacks: (a) 3-6 of 10 at 2400 s (b) 2-4 (c) leave as it comes.

### Phase 3: M8 Indirect fire and smoke

Follows `m8.md`. M6.5c and the fire-support step already built the off-map mortar section, ranging, registered
points, flat smoke and the AI's fire plan. About 9-11 sessions.

**Owner round M8** (at slice 21; three screens):
- Screen 1: Mortars: (a) on the map, plus artillery off the map (b) everything off the map (c) on-map mortars only.
  Who may call fire: (a) any unit with a radio; observed calls by eye or vehicle sight; unobserved calls with a
  large error (b) only leaders and radio operators (c) only a forward-observer team. First-round accuracy: (a)
  automatic, from the best means the caller has (b) you pick the method. Artillery in the platoon battle: (a) a
  few 155 mm missions with danger close (b) only in larger scenarios (c) not before the campaign.
- Screen 2: Counter-battery: (a) abstract: the firing unit must move after a few missions (b) real counter-fire with
  losses (c) interface only. Smoke: (a) height, wind drift and screen lines (b) height only (c) as now.
  Illumination: (a) rounds and data now, the light in M9 (b) night lighting in M8 [pull-forward] (c) drop until
  M15. Airburst: (a) where a public source shows the fuse (b) in M9.
- Screen 3: White phosphorus: (a) generic smoke, no casualty effect (b) incendiary wounds. Russian 155/152 mm type:
  (a) 2S19 Msta-S (b) 2S3 Akatsiya.

**21. M8.1 Smoke volume v2** (M). Depends on M7.5e.
- **Built:** cloud height; wind drift and stretch (wind sign corrected); build-up and fade in data, renderer using
  the sim's growth; a screen mission along a dragged line; spatial culling; `lab -- smoke`; hand smoke here if A5 (b).
- **Acceptance:** a man upstairs sees over a cloud only when his line clears its top; a cloud drifts 100 m or more in
  30 s at 4 m/s and never upwind; a 6-round screen across 150 m blocks 90 % or more of spotting checks across it.
  **[perf]** with 30 clouds.

**22. M8.2a Call-for-fire chain** (M). Depends on 21.
- **Built:** mission phases (request through comms, processing, "shot", time of flight, "splash"); first-round error
  by location method (map or eye estimate, laser rangefinder, registered point); planned targets set in deployment.
- **Acceptance:** time to effect is the sum of the phases; at 500 m the map-estimate first-round miss is about 3×
  the rangefinder miss; xf unchanged.

**23. M8.2b Observers and adjustment** (M). Depends on 22.
- **Built:** an observer abstraction for soldiers and vehicle sights, with a slot for drones (M9.5); adjustment
  converging with observer skill; missions skip a recognised Verwundetennest (M10.7a); `lab -- indirect`.
- **Acceptance:** adjustment converges within the lab bands; attacker wins at or above baseline minus 1.

**24. M8.3a On-map mortars: crews and firing** (M). Depends on 23.
- **Built:** crewed sections (DE 120 mm, RU 82 mm 2B14 and 120 mm 2S12; carriers from research); deploy and set-up
  (SPEC 6.6 "deploy crew-served weapon"); minimum and maximum range; rounds as items. **[perf]**
- **Acceptance:** missions out of range refused; rounds conserved.

**25. M8.3b On-map mortars: signature and degradation** (M). Depends on 24.
- **Built:** flash and sound the enemy can detect; a hit or suppressed crew slows or stops; DATA_GUIDE section on
  adding a mortar.
- **Acceptance:** the enemy hears the tubes (contacts test); fire rate falls under suppression.

**26. M8.4 Off-map 155 mm, airburst, flares as data, reserved interfaces** (M). Depends on 23.
- **Built:** off-map PzH 2000 battery (DE) and the chosen RU type; danger close; airburst; flares saved in state
  without light; `CounterBatteryModel`; a `guidance` field (guided rounds refused until M9).
- **Acceptance:** lab rows 155 mm against 120 mm; airburst hurts prone men in the open much more, men under a roof no
  more; flares leave the light unchanged.

**27. M8.5 AI and balance** (M). Depends on 25, 26 and D4.
- **Built:** the AI chooses observers (reusing `siting.ts` view scoring); planned fires; screens across the wind;
  airburst on men in the open; danger close respected; the Russian mounted attack revisited (A4).
- **Acceptance:** attacker wins in the agreed band; never own HE within danger close of own men; overlay shows
  observing.

**28. M8.6 Interface** (M).
- **Built:** fire-support pop-up (HE, airburst, smoke at a point or along a line, illumination greyed until night);
  asset choice with rounds left and time to effect; danger-close warning; planned targets in deployment; "splash in
  N s"; review table.
- **Acceptance:** on your phone, without a manual, you call adjusted HE, a smoke screen and artillery.

**29. Debt slot after M8** (S): delete `?look=classic` (owner, 2026-11-13); perf re-baseline; STATE trim; refresh
the low-confidence data table (182 entries today).

### Phase 4: M9 Modern layer one

Follows `m9.md`. About 10-12 sessions.

**Owner round M9** (three screens):
- Screen 1: Order: (a) night and sensors, then missiles, then drones (b) drones first (c) missiles first. RU
  dismounted missile: (a) Metis-M at company level (b) Kornet attached from battalion (c) both. MELLS on the Puma:
  (a) 2 ready, reloaded outside while halted with a man exposed (b) no reload in battle (c) dismounted teams only.
  A locked fire-and-forget missile against smoke: (a) flies on to the last point seen (b) smoke defeats it (c) no
  effect.
- Screen 2: Drones: (a) one quadcopter at the platoon HQ (b) one per squad (c) company level, off the map. Drone
  feed: (a) over the radio with the usual delay (b) the operator's platoon first (c) instantly to everyone. Night
  look on the phone: (a) darkened map with fires and flashes lit (b) green night-vision tint (c) unchanged.
  Programmable airburst (SPEC 8): (a) in M14 (b) in M9.3.
- Screen 3: Night-vision goggles per squad (today 8 DE against 2 RU): (a) research defaults, marked low (b)
  everyone on both sides (c) you set them.

**30. M9.1 Night and light** (M): sun and moon table; light from time of day; `?time=`; the night look; flashes and
tracers reveal far more at night; the flare light from M8.4. Acceptance: full-daylight goldens bit-identical; `lab
-- night`.

**31. M9.2 Sensor physics** (M). Depends on 30: field-of-view and range per sensor; signature per sensor kind
(thermal against hedges and hot hulls); weapon thermal sights as data; thermal blankets; goggle numbers fixed;
battery slot reserved; battlefield surveillance radar stays reserved (SPEC 8, deferred). Acceptance: `lab --
thermal`; signature computed per observer, not per pair. **[perf]**

**32. M9.3a Guided missiles on vehicles** (M): beam riding (Kornet) and fibre-optic fire-and-forget with top attack
(MELLS / Spike LR) on the Puma ("IFV missiles later", M7); launch warning and smoke. Acceptance: `lab -- missile`
rows per guidance kind; xf gets a missile of a new guidance kind.

**33. M9.3b Dismounted missile teams** (M). Depends on 32: deploy order (crew-served), launch signature, AI siting,
moving after a shot; the Russian mounted attack revisited (A4). Acceptance: lab rows; batches.

**34. M9.4a Reconnaissance quadcopter: the drone** (M). Depends on 31: drone as item and entity; busy operator;
battery; downward day and thermal camera whose contacts go through comms; a sidebar tile where Move means fly.
Acceptance: `lab -- drone`; save and load with a drone in the air. **[perf]** with `bench-drones`.

**35. M9.4b Counter-drone and AI use** (M). Depends on 34: seen, heard and shot at; AI use; hooks for M14 (control
link, `operator-flown` guidance, hit boxes). Acceptance: lab rows for detection and shooting down.

**36. M9.5 Drone-observed fire** (S-M). Depends on 23 and 34: a drone as the observer of the fall; optional off-map
fixed-wing reconnaissance asset. Acceptance: fire-support lab rows by location method.

**37. M9.6 Night AI, balance and polish** (M): night drills, hiding from drones, review rows, re-tuning allowed, an
owner play-test. Acceptance: batches day and night, before and after.

**38. D5 Replay** (M, the debt slot after M9). Depends on D2. SPEC 6.9 "replay from the event stream with full
information" is a foundation gap.
- **Built:** full-information replay from the saved orders with a scrubber, 4-16× speed, keyframes every 60 s.
- **Acceptance:** a 2400 s battle reaches its end-state hash; seeking ≤ 3 s; works on a phone at 4×.

### Phase 5: M7.6 Combined-arms breadth (placement: owner Q7c)

SPEC 7 lists these and M7 deferred them ("main battle tanks, wheeled carriers and IFV missiles later"). About 4-5
sessions.

**39. M7.6a Main battle tanks: data and labs** (M): Leopard 2A7/2A8 and T-72B3M/T-90M (add-data-entry; armour
medium/low; ERA tiles as counted items); armour and anti-tank lab rows. APS waits for M14.5.

**40. M7.6b Tanks in battle** (M). Depends on 39: AI use with infantry; a tank-supported scenario variant; vehicles
batch. **[perf]**

**41. M7.6c Wheeled carriers and their platoons** (M). Depends on 12 (Boxer base): Boxer infantry variant, BTR-82A;
the German Jäger platoon and the Russian BTR platoon as unit templates; app `?vehicles=` choice. Acceptance: drive
and gunnery lab rows; mounted batches with wheeled carriers.

**42. M7.6d Russian assault group and support weapons** (M, optional): the assault-group organisation; automatic
grenade launcher (AGS type) and thermobaric launcher as data (abstract effects, SPEC 3); a German automatic grenade
launcher if sourced. Acceptance: lab rows; batch.

- **Owner (Q7c):** tanks and the other vehicles: (a) after M9, before logistics (b) just before M14 (c) tanks only
  before M14, the rest after M15 starts.

### Phase 6: M11 Logistics

Follows `m11.md`. Minimum set: 43-47 and 52; 48-51 optional. Shared machinery from M10 (carry store, rear points,
off-map vehicles, rear runs).

**Owner round M11** (three screens; asked after slice 43's measurement):
- Screen 1: Focus: (a) ammunition first, fuel and repair after (b) everything (c) minimum. Making logistics felt,
  given the measured 40-minute consumption: (a) a long 45-60 min "hold the village" battle in waves (b) men fire
  more (c) wait for M12. Loose rounds: (a) men refill magazines in cover (b) magazines stay the smallest item.
  Taking kit: (a) own casualties automatically, enemy kit only on order (b) own casualties only (c) anything.
- Screen 2: Delivery: (a) carried, vehicle runs and off-map delivery (b) vehicles only (c) caches only. Control:
  (a) automatic with orders (b) manual (c) fully automatic. Supply point and Verwundetennest: (a) separate, no
  ammunition at the red cross (b) one combined point. Repair: (a) crews fix light damage, recovery vehicles can be
  requested (b) crew only (c) none in battle.
- Screen 3: Batteries and water: (a) batteries after M9, water only in battles of 2 hours or more (b) both only in
  the campaign. Caches: (a) legitimate targets; captured caches become the captor's; an ambulance carrying
  ammunition is a breach (b) destroyed rather than captured. Fire-support stocks: (a) allotment topped up by
  deliveries (b) fixed.

**43. M11.1 Consumption test bed and packaging** (M): `lab -- consumption` at 1200 s and 2400 s (the m11 notes
measured only 900 s); the long `hold-resupply` scenario; bandoliers, cans, crates; a `refillMagazines` action;
whole-battle item conservation as a new foundation guard. Acceptance: conservation in every scenario, 6 seeds; at
least one squad per battle runs low without resupply (median) in the long scenario.

**44. M11.2 Redistribution and cross-loading from casualties** (M). Depends on 43 and M10.3a: squad leader evens out
ammunition at consolidation, belts first; own casualties' ammunition taken after treatment; enemy weapons only if
chosen. Acceptance: loads even out within 60 s, nothing created or lost; treatment always before taking ammunition.

**45. M11.3 Supply points and caches** (M). Depends on 43 and M10.5 (rear points, `kind = supply`): supply-source
query; caches that can be destroyed (cook-off); orders "set supply point", "resupply at"; ammunition icons on tiles.
Acceptance: tests and phone screenshots. **[perf]** with 20 caches.

**46. M11.4a Resupply on foot** (M). Depends on 45 and M10.4a: ammunition bearers through the carry store; AI
requests. **[perf]**

**47. M11.4b Resupply by vehicle and off map** (M). Depends on 46 and M10.6a/b: rear runs carrying ammunition
forward; off-map delivery. Acceptance (with 46): `lab -- resupply` within ±10 %; fewer squads dry over 20 seeds; the
AI never strips a defended objective to fetch ammunition.

**48. M11.5 Re-arming and refuelling** (M, optional). Depends on 47 and 24: crates into stowage, fuel in litres per
minute, rounds to mortars. Acceptance: conservation includes litres; roster round trip keeps them.

**49. M11.6 Batteries, water and other consumables** (M, optional). Depends on M9: battery charge for radios,
sights and drones; drone airframes as items; water in long battles; smoke and medical resupply. Acceptance: a
3-hour night battle shows battery swaps.

**50. M11.7a Field repair** (M, optional). Depends on 13: crew repair with parts and time. **51. M11.7b Recovery**
(M, optional): off-map recovery vehicle towing; `VehicleRecord.recovery`. Acceptance: `lab -- repair`, towing test,
roster status.

**52. M11.8 AI logistics, review page, balance** (M): Logistics tab; batch columns; `BattleResult` lists consumed,
delivered and captured items (input for M12/M13). Acceptance: `hold-resupply` 20 seeds each way within the band;
you play it on your phone.

### Phase 7: M12 Persistent company

Follows `m12-13.md`. About 6-7 sessions. Needs M10.6b (recovery days, "evacuated") and, if logistics comes later,
refills to the standard load until M11.

**Owner round M12** (two screens):
- Screen 1: Force: (a) a company; you pick 1-2 platoons per battle (b) one platoon (c) a battalion. Operations: (a)
  3-5 linked battles on connected maps (b) an endless chain (c) a fixed sequence. Saving: (a) automatic between
  battles; a lost battle can be retried (b) free saving (c) ironman. Experience: (a) grows a little per battle and
  more under fire, capped; stress history stays (b) battle count only (c) no change.
- Screen 2: Replacements: (a) green men after every battle (b) only between operations (c) none. Ammunition and fuel:
  (a) refilled to the standard load, consumption logged (b) partly refilled. Recovered wounded: (a) back to their
  old squad if there is room (b) to the pool. New leaders: (a) automatic, you can change them (b) always your
  choice.

**53. M12.0a Contract gaps** (M): `BattleInput.damage`, `wrecksIn`; `BattleResult.damageOut`; `ScenarioDef.forces`
and `terrain`; `campaign` package rules (sim-like lint; injected `BattleRunner`, never imports `ai`; `app` may import
`campaign`: eslint and architecture-test rows). Acceptance: battle 1 into battle 2 keeps every field (fatigue and
stress history included); a crater from battle 1 is in battle 2's nav grid; goldens unchanged when fields are absent;
xf runs a chain.

**54. M12.0b Scenario kinds** (M; SPEC 6.9 foundation gap, ARCH row 9.3 🟡): defence with counter-attack, meeting
engagement, ambush, withdrawal; reinforcement schedules; exit zones and time limits as objectives. Acceptance: every
kind generates and runs AI-vs-AI on every map kind for 10 seeds without a stalemate flag; ARCH row 9.3 ✅.

**55. M12.1 Campaign record and rules between battles** (M): pools (recovering with M10 `recoveryDays`, dead,
missing, prisoners); `core/campaign.json`; versioned campaign save with migrations and ID repair; IndexedDB plus
export and import. Acceptance: a 10-battle headless chain is reproducible; save-load-continue matches an
uninterrupted run; an old save migrates.

**56. M12.2 Linked operations** (M): operations of 3-5 battles; the result picks the next; the enemy remembered with
its losses; skipped battles auto-resolved with the real sim. Acceptance: batch of 50 operations; no battle starts
with a side of 0 men.

**57. M12.3 Phone roster interface** (M, can run beside 56): home, company, man card, briefing; a "what changed"
card. Acceptance: `--scene campaign` screenshots; you play two linked battles on your phone.

**58. M12.4 Review and tuning** (S).

### Phase 8: M13 Dynamic campaign

About 9-10 sessions.

**Owner round M13** (two screens):
- Screen 1: Map: (a) a graph of 15-30 sectors (b) hexes (c) a linear front. Turn length: (a) 6 hours (b) 1 day (c)
  1 hour. Your role: (a) one company battle group with AI neighbours (b) a battalion. Length: (a) 10-20 turns (b)
  40 or more (c) open-ended.
- Screen 2: Enemy plan explanation (SPEC 9.3 requires a debug view): (a) behind a toggle (b) shown after the
  campaign (c) not shown. Battles you do not fight: (a) the real sim at full detail with a progress bar (b) the real
  sim at reduced detail, faster. (A statistical shortcut is not offered: SPEC 9.3 asks for the real sim.)

**59. M13.0 Sim in a worker and auto-resolve speed** (M), unless done in D3. Acceptance: a two-platoon auto battle
in ≤ 30 s on your phone; worker and Node identical.

**60. M13.1 Operational map and state** (M): sectors, formations with rosters, supplies, posture and orders; hooks
reserved for intelligence, reconnaissance tasks, weather forecasts, civilians and rules of engagement (SPEC 9.3,
deferred). Acceptance: a deterministic 20-turn log.

**61. M13.2 Battles generated from the situation** (M). Depends on 54: kind, strengths, terrain, time of day,
weather, support, intelligence quality. Acceptance: 100 generated situations run with no crash.

**62. M13.3a Operational enemy commander: plans** (M): objectives, limited resources, imperfect information; debug
view from the start. **63. M13.3b Commander: reassessment and tuning** (M). Acceptance (both): over 50 campaigns
neither side always wins; no attack below the force ratio unless ordered; at most 2 repeat attacks on a sector after
a failure.

**64. M13.4 Results feed back; campaign supply** (M): ground, casualties and recovery, consumption, captured
equipment, persistent terrain damage; supply lines as routes with capacity, interdiction, stockpiles per formation,
replacements over time (SPEC 9.2 campaign level). Acceptance: person conservation (every man in exactly one place);
40 turns stay stable.

**65. M13.5a Phone operational map** (M). **66. M13.5b Turn flow and briefings** (M). Acceptance: you play 5 turns.

**67. M13.6 Campaign balance and review** (M).

### Phase 9: M14 Modern layer two

Follows `m14-15.md`. About 9-10 sessions.

**Owner round M14** (two screens):
- Screen 1: What you see of the enemy (your M6 reminder): (a) a switch; the default stays "what your men have
  reported", as you decided at the M6 review (b) only what has reached your HQ (c) as now, no switch. Lost radio:
  (a) a runner walks the order over (b) the order fails (c) slower. EW: (a) jammers on the map that can be found,
  plus off-map EW as a setting (b) setting only (c) campaign only. Who flies attack drones: (a) a team ordered to
  "attack this", which you can watch (b) you steer it yourself (c) off the map only.
- Screen 2: Fibre-optic drones: (a) both kinds for both sides (b) radio-link drones only at first. FPV
  effectiveness: (a) public estimates of 20-40 % (b) deadlier (c) weaker. Active protection: (a) only where public
  sources show it in service (e.g. Leopard 2A8 with Trophy), after the tanks (b) also as a scenario option on other
  sourced hulls, marked low (c) none.

**68. M14.1a Command picture and radio nets** (M): a stored "reported picture" per HQ beside the pure
`knowledge.ts`; nets per echelon; new comms model "nets" (`simple` stays default until batches accept it). **[perf]**

**69. M14.1b Runners, hand signals, leaders, BMS** (M). Depends on 68: runners and hand signals as fallbacks;
leaders as casualties change delays; a battle management system item that speeds contact sharing (SPEC 9.5).
Acceptance (both): `lab -- comms`; batches within noise when nets are perfect.

**70. M14.2 Jamming and direction finding** (M): jamming zones on radio, drone control and satellite navigation;
direction finding. Acceptance: `lab -- ew`. **[perf]**

**71. M14.3a FPV attack drones: flight and strike** (M). **72. M14.3b FPV counters and interface hooks** (M).
Acceptance: `lab -- fpv` anchored at 20-40 % success; **[perf]** with 10 FPVs per side.

**73. M14.4 Loitering and dropped munitions** (M).

**74. M14.5 APS, cages and nets** (M). Depends on 39-40 (tanks): APS charges and ERA tiles as counted items; cages
and nets as armour items.

**75. M14.6 AI, doctrine and balance** (M): persistent observation in doctrine (dispersion, overhead cover,
signature management; SPEC 8); re-tuning allowed.

**76. M14.7 Interface** (M). Acceptance: you fly an FPV on your phone without a manual.

### Phase 10: M15+ breadth

Each item is its own milestone, chosen by the owner when M15 starts.

| Item | Effort | Contents | Notes |
|---|---|---|---|
| W1 Weather and wind | M | Wind on ballistics (SPEC 6.3 "wind later") and sound; rain and fog on spotting and sound; weather changing slowly in battle | |
| W2 Seasons | M | Mud, snow, ice, foliage; cold and heat on fatigue and on wounds | |
| FA1 Third faction | M per faction | Data pack plus strings | Candidates: US, Poland, Ukraine (owner) |
| FA2 Runtime packs | S-M | Load a data pack from a file in the app | |
| ED1 Scenario editor | M | | |
| ED2 Map editor | 2 × M | Heightmap image import and export | |
| RT1 Real terrain import | M | Offline tool first | SPEC lists it, but SPEC 3 wants fictional contingencies: owner decides first whether real ground is allowed (e.g. unnamed, generic use only) |
| SN1 Sound | M | Positional, only what your own men hear | |
| MP1 Deterministic maths | S-M | | Size from the F2 probe |
| MP2 Lockstep over a relay | 2 × M | | |
| PK1 Installable web app | S | Offline play from the home screen | **[pull-forward]** possible, Q7e |
| PK2 Desktop builds | M | | |
| BSR Surveillance radar | S-M | SPEC 8 reserved sensor | Deferred until asked |

### Summary

| Phase | Slices | Sessions (rough) |
|---|---|---|
| Finish M7.5e | 1 | 1-2 |
| M10 Medical (incl. kick-off, D1, D2) | 2-17 | 15-17 |
| D3 and D4 | 18-20 | 3 |
| M8 (incl. debt slot) | 21-29 | 9-11 |
| M9 (incl. D5) | 30-38 | 10-12 |
| M7.6 breadth | 39-42 | 4-5 |
| M11 (minimum to full) | 43-52 | 6-10 |
| M12 | 53-58 | 6-7 |
| M13 | 59-67 | 9-10 |
| M14 | 68-76 | 9-10 |
| M15+ | — | per item |

---

## Part 4: Proposed changes to the SPEC roadmap order

Owner questions are marked Q7; they go into round A screen 2 (Q7c, Q7d) or into the round named. The rest are
software decisions, recorded only.

**a. M10 Medical directly after M7.5e** (decided by the owner). Update SPEC §11 and ROADMAP in M10.0.

**b. Shared machinery** (software decision): M10.4, 10.5 and 10.6 build the carry store, rear points and off-map
vehicles generically; M11 reuses them. Record in DECISIONS and ARCHITECTURE.

**c. Tanks, wheeled carriers and missing organisations get a home (M7.6)** — Q7c (Phase 5).

**d. Stage C order after medical** — Q7d. The m11 notes measured 900 s batches; the app battle is 2400 s.
- (a) M8 → M9 → M7.6 → M11 (minimum, after its consumption measurement) → M12 → M13; M11's optional slices folded
  into M13 where they matter.
- (b) M8 → M9 → M7.6 → M12 → M11 → M13: persistence first, so consumption carries over and logistics matters; M12
  refills to the standard load until M11.
- (c) the SPEC order with full M11.

**e. Installable web app (PK1)** [pull-forward] — Q7e, asked in D3: (a) keep it in M15 (b) pull it into D3. (a) is
recommended: it keeps to the rule against building early.

**f. Sim in a worker** (software decision): moved into D3 only if the phone numbers show the sim is the bottleneck.

**g. Foundation probes early** (software decision): F2 cross-browser hashes and F3 4 km map in D3 (guards for SPEC
9.6 and 6.1, not features).

**h. Illumination split** (record only): rounds and data in M8.4, the light in M9.1, following the SPEC order.

### SPEC and ARCHITECTURE text changes, in the slice named

| Change | Slice |
|---|---|
| SPEC §11 / ROADMAP: M10 next, slices listed; M6.5 closed or carried | 10.0 |
| New foundation rows: contact sharing only through comms; environment save/load | 10.0 |
| `PhysiologyModel.step` gets an optional environment argument | 10.1 |
| Off-map entity state: vehicles arrive and leave mid-battle (reused by M11, M13) | 10.6a |
| `SoldierRecord.status` "evacuated", `recoveryDays`, `diedOfWoundsTick` | 10.6b |
| SPEC 9.1 note: air evacuation deferred if the owner picks Q-1f (a) | 10.6b |
| Breach propensity from unit quality only (SPEC 3, rule 8) | 10.7b |
| Cross-browser hash probe row | D3 |
| New foundation rows: supply-source query, whole-battle item conservation, attackable containers | M11 |
| SPEC 9.2: in a battle, fuel and batteries are tracked; they matter at roster level; the long scenario is the test bed | M11 |
| `campaign` may be imported by `app`; `campaign` never imports `ai` | 12.0a |
| Scenario kinds row (9.3) flipped to ✅ | 12.0b |
| SPEC 3 and real terrain (RT1): owner decision before any work | M15 |

---

## Part 5: Main risks and how the plan answers them

**The behaviour layer disappoints (SPEC 13).** Care, carrying and the laws of war add many per-man decisions.
- Debug overlay reasons in every medical slice; tactics pass D4 right after M10; owner play-tests in 10.8, 8.6, 9.6.

**Balance shock from medical.** Care and carrying take 2-4 men per casualty out of the fight, with 12-19 casualties
per side per battle.
- `--no-medical` A/B batches in every slice; carer caps; re-tuning only in 10.8 and D4.

**Performance.** `bench-vehicles` has about 20 % headroom, and every milestone adds per-tick work.
- Gates marked [perf] (10.3a, 10.4a, 10.4b, 10.5, 10.6a, 10.7a, 21, 24, 31, 34, 40, 45, 46, 68, 70, 71-72).
- Staggered systems that do nothing when idle; a real phone measured in D3.

**Golden churn.** Every data change regenerates the goldens.
- One update per slice with a DECISIONS line; the dead pre-interiors set deleted in M10.0.

**Battle length against the medical chain.** An ambulance takes 10-20 min; the app battle lasts 40 min, batches
15-20 min.
- End-of-battle settlement (Q-1e); batches at 2400 s at milestone ends; the long logistics scenario in M11.

**Hidden vehicle work.** The ambulances are the first German and Russian wheeled hulls.
- Their own data slice (12), reused by M7.6c.

**Weak data.** Every value is medium confidence at most; 182 entries are low today.
- A one-page table before each numbers review; SPEC 3 content rules checked in every owner option.

**Too many questions.** Screens of at most four, "accept all recommended" first; software choices never asked.

**Scope creep.** M8 keeps only the observer and light interfaces; M9 only the attack-drone and jamming hooks; air
evacuation, blood products and prolonged field care stay out of M10 unless the owner picks Q-1f (b).

**Determinism across devices (SPEC 13).** F2 probe in D3 before any multiplayer work.

**The owner losing track (SPEC 13).** STATE trimmed in M10.0 and every debt slot; a HOW_IT_WORKS chapter per
milestone; plain-language reports.
