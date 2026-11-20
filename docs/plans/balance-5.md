# Balance pass 5: Germany against Russia in the mounted battle (plan)

**Progress:** plan written 2026-11-20 (branch `claude/balance-5`, from main d4bb676, after M12); revised the same day
with the owner's two new features (section 3) and his order of work. 2026-11-20: the fix list (section 2, F0-F10) built, F8 covered by F1 (no siting change); DECISIONS "Balance pass 5" has what changed and the quick ledger. 2026-11-20: 3A, the mounted assault, built (DECISIONS "Balance pass 5: the mounted assault"; `npm run lab -- mounted-assault`, `--scene assault-mounted`). 2026-11-20: 3B, area fire and air burst, built (DECISIONS "Balance pass 5: area fire and air burst"; `npm run lab -- areafire`, `--scene areafire`). Next: the owner's pause, then section 4.

**Order of work (owner, 2026-11-20, binding):** finish the diagnosis and fix the bugs it found (section 2), pause
before the final measuring, build the two features the owner asked for (section 3: mounted assault, area fire with
HE / airburst), THEN measure and set the campaign values once (section 4). Quick ledger checks per fix are allowed;
the 20-run batches and the campaign batches run only after the features.

**Why.** M12.4 (DECISIONS "2026-11-20 — M12.4") found the DE / RU gap in the mounted battle, not in the campaign's
numbers: RU as player won 0 of 8 operations, DE 8 of 8; DE's minimum commitment (one Puma platoon + company HQ) beats a
motor rifle company in BMP-2s. The platoon scenarios are closer (platoon-vehicles DE attacking 13/20, platoon-ru-vehicles
RU attacking 8/20). The owner answered "Balance pass next" (2026-11-20): balance the mounted battle (Puma against BMP-2),
then set the campaign values from its results.

**Principle (SPEC, realism).** Fix bugs, data errors and AI gaps on both sides. A genuine, sourced capability gap stays
and is answered by the campaign's `fightingValue` (a game value, low confidence). The Russian side is not made better
than it is. Data edits follow the add-data-entry skill (search extracts only: confidence "medium" at most).

**Owner answers to record in DECISIONS (all already built that way, no change):** wounded keep their real recovery
times (no campaign scaling); the fittest company is proposed (companies rotate); crews of lost or workshop hulls rest.

**Owner request (2026-11-20, binding, his words):** "Make assault work for vehicles as well. If infantry are riding,
the vehicles will stop a sensible distance from the objective, let infantry dismount, fall back slightly to provide
support for the infantry that goes the final stretch. Make vehicles fire more near areas where they believe enemy
infantry is, even if they don't see them anymore. For this, they can use HE / airburst munitions, as they do in real
life." (A start menu is built on another branch: not part of this pass.)

## 1. Diagnosis (three agents, cross-checked)

