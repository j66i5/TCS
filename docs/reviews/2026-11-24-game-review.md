# TCS: whole-game review (2026-11-24)

The owner asked for a review of the whole game for realism, function, fun, and how close it is to the plan. Six
reviewers each looked through one lens: infantry realism, vehicle realism, function, fun, the AI opponent, and the plan.
A seventh reviewer (the "skeptic") then re-ran the key claims to check them. All of it was done on main `309ab09`
(the live build is the one before it, `#110`, with the same game content). No game files were changed.

Labels used below:
- **Confirmed**: reproduced by the skeptic, or backed by code that was read.
- **Suspected**: one reviewer's evidence only, not re-checked.
- **Owner decision**: true as stated, but whether to act on it is your call.

One claim was dropped as refuted: that no guided missile was fired in seven mounted battles. A Konkurs was fired and
hit a Puma in one of them. Missiles are **rare**, not absent.

---

## 1. Verdict

TCS is a remarkably deep simulation sitting inside a game that is not yet fun to play. The parts are excellent and
well measured: ballistics, armour, wounds, sight through vegetation and at night, the medical chain, resupply,
repair, saves, determinism (the same battle always replays exactly the same). It never crashed in about 40 headless
scenarios and 30 browser battles. When the parts are put together into a battle, four things go wrong. The opponent
AI breaks down outside the "attack a village on foot" case. Battles are often decided in the first five minutes and
then run on empty until the 40-minute clock ends them. Germany against Russia is badly one-sided, partly for real
reasons and partly because of the model. And a phone player gets no briefing and has trouble seeing the fight. On the
plan side, every milestone up to M12 is built, but the SPEC's "stop after M6 and ask: is it fun?" check never
happened, and several milestones were closed with their targets unmet. Before M13, the work should be fixing and
accepting what exists, not adding more.

| Lens | Score (1-10) | One sentence |
|---|---|---|
| Realism: infantry | 6 | Excellent parts, but in battle the fire is too accurate, attacks rarely work, and a friendly-fire bug kills men. |
| Realism: vehicles | 7 | Armour, missiles and repair are close to public data; short maps and "harmless bounces" skew the results. |
| Function | 7 | Stable, deterministic and save/load-safe; two battle kinds misbehave and the menu hides most of the content. |
| Fun | 4.5 | Decisions matter and the men feel like people, but dead time, no briefing and poor phone readability hurt. |
| AI opponent | 5 | Good doctrine in the village foot attack; brittle in ambush, withdrawal and mounted defence, and easy to read. |
| Plan | 6 | M0-M12 are built and the hard rules hold, but the fun gate, acceptance targets, docs and phone testing slipped. |

---

## 2. What is strong

- **The building blocks are realistic and measured.** Hit chance by posture, training and range looks right (an AK prone at 300 m hits 49 %, standing 20 %). Helmets do not stop rifle rounds; plates stop 56-71 % of torso hits. A PKP pins men in 1-3 s. Sight through crops, hedges, woods, walls and windows works.
- **Armour and missiles are close to public figures.** For example 3BM60 is about 620 mm and DM63A1 about 680 mm. Relikt and Kontakt-5 are separate tiles that cover part of a face and get used up. Wire-guided, beam-riding and fire-and-forget missiles each behave in their own way (a Konkurs is lost in smoke). KETF is modelled down to its 162 pellets.
- **Logistics and medical care work.** Squads pass ammunition round correctly (6 of 6 lab trials). The medical chain runs from self-aid to the ambulance, and some treatments fail. Track repair takes two men 38-50 min.
- **It is stable and deterministic.** All 37 headless scenarios ran without error. There were no browser errors on phone portrait, phone landscape or desktop. A battle saved and reloaded continues tick for tick to the identical state. The project's own menu and campaign browser checks pass (9 of 9, 12 of 12).
- **Your men feel like people.** Units answer by radio ("lifting fire, our men are on the objective", mortars call "splash"), wounded men are named, and the after-action review is rich.
- **Your decisions matter.** In the Russian defence on foot, putting squads in houses, setting an ambush and calling mortars won a close fight, 8 lost against 25. That one battle felt like Close Combat.
- **The campaign briefing is good.** Mission, map, time, an enemy estimate and the forces to commit, with men who carry over from battle to battle.
- **The SPEC's hard rules hold.** No faction names in the code, no unseeded randomness. The golden replays (recorded reference battles that must replay identically) and the test faction both pass.

