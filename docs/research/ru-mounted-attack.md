# Why the Russian mounted attack never wins (balance investigation, 2026-11-13)

Owner answer 2026-11-13: "Investigate and tune" — the AI, its tactics and doctrine data, **not** armour or
penetration data. This note is the investigation. **Result: no tuning was committed.** Every AI and doctrine change
tried (below) left the Russian mounted attack at 0 wins in 10 (or 20) and most made its losses worse; the cause lies
in the scenario set-up and the owner's vehicle choices, which need owner decisions (end of this note).

Method: `npm run batch` (10 x 900 s per scenario, seeds 1..10, plus seeds 11..20 for the mounted Russian attack),
2400 s batches (the app's default battle length), and a throw-away diagnostic runner (not committed) that ran the
headless battles with the commander's memory and the event stream: casualties of the attacker by distance from the
main objective and by the ammunition of the hit that downed them, every hull penetration (shooter, face, range),
vehicle losses, the dismount points, the commander's phases, and unit snapshots every 150 s.

## Batches (baseline = current `main` state; nothing committed changes them)

| Scenario (10 x 900 s) | Attacker | Winners blue / red / draw | Casualties blue / red | Vehicles lost blue / red | End reasons |
|---|---|---|---|---|---|
| platoon (village) | DE on foot | 0 / **10** / 0 (defender) | 14.5 / 9.3 | – | time-limit 10 |
| platoon-ru (farmland) | RU on foot | **10** / 0 / 0 (defender) | 8.1 / 16.1 | – | time-limit 10 |
| platoon-vehicles (village) | DE mounted | 3 / 6 / 1 | 11.5 / 20.0 | 0.1 / 2.5 | time-limit 8, side-eliminated 2 |
| platoon-ru-vehicles (farmland) | RU mounted | **10** / 0 / 0 | 8.6 / 18.5 | 0.0 / 1.3 | time-limit 8, side-broken 2 |
| platoon-ru-vehicles, seeds 11..20 | RU mounted | 10 / 0 / 0 | 5.8 / 22.4 | 0.0 / 2.4 | time-limit 7, side-broken 2, side-eliminated 1 |
| platoon-ru-vehicles, 2400 s | RU mounted | 10 / 0 / 0 | 8.7 / 20.4 | 0.0 / 1.3 | time-limit 8, side-broken 2 |
| platoon-ru, 2400 s | RU on foot | 9 / 1 / 0 | 10.1 / 20.5 | – | time-limit 9, side-eliminated 1 |
| platoon-vehicles, 2400 s | DE mounted | 5 / 5 / 0 | 15.8 / 20.9 | 0.1 / 2.5 | side-eliminated 5, side-broken 1, time-limit 4 |
| demo (50 x 120 s) | – | draw 50 | 0 / 0 | – | time-limit 50 |

(Blue is always Germany, red Russia. In `platoon` and `platoon-vehicles` Germany attacks; in the `-ru` ones Russia
attacks. The attacker has two platoons: 56 Russians in 6 BMP-2s against 20 German infantry and 4 Pumas (32 men);
42 Germans in Pumas against 19 Russian infantry and 3 BMP-2s.)

## Is it attackers in general, Russian doctrine values, or vehicle tactics?

- **Attackers in general lose on foot**: both infantry attacks lose 10/10 (the German attack on the village too).
  The Russian infantry attack on the village loses too (8/8 diagnostic runs), and the German mounted attack on
  farmland wins (6/8) — so it is **not the farmland map** and **not the Russian doctrine values** (both factions'
  values are identical except the dismount distance and the mortar).
- **The German mounted attack wins because its Pumas wreck the Russian defence**, not because its infantry takes
  the position: 121 of 136 hull penetrations in `platoon-vehicles` are Puma 30 mm rounds through BMP-2 fronts at a
  median 497 m; the Russian defenders lose 2.5 of 3 BMP-2s per battle, and the 3 German wins in 10 come with the
  defence's crews and squads broken or wiped out. The main objective fell in 3 of 10 battles.
- **The Russian mounted attack has no way to do the same**: its BMP-2s cannot hurt a Puma front (owner's armour
  choice), it has no ATGM (the BMP-2 in data carries only the 2A42 and PKT), and its RPGs got 1 side penetration in
  10 battles. Whatever the AI does, the Pumas stay in the fight for the whole battle.

## Where and when the Russians lose (platoon-ru-vehicles, seeds 1..10)

- **Before they can act.** The attacker's six BMP-2s start in a line 20 m apart at the map edge, about 780-820 m from
  the Pumas, on open farmland and in their sight. Pumas penetrate BMP-2 fronts at that range: in seed 12 the first
  BMP-2 is penetrated at 3 s (780 m, front), four are lost by 20 s. Vehicle losses (destroyed or abandoned events)
  in the ten battles at 5, 10, 12, 14, 21, 24, 49, 59, 60, 61, 81, 112, 167, 180, 195, 357, 471 s: **two thirds in the
  first two minutes**, most during the ride. Penetrations of BMP-2s: 37 side, 18 front, 10 rear by Puma 30 mm, at a
  median range of 668 m.
- **The early collapses (side-broken at 12-25 s, 2 battles in 10, 2-3 more in seeds 11..20) are a morale cascade**:
  one BMP-2 cooks off with its squad aboard (9-10 men down at once); every man within 60 m — that is everyone in the
  neighbouring carriers 20 m away — takes 0.15 stress per comrade down (core `stress.fromCasualty`, applied to men
  aboard too: an owner decision, "a comrade falling nearby shakes men aboard too"), so all of them panic; the few men
  on foot (survivors getting out) are all panicked, so `breakPanickedFraction` (half the *men on foot*) breaks the
  platoon, and with both platoons broken the side loses. (Counting the men aboard in that share does not help: they
  are panicked too.)
- **Then on foot, far out.** The squads get out at a median 618 m from the objective (429-823 m), because an enemy
  vehicle seen within 600 m puts them out at once (`dismountThreatVehicleM`); the 400 m doctrine distance is rarely
  reached. **Russian losses by distance from the objective: >450 m: 98 (45 of them aboard), 300-450 m: 44,
  200-300 m: 11, 100-200 m: 8, <100 m: 0.** Almost 90 % of the losses come more than 300 m out, before the assault, and the downing hit was
  Puma 30 mm HE in 42 cases, Puma 30 mm AP in 41, fragments 20, rifles and MGs 29 (26 unknown).
- **The assault starts far out and crawls.** Squads that go to ground on contact count as "arrived", so the support
  line is wherever the first shots came (430-480 m out in seed 1, not 300 m); the advance is sneaked (0.3-0.5 m/s),
  recon starts at 200-290 s and the assault at 290-380 s (in 7 of 10 battles; once only at 760 s); the fire-and-movement bounds then
  advance at about 0.4 m/s under the Pumas' fire. In seed 1 the German infantry on the main objective is down to its
  two headquarters men by 450 s, yet the Russian assaulters are still 100-230 m out at 900 s. The Russians withdrew
  (30 % down) in 6 battles of 10; **they never took the main objective in 900 s** (in 2400 s once, at 903 s, then
  withdrew from the second objective).
- **Smoke**: the attacker's assault smoke (3 x 82 mm rounds every 120 s at the objective's near edge) stands only
  during the assault; the BMP-2s fire their dischargers only as a crew reaction once hit. Ordinary smoke halves a
  thermal sight (owner Q7), so the Pumas still see through it.
