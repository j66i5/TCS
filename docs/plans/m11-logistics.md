# M11 Logistics: build plan

**Progress:** plan written 2026-11-16 (this file); slice 43 built 2026-11-16 (DECISIONS "M11.1": point 7b built but off, late arrival as "not in the state until its time", hold mortar allotment a third). Hold battle strengthened 2026-11-16 (fighting positions, attacker mortars a sixth). Slice 44 built 2026-11-16 (DECISIONS "M11.2": consolidation also waits for the squad to stand still 20 s, men walk back to their places after a hand-over or taking; attacker wins in the foot platoon battles rose, open). Slice 45 built 2026-11-16 (DECISIONS "M11.3": no automatic siting in battle until the deliveries, grenades not taken at a cache; platoon batches unchanged). Slice 46 built 2026-11-16 (DECISIONS "M11.4a": bearers walk, not run, to the point; the crate is put down beside the squad leader as a cache the squad takes from when quiet (no hand-out walk by the bearers); no covered-route choice; "Bring ammunition to" is the squad card's "Send bearers"; the AI part lives in the sim's bearer rules, the same for both sides).

Owner request: ROADMAP M11 (SPEC 9.2, "ammunition, fuel and equipment are finite and must be moved"). This file
replaces the short Phase 6 list in `docs/plans/roadmap-detail.md` for the slices of **this chain** (43-48 and 52).
Two parallel cloud sessions build the rest of M11 at the same time:

- **Field repair and recovery** (roadmap slices 50-51), branch `claude/m11-repair`.
- **Batteries, water and drone airframes** (roadmap slice 49), branch `claude/m11-batteries`.

This chain stays out of vehicle damage repair and battery charge, but keeps the item, transfer and delivery machinery
generic so that those two can plug into it (section 4).

## 1. The owner's answers (binding, 2026-11-16)

Recorded in DECISIONS.md "M11 owner round (2026-11-16)".

| Question | Answer |
|---|---|
| Scope | **Everything**: ammunition, fuel, re-arming, repair, batteries, water. This chain: ammunition, resupply, re-arming and refuelling, the AI and the review page. Repair and recovery, batteries and water: the parallel sessions. |
| Making logistics felt | **Both**: (a) a new long "hold the village" battle in waves, 45-60 minutes (scenario `hold-resupply`), where resupply decides the outcome, and (b) men fire more, where that is realistic (suppressive fire volume, machine-gun belts; with sources and confidence; measure first). |
| Loose rounds | Men carry loose rounds (bandoliers, boxes) and **refill empty magazines in cover when not firing** (a `refillMagazines` action). |
| Taking kit | **Own casualties' ammunition automatically, after treatment.** Enemy weapons and ammunition **only on a player order**. |
| Delivery | **All three**: ammunition bearers on foot (the M10 carry store), vehicle rear runs, off-map deliveries. |
| Control | **Automatic** (squads ask for ammunition, on the AI and the player side) **plus player orders** ("set supply point", "resupply at", order a run). |
| Supply point and casualty nest | **Separate.** No ammunition at the red cross. An ambulance carrying ammunition is a breach of the law of war. |
| Repair | Crews fix light damage; a recovery vehicle on request (parallel session). |
| Batteries and water | Batteries now; water only in battles of 2 hours or more (parallel session). |
| Caches | Legitimate targets; a captured cache becomes the captor's. |
| Mortar and artillery stocks | The allotment is **topped up by deliveries**. |
| Military police and prisoners of war | Built at the end of M11, in a separate later workflow (not in this chain). |

## 2. What the battles use today (measured 2026-11-16, code at 760bdd6)

How it was measured: a diagnostic script (kept outside the repository) ran the four platoon battles with both AI
commanders, 6 seeds each (1-6), with a 2400 s time limit, and read every man's rounds (the magazine in his weapon plus
the loaded magazines and belts he carries) at the start, at 1200 s and at the end, his own shots (`shot.fired` with his
personal weapon), and every 5 s whether he still had a loaded spare magazine or belt ("out of spares") or no round at
all ("dry"). A first pass with a 1200 s limit gave the same battles wherever they ended before 1200 s and the same
figures at 1200 s otherwise, so the 1200 s column below comes from the 2400 s runs. "Men" counts a man once per
battle (6 battles). The vehicles' crews are in the "rifle" rows of the mounted battles.

**The short answer: nobody runs short today.**

- **Most battles end early.** platoon-ru ended in 455-1098 s every time (a side eliminated); platoon in 695-1006 s in
  4 of 6; the mounted battles mostly run to the time limit with long quiet stretches. Of 24 battles, 12 lasted the
  full 2400 s.
- **Men fire very little.** Averaged over a battle a rifleman fires 0.02-0.84 rounds a minute, a machine gunner
  0.06-6. The median rifleman fires **no round at all** in every scenario; the 90th percentile 0-53 rounds. Even the
  busiest men (a German rifleman 192 rounds, a Russian PKP 555 rounds in 2400 s) stay far below the sources'
  sustained rates (rifle 12-15 a minute, machine gun about 100 a minute while engaged; section 3).
- **The load is never the limit.** On average a side's men use 0-22 % of what they carry; the machine guns most
  (13-22 % on foot). At most 7 of 36 German gunner-battles (platoon) ran out of loaded spare belts (first at about
  935 s), and at most 2 men in any scenario were ever completely dry, and then only for a while: comrades hand belts
  over (0-8 hand-overs a battle, the M4 `bringAmmo` rule). The rifle magazine reserve rule (a rifleman keeps his last
  magazine) is reached by 1-7 riflemen in a scenario.