---

## 3. The biggest problems, ranked

**1. A rifleman shot his own comrade dead, then kept firing into the body (critical, confirmed).**
*What the player sees:* in platoon seed 1, Russian rifleman 71 hits soldier 73, who is crawling over to hand him a
magazine. 73 is killed at 243 s. Rifleman 71 then fires into the body 43 more times over four minutes, and later hits a
downed comrade 14 times. That is 59 of the battle's 149 hits, all on his own side.
*Why it matters:* it is the worst bug found. It skews the numbers and breaks trust in the game.
*Evidence:* `npm run headless -- --scenario platoon --seed 1 --seconds 1200 --events`, reproduced exactly. The fire-safety
check skips dead men (`sim/src/systems/fire.ts:236`) and any comrade within 0.15 m (`fire.ts:248`), but bullets still
strike those bodies.
*Fix (small):* treat any body a bullet can strike as blocking the shot, and never fire while a comrade is handing you
items in front of you. Add this seed as a regression test (a test that keeps the bug from coming back).

**2. Men cannot react to fire from an enemy they cannot see (critical, confirmed).**
*What the player sees:* in the "ambush" battle on foot, the ambushed German platoon walks on through the kill zone and
fires **zero** rounds while red fires 1,042. It is eliminated in 282 s, with 3 killed and 14 wounded. The same happens
on farmland (571 to 0).
*Why:* a moving man may only fire at enemies within 75 m. Return fire needs him halted. The "transit" orders keep him
walking. There is no immediate-action drill: go to ground, return fire, then assault or break contact.
*Evidence:* `npm run lab -- kinds 1 --kinds ambush --maps village --seconds 600` gives blue "last fire -1". Code:
`ai/src/postures.ts:234`, `sim/src/systems/decisions.ts:1402-1405`, `behaviour.json` moveEngageM 75. *Suspected,
same root:* in a mounted meeting battle the Germans sat under BMP cannon fire directed by a drone, saw no target,
laid no smoke and did not move, until they broke.
*Fix (medium):* a contact drill for units on the move, and area fire at the direction the fire comes from. Vehicles
already do this ("crewSuspects"). Add a lab check that fails when a side under fire never shoots back.

**3. Battles are decided early, then nothing happens until the clock runs out (critical, confirmed in code).**
*What the player sees:* in the German mounted attack, Russia had lost 22 of 49 men by minute 6, and both objectives were
German by minute 27. Then 13 empty minutes passed until "Time ran out". In the company meeting battle nothing changed
after minute 17. In the defence the first 11 minutes were empty. Even at the top speed (8x), a 40-minute battle takes
7 real minutes.
*Why:* a battle ends early only when every top unit of one side is broken, nobody is standing, or a side withdraws
(`sim/src/systems/objectives.ts:62-79`). One BMP crew left alive keeps the battle going. There is no "end battle" button.
*Fix (small-medium):* end the battle when one side has held all objectives for N minutes with no contact, or when a side
is below about 25 % of its men able to fight. Add a "claim victory" button and a "fast forward to contact" button.
Consider 20-minute quick battles.