- **RPG flank shots**: anti-tank rounds per battle: Russians 2.7 in all, one side penetration of a Puma in 10 battles.
  The Pumas stand 60-130 m behind the objective, beyond RPG reach from the support line; the hunters (2 at a time) go
  straight at them, i.e. at their fronts.
- **Morale breaks** see above; otherwise the attack ends by the 30 % casualty rule.
- Side observation (possible bug, not investigated further): 3 penetrations of a BMP-2's **rear by Russian 30 mm**
  (own fire through an own hull) in the ten battles, and some downed men whose last hit was their own side's ammunition.

## What was tried (all reverted; game values, low confidence)

| Variant (on top of the baseline) | RU mounted wins | RU casualties | RU vehicles lost | Notes |
|---|---|---|---|---|
| A: BMP-2s fire their smoke on first seeing an enemy vehicle; mortar smoke on seen enemy vehicles every 60 s; 6-round smoke screen 80 m in front of the objective before setting off (ride waits for it); vehicle slots 100 m; following BMP-2s back off out of a seen enemy vehicle's sight and only move up to hidden follow points ("cover to cover") | 0/10 (seeds 11..20: 0/10) | 21.7 (27.6) | 2.2 (2.6) | waiting for the smoke keeps the hulls in the Pumas' sight; side-broken unchanged |
| A without "cover to cover" | 0/10 (0/10) | 21.6 (27.4) | 2.0 (2.6) | |
| A + platoon break counts the men aboard | 0/10 (0/10) | 21.0 (27.6) | 2.0 (2.6) | the riders panic too: no change |
| A + Russian casualty tolerance 0.45 (doctrine data) | 0/10 (0/10) | 25.8 (29.4) | 2.2 (2.6) | longer attacks, more losses; RU on foot still 0/10 |
| B: squads gone to ground short of the support line move on after 20 s (the assault starts from 300 m) | 0/10 | 20.2 | 1.5 | DE on foot still 0/10, more German attackers down (17.1) |
| B + attacker vehicles start 60 m apart, slots 100 m, Russian aggressiveness 0.7 (less sneaking, shorter recon) | 0/10 (0/10) | 24.7 (27.1) | 2.1 (3.1) | side-broken 0 (1); more hulls in view, more lost |
| B + the same + following doctrine rides on through seen enemy vehicles to the 400 m line | 0/10 (0/10) | 24.0 (31.1) | 2.1 (3.6) | more men lost aboard |
| Only: attacker vehicles start 60 m apart, slots 100 m | 0/10 (0/10) | 28.1 (25.6) | 2.6 (2.8) | DE mounted 6/10 (attacker-favoured) |
| Only: RPG hunters of the attacker go round to a halted vehicle's flank (75 deg off its front) and hold their shot while they see its front | 0/10 (0/10) | 19.7 (21.9) | 1.6 (2.6) | AT rounds per battle 2.1; DE mounted 2/10 |

