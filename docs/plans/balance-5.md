# Balance pass 5: Germany against Russia in the mounted battle (plan)

**Progress:** plan written 2026-11-20 (branch `claude/balance-5`, from main d4bb676, after M12). Nothing built yet.

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
| C26 | Campaign: RU enemy capped at one company, so fightingValue cannot help when DE is the player | campaign | real asymmetry (rule) | DE-player nodes at the cap: 110-122 RU men against 124-136 DE | **Retune after the fixes** (section 3); Q2 if DE-as-player stays above 70 % with RU at its cap |

Dropped: none outright; C7 is dropped as a sensor change (the BMP-2's sights are right) and kept only as the
firing-window bug (C10) and the reported-contact missile task.

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
- **F4. Dismount per carrier (C4).** The trigger becomes per squad: its own carrier hit, a hit on a carrier within
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
- **F7. Idle tank section (C12).** In `ai/tanks.ts`: no live target for 60 s while its side attacks: bound forward
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

## 3. Measurement protocol

CPU: 4 shared cores; one heavy process at a time, at most 2 workers; timing tests alone at the very end.

**Baseline** (before F1, from the ledger; re-run if code changed under it): platoon-vehicles DE attacking 5 of 6,
platoon-ru-vehicles RU attacking 3 of 6 (2 DE, 1 draw); M12.4: platoon-vehicles 13/20, platoon-ru-vehicles 8/20
attacker wins.

**Per fix (quick):** the lab row of the fix, plus the 6-seed ledger per scenario at 1200 s, reporting: Konkurs, Spike,
Metis-M and RPG launches; AP hits at faces that cannot be pierced (target 0); first sightings each way; dismount time and
distance; men killed aboard; casualties by weapon. Accept a fix when its lab row passes and the ledger moves as
expected, without new regressions on the other side.

**Platoon acceptance (after F1-F8):** `npm run batch -- --scenario platoon-vehicles --runs 20 --seconds 1200` and the
same for `platoon-ru-vehicles` (daylight, AI both sides), one at a time. Target: attacker wins 30-70 % in both, or a
justified result outside the band (the kept real gaps of section 1, quoted with the ledger split). Also report-only:
`platoon-vehicles-tanks-both`, `platoon-vehicles-wheeled` and `platoon-ru-vehicles-wheeled` at 10 runs (no
regression in the wheeled carriers), and 10 runs of each main scenario at `--time 23:00 --moon 0` after F9.

**Campaign (after the platoon acceptance), the M12.4 protocol:** `npm run campaign -- batch-part` per campaign, merged
with `batch --merge`; 1200 s battles, AI on both sides, tracked carriers, seeds 300 and 301 (more when time allows):
DE as player (enemy RU), RU as player (enemy DE), xf vs xf (the campaign rules alone; M12.4: 58 %, must stay in the
band). Retune `factions/<id>/campaign.json` `fightingValue` (outside the fingerprint: no golden change) so both player
sides land in 30-70 % operation success where possible; `enemyCapScale` stays 1.0 (phone budget). Report the M12.4
tuning lines (success, failure reasons, node results by type, casualties each way, wall time per battle). If DE as
player stays above 70 % with RU already at its cap, record it and put Q2 to the owner. No phone-proxy rerun is needed
while the caps do not grow; rerun `npm run phoneperf -- --campaign 2 --battle-seconds 1200` if any commitment rule
changes.

**Finish:** golden updates with DECISIONS lines per intended change (never `packages/tools/golden/no-interiors`),
`npm run check` alone, timing tests alone, DECISIONS "Balance pass 5" with the tables and the owner answers above,
STATE.md handover.

## 4. Owner questions (multiple choice, recommended first)

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