**4. Germany against Russia is one-sided, and part of that comes from the model (major, confirmed).**
*What the player sees:* Pumas kill every Russian hull within 2-4 minutes at 650-900 m. In the campaign, Germany wins
100 % of operations and Russia 0 %. In a two-battle Russian campaign chain, the Russian player lost 51 and 62 killed
against the enemy's 2 and 4.
*Why:* some of the gap is real. A basic BMP-2 against a Puma is a generation apart. But the model adds to it:
- A kinetic round that does not penetrate does nothing at all. It cannot break sights, tracks or weapons, so a BMP-2's 30 mm cannon is useless against a Puma (`sim/src/systems/armour.ts:383-424`; listed as a known limit in DECISIONS).
- The mounted maps are 1200 x 900 m, so every armour fight happens at 600-980 m, inside the Puma's best range and too short for Russian guided missiles to pay off (`scenario/src/battle.ts:48`).
- Russia's present-day tools are not in yet: FPV drones, Lancet loitering munitions, electronic warfare and mines (planned for M14).
- *Suspected:* Russian carriers stall short of their dismount point (5 of 6 BMP-2s) and never set up support posts.

*Fix:* balance pass 6 (already queued) plus damage from non-penetrating hits (medium), longer maps for open-ground
battles (medium), and a reason logged for every carrier that stalls (small). *Owner decision:* bring one FPV or Lancet
asset forward from M14, or offer the BMP-2M as an option.

**5. The start menu hides most of the battles that were built (major, confirmed).**
*What the player sees:* Quick battle offers only attack or defend at platoon size. The meeting, ambush, withdrawal and
counter-attack battles and the company-size battles all work, but only through a hand-typed web address. The menu also
says "One platoon battle", yet the attacker gets two platoons (8 Pumas, 66-78 men).
*Evidence:* `app/src/menu-model.ts:30-41` writes no battle kind and no size; `strings.en.json:1357`; `scenario/src/battle.ts:55`.
*Fix (small):* add "Battle type" and "Size" choices and fix the wording. Fix problem 2 first, or the ambush battle will look broken.

**6. A new phone player does not know what to do or what is happening (major; partly suspected).**
*What the player sees:*
- No briefing in a quick battle. The objectives appear only as text, and the help card lists only gestures (confirmed).
- The default fire rule is "Return", even when you attack. With it, the first German attack stalled. *Owner decision:* you confirmed this rule on 2026-11-12; it may be worth asking again for attacking players.
- *Suspected:* at zooms that show a platoon, everything is symbols; old "9 min ago" enemy pins pile up; "enemy drone overhead!" floods the 4-line radio log. In phone landscape, the unit card and the radio log cover most of the map once a unit is selected.

*Fix:* reuse the campaign briefing card for quick battles (small). Open the battle zoomed to show your force and the
objectives. Collapse the card to one line. Report each drone once per unit (small each).

**7. Infantry fire and movement rarely works, and squads break on a timer (major, confirmed).**
*What the player sees:*
- The supported squad attack lab succeeds in 15 % of runs (3 of 20). In 14 runs the attacker "broke" at 123-126 s, which is exactly the minimum break time of 120 s (`behaviour.json:162`). So a timer decides the end, not the fight. The defenders lose 0.6 of 6 men while 767 rounds are fired at them. Earlier records range from 5 % to 40 %, so the number is noisy; the timer is the solid finding.
- The house-clear showcase never reaches the clearing drill. Seed 1: no shot in 15 min. Seeds 2-4: the German squad in the house broke after 2-4 minutes with one man killed.
- In some attacks the riflemen barely fire: 32 Russians fired a mean of 1 round each. In one mounted battle no dismounted man fired at all.

*Fix (medium):* fire at cover should suppress the men behind it more. The break should depend on losses and suppression
over time, not a fixed timer. A held building should stiffen a squad. Add an acceptance test that the house-clear battle
enters a room in most seeds.

