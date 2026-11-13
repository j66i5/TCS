# The infantry attack on foot (balance pass, 2026-11-13)

Owner decision 2026-11-13 ("Yes, next"): a separate pass on the infantry assault, through the AI, its drills and
doctrine (game values, low confidence), not weapon data, aiming at a real but defender-favoured chance (about 2-4
wins in 10) for two attacking platoons against one dug-in platoon. Defender behaviour unchanged.

Method: batches (`npm run batch`, 10 x 900 s, seeds 1..10 and 11..20; 10 x 2400 s, the app's default battle length)
and a throw-away diagnostic runner (not committed) logging the commander's phases, each squad's distance to the
objective, pinned and moving men, the drill phases, which men of the base of fire had a fire task, a clear line of
fire and what they had fired, and, for every attacker who fell, where he was, which phase it was and **where the
man who hit him stood** (inside the main objective, the second objective, elsewhere).

## Diagnosis (baseline = `main` 6e5a116)

1. **The support line lay where the first shot came from.** Squads that went to ground on contact counted as
   arrived, so the base of fire sat 430-490 m out (seed 1: 457-493 m), beyond the reach of its rifles; on farmland
   the Russian base never hit a German in ten battles of one seed. The assault then bounded the whole 450 m.
2. **The base of fire mostly could not fire.** At its geometric places on the line two thirds of its men had no
   line of fire to the objective (a fold, a hedge, a house in the way; prone or kneeling); none of them *saw* a
   defender, they fired at remembered positions, at the normal rate, about 1000 rounds a battle for 40 men.
   Defenders were pinned in only 4-7 % of the samples during the assault.
3. **A pinned runner held his whole squad.** The drill swapped halves only when every runner had stopped moving;
   a pinned man keeps his path, so one pinned man stalled the bound for the full 40 s timeout (0.4-0.7 m/s).
4. **Three quarters of the attackers fell to the second objective's garrison.** With the shooter located, 75 % of
   the attackers' losses (both factions) came from the one squad holding the second objective, which lies about
   120 m nearer the attacker and 180 m to the side of the main one: the approach and the assault on the main
   objective pass across its front. (The main objective's own defenders, mostly in and behind buildings, did a
   quarter.)
5. **The two attacking platoons fired through each other.** The "friend in the line of fire" check only knew the
   firer's own platoon; with the second platoon's assaulters crossing the first one's base of fire, about one
   attacker loss in ten was by his own side's rounds.
6. **Time.** On foot from about 700 m, the approach alone takes 300-450 s (village routes are slow); a deliberate
   attack (approach, fires, closing in, fire and movement over the last 100-150 m at ~0.7 m/s) needs 750-1000 s.
   In 900 s most attacks are still short of the objective when the clock stops; in 2400 s they are not.
7. Grenades were barely used (0-2 per battle): only hand grenades, only at enemies within 35 m.

## What changed (all game values, low confidence; `COMMANDER` in `packages/ai/src/commander.ts`)

- **Axis away from the flanking garrison.** The way in is turned about the objective by up to 45 degrees so that the
  support line stays 320 m from the other objective the enemy holds (outside its 300 m fire), the least turn that
  does. On foot only: a mounted attack keeps its straight way in (its ride and dismount points are planned on it).
- **Blinding smoke** on that garrison (3 rounds, every 120 s while rounds last) from the moment the fires are called.
- **Support-by-fire places with a field of fire.** Each squad's place is chosen once (from the map) among 15 spots
  around its slot (depth 330 m +20/-10, aside 0/20/40 m) for clear lines of fire, lying or kneeling, onto the
  objective. A squad that went to ground short of its place moves on after 15 s (at a run while under fire; at most
  4 times); two thirds of the squads in place is enough. The support line is 330 m out (was 300 m: just outside the
  defenders' 300 m fire rule, inside the attackers' rifle reach of 400 m). The last stretch is sneaked for 50 m (was
  200 m).
- **Fires timed with arrival.** The mortars' HE and a smoke screen (half way from the objective to the assault
  position) are called when the first squad is 100 m short of the line, so they land about as the squads arrive;
  HE then every 45 s (was 90 s) while no own men are close.
- **Base of fire man by man.** Each man of the base gets his own target among the enemies known near the objective,
  one he has a line of fire to, at the full rate (ammunition rule "max"); fire lifts off any enemy own men are
  within 40 m of; one squad of the base keeps the other objective's garrison down.
- **Assault element closes in under the smoke** on a flank (the bearing up to 50 degrees off the axis seen from the
  fewest objective edges and known enemies, away from the other garrison), at a run toward a point 60 m short; under
  fire within 120 m it goes over to fire and movement at once (after 180 s in any case).