None reaches the owner's target of 2-4 wins in 10, and several make the German mounted attack attacker-favoured.

## Conclusion

The Russian mounted attack loses because **six BMP-2s start inside the effective range and sight of four Pumas on
open ground, cannot hurt their fronts, and carry no anti-tank missile**; the Pumas destroy the carriers during the ride,
the riders' losses panic the neighbouring carriers, and the infantry then has to cross 400-600 m of open ground under
30 mm high explosive. The AI can shuffle where those losses happen, but not avoid them. The generic weakness of the
infantry attack (both on-foot attacks lose 10/10: the support line is wherever the first shot came from, and
fire-and-movement is slow under fire) is a second, separate problem that also caps the German attacks.

## For the owner to decide

1. **Give the BMP-2 its ATGM** (9M113 Konkurs / 9M111 Fagot on the turret; data with sources, a new weapon and round,
   including penetration values — outside this pass's remit). This is the Russian doctrinal answer to an enemy IFV.
2. **Start the attacker out of the defenders' direct fire**: a bigger map for the mounted battles (e.g. 1800-2400 m
   deep; the Russian research note puts deployment 2-3 km out "beyond short-range ATGM reach") or start positions in
   dead ground. Today the attacker starts about 800 m from the defending IFVs.
3. **Casualty stress for men aboard**: should men inside a closed hull take stress from comrades falling outside it
   (and from a neighbouring carrier's cook-off)? Today one cook-off can break a whole mounted platoon in seconds.
4. **The infantry assault in general** (both factions lose 10/10 on foot): a separate pass on the support line
   (move on after going to ground), the assault start distance, and the bounding pace under fire.
5. Time limit: the batches use 900 s; the app's default battle lasts 2400 s, where the attack reaches the assault
   later but the outcome is the same.