**8. The plan's own checkpoints were skipped (major, confirmed).**
- No "is it fun" verdict was ever recorded: the word does not appear in DECISIONS or STATE. You have played and asked for changes, but no milestone has a recorded "played it, accepted".
- Milestones were closed with their targets unmet. M10: preventable deaths 30 % lower against a target of at least 40 %. Also M7.6b and M7.5e. (M12 is honestly marked 🟡.)
- The guided tour HOW_IT_WORKS still says "no first aid, no AI beyond wander" and "321 tests" (there are now about 1,700). STATE is 872 lines and lists things that are gone (the classic look) or since built (evacuation).
- Real-phone performance has never been measured.
- CI (the automatic check-and-deploy on GitHub) failed on 2 of the last 6 merges because a speed test missed by under 1 %, so the newest main never went live.

*Fix:* see section 9.

---

## 4. Realism

**Infantry.** The parts are among the best in the genre. In the assembled battle, three things are off:
- **Fire is too accurate (suspected).** Unsuppressed defenders hit at about 3 shots per hit at 130-330 m, and German marksmen scored 32-36 hits from 84 shots. Bullets cause 60-85 % of wounds. In real fights it takes hundreds of rounds per hit, and most casualties come from fragments. The code itself notes that target movement is not yet in the aiming error. Overall, the skeptic's run gave about 38 shots per hit, so this needs a dedicated lab before anything is tuned.
- **Most men hit by a rifle round fight on.** About half of all hits leave the man able to fight. That was your decision ("the wounded carry on, impaired"). Combined with the high hit rates, firefights become attrition by bullets. Worth a second look.
- **Smaller points (suspected):** 92 % of first hits on a side-on man land on the arm. A still man on a moonless night is seen at 300 m in 33-50 % of runs, which is too often.

**Indirect fire (confirmed numbers; "too weak" is a judgement).**
- A 155 mm shell wounded 25 % of standing men at 25 m and **none** of the prone men, whether it burst on impact or in the air.
- A 120 mm bomb wounded 6 % of standing men at 25 m. An 82 mm bomb wounded none at 25 m.
- Air bursts are meant to reach prone men, so the air-burst geometry is clearly wrong.
- The Puma's KETF also does no better than impact HE against prone men.
- Fragments need calibrating against published lethal areas.

**Vehicles.**
- Penetration, reactive armour, missile types, repair times and drone sensors are all believable.
- Weak points: hits that do not penetrate are harmless (problem 4), and each face of a hull is one plate. There is no weak lower glacis or mantlet, and no skirted versus engine-bay side. That is why 30 mm goes through a T-90M's side anywhere along its length, and why a full-Relikt T-90M front stops DM63A1 every time.
- Tanks hit 100 % at 3,000 m and on the move (small samples). That is optimistic, but rarely matters on 1 km maps.
- The Panzerfaust 3 hits only 25 % at 300-400 m, worse than the RPG-7, because the model does not know about its Dynarange laser rangefinder sight (code confirmed: `launcher.ts:405`).
- Fire support answers fast (mortars 60-75 s, guns 150-180 s), and nearly the same for both sides.

**Germany vs Russia overall:** the campaign result (Russia 0 of 8) should **not** be read as a real-world verdict. The
model leaves out Russia's equalisers and keeps fights inside the Puma's best range.

---

## 5. Function and bugs

**What works (all confirmed in the browser):**
- Touch and mouse orders: select, route, Go, Halt, Fire.
- Speeds of exactly 1, 2, 4 and 8x, and pause.
- Unit folding; the review with four tabs; hold, assault, sandbox, company, night and red-side battles.
- Save/load to the identical state.
- The campaign, from briefing through auto-resolve to "what changed" and Continue.
- Menu screens never scroll sideways at 360, 780 or 1,400 px.

**Bugs and rough edges:**