Three diagnosis agents worked on main d4bb676: a kills ledger (12 platoon battles at 1200 s, seeds 1-6 each; two
campaign operations, seed 300, DE and RU as player), a sensors study (crew duels, a crew looking for one man, the
approach lab, day and night) and a weapons study (armour, missile, gunnery, mount and antitank labs; 9 mounted battles
with per-tick traces). Scratch tools and outputs: `<scratchpad>/bal5/` (ledger.md, duel-*.txt, crewmen.txt,
weapons/*.txt). All battles were by day: the campaign sets no `environment.sky`, so light is 1 and night findings do
not move the campaign numbers.

Where RU's losses come from (ledger): the Puma causes 76-85 % of RU casualties in every set. 30 mm APFSDS kills the men
aboard BMP-2s (30-45 % of all RU casualties: 75 of 200 in the DE-player campaign); 30 mm impact HE kills dismounted men
at 0.5-1.6 km (40-45 %). What RU almost never does: penetrate a Puma's front with 30 mm (0 in more than 220 hits), fire
its Konkurs (3 launches in 18 BMP-2 platoon-battles with DE attacking, 0 in 36 with RU attacking), see the Pumas (BMP-2 crews
9 first sightings of Pumas against the Pumas' 287 of BMP-2s), fire its Metis-M (1 launch in 12 battles) or its RPG-7s
(0 in 9).

### Cross-check

Code read for every cited line; the claims hold:

- `commander.ts:880` `hitNow` is true when any carrier crew of the side has a new `lastHitTick`; `commander.ts:1654`
  dismounts every squad still riding on `hitNow`, wherever its carrier is. **Confirmed.**
- `gunnery.ts:772-781` `missileReady` returns null above `missileHaltedMps` 0.3 m/s; `natureFor` (gunnery.ts:330-334)
  then falls back to `"ap"` even when `apCanPierce` is false. Nothing re-runs the choice when the hull halts.
  **Confirmed.**
- `missileCanPierce` (gunnery.ts:842-848) calls `faceNeed`, which knows only front / side / rear from the bearing; the
  Spike's `guided.topAttack` is never considered. **Confirmed** (bug). Beyond `missileBeyondM` 1000 m the missile is
  chosen as "far", which is why the duels show the Puma launching Spike first at 1000-2000 m while the platoon
  battles (Pumas against T-90M fronts at 500-900 m) show 0 Spike launches.
- `chooseTarget` scores `distance x vehicleScore x firingScore` and nothing else (gunnery.ts:280): no account of a
  friendly missile in flight at the target or a hull just penetrated. **Confirmed.**
- `missileSees` / `missileSeesTarget` (gunnery.ts:748-769): line, visibility >= 0.2 and smoke only, no light or sensor
  term. **Confirmed** (bug at night only).
- `vehicleTargets` marks a hull firing for `firingWithinSeconds` 2 s (spotting.json; spotting.ts:644), while crewmen
  and men on foot look for vehicles only every fourth scan (`VEHICLE_SCAN_EVERY` 4, spotting.ts:221, 742): a single
  shot or a missile launch is seen as "firing" by about half the scans. **Confirmed** (bug).
- `core/spotting.json` `vehicle-night-ir` `maxRangeM` 3000 (BMP-2 gunner, BTR-82A); men on foot `maxRangeM` 1200.
  **Confirmed.**
- `ru-relikt-hull-side` `triggerSteelMm` 150 against PMC287 132.5 mm: `faceNeed` and the hit leave the tile out for the
  30 mm round. **Confirmed** (plausible: small-calibre APFSDS is not expected to set ERA off; data check only).
- `factions/de/campaign.json` fightingValue 3.0, `ru` 1.0, `core/campaign.json` `enemyCapScale` 1.0. **Confirmed.**

Where the agents disagree or the evidence is thin:

- **Hull-against-hull sighting.** The sensors duel says even by day in the open (Puma sees a BMP-2 at 1500 m in 4.9-6.0
  s, the BMP-2 the Puma in 7.8 s); the weapons trace has six BMP-2s with no own sighting of Pumas firing at them from
  680-850 m for 400 s. Both can be true: in battle the Pumas fire from hull-down posts (turret only, about a third of
  the area) and single shots are half missed (the firing-window bug). Decision: fix the firing window first, then a
  spotting-lab row (a day-sight crew against a hull-down Puma firing bursts at it from 800 m) decides whether anything
  remains. No sensor change for the BMP-2 itself (it has no thermal sight: real).
- **Konkurs against the Puma's front.** The armour lab says through on every face (937 against 750 hull front, 700
  turret front); the sensors duel at 1000 m shows 7 Konkurs hits and 0 penetrations. Most likely the hits come after
  the launcher was killed (the Puma kills in 5.7 s, the missile needs about 5 s to fly 1000 m; a wire missile without
  its gunner flies on unguided) and are counted as hits on ground or a wreck. Decision: check in step F0 before any
  missile fix (event trace of one duel seed); a real armour error would be a data fix.

### Causes and decisions

Kinds: bug, data error, AI gap (fix, both sides, symmetric code); real asymmetry (keep, sourced; answered by
fightingValue); unknown (check, then fix or keep). Side: whom it hurts.

| # | Cause | Hurts | Kind | Evidence (short) | Decision |
|---|---|---|---|---|---|
| C1 | Puma 30 mm APFSDS (PMC287 132.5 mm) penetrates every BMP-2 face; men die aboard | RU | real asymmetry | 282 of 306 hits through (DE-player campaign); BMP-2 needs 45 mm hull front, 23 side; 30-45 % of RU casualties are men aboard | **Keep.** Sourced (BMP-2 proof against 12.7 mm frontally). The AI exposure part goes to F4 |
| C2 | Puma 30 mm impact HE kills dismounts at 0.5-1.6 km; the BMP-2's HE does little | RU | real asymmetry | Puma 1052 HE rounds for 87 casualties, BMP-2 76 for 1; Puma LRF, 0.3 mrad, stabilised; BMP-2 no LRF, 0.6 mrad, 0.8 mrad per m/s | **Keep.** Real fire-control gap (Puma's ABM airburst not even modelled) |
| C3 | No thermal sight on the BMP-2: finds hidden men far worse | RU | real asymmetry | crewmen lab: prone in crops 200 m, Puma 9/12 against BMP-2 0/12; prone in the open 300 m 10 s against 52 s | **Keep.** BPK-2-42 / TKN-3B have none. BMP-2M Berezhok is an owner question (Q1) |
| C4 | Whole side dismounts on the first hit on any carrier, 1.2-1.5 km out; infantry walks into Puma HE | both (RU in practice) | AI gap | commander.ts:880 / 1654; RU squads out at 68-114 s, 1.2-1.5 km from the Pumas, DE at 101-271 s; RU men see only 1200 m | **Fix** (F4) |
| C5 | Hulls fire AP at faces it cannot pierce (BMP-2 at Puma fronts, Puma at T-90M fronts) and show themselves (firingFactor 15) | both | AI gap | BMP-2 AP on Puma fronts 172 + 31 + 13 + 9 hits, 0 through; Puma 240 of 240 T-90M front hits stopped | **Fix** (F1) |
| C6 | The BMP-2's Konkurs is almost never fired: halted-only, the cannon is chosen while moving and the choice is not re-checked | RU (same code for the Puma's MELLS) | AI gap | 3 launches in 9 traced battles; seed 3: V92 fired ~25 AP rounds into a Puma front at 570 m with a missile ready and the line clear (vis 0.78-0.88) while reversing at 1 m/s | **Fix** (F1) |
| C7 | BMP-2 crews rarely see a Puma for themselves, even one firing at them from 840 m | RU | unknown | prv seed 1: no own sighting for 400 s, only reported; duel says even in the open | **Check after F3** (spotting-lab row); allow a missile task on a precise reported hull contact once the gunner's own missile sight sees it (F3b) |
| C8 | Top-attack Spike judged against front armour: Pumas never use it within 1000 m | DE | bug | gunnery.ts:842-848; Spike 875 against T-90M front 944 / 1079, roof 20-40 mm; 0 Spikes in the platoon battles | **Fix** (F2) |
| C9 | Missiles and tank rounds pile onto one target | both (RU more: 40 s missile reload) | AI gap | pv seed 1, 37-40 s: three Konkurs and two 125 mm rounds at Puma 1, four Pumas within 1 km left alone | **Fix** (F5) |
| C10 | The firing window (2 s) is shorter than the crew's vehicle scan (4 s); a guided missile's launcher is not shown while it guides | both (slightly pro-RU) | bug | spotting.ts:644 vs 221 / 742; dbg seed 2: no Puma crewman saw the Konkurs launch (scans 2.0 and 3.0 s after) | **Fix** (F3) |
| C11 | Metis-M team never fires: stays at its start, fires only at hulls its men saw within 6 s | RU | AI gap | 0 launches in 9 traced battles, 1 in 12 ledger battles; team at seen=0 for 330 s, 300 m behind its post. Balance pass 4 tried posts and failed ("no shot" loop) | **Fix** (F6), with the BP4 lesson: site on the predicted line to the enemy's overwatch posts |
| C12 | A tank left alone sits idle on overwatch with only wreck contacts | both | AI gap | prv seed 1: V53 idle 210-405 s, live Pumas 836-906 m away | **Fix** (F7) |
| C13 | RU ambush engages Puma fronts at ~700 m | RU | AI gap | ru300-2: 172 front AP hits, 0 through; 9 of 10 BMP-2 lost | **Fix** (F8): hulls that cannot pierce the expected front hold fire for the side |
| C14 | Company meetings open at 1.6-1.9 km, inside DE's reach and beyond RU's | RU | real asymmetry | Leopard sees a BMP-2 at 0.3 s at 1862 m; Puma engageRangeM 2000, 2A42 1500; RU first sighting at 25-46 s | **Keep** (start distance is a scenario value; Q3) |
| C15 | 2A42 engagement range 1500 m against the MK30's 2000 m | RU | real asymmetry | vehicles.json station data | **Keep** (sourced; no LRF on the BMP-2) |
| C16 | Puma 30 mm APFSDS through the T-90M hull side (Relikt not triggered by 30 mm) | RU | unknown | 254 side-hull hits, 39 through; 7 of 10 T-90M lost to PMC287 in platoon-vehicles | **Check** (F10): sources for Relikt against small-calibre APFSDS and the side plate at the crew compartment; change only if sourced |
| C17 | T-72B3M carousel round 3BM42; the B3/B3M autoloader is widely reported to take 3BM59/60 | RU | data error (likely) | data note itself marks it low; 3BM42 575 mm at 2000 m stopped by the Leopard 2A7V front | **Fix if sourced** (F10), confidence at most medium |
| C18 | PG-7VL maxRangeM 300 against PzF3 400 (halted target) | RU | data consistency | ammunition.json notes | **Check** (F10): the same halted / moving rule for both launchers from sourced figures; the Puma's stand-off itself is real |
| C19 | `vehicle-night-ir` reaches 3000 m (BMP-2 gunner, BTR-82A) | pro-RU at night | data error | BPK-2-42 night channel 400 m passive / 800-900 m active (search extracts); approach lab: BMP-2 kills a Puma with Konkurs at ~2940 m at night, 10/10 | **Fix** (F9): sensor kind `vehicle-night-gen1` ~800-900 m |
| C20 | BMP-2 commander's TKN-3B night channel missing | RU at night | data error | commander seat vehicle-day only; TKN-3B active IR < ~400 m | **Fix** (F9), confidence low |
| C21 | A missile is guided at night through a day sight | pro-RU at night | bug | missileSees has no light term; 9Sh119M1 is a day sight | **Fix** (F9) |
| C22 | Leopard 2A7V a larger visual target than the T-90M | DE | real asymmetry | front 13.3 against 8.5 | **Keep** (real dimensions) |
| C23 | T-72B3M commander may have a thermal panoramic sight | RU | unknown | sources conflict (Army Technology / Army Recognition yes; War Thunder wiki TKN-3MK) | **Keep** (Q4) |
| C24 | Infantry optics: G36 / MG5 magnified against AK / PKP iron | RU | real asymmetry | ×1.4 only within ±10° beyond 150 m | **Keep** |
| C25 | Defence range rule (300 m) keeps RU riflemen silent at 500 m | both (defender) | AI gap (minor) | 201 RU rifle rounds against DE 1981 in 5 battles; option built and switched off in BP4 | **Keep** (Q5); not re-measured unless the band fails |
| C26 | Campaign: RU enemy capped at one company, so fightingValue cannot help when DE is the player | campaign | real asymmetry (rule) | DE-player nodes at the cap: 110-122 RU men against 124-136 DE | **Retune after the fixes and features** (section 4); Q2 if DE-as-player stays above 70 % with RU at its cap |

Dropped: none outright; C7 is dropped as a sensor change (the BMP-2's sights are right) and kept only as the
firing-window bug (C10) and the reported-contact missile task.

### What the owner's features address (so nothing is built twice)

Read for the features (2026-11-20): the AI commander already has a mounted approach (`ai/src/commander.ts` "start" ->
"ride": carriers drive to a dismount point `dismountM` short of the objective, the nearest one out of sight of the
objective's near edges, slots `vehicleSlotM` 60 m apart; squads get out on arrival, `hitNow`, `atThreat` or
`rideTimeoutSeconds`); the doctrine values are sourced per faction (`factions/de/doctrine.json` `dismount.distanceM`
300, low, `afterward: "overwatch"`; `factions/ru/doctrine.json` 400, medium, `afterward: "follow"`, `followM` 150);
after the dismount the hulls bound in overwatch (`overwatchBounds`, ai/src/tanks.ts:527) and the commander orders
"support by fire" every 20 s at enemies its side knows within 150 m of the objective (commander.ts:1524). The player
has none of this: an Assault order to a mounted squad finds no men on foot (`drillGroups` uses `footSoldiers`) and is
"unable"; a hull cannot take an Assault at all. Vehicle crews choose targets only from contacts seen within 4 s or
reported within 15 s (`chooseTarget`), so a crew stops firing at men 15 s after it loses them; men's contacts are kept
120 s (`spotting.json` `conceal.forgetSeconds`) with 1 m/s drift. HE is impact-fused everywhere; DM11's air-burst mode
and the Puma's KETF round are not modelled; the sim already bursts mortar rounds in the air (`airburstHeightM`,
explosions.ts:130) and has a forward fragment cone for spall (armour.ts:247).

| Cause | Fix step | Feature that also touches it | Rule |
|---|---|---|---|
| C4 whole-side dismount far out | F4 | Mounted assault (A): the per-carrier dismount trigger is the same | F4 builds the trigger as a pure sim helper (`shouldDismount(state, carrier, squad)` in `sim/src/mount.ts` or a new `sim/src/systems/assault-mounted.ts`), used by the commander now and by the drill in A. The terrain-aware dismount point moves into the same module in A (the AI then calls it). F4 does not rework the dismount point. |
| C1 men killed aboard (exposure part) | F4 | A: carriers stop at the doctrine distance and back into a support post | No separate fix; measured after A. |
| C12 tank idle with only wreck contacts | F7 | Area fire (B) gives it suspected targets | F7 (bound forward after 60 s with no live target) stays: area fire does not move the hull. |
| C5 AP at faces it cannot pierce | F1 | B never fires AP or missiles at an area | F1 alone. |
| C25 defence riflemen silent at 500 m | (kept, Q5) | B: the defence's hulls fire HE at suspected men, which answers part of the "no reply" feel | Re-measure after B before reopening Q5. |
| C2 Puma HE kills at range | (kept) | B adds KETF air burst: DE gets stronger | Expected; recorded; answered by fightingValue. |
| Commander support fire (commander.ts:1524) | - | B: area fire is the crews' own; A: the hulls' support post | In B the commander's support-fire block issues the same area-fire order the player uses (one code path); no second targeting rule. |

## 2. Fix list (ordered)

Each step: symmetric code (no faction literals), a lab row that shows it, `npm run check` alone, then
`npm run golden:update` and a DECISIONS line for any intended replay change, commit and push. Re-run the 6-seed ledger
(`<scratchpad>/bal5/ledger.mts`, platoon-vehicles and platoon-ru-vehicles, 1200 s) after F1-F4 to see each effect
before going on.

- **F0. Check the Konkurs duel at 1000 m** (7 hits, 0 through against the armour lab's "through"): event trace of one
  `duel.mts` seed. If it is a real armour or fuse error, fix the data first; if hits after the launcher died, note it.
- **F1. Missile and AP choice (C5, C6).** In `natureFor` / `chooseTarget`: when the target is a hull, AP cannot pierce
  the face shown and a missile on the rail could (`missileCanPierce` + `missileSeesTarget`), choose `"atgm"` even while
  moving and set a short drive hold (as `playerHold` does) so the hull halts for the launch and the guidance, then goes
  on with its route; re-run the choice when a moving hull comes to a halt. When neither can pierce: no AP at that face;
  take another target (HE at men, a hull showing its side), else hold (and while the missile reloads, no fire that
  only shows the hull). Lab rows: missile lab, a BMP-2 on a slow reverse route against a Puma head-on at 600 m launches;
  gunnery lab, a BMP-2 with no missile left does not fire AP at a Puma front.
- **F2. Top-attack faces (C8).** `missileCanPierce` (and any missile-face judgement) uses the roof plate (hull top /
  turret top, with roof tiles if any) for ammo with `guided.topAttack`. Lab row: Puma against a T-90M head-on at 600-800
  m, fire free: own choice = missile.
- **F3. Seeing a firing hull (C10, C7).** A hull counts as firing for at least `VEHICLE_SCAN_EVERY x scanSeconds` after
  a shot, and for the whole guidance of a wire- or beam-guided missile (`st.guide` set). F3b: a halted missile carrier
  may lay on a precise reported hull contact (`reportedWithinSeconds`, `reportedErrorM`) and fire once its own missile
  sight sees the aim point. Then the spotting-lab row for C7 (day-sight crew, hull-down Puma firing bursts at 800 m).
- **F4. Dismount per carrier (C4).** Built as a pure sim helper the mounted-assault drill (3A) reuses. The trigger becomes per squad: its own carrier hit, a hit on a carrier within
  about 300 m of it, or `atThreat`; the timeout stays. After a long-range dismount the squad goes to ground or moves by a
  covered route, and the empty carrier backs into defilade (the existing hull-down siting) instead of standing in the
  open. Measure dismount distance and men killed aboard in both directions.
- **F5. Fire distribution (C9).** In `chooseTarget`: a penalty (about ×3) for a target a friendly missile is already
  guided onto (any own-side `st.guide` with that target), a smaller one for a target a section mate engaged in the last
  few seconds or one penetrated or immobilised recently.
- **F6. Missile team posts (C11).** Site the team (kneeling `sightHeightM`, `siteHullDown`-style scoring) on the
  predicted line to the enemy's likely overwatch posts, not the objective; re-site after a set time with no target; let
  it fire on a precise reported hull contact its gunner's own `missileSees` passes. Measure launches and the "no shot"
  rate in the missile-team lab and in platoon-vehicles.
- **F7. Idle tank section (C12).** (Area fire, 3B, gives such a hull targets but does not move it: F7 stays.) In `ai/tanks.ts`: no live target for 60 s while its side attacks: bound forward
  to the next hull-down post along the axis (the "bound forward" code already there).
- **F8. Ambush siting for hulls (C13).** For hulls whose guns cannot pierce the expected enemy's front (`faceNeed`
  against the expected type), score posts by the side aspect to the route and hold fire until the side is shown
  (`ambushRangeM` / `crew.ambush`).
- **F9. Night (C19, C20, C21).** Data: sensor kind `vehicle-night-gen1` (factor 1.5, nightLight 0.5, maxRangeM about
  850) for the BMP-2 gunner and the BTR-82A; the BMP-2 commander a night channel capped at about 400 m (per-seat
  `maxRangeM` or its own kind); `vehicle-night-ir` stays only for sights shown to reach about 3 km. Code: missile
  guidance needs a light-adjusted sight factor above a floor at that range (no night or thermal sight: no guidance below
  about light 0.3). Approach lab at night before and after. No campaign effect (day only).
- **F10. Data checks (C16, C17, C18)** by search extracts (add-data-entry, confidence at most medium): T-72B3M carousel
  round; Relikt hull-side against 30 mm APFSDS and the T-90M side plate; PG-7VL and PzF3 halted / moving ranges.
  Change only what sources support.

Not changed (kept, record in DECISIONS as real gaps for fightingValue): C1, C2, C3, C14, C15, C22, C24.

## 3. The owner's features (design; built after section 2, before the final measuring)

Both are symmetric code (no faction literals); every number below is a game value (low) unless it names a source, and
goes into `core/behaviour.json` (new blocks `mountedAssault`, `areaFire`) or faction doctrine. Both change replays
with vehicles: `npm run golden:update` + a DECISIONS line each. Strings through `Strings.t` (events carry keys).

### 3A. Mounted assault

**Order.** No new order kind: the existing `assault {x, y, building?}` (orders.ts:114) becomes valid for (a) a unit
whose men ride, (b) a platoon (or higher) with carriers, and (c) a vehicle crew / hull. The sim decides the form from
the state when the order arrives: riders aboard -> mounted assault drill; no riders (a tank section, an empty carrier)
-> assault by fire (below); men already on foot -> today's drill unchanged. The player's Assault button and the AI
commander's attack both use it (the commander's "start"/"ride" code then issues the order and its own dismount-point
code moves into the sim module, one code path). New drill state in the unit's `drill` (plain data, serialisable):
`{ kind: "mountedAssault", x, y, building?, phase: "drive" | "dismount" | "support" | "final" | "done", carriers: [{ vid, squad, dismount:{x,y}, post:{x,y} | null }], phaseTick }` in a new `sim/src/systems/assault-mounted.ts` (systems loaded before mount.ts must use string literals, see Gotchas).

**Phases.**
1. *Drive.* Each carrier gets a dismount point: along the way in (the order's point from the unit's centre), at the
   faction's `doctrine.dismount.distanceM` from the objective (DE 300 low, RU 400 medium; both outside the RPG-7 /
   Panzerfaust reach of 300-400 m and the effective small-arms range), each carrier on its own slot across the axis
   (`vehicleSlotM`). Terrain-aware: from the first point far enough, up to `dismountCandidates` x `dismountStepM`
   farther back, the first one out of sight of the objective's near edges and of the enemies the unit knows (the
   current commander test, moved here), preferring a point in defilade or behind a building/wood edge (sight test at
   the hull's height); none hidden: the distance itself. Route by `routeBetween` for hulls as today; drive "run".
2. *Dismount.* On arrival (or the F4 trigger: own carrier hit, a hit on a carrier within ~300 m, an anti-tank threat,
   the ride timeout) the carrier halts and its squad gets out on the far side from the threat (existing exit fan).
   Squads then take today's assault drill to (x, y) (groups, bounds, fire and movement, house clearing if `building`).
   A carrier that cannot get there (immobilised, route blocked) drops its squad where it stands.
3. *Support.* Once its squad is out, the carrier "falls back slightly": it reverses (never turns its side to the
   objective) to a support-by-fire post chosen by a pure siting function (the scoring of `ai/siting.ts siteHullDown`
   moved into sim so the drill and the AI share it): candidates 30-150 m behind the dismount point and up to 80 m to the
   sides; score = line of sight from the gunner's sight to the objective's points (ring of 9 as in `overwatchBounds`)
   + hull-down (only the turret shows) + range within the main weapon's `engageRangeM` - nearness to the squads'
   lanes (no post whose line of fire crosses within `friendlyClearM` of the lane) - known anti-tank threats in reach.
   Doctrine `afterward` then applies: "overwatch" (DE, sourced low) stays on the post and re-sites only when it loses
   the line to the objective; "follow" (RU, sourced low) bounds post to post `followM` behind the chain, each post
   chosen by the same scoring. From the post the hull fires on the objective with area fire (3B) at every enemy its
   side knows or suspects there, and lifts / shifts fire as the squads close: no burst within the round's danger radius
   of own men (`stationDangerM`, balance pass 4), first shifting to the objective's far half, then ceasing ("radio.
   shiftFire", "radio.liftFire").
4. *Final / done.* When the drill reports the objective taken (`radio.objectiveTaken`), the hulls move up to the
   objective's near edge (hull-down if possible) to consolidate and be ready to remount; a failed or withdrawn assault
   (squads routed, drill ended) brings the carriers to the squads' rally point to pick them up (`mount` orders).

**Assault by fire (no riders).** A hull or tank section given Assault drives by bounds (`overwatchBounds` style, one
moves, one watches) to a support post at `mountedAssault.noRidersStandoffM` (~250 m: beyond RPG reach, within the
coax) chosen by the same scoring, and fires on the objective with area fire. It does not drive onto the objective
without infantry (realism: tanks do not clear woods or villages alone); owner question Q7.

**Under fire before the dismount point.** The F4 per-carrier trigger: that carrier halts or backs into the nearest
cover (the siting function with a 60 m radius), its squad dismounts there and goes on foot (moving by covered routes,
`routeBetween` with the doctrine's cover preference), the other carriers go on. An enemy vehicle seen within its
gun's reach: the carrier engages it first (gunnery as now) and dismounts its squad behind it.

**Night.** The dismount distance stays the doctrine value; "out of sight" is tested with the enemy's sight as it is at
that light (the existing `hidden` test with the light term). A support post must lie within the hull's best night
sensor range of the objective (`vehicle-night-gen1` after F9, ~850 m; thermal 3000 m); if no candidate does, the post
moves forward until it does but never inside `noRidersStandoffM`. Without a night sensor the hull fires only at
points its side reports (flares, drones, men on foot), never at suspicion alone.

**Interface.** The plan bar shows the dismount points and the support posts as markers once the order is accepted
(events `assault.dismountPoint`, `assault.supportPost` carry positions); the card shows the phase. The Assault button
is enabled for a mounted unit, a hull and a platoon with carriers (today it is greyed out for riders). A player who
wants another dismount point still has Move + Dismount.

**Tests and labs.** Unit tests: an assault to a mounted squad is accepted; the carrier stops within 50 m of the
dismount distance; squads get out and take the assault drill; the carrier reverses to a post with a line to the
objective and fires; no rider -> assault by fire; serialise/deserialise mid-drill gives the same hash. A lab
`npm run lab -- mounted-assault [seeds]`: DE and RU platoons, mounted, assaulting a held village edge: dismount
distance, men killed aboard, time to the objective, rounds fired by the hulls from their posts, own casualties to own
fire (must be 0). Screenshots: `-- --scene assault-mounted` (dismount, posts, firing, both looks).

### 3B. Area fire with HE and air burst

**Suspicion.** Each hull keeps a short list `VehicleState.suspects` (plain data, at most `areaFire.maxSuspects` 4):
`{ x, y, r, weight, tick, firedAt }`. A suspect is made when a crew contact on enemy men (seen, or reported with an
error under `reportedErrorM`) gets older than `gunnery.seenWithinSeconds` without being down or surrendered: the men's
last positions within `groupRadiusM` merge into one suspect (centre, radius = spread + drift error, weight = men, x2
for a man seen firing, x3 for a machine gun or an anti-tank weapon). New contacts and reports refresh it. Weight decays
with a half-life `areaFire.halfLifeSeconds` (~60 s; `sim/math` exp) and faster (`clearedHalfLifeSeconds` ~15 s)
while the crew sees the spot well (visibility over 0.5) and no one there; dropped below `minWeight` or after
`maxAgeSeconds` (~180 s). Stored per hull in ID order; part of the state hash.

**When a crew fires at a suspect.** Only when `chooseTarget` finds no live target (seen and reported targets always
come first), and only if:
- the crew's rules are fire "free" (never under "return", "hold", an ambush hold, or a defence's `maxEngageM` beyond
  the spot), or the player / commander ordered it;
- an HE (or coax) feed is left above the ammunition discipline floor: `rules.ammo` "conserve" -> area fire off,
  "normal" -> keep `areaFire.reserveFraction` (~0.5) of each HE feed for seen targets, "max" -> no reserve; AP rounds
  and missiles are never fired at a suspect;
- no own man within the round's danger radius and spread of the spot (`stationHeld` / `stationDangerM` as for seen
  targets) and no protected person known there (`refusesFireAt`);
- the line from the muzzle reaches the spot (as for a point fire order).
Rate: a cannon fires a burst of `burstRounds` (30 mm: 3-5) every `areaFire.everySeconds` scaled by weight (heavier
suspect, more often; ~8-20 s); a tank's main gun one HE round per `mainGunEverySeconds` (~45 s) and only at a weight
of 3 or more; the coax a 10-20 round burst within `coaxSingleWithinM`. Each burst is aimed at a random point in the
suspect's circle (stream "gunnery"), spreading it over the area. Why-keys `why.target.suspected`,
`why.nature.airburst`; event `vehicle.areaFire` for the review and the ledger.

**Air burst where the real round has it (data, add-data-entry, confidence at most medium):**
- *Puma, MK30-2/ABM:* 30 x 173 KETF, Rheinmetall PMC308, Bundeswehr DM21 (search extracts: Rheinmetall brochures
  "ABM KETF 30x173 PMC308", esut.de, Rheinmetall news 2024-01-17): round about 830 g, projectile 360 g, a tungsten
  payload of 201 g released as sub-projectiles in a forward cone at a set stand-off in front of the target, muzzle
  velocity 1100 m/s, fuze programmed at the muzzle with the laser range (time resolution 2 ms). Model: fuse
  "programmable" (already in `FuseKind`), burst time = (laser range - standoff) / speed with the LRF range error;
  at the burst the payload flies on as N fragments in a cone (the spall-cone code, armour.ts:247, made generic), no
  blast. Pellet count, cone and standoff are game values (low) fitted to the published payload. Owner Q6: the Puma's
  HE feed becomes KETF (the Bundeswehr's main combat round), or KETF beside the impact HE.
- *Leopard 2A7V, DM11:* the data note already says its programmable fuze has point detonation, delay and air burst
  (published, medium; spartanat, asiapacificdefencereporter). Model the air-burst mode: burst `airburstHeightM` ~3 m
  over the aim point (the existing airborne burst, explosions.ts:130), set from the EMES 15 laser range.
- *T-90M, 3OF26 with Ainet:* search extracts (Army Recognition T-90M data sheet, the War Thunder wiki: a game source)
  say the T-90M's fire control has the Ainet remote-detonation system for HE-FRAG; the new 3VOF128 Telnik round with
  "air detonation at a given point" is reported in service with the T-90M only (defensemirror, armyrecognition 2023;
  its "6-8 times" claim is an official's, unverified). Confidence low: owner Q8 (recommended: Ainet air burst for the
  T-90M's 3OF26, Telnik not added).
- *BMP-2 3UOF8, T-72B3M 3OF26, BTR-82A, GTK GMW, Boxer:* impact (point-detonating) as now; no source for an air-burst
  fuze on them. (The T-72B3M has no Ainet in the extracts found; keep impact.)
Choice of fuse: air burst for a suspect or a target that is prone, in a fighting position, behind a low wall or a
hedge, or at a wood edge; impact (or delay) at a building wall or a hull; the player can force either.

**Player.** The existing `fire {x, y, contact?}` order to a hull is already "area fire at a point"; it gets an optional
`fuse?: "airburst" | "impact"` (validated like `callFire`'s, refused with `radio.noAirburst` when no feed has it) and
the Fire tray a fuse toggle for hulls that have it. The Rules row gets "Area fire" (on / off; default on under fire
"free"), kept in `rules` as `areaFire?: boolean`. Owner Q9 for the default.

**AI.** Crews do area fire on their own as above; the commander's support-fire block (commander.ts:1524) issues the
same `fire` order (with `fuse` per the rule above) at suspects near the objective instead of its own 150 m contact
search; the defence's hulls get area fire like any crew (it answers part of C25).

**Tests and labs.** Unit tests: a crew that loses a man keeps firing HE at his last position for a while and stops
after the decay; never under "return"/"hold"/"conserve"; never within danger close; KETF bursts short of the target
with fragments going forward; DM11 air burst over a prone man hurts him where impact HE behind a low wall does not.
Labs: `npm run lab -- fragmentation` and `-- gunnery` get KETF / DM11 / 3OF26-Ainet rows (casualties per burst against
prone men in the open, in a trench, behind a wall at 400/800/1200 m); a new `npm run lab -- areafire [seeds]` (a crew
loses a squad that goes to ground in a hedge row at 600 m: rounds fired, casualties, HE left, time to stop).
Performance: suspects are updated once a second per hull, staggered (bench-vehicles is near its 8x floor: perf check).

## 4. Measurement protocol

CPU: 4 shared cores; one heavy process at a time, at most 2 workers; timing tests alone at the very end.

**Baseline** (before F1, from the ledger; re-run if code changed under it): platoon-vehicles DE attacking 5 of 6,
platoon-ru-vehicles RU attacking 3 of 6 (2 DE, 1 draw); M12.4: platoon-vehicles 13/20, platoon-ru-vehicles 8/20
attacker wins.

**Per fix (quick):** the lab row of the fix, plus the 6-seed ledger per scenario at 1200 s, reporting: Konkurs, Spike,
Metis-M and RPG launches; AP hits at faces that cannot be pierced (target 0); first sightings each way; dismount time and
distance; men killed aboard; casualties by weapon. Accept a fix when its lab row passes and the ledger moves as
expected, without new regressions on the other side. After 3A/3B the ledger also reports: dismount distance from the
objective per carrier, hull posts' range to the objective, rounds fired at suspects (HE / air burst / coax) and the
casualties they caused, own casualties to own fire (target 0), HE left at the end.

**Platoon acceptance (after F0-F10 and both features, 3A and 3B; the owner's pause comes before this):** `npm run batch -- --scenario platoon-vehicles --runs 20 --seconds 1200` and the
same for `platoon-ru-vehicles` (daylight, AI both sides), one at a time. Target: attacker wins 30-70 % in both, or a
justified result outside the band (the kept real gaps of section 1, quoted with the ledger split). Also report-only:
`platoon-vehicles-tanks-both`, `platoon-vehicles-wheeled` and `platoon-ru-vehicles-wheeled` at 10 runs (no
regression in the wheeled carriers), and 10 runs of each main scenario at `--time 23:00 --moon 0` after F9.

**Campaign (after the platoon acceptance), the M12.4 protocol:** `npm run campaign -- batch-part` per campaign, merged
with `batch --merge`; 1200 s battles, AI on both sides, tracked carriers, seeds 300 and 301 (more when time allows):
DE as player (enemy RU), RU as player (enemy DE), xf vs xf (the campaign rules alone; M12.4: 58 %, must stay in the
band). Set `factions/<id>/campaign.json` `fightingValue` once, from these batches, (outside the fingerprint: no golden change) so both player
sides land in 30-70 % operation success where possible; `enemyCapScale` stays 1.0 (phone budget). Report the M12.4
tuning lines (success, failure reasons, node results by type, casualties each way, wall time per battle). If DE as
player stays above 70 % with RU already at its cap, record it and put Q2 to the owner. No phone-proxy rerun is needed
while the caps do not grow; rerun `npm run phoneperf -- --campaign 2 --battle-seconds 1200` if any commitment rule
changes.

**Performance:** after 3A and 3B, the bench-vehicles timing test alone (it sits near its 8x floor) and a headless
`bench-vehicles` run against main for the per-tick cost of suspects and post siting.

**Finish:** golden updates with DECISIONS lines per intended change (never `packages/tools/golden/no-interiors`),
`npm run check` alone, timing tests alone, DECISIONS "Balance pass 5" with the tables and the owner answers above,
STATE.md handover.

## 5. Owner questions (multiple choice, recommended first)

Asked with clickable choices (AskUserQuestion) by the main session. Q6-Q10 are needed before 3A/3B are built; Q1-Q5
can wait for the measurement, except that Q1 (b)/(c) would add data before it.

**Q1. Which BMP-2 should the Russian motor rifles field?**
- (a) Keep the basic BMP-2 (day and image-intensifier sights, no rangefinder); the gap goes into fightingValue.
  *Recommended: the standard vehicle, sourced.*
- (b) Add a BMP-2M (Berezhok: thermal gunner sight, panoramic commander sight, rangefinder, Kornet) as a separate
  vehicle for some RU platoons (search extracts, confidence medium at most).
- (c) Replace the BMP-2 with the BMP-2M everywhere.

**Q2. If DE as player still wins more than 70 % with the RU enemy at its one-company cap:**
- (a) Propose a smaller DE commitment against a capped enemy (fewer platoons proposed by fightingValue; the player may
  still commit more). *Recommended: keeps the phone budget.*
- (b) Accept DE-as-player above the band and record it.
- (c) Raise RU's caps (`enemyCapScale` above 1.0); breaks the phone budget measured in M12.4.

**Q3. Company meetings open at 1.6-1.9 km, beyond RU's reach:**
- (a) Keep the start distance (real terrain and reach). *Recommended.*
- (b) Shorten meeting starts to about 1.0-1.2 km (a scenario game value).

**Q4. T-72B3M commander's sight (sources conflict):**
- (a) Leave it day-only until a firmer source. *Recommended.*
- (b) Give it a thermal channel at confidence low (Army Technology, Army Recognition).

**Q5. Defence riflemen held to 300 m while Pumas fire from 500 m:**
- (a) Keep the defence range rule. *Recommended: rifles do not hurt Pumas at 500 m.*
- (b) Lift it for a squad under effective fire (`decisions.rangeRuleLiftsUnderFire`) and re-measure both directions.

**Q6. The Puma's 30 mm high explosive:**
- (a) Replace the impact HE feed with the KETF air-burst round (DM21 / PMC308), the Bundeswehr's main combat round
  (Rheinmetall brochures, esut.de; medium). *Recommended.*
- (b) Carry both: KETF and impact HE in a game split.
- (c) Keep impact HE only (no air burst for the Puma).

**Q7. A hull or tank section given Assault with no infantry aboard:**
- (a) Assault by fire: bound to a support post about 250 m out and fire on the objective; never drive onto it alone.
  *Recommended: tanks do not clear woods or villages without infantry.*
- (b) Drive onto the objective and fire on the move.
- (c) Refuse the order ("needs infantry").

**Q8. T-90M air burst (Ainet), sources thin (Army Recognition data sheet, the War Thunder wiki; Telnik reports):**
- (a) Give the T-90M's 3OF26 the Ainet air-burst mode (confidence low); Telnik not added. *Recommended: the
  T-90M's fire control is described with it in several extracts.*
- (b) Keep the T-90M impact-only until a firmer source.
- (c) Add the 3VOF128 Telnik round as well (claims unverified).

**Q9. Area fire for the player's hulls:**
- (a) On by default under fire "free", with a Rules toggle and the "normal" ammunition reserve of half the HE.
  *Recommended: the same as the AI.*
- (b) Off by default; the player turns it on per unit.
- (c) Only on the player's fire order (no automatic area fire for the player).

**Q10. After the dismount, the carriers' doctrine (sourced per side, both low):**
- (a) Keep it per faction: DE stays on its support post (overwatch), RU follows the chain about 150 m behind from post
  to post. *Recommended: sourced (docs/research/dismount.md).*
- (b) Both fall back to a support post and stay there, as in the owner's words.