- **Grenade launchers** (40 mm, already in the squads' kit) fire at the nearest known enemy within 200 m once a squad
  has closed in; hand grenades as before within 35 m.
- **Drill (sim):** a runner who is pinned or panicked no longer holds the next rush; the others go on.
- **Fire (sim):** the friend-in-the-line check covers every platoon of the firer's side (also vehicle guns).
- Unchanged: the defender; the 30 % casualty tolerance (+10 % once the assault was under way was tried: no effect at
  900 s, more attacker wins at 2400 s); `boundM` 30 m (15 m, "3-5 s rushes", was tried: no measurable effect, and
  it is catalog data whose change would break the M7.5c no-interiors equivalence goldens — for the owner).

## Results

| Batch | Attacker | Baseline wins (att.) | After | Casualties att. / def. before | after |
|---|---|---|---|---|---|
| platoon 10 x 900 s, seeds 1..10 | DE on foot | 0 | 1 | 14.5 / 9.3 | 14.4 / 10.3 |
| platoon, seeds 11..20 | DE on foot | 0 | 0 | 11.1 / 5.0 | 16.1 / 9.2 |
| platoon-ru, seeds 1..10 | RU on foot | 0 | 2 | 16.1 / 8.1 | 15.5 / 12.8 |
| platoon-ru, seeds 11..20 | RU on foot | 0 | 1 | 14.4 / 8.6 | 13.1 / 11.2 |
| platoon 10 x 2400 s | DE on foot | 0 | 4 | 21.1 / 10.8 | 18.9 / 12.5 |
| platoon-ru 10 x 2400 s | RU on foot | 1 | 6 | 20.5 / 10.1 | 18.8 / 14.9 |
| platoon-vehicles 10 x 900 s | DE mounted | 3 (1 draw) | 4 | 11.5 / 20.0 | 14.9 / 19.2 |
| platoon-ru-vehicles 10 x 900 s | RU mounted | 0 | 0 | 18.5 / 8.6 | 22.5 / 7.4 |
| demo 50 x 120 s | – | draw 50 | draw 50 | 0 / 0 | 0 / 0 |

Mean attacker score (objectives minus 5 per man down) at 900 s: DE -30.5 / -30.5 -> -27.5 / -39.0; RU -48.0 /
-27.5 -> -11.5 / -29.0. Vehicles lost in the mounted batches: DE 0.1 / RU 2.5 -> 0.1 / 2.4 (DE attack), RU 1.3
-> 1.4 (RU attack).

**Reading:** at 900 s the attack now gets home in 1-3 battles of 20 (target 2-4 in 10 not reached); at 2400 s
(the app's battle) 4/10 (German attack on the village) and 6/10 (Russian attack on farmland: slightly
attacker-favoured). The defenders now lose about a third more men. The attack is limited at 900 s by the clock, not
by its losses: it reaches the objective about when the battle ends. The Russian mounted attack stays at 0/10 (its
problem is the ride, see `ru-mounted-attack.md`), with about 4 more men lost because its squads now press on to the
support line and into the assault.

## Tried and dropped

| Variant | Result |
|---|---|
| Resume to the support line only (300 m) | more attackers down (DE 21.6, RU 23.6), 0 wins |
| + assault position at 120 m, smoke screen, closing at a run | 0-1 wins in 20, losses ~20-25 |
| Whole platoons in fire and movement from the support line (no base of fire) | 0/40, attackers lost ~32 of 40 |
| Second objective first, then the main one (from the second, on its flank) | losses back to baseline, objectives held more often, but no wins at 900 s and 0/10 for DE at 2400 s (the main assault from the second objective failed) |
| Assault element waiting at a hidden attack position 220 m out | never found on farmland; slightly worse on the village |
| Casualty tolerance +10 % once the assault is under way | no change at 900 s; 2400 s DE 6/10, RU 8/10 |
| `boundM` 15 m | DE 2/20, RU 2/20 (vs 1/20, 3/20 with 30 m): no measurable effect |

## For the owner to decide

1. **Battle length for balance batches**: 900 s is shorter than a deliberate foot attack from 700 m takes; the 2400 s
   battle (the app's) is where the attack now gets 4-6 wins in 10. Measure balance at 2400 s (or 1500 s), or start
   the foot attack nearer?
2. **Rushes of 15 m** (`boundM`, "3-5 s"): doctrinally closer to the drill; no measurable effect; changing it breaks
   the M7.5c no-interiors goldens (regenerate them once, or keep 30 m?).
3. **Hand smoke grenades** (DM25 / RDG-2) for squads: not in the data; would let squads screen their own last 100 m.
4. The Russian attack on farmland at 2400 s is slightly attacker-favoured (6/10): accept, or hold the support line
   longer before the assault?