| Issue | Status |
|---|---|
| Friendly fire through a comrade handing over a magazine (problem 1) | confirmed, critical |
| Ambushed side never fires (problem 2) | confirmed, critical |
| In a withdrawal the pursuing side never makes contact: closest 518 m, 0 shots in 600 s on all 4 maps | confirmed |
| The kinds lab's "0 stalemates" counts off-map mortar rounds as fighting, and runs only 600 s; it missed battles with no rifle shot in 10 min | confirmed (`tools/src/labs/kinds.ts:26`) |
| The radio shows raw codes: "Order not accepted (invalid-params)" | confirmed |
| A battle saved while paused runs on straight away after Load | confirmed |
| "Puma 1: unable to comply." gives no reason | suspected |
| Two Russian squads both called "Gruppa 1" | confirmed |
| Phone landscape: the card and radio cover the map; the "Shtur..." tile label is cut off | suspected (screenshots by one reviewer) |
| Campaign auto-resolve runs the flank and main battles one after the other: 146 s here, possibly many minutes on a phone | confirmed |
| A company battle at 8x costs 33-52 ms of sim time per frame on this machine; it may not keep up on a phone | suspected |

---

## 6. Fun

The fun reviewer played three full battles on a phone-sized screen.
- **German mounted attack:** decided at long range in minutes, then empty.
- **Russian defence on foot:** tense and close; your choices mattered. The best battle.
- **German company meeting battle:** decided by minute 17, then 23 empty minutes.

What hurts most:
- **Dead time** (problem 3).
- **No briefing** (problem 6).
- **You rarely see the fight on the phone**: the killing happens at 700-1,700 m, while your men are shown as figures only when about 45 m fits across the screen.
- **Hidden content** (problem 5).
- **No difficulty or force choice.**

What helps:
- Men who talk back.
- Choices that matter.
- The campaign's carried-over soldiers.
- The review. It is thorough but long: it lists 100+ men, including the unhurt ones, and has no "Play again" or "Swap sides".

**First thing a new player should meet:** the battle on foot in a village. It is the one kind that is already fun.

---

## 7. The opponent (AI)

**Good:** in a village attack on foot, the AI runs a recognisable drill:
- approach, a base of fire, and individual fire orders;
- mortar HE and smoke, grenades, a reserve held back;
- withdrawal at its casualty limit.

The defence re-sites blind squads, falls back to rally points, and routs under sustained fire. Vehicle crews log why
they hold or fire.

**Weak:**
- **No reaction to unseen fire** (problem 2).
- **The mounted defence barely fights.** In one battle, 37 defenders fired 23 rifle rounds in 12 minutes. Reserves counter-attack straight into the Pumas' guns; mounted ambushes are spotted at 213 m and wiped out.
- **Timeouts set the pace.** The foot attack waits for a 600 s timer. In the house-clear battle the attackers start 200 m away and nobody fires for 12 minutes.
- **The withdrawal is never pursued.**
- *Suspected, exploitable:* the defence faces one direction fixed at the start and never turns. The counter-attack is one squad sent straight at the objective. The attacker picks its flank once and never changes it. A player who learns this can flank the defence every time.
- Defenders in houses sit blind for long spells even when another window could see the enemy.

**Next AI work:** adapting to the enemy (fronts, flanks, unseen fire) and the new battle kinds, not more drills.

---

## 8. Against the plan