- **Vehicle stowage is hardly touched.** Men took magazines from a halted vehicle (`fetchAmmo`) in no battle; the
  hulls' own guns used 0-750 rounds of their stowage.
- **The mounted defenders hardly fire.** In platoon-vehicles the Russian defenders' riflemen fired 0 rounds in 5 of 6
  battles (mean 0.02 a minute); in platoon-ru-vehicles both sides fire under 1 round a man. (Noted for the owner;
  not a logistics question. The rifleman's mounted load is 3 magazines (DE) and 4 (RU), the rest stowed.)

So, as the owner's answer foresaw, logistics can only be felt with (a) a longer battle with fresh enemies coming in
waves and (b) men who fire at realistic rates while engaged. Slice 43 measures the rate **per minute in contact**
(not per minute of battle, which the quiet stretches dilute) before anything is raised.

Per scenario, side and weapon type (both AI commanders; DE = Bundeswehr, RU = Russian):

#### platoon (6 seeds, 2400 s limit)
Battle lengths 2400, 2400, 820, 929, 1006, 695 s (ends: side-eliminated, time-limit); winners red, red, blue, blue, blue, blue;
hand-overs of ammunition between men per battle: 3, 8, 0, 1, 8, 0.

| side (who) | weapon | men (6 battles) | load on the man at start | fired per man: median / mean / 90th pct / max | per man and minute of battle (mean) | load gone by 1200 s (mean) | load gone by the end (mean) | men out of loaded spares / with 0 rounds | first out of spares (median s) |
|---|---|---|---|---|---|---|---|---|---|
| blue de | machine-gun | 36 | 240 | 4 / 65 / 218 / 480 | 3.61 | 22 % | 22 % | 7 / 2 | 935 |
| blue de | marksman-rifle | 36 | 120 | 4 / 18 / 68 / 100 | 1.03 | 15 % | 15 % | 1 / 0 | 865 |
| blue de | rifle | 216 | 150 | 0 / 15 / 53 / 192 | 0.75 | 10 % | 10 % | 7 / 1 | 1005 |
| red ru | machine-gun | 18 | 300 | 10 / 103 / 500 / 555 | 3.98 | 19 % | 18 % | 4 / 1 | 655 |
| red ru | rifle | 132 | 180 | 0 / 10 / 33 / 180 | 0.35 | 5 % | 6 % | 1 / 0 | 425 |

#### platoon-ru (6 seeds, 2400 s limit)
Battle lengths 455, 493, 1062, 777, 527, 1098 s (ends: side-eliminated); winners red, red, red, red, red, red;
hand-overs of ammunition between men per battle: 2, 0, 4, 0, 2, 0.

| side (who) | weapon | men (6 battles) | load on the man at start | fired per man: median / mean / 90th pct / max | per man and minute of battle (mean) | load gone by 1200 s (mean) | load gone by the end (mean) | men out of loaded spares / with 0 rounds | first out of spares (median s) |
|---|---|---|---|---|---|---|---|---|---|
| blue de | machine-gun | 18 | 240 | 0 / 17 / 48 / 245 | 2.24 | 4 % | 4 % | 1 / 1 | 155 |
| blue de | marksman-rifle | 18 | 120 | 0 / 16 / 100 / 100 | 1.56 | 13 % | 13 % | 2 / 0 | 240 |
| blue de | rifle | 126 | 150 | 0 / 8 / 5 / 180 | 0.74 | 5 % | 5 % | 5 / 0 | 270 |
| red ru | machine-gun | 36 | 300 | 52 / 66 / 200 / 280 | 6.04 | 21 % | 21 % | 3 / 0 | 490 |
| red ru | rifle | 228 | 180 | 0 / 10 / 36 / 88 | 0.84 | 6 % | 6 % | 0 / 0 | - |

#### platoon-vehicles (6 seeds, 2400 s limit)
Battle lengths 2400, 2400, 2400, 2400, 2400, 498 s (ends: side-broken, time-limit); winners blue, blue, red, blue, blue, blue;
hand-overs of ammunition between men per battle: 0, 5, 6, 4, 4, 2.

| side (who) | weapon | men (6 battles) | load on the man at start | fired per man: median / mean / 90th pct / max | per man and minute of battle (mean) | load gone by 1200 s (mean) | load gone by the end (mean) | men out of loaded spares / with 0 rounds | first out of spares (median s) |
|---|---|---|---|---|---|---|---|---|---|
| blue de | machine-gun | 36 | 240 | 24 / 66 / 210 / 335 | 2.48 | 13 % | 15 % | 7 / 0 | 420 |
| blue de | marksman-rifle | 36 | 120 | 2 / 15 / 44 / 107 | 0.60 | 10 % | 13 % | 1 / 0 | 640 |
| blue de | rifle | 360 | 90 | 0 / 6 / 23 / 180 | 0.21 | 3 % | 4 % | 1 / 0 | 835 |
| red ru | machine-gun | 18 | 300 | 0 / 2 / 15 / 25 | 0.06 | 1 % | 1 % | 0 / 0 | - |
| red ru | rifle | 204 | 120 | 0 / 0 / 0 / 34 | 0.02 | 0 % | 0 % | 0 / 0 | - |

#### platoon-ru-vehicles (6 seeds, 2400 s limit)
Battle lengths 217, 2400, 2400, 2400, 2400, 2400 s (ends: side-broken, time-limit); winners red, blue, blue, blue, blue, blue;
hand-overs of ammunition between men per battle: 2, 0, 0, 0, 0, 1.

| side (who) | weapon | men (6 battles) | load on the man at start | fired per man: median / mean / 90th pct / max | per man and minute of battle (mean) | load gone by 1200 s (mean) | load gone by the end (mean) | men out of loaded spares / with 0 rounds | first out of spares (median s) |
|---|---|---|---|---|---|---|---|---|---|
| blue de | machine-gun | 18 | 240 | 0 / 4 / 0 / 68 | 0.09 | 2 % | 2 % | 0 / 0 | - |
| blue de | marksman-rifle | 18 | 120 | 0 / 4 / 21 / 25 | 0.09 | 3 % | 3 % | 0 / 0 | - |
| blue de | rifle | 198 | 90 | 0 / 4 / 2 / 143 | 0.10 | 3 % | 3 % | 3 / 0 | 405 |
| red ru | machine-gun | 36 | 300 | 0 / 10 / 30 / 173 | 0.75 | 3 % | 3 % | 0 / 0 | - |
| red ru | rifle | 354 | 120 | 0 / 1 / 0 / 51 | 0.06 | 1 % | 1 % | 0 / 0 | - |

## 3. Research: real loads, packaging and practice

Only search extracts could be read (the web pages themselves are blocked here), so every number below is
**confidence "medium" at most**; anything from a game, a forum or a seller is "low" or used only as packaging
evidence. Entries go into the data with the `add-data-entry` skill.

**Basic loads (what a man carries)**

| Item | What the extracts say | Confidence | In the data today |
|---|---|---|---|
| Bundeswehr rifleman (G36 / G95, 30-round magazines) | Five magazines per rifle planned for capability levels 1-2, ten for level 3 (Bundeswehr journal, via pcwelt.de); a G36 technical report pictures a soldier firing "his whole daily supply of 150 rounds" in under 20 minutes. So 150 rounds (5 x 30) on the man. | medium | 5 x 30 = 150 on foot; 3 x 30 = 90 on the man in the mounted scenarios, the rest stowed in the Puma |
| Russian motor rifleman (AK-74M / AK-12, 30-round magazines) | Magazine 30 rounds (45-round RPK and 60-round magazines fit); "4 magazines, 120 rounds" is the figure usually quoted but no extract confirmed it; one extract (a Wikipedia mirror) gives 10 magazines, 300 rounds, as a maximum. | low (the 120); medium (magazine size) | 6 x 30 = 180 on foot; 4 x 30 = 120 mounted |
| MG5 (Bundeswehr) | Fed from 80-round (also 50-round) cloth pouches or a 120-round belt box on the left of the receiver, or from separate ammunition boxes; 640/720/800 rounds a minute selectable (H&K, Bundeswehr pages via extracts). MG3: 120-round box, barrel change after 120 rounds of rapid fire. | medium | gunner 2 x 120 = 240; the assistant carries more belts |
| PKP / PKM (Russian) | 100-round box under the receiver; belts of 100, 200 or 250; PKT belts in 250-round boxes or 1,000-round cans (Great Russian Encyclopedia via extract). A gunner's load is not given. | medium (packaging); none (load) | gunner 3 x 100 = 300 |
| Machine-gun team's load | No extract gave a Bundeswehr or Russian figure. US practice (from general knowledge, not an extract): gunner and assistant carry about 600-1,000 rounds between them. | low | not modelled as a team load yet |

**Rates of fire and how much is used**

| Item | What the extracts say | Confidence |
|---|---|---|
| Rifle | Sustained 12-15 rounds a minute, rapid aimed semi-automatic about 45, bursts about 90 (US TC 3-22.9 summaries and the M4 TM); the TM caps rapid continuous fire at 150-180 rounds before the barrel overheats. | medium |
| General-purpose machine gun (M240/M60 class, the MG5's and PKM's class) | Sustained about 100 rounds a minute in 6-9 round bursts 4-5 s apart, barrel change every 10 minutes; rapid 200 a minute, barrel change every 2 minutes; cyclic 650-950 (US manuals via study cards; the 1964 M60 manual gives the same). | medium |
| Planning averages | US WWII "day of supply": 5 rounds per rifle, 150 per machine gun per day; the "unit of fire" (what a big action uses): 150 per rifle, 2,000 per machine gun; Pacific figures revised to 100 and 500. Consumption "tracks supply": units with more fire more. | medium (as historical planning factors) |
| Ukraine 2022-2025 | Reports are about artillery shells (thousands a day), not rifle rounds; infantry short of ammunition cannot afford to fire at one or two men, which made the enemy move in small groups. | medium (qualitative only) |

**Packaging (what gets carried forward)**

| Package | What the extracts say | Confidence |
|---|---|---|
| 5.56 x 45 mm | 10-round stripper clips; 14 clips (140 rounds) in a cloth bandolier; 6 bandoliers (840 rounds) in an M2A1 can. These are seller listings of the military pattern; Bundeswehr packaging was not found (assume the same bandolier and can until a better source). | medium (pattern), low (Bundeswehr use) |
| 5.45 x 39 mm | 30-round paper packs; 1,080 rounds in a sealed tin; two tins (2,160) in a wooden crate (Uzbek defence-industry catalogue; sellers). | medium |
| 7.62 x 54R | 20-round packs; 440 rounds in a sealed tin; two tins (880) in a crate (sellers); PK belts 100/200/250 in boxes. | medium (pattern) |
| 7.62 x 51 mm (MG5) | 120-round belt boxes, 50/80-round pouches (above); a US .30 cal can (M19A1) holds 200 linked rounds, about 1.7-1.8 kg empty. | medium |
| Mass of a full can or crate | Not given; computed from the rounds' masses already in the data (5.56: 12.3 g a round; 7.62 NATO: 24 g a round with link). An 840-round 5.56 can is about 10.3 kg of rounds + about 2.4 kg can; a 2,160-round 5.45 crate about 23 kg + crate. | derived (game) |

**Practice (how resupply works)**

The doctrine pages themselves could not be opened. What the plan uses, from general knowledge marked low until a
source is found: ammunition is pushed forward to a platoon supply point by vehicle; squads send one or two men back
for it, or bearers bring it forward; machine guns are fed first; after a fight the squad leader redistributes so
every man has about the same; men refill magazines from bandoliers in quiet moments (about 30-60 s a magazine by hand,
10-20 s with stripper clips and a loader); ammunition is taken from casualties once they are treated. The Russian
practice in Ukraine (reported, qualitative): small assault groups carry everything forward; resupply by night, by
drone or by vehicle dash. Values for these timings are game values (low) tuned in the labs.

## 4. Machinery shared with the parallel sessions

The rule stays: every consumable is a counted item in a container, and **`transferItems` is the only thing that moves
items between containers** (SPEC 4.3 rule 9). M11 adds what the three chains all need (`moveCharge` and the ledger in slice 43, first; the stores in 45 and 47):

- **`moveCharge`** (items.ts): moves charge (rounds, litres, watt-hours) from one stack to another of the same
  charge kind inside one container or between two (a bandolier into a magazine, a jerrycan into a tank, a charger
  into a battery). It splits stacks as `transferItems` does and conserves the charge exactly. The batteries session
  uses it for battery charge; this chain for rounds and fuel. Items declare what their charge
  is (`chargeItem`, a cartridge id, for rounds as now; a new `chargeKind` for litres of a fuel or watt-hours) and the
  two stacks must agree.
- **The ledger** (`sim/ledger.ts`, pure, reads state only): counts every countable thing by kind (rounds per cartridge
  id, litres per fuel, watt-hours, whole items) in every container, weapon, feed, carry payload, cache, off-map stock
  and support section. The conservation guard (slice 43) checks `start - end = used + destroyed - delivered from off
  the map`, where used, destroyed and delivered come from events alone. The parallel sessions add their kinds
  (battery Wh, spare parts) as items and the guard covers them without change.
- **Off-map stock** (`state.stock`, one per side, a container entity parked off the map like an off-map asset): the
  only source of anything that arrives during a battle. Its contents come from the `BattleInput` (the scenario or,
  later, the campaign). Nothing in the sim creates items.
- **`OffMapAsset.kind`** becomes `"ambulance" | "supply"`; the repair session adds `"recovery"`. Runs read their
  behaviour from the kind's data block, not from code branches where that is possible.
- **`RearRun.cargo`** becomes `"casualties" | "supplies"` (a combat vehicle's run can carry both ways: wounded back,
  ammunition forward).
- **Rear points:** `RearPoint.kind = "supply"` is already reserved (M10.5). Supply points and caches are their own
  entities (`cache` store), never the nest.
- **State schema:** this chain owns the next schema bumps (22 in slice 45: migration 21 -> 22 adds the empty `cache`
  store; 23 in slice 47 adds the `stock` store). The parallel sessions use new optional fields only (no bump); if one must bump, the later merge renumbers.
  New fields are optional everywhere else.
- **Merge order:** whichever chain merges second runs `npm run golden:update` after the merge and writes a DECISIONS
  line (goldens are expected to change in all three). `packages/tools/golden/no-interiors` is never touched.

## 5. The slices of this chain

Seven slices, built in this order. Each is one session. Every slice ends with `npm run check` run alone, its labs and
batches, a DECISIONS.md entry, STATE.md, and `npm run golden:update` (with a DECISIONS line) where behaviour or data
change. Per-tick work per man or vehicle needs `npm run test:perf` alone (bench-vehicles stays above its 8x floor).
Player-visible changes need screenshots, phone and desktop, looked at.

### Slice 43 (M11.1): consumption test bed, packaging, refilling magazines, conservation, `hold-resupply`, men fire more

**What.** The measuring tools and the long battle first, then packaging and loose rounds, then a careful raise of
fire volume where the sources support it.

1. **`npm run lab -- consumption [seeds] [--seconds 1200,2400]`** (`packages/tools/src/labs/consumption.ts`): the
   measurement of section 2 as a lab: per scenario, side and weapon type the load at start, rounds fired (median,
   mean, 90th percentile, max), rounds per man per minute of contact (a man "in contact" from his first shot or first
   time under fire until 60 s after his last), load gone at 1200 s and at the end, men out of loaded spares and dry
   (and when), squads with a man out of spares, hand-overs, vehicle stowage used. Scenarios: platoon, platoon-ru,
   platoon-vehicles, platoon-ru-vehicles, hold-resupply. Writes `reports/consumption-<stamp>.md`.
2. **The ledger and the conservation guard** (`sim/ledger.ts`, `packages/tools/test/conservation.test.ts`): section 4.
   Counts rounds by cartridge id (magazine and belt charge, rounds in weapons and vehicle feeds, loose rounds,
   packages, support sections' rounds, carried payloads), litres, and whole items. `npm test` runs every scenario of
   the headless list for 1 seed x 120 s; the lab (`consumption --conservation`) runs them for 6 seeds x 300 s and
   hold-resupply for 2 seeds x 1200 s, before each slice is finished. Both check for each kind `start - end
   = fired + thrown + destroyed - delivered` from the event stream alone (new events where needed: `items.destroyed`
   with a cause, `items.delivered`). Acceptance: exact (integers) in every scenario and seed. Any present leak found
   is fixed in this slice and listed in DECISIONS.
3. **Packaging data** (add-data-entry skill; section 3; confidence medium at most): bandolier 5.56 (140 rounds),
   can 5.56 (840), pack and tin 5.45 (30 / 1,080), crate 5.45 (2 tins), 7.62 x 51 belt can (200 linked, game: MG5
   belts of 120 are what a gunner loads, so cans hold belts), 7.62 x 54R box (100/200/250) and tin (440), and the
   matching cans for 40 mm and hand grenades (crate counts low). A package is an item with a charge (rounds) and a
   `chargeItem` like a magazine, but no weapon feeds from it. Fuel and battery items get a `chargeKind` (litres of
   a fuel, watt-hours) so that `moveCharge` and the ledger can match them. A **crate or can on the ground is an
   entity** with a transform and a container (it becomes a cache in slice 45). New factions need no code: the
   fixture faction `xf` gets one bandolier and one can.
4. **Loose rounds on the man** (unit templates, both factions): each rifleman and leader carries loose rounds in
   addition to his magazines: one bandolier (DE, 140 rounds) or four 30-round packs (RU, 120 rounds); values low
   until a source for the carried loose load is found. Machine-gun assistants carry belts as now. The mounted
   scenarios keep their stowage and gain the cans that are really carried there (Puma and BMP-2 stowage lists: low).
5. **`refillMagazines` action** (`actions.ts` handler, decision in `systems/decisions.ts`): a man with an empty or
   partly used magazine (below `refill.belowFraction` 0.5) and loose rounds of the matching cartridge, who has not
   fired for `refill.quietS` 20 s, is not under fire (suppression below 0.1), not moving and not on a care or carry
   task, refills one magazine at a time with `moveCharge` (`refill.secondsPerRound` 1.2 by hand, 0.4 with stripper
   clips: game values, low); interrupted by any fire, order or threat, keeping the rounds already loaded. A machine
   gunner does not reload belts from loose rounds in battle (belts come linked).
6. **The `hold-resupply` scenario** (`scenario` package, `kind: "hold"`; headless name `hold-resupply`, app
   `?scenario=hold`): a German platoon (on foot, three squads and the headquarters) holds the village centre against
   **three Russian waves** (a platoon each, entering at 0, 15 and 30 minutes from the east edge, each with its own
   mortar allotment), time limit 3,600 s; the defender scores for holding the objective at the end. Waves need
   **late arrival**: `UnitInput.arriveS` (optional); until then the unit's men stand off the map exactly like an
   off-map asset's crew (`isOffMapMan` reads it), so no system sees them and no per-tick cost is added. The defender
   has a supply point with one crate per squad 150 m behind the village (it is a plain crate entity in this slice;
   slice 45 makes it a cache) and nothing else. Swapped sides (`hold-resupply-ru`) for the batches. Golden: one
   300 s replay of each. The AI commander takes each wave as it arrives (a wave is a new platoon of its side; the
   attack plan is made again for it). `rules.resupply: false` (headless and batch
   `--no-resupply`, as `--no-medical`) switches every resupply route of slices 44-48 off for comparison batches.
7. **Men fire more, only where justified** (`core/shooting.json`, `core/behaviour.json`): today a rifleman fires
   0.02-0.84 rounds a minute averaged over the battle and a machine gunner 0.06-6 (section 2), against sources of
   12-15 (rifle, sustained) and about 100 (machine gun, sustained) while engaged. The comparison must be per minute
   **in contact**, which the lab measures first. Candidate changes, each measured alone in the lab and the batches
   and kept only if it brings the in-contact rate closer to the sources without breaking the balance bands:
   (a) the slowdown after 30 s without incoming fire (`trickleIntervalS` 10 s) applies only when no enemy is seen
   or reported within 60 s (a seen enemy keeps the full rate); (b) a base of fire (drill cover half, ordered fire
   task, defenders in a held sector) fires at a known or suspected enemy position it cannot see at the
   suppressive rate (rifles one aimed shot per 4 s, machine guns one 5-7 round burst per 4-5 s: sources above); a
   pinned man fires back at the place the fire comes from (the open point in DECISIONS "Sight realism: review
   fixes"); (c) machine guns take a sustained rate of 100 a minute while a target is in sight, rapid for the first
   30 s of a contact. The ammunition rule `conserve` / `maximum` stays as it is.

**Acceptance.** Conservation exact in every scenario (6 seeds). Lab `consumption` runs and its numbers for the four
platoon scenarios match section 2 within 10 % before any change in point 7. After point 7: rifle and machine-gun
rounds per man per minute in contact within the source ranges (rifle 4-15, machine gun 40-120), and in
`hold-resupply` without any resupply (`--no-resupply`) **at least one defending squad has a man
out of loaded spares by minute 30, and a defending machine gun is dry by minute 45, in the median of 6 seeds**.
Balance of the four platoon scenarios (10 seeds x 1200 s) stays inside the bands of DECISIONS "Sight realism: review fixes"
(attacker wins 2-8 of 10 where they were inside), or the change is reported to the owner before it is kept.

**Tests.** `moveCharge` (split stacks, conservation, mismatch refused); ledger over a hand-made state; the
conservation test; refill action (quiet gate, interruption keeps rounds, never for belts); late arrival (no system
sees an unarrived man, save/load in between). **[perf]** the refill decision is part of the existing staggered
decision step (no new per-tick loop); ledger only in tools/tests. `npm run test:perf` alone. **Screenshots:** none
(no UI yet; the men's ammunition bar already shows rounds).

### Slice 44 (M11.2): redistribution, and taking ammunition from casualties

**What.**
1. **Consolidation** (`systems/decisions.ts` or a new `systems/consolidate.ts`, once a squad has not been fired upon
   for `consolidate.quietS` 60 s): the squad leader evens out the ammunition of the squad's able men: belts first
   (a gunner below 2 belts gets them from the assistant and the riflemen who carry belts), then magazines so that no
   man has 2 or more magazines more than another, then loose rounds. Hand-overs reuse `bringAmmo` intents and the
   `transferItems` action (3 s a hand-over), at most two at a time per squad.
2. **Own casualties** (`systems/medical.ts` hook): once a casualty's treatment is finished (`rec.firstTreated`) or he is
   dead, the nearest able man of his squad within 30 m who is low (or the treating man, if the squad is low) takes his
   magazines, belts, grenades and rockets, leaving a treated man who can still fight one magazine. Never before the
   treatment (owner); never from a man still being cared for or carried. The nest holds no ammunition (owner): a casualty
   brought there hands his ammunition, at the nest's edge, to the nearest able man of his platoon, or it is left
   as a small cache 30 m outside the nest (slice 45 makes it a cache).
3. **Enemy weapons and ammunition, on order only** (new order `takeKit` to a unit, target an enemy casualty, prisoner or
   abandoned cache): the men take enemy ammunition only if it fits a weapon they carry; otherwise a man may swap his
   rifle for the enemy rifle with its magazines (the rifle becomes an item in his container: personal weapons get an
   item entry each, `weaponItem` on the weapon def, so nothing appears or vanishes). The AI never orders it. Taking
   arms from enemy wounded or prisoners is lawful (disarming); the conduct tally records nothing.

**Data.** `core/behaviour.json` `consolidate` block (game values, low).

**Acceptance.** Lab `npm run lab -- redistribute`: a squad with loads of 0-6 magazines evens out within 60 s of
quiet (no man more than one magazine from the mean, belts to the gunner first), ledger unchanged. In the batches,
taking from casualties never happens before the casualty's treatment (0 cases in 20 seeds of each platoon scenario and hold-resupply) and median rounds
taken from casualties per battle is reported. `takeKit` test: German rifleman takes a Russian rifle and 3 magazines,
fires them, ledger exact; refused with a radio reason when nothing fits. Batches 10 seeds each: dry men per battle
reported against slice 43.

**UI.** "Take enemy kit" on the order bar (phone: under "⋯"), only shown with an enemy casualty, prisoner or cache
selected nearby. Screenshots `--scene ui` phone and desktop.

**Perf.** Consolidation once per squad per 2 s, only when quiet. `npm run test:perf` alone.

### Slice 45 (M11.3): supply points and caches

**What.**
1. **Caches** (`cache` store: `{ side, top, kind: "point" | "cache", placed?, hp, cookoff?, capturedBy? }` plus a
   transform and a container): a supply point is a cache that a platoon uses (`RearPoint kind "supply"` refers to
   it); a cache is any pile of ammunition on the ground (dropped crates, a delivery).
2. **Siting** (`systems/supply.ts`): a platoon's supply point is sited automatically like the nest (behind the
   platoon, covered from the enemy it knows) but **at least `supply.nestApartM` 50 m from its nest and never inside
   it**; no ammunition is ever put at the nest (a check in `transferItems` callers: the nest point is not a valid
   destination for an ammunition item; a test).
3. **Destruction and cook-off** (`systems/explosions.ts` hook): a cache takes blast and fragment damage like a light
   vehicle's ammunition rack: hits by high explosive within its radius or a burning vehicle next to it may set it off
   (chance per kilogram of explosive filling, `supply.cookoff`, low); a cook-off destroys its contents
   (`items.destroyed`, cause "cookoff"), throws fragments in bursts over 30-120 s (the M7.4a cook-off model), and
   burns. Rifle rounds alone do not detonate in bulk (they burn and pop: no fragments, contents lost over time;
   source: general knowledge, low).
4. **Capture**: a cache with no able man of its side within `supply.holdM` 50 m and an able enemy within 10 m for
   10 s becomes the enemy's (`cache.captured`, the side changes; its contents count as captured in the record). Caches
   are legitimate targets; the AI fires at an enemy cache it sees with high explosive when no better target is
   there.
5. **Orders**: `supplyPoint` (to a platoon or its leader: put the supply point here; it stays, like `casualtyPoint`),
   `resupplyAt` (to a squad: go to a supply point or cache, take up to the standard load per man, come back to where
   you were; refused with radio reasons: none in reach, cache empty, under fire). The order bar gets "Supply point"
   and "Resupply" (phone: under "⋯").
6. **Map icons**: an ammunition-crate icon (own colour, enemy colour when known, grey when empty) on the map at
   every zoom, the supply point with its fill level, a cook-off drawn as a burning pile with smoke (reuse the
   vehicle fire). Photo and flat look; flat stays byte-identical elsewhere.

**Data.** A new core file `core/supply.json` (siting, cook-off, capture, request and delivery values; game values,
low, except where section 3 gives a source). A new file under `core/` is bundled by the existing `core/**` glob in
`packages/app/src/data.ts` (the bundle test checks it); no new folder.

**Acceptance.** Tests: siting apart from the nest; ammunition refused at the nest; cook-off destroys exactly the
contents (ledger); capture after 10 s and not with a defender near; orders and their refusals; save/load mid
cook-off. Lab `npm run lab -- cache`: a 120 mm and a 152/155 mm round at 0, 5, 10, 20 m from a full crate (cook-off
chance table). Screenshots `--scene supply` (new): the supply point and a cache in both looks, phone and desktop,
the cook-off. **[perf]** `bench-caches` (bench with 20 caches spread over the map, one being shelled): within 5 % of
bench, `npm run test:perf` alone.

### Slice 46 (M11.4a): resupply on foot

**What.**
1. **A squad asks** (`systems/supply.ts`, both sides, player and AI alike): a squad whose able men hold below
   `supply.requestBelow` 40 % of their standard load of rounds, or whose machine gun is below one belt, radios for
   ammunition ("radio.ammoRequest"), once per 120 s.
2. **Bearers** (platoon level): the platoon sends two men (the headquarters' runner and a man of the asking squad's
   rear, never the gunner or a leader, never a medic or first responder: medical personnel doing other work lose their
   protection; a software decision from the law of war, for the owner to confirm) to the supply point; they
   take a crate (two men: the M10 carry store with a crate as the payload, method "two-hand carry", speed from its
   mass) or cans and bandoliers into their own containers (one man: up to `supply.bearerMaxKg` 25 kg), walk to the
   squad by covered routes (`routeBetween`), and hand out (slice 44's evening out). Bearers under fire take cover
   with the load (the M10.4a rules). An ammunition bearer is no protected person.
3. **Player orders**: "Fetch ammunition" (to a squad: send two of your men to the supply point and back) and
   "Bring ammunition to" (to the headquarters: bearers to that squad). The automatic request runs on the player's side
   too, but only proposes: a radio message plus a button on the squad card ("Send bearers"), unless the player's
   standing rule says "automatic" (new rule `supply: "auto" | "ask"`, default auto).
4. **The AI** (`ai/src`): the commander never takes men from a squad holding an objective under attack (the bearer
   comes from the headquarters or from a squad not in contact); a defended objective is never stripped.

**Acceptance.** `npm run lab -- resupply` (new): a squad at 400 m from the supply point is resupplied within a time
that the lab reports against a hand calculation (walk there and back at the carry speed + loading and hand-over)
within ±10 %. In hold-resupply (6 seeds), with bearers on: fewer men dry at the end than slice 43's no-resupply runs,
and no bearer trip starts from a squad in an assault. Tests: request thresholds; bearers chosen (never gunner,
leader, medic); carry of a crate conserves its contents; under fire the bearers stop and go on. **[perf]**:
requests once per squad per 2 s; carrying through the existing carry system. Screenshots: bearers carrying a crate
(`--scene supply`), the squad card's button, phone and desktop.

### Slice 47 (M11.4b): resupply by vehicle and off the map

**What.**
1. **Rear runs carry supplies** (`systems/rearrun.ts`): `RearRun.cargo` becomes `"casualties" | "supplies"`; a combat
   vehicle away on a run comes back with its stowage refilled from its side's off-map stock up to the vehicle's
   standard stowage (what it started with), and unloads the platoon's share into the supply point (crates into the
   cache by `transferItems`, a timed action per kilogram). Away time as for casualties (900 s; game value). A run
   that takes wounded back brings ammunition forward on the same trip.
2. **Off-map delivery** (`OffMapAsset.kind: "supply"`, `core/supply.json` delivery block): a supply vehicle per side
   (Bundeswehr: a truck or a Boxer in the transport role; Russia: a Ural or KamAZ truck or an MT-LB; data low until
   sources) waits off the map, is called (automatically when a platoon's supply point falls below
   `supply.callBelow` 30 % of its standard fill, or by the player's "Order a delivery"), drives to the supply point,
   drops its load (crates become part of the cache), and leaves. One delivery per side at a time; travel times from
   the data (call to arrival 600-1,200 s: game values, low).
3. **Mortar and artillery top-up** (owner: allotments topped up by deliveries): the side's off-map support section
   receives rounds from the off-map stock at the rate the scenario sets (`stock.supportTopUp`, rounds per 10 minutes);
   an on-map mortar section receives them by delivery to its position (a cache next to the tubes). The fire-support
   panel shows the rounds left as now.
4. **The ambulance and ammunition (law of war)**: an ambulance (or any vehicle showing the protective emblem) never
   carries ammunition on its own; a player order that would put ammunition into one (a transfer, a rear run with
   supplies by a protected vehicle, a delivery by an ambulance) is carried out but recorded as a **breach**
   (`conduct.breach`, cause "ammunitionInAmbulance") and the vehicle loses its protection while it carries it (the
   enemy may fire at it; the recognition code reads a new `protectedUnlessCarrying` rule). The AI never does it.
   The review's Conduct tab lists it.

**Data.** `core/supply.json` delivery and stock blocks; scenario stocks in the scenario builders (hold-resupply: the
side's stock for 60 minutes: game values set so that resupply decides the battle, documented in DECISIONS).

**Acceptance (with 46).** `lab -- resupply` within ±10 % of the hand calculation for the vehicle run and the off-map
delivery as well. Over 20 seeds of hold-resupply: fewer squads dry at the end with all three ways on than with none
(report the medians: none / foot only / all), and the AI never strips a defended objective (0 bearer trips from a
squad in contact). Conservation exact with deliveries (`items.delivered` balances the off-map stock). Breach test:
ordered ammunition into an ambulance gives one breach and the enemy may then fire at it; the AI never does it in 20
seeds. **[perf]** off-map vehicles are skipped by every system (architecture test). Screenshots: a supply truck at
the supply point, the delivery button, phone and desktop.

### Slice 48 (M11.5): re-arming and refuelling vehicles

**What.**
1. **Re-arming**: a halted vehicle within 15 m of a cache (or a supply vehicle) with rounds for its weapons takes
   them into stowage (crates by `transferItems`, a timed action by its crew: `rearm.secondsPerKg`, low); its ready
   racks and belts then refill from stowage as today (owner Q17). Missiles and reactive tiles are items like any
   other (tiles: a damaged-tile swap belongs to the repair session; this slice moves the item only).
2. **Refuelling**: fuel in jerrycans (20 l, items with a litre charge) or from a supply vehicle's tank: litres move by
   `moveCharge` at `refuel.litresPerMinute` (jerrycan by hand about 20 l a minute; a pump about 100 l a minute: low)
   while halted. A vehicle below `refuel.callBelowL` asks like a squad (slice 46) and may go on a rear run for fuel.
3. **Rounds to mortars**: on-map mortar tubes take rounds from a cache next to them (men carry them: a mortar man
   fetches rounds when the tube's ready stock is below 10).
4. **Roster round trip**: `VehicleRecord` keeps fuel litres and stowage as now (check that refills and deliveries come
   out in `forcesOut`).

**Acceptance.** Conservation covers litres (equal within 1e-6 l: litres are not whole numbers); roster round trip keeps fuel and
stowage after a refuel and a re-arm (test). `lab -- rearm` (new): times to re-arm a Puma, a BMP-2, a Leopard 2A7V and
a T-90M from a full cache, and to refuel each from jerrycans and from a truck; checked against the hand calculation.
Mounted batches 10 seeds each: no change beyond noise unless stowage ran low (reported). Screenshots: a vehicle
re-arming at a cache (`--scene supply`).

### Slice 52 (M11.8): the AI's logistics, the Logistics review tab, batch columns, results, balance

**What.**
1. **AI logistics** (`ai/src`): the commander sites the supply point, sends bearers and runs, calls deliveries, moves
   a threatened cache, re-arms its vehicles between waves, never strips a defended objective, and fires at enemy
   caches it sees.
2. **Logistics tab in the review** (`ui/src/aar.ts`, fourth tab after Medical and Conduct; data from the battle record
   `record.ts`, new `logistics` block): per side, rounds fired by weapon type, rounds delivered (by foot, by vehicle,
   from off the map), taken from casualties, captured and lost (cook-off, captured caches), men dry at the end,
   supply requests and how long they waited, fuel used and delivered. All text from the string table.
3. **Batch columns** (`tools/src/cli/batch.ts`): fired, delivered (foot / vehicle / off map), taken from casualties,
   captured, destroyed, dry men at the end, requests, mean wait.
4. **`BattleResult`** gets `logistics: { consumed, delivered, captured, destroyed }` per side (counts by item id and
   litres) and `forcesOut` already carries the loads: input for M12 and M13.
5. **Balance**: hold-resupply 20 seeds each way (German defence, Russian defence): the defender holds in 30-70 % of
   battles, and holds clearly less often with resupply switched off (the "resupply decides" check: at least 25
   percentage points fewer holds). The four platoon scenarios stay in their bands.

**Acceptance.** The numbers above; the review tab on the phone and the desktop (screenshots `--scene aar` with the new
tab, looked at); a write-up with the `balance-report` skill in DECISIONS; you (the owner) play
hold-resupply on your phone.

## 6. Open points for the owner (asked later, not blocking)

- **Mounted defenders who hardly fire** (section 2): the Russian riflemen defending in platoon-vehicles fired no
  round in 5 of 6 battles. Not a logistics question; to look at in the next debt slot.
- **Loose rounds carried on the man** (slice 43): the Bundeswehr bandolier and the Russian packs are assumptions
  (low) until a source is found; the owner may know the current practice.
- **Medics as bearers** (slice 46): the plan keeps medics and first responders out of ammunition carrying (they would
  lose their protection); to confirm.
- **Enemy weapons** (slice 44): only rifles and their magazines in this chain; enemy machine guns, launchers and
  vehicles' stowage on order later, if wanted.
- **"Men fire more"** (slice 43, point 7): kept only where the in-contact rate moves toward the sources and the
  balance bands hold; if a change helps realism but moves a band, the owner decides.
- **Military police and prisoners of war**: a separate workflow after this chain (owner).