| SPEC / ROADMAP item | Status | Note |
|---|---|---|
| SPEC 4.3 hard rules (determinism, orders only, no faction in code, test faction) | built | Tests pass. |
| M0-M6 core battle (squads, fire, suppression, wounds, AI attack/defence) | built | Supported attack only 15 %. |
| SPEC 11/13 "stop after M6: is it fun?" | **missing** | Never recorded. |
| M7 vehicles, tanks, wheeled carriers, assault group | built / partly | M7.6b and M7.5e targets missed. |
| M8 look (photo, flat), M9 night, sensors, missiles, drones | built | ROADMAP is missing the M9.1-M9.3 entries. |
| M10 medical | partly | Built; preventable deaths -30 % against a target of ≥ -40 %. |
| M11 logistics, repair, recovery, prisoners/MP | built | Prisoners and MP were an owner request beyond the SPEC. |
| M12 campaign, kinds, company size | partly (🟡) | Germany 100 % / Russia 0 %; your phone test is pending. |
| SPEC 6.9 after-action **replay** | missing | The review has no playback. |
| SPEC 6.10 "slow" speed | missing | There is no 0.5x. |
| SPEC 4.4 real time on a mid-range phone | unmeasured | Only a rough stand-in measurement: 8-10 fps. |
| SPEC 4.4 ≥ 8x headless | marginal | Spotting 7.3-7.9x, vehicles 7.6-7.98x on this machine. |
| SPEC 7 Russian scope: FPV, loitering munitions, EW | missing | Planned for M14. |
| SPEC 4.2 package layout (soldier AI in `ai`) | drifted | It lives in `sim`; not recorded as a change. |
| SPEC 1 / 10: docs current, main always deployable | drifted | HOW_IT_WORKS and STATE stale; CI failed 2 of 6. |
| Data plausibility (owner reviews data) | drifted | 579 low / 133 medium / 2 high confidence; your data reviews are still open. |

**What it means:** M13 (the dynamic campaign) builds on an M12 that is not accepted yet. It would also make phones
auto-resolve many more battles, and one campaign stage already takes 3-18 minutes. The plan's own first step, M13.0
(faster auto-resolve), should come first. Even before that, the gates above should be closed.

---

## 9. Recommended next steps (ranked)

1. **Fix the friendly-fire bug**, with a regression test from platoon seed 1. *Small.*
2. **Contact drill and fire at unseen shooters for infantry**: ambush, meeting and mounted defence. Make the pursuer close in a withdrawal. Make the kinds lab fail on "a side never fires" and "no casualty for X minutes". *Medium.*
3. **End battles sensibly**: objectives held for N minutes with no contact, or a side below 25 % able. Add "Claim victory" and "Fast forward to contact". *Small-medium.*
4. **Balance pass 6** (queued), plus damage from non-penetrating hits, a stall reason and re-route for carriers, and a Panzerfaust 3 rangefinder. *Medium-large.*
5. **Quick battle polish**: battle type and size in the menu, correct wording, a briefing card, open zoomed to the force and the objectives, one-line card in landscape, drone radio de-duplicated, clear rejection messages. *Medium.*
6. **Infantry attack realism**: suppression of men behind cover, a loss-based break instead of the 120 s timer, resolve in buildings, fragment and air-burst calibration. *Medium.*
7. **Close the plan gates**: rewrite STATE to one screen; update HOW_IT_WORKS; add a "built, target not met" status in ROADMAP; give CI speed tests noise margins; then your phone play session with a recorded fun verdict and `?perf=1` numbers. *Small-medium.*
8. **Then decide M13 against M14** (see Q2).

### Owner questions (multiple choice, recommended first)

**Q1. What should come before any new milestone?**
- (a) **Fix and accept what exists: steps 1-7, then your phone play test** (recommended)
- (b) Only the bug fixes (steps 1-3), then go on with M13
- (c) Go straight on with M13 as planned

**Q2. Which big milestone next?**
- (a) **M14 first: FPV drones, Lancet, electronic warfare** (adds present-day realism and gives Russia its equalisers) (recommended)
- (b) M13 first: the dynamic campaign map
- (c) A smaller step: bring forward one FPV/Lancet asset per Russian company, then M13

**Q3. How should a quick battle end once it is decided?**
- (a) **Automatic end when the objectives are held with no contact for a few minutes, plus a "Claim victory" button** (recommended)
- (b) Only a "Claim victory" / "End battle" button
- (c) Keep the 40-minute clock, but make quick battles 20 minutes

**Q4. Default fire rule for the player's own units?**
- (a) **"At will" when attacking, "Return" when defending** (recommended)
- (b) Keep "Return" everywhere (your 2026-11-12 choice) and add a first-battle tip
- (c) "At will" everywhere
