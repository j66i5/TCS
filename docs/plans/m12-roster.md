# M12 Persistent roster and linked battles (SPEC 9.3 stage one): build plan

**Progress:** plan written 2026-11-19 (this file, branch `claude/m12`, from main 828e4e0 after balance pass 4).
12.0a built 2026-11-19 (DECISIONS "M12.0a"; craters carried in are rough ground only, this battle's own craters
still do not touch the grids; wrecks of earlier battles are hulls of side `WRECK_SIDE`).
12.0b built 2026-11-19 (DECISIONS "M12.0b"; kinds attack / defence-counterattack / meeting / ambush / withdrawal,
exit zones, objectives scoring at a time, late units with their hulls, a company per side, `bench-company` and the
per-battle cap in `core/campaign.json`; the company headquarters is not in the data yet: it comes with 12.1a).

SPEC 9.3 stage one: the player's force carries over between linked battles; soldiers keep names, experience, wounds,
fatigue and stress history; vehicles keep damage; replacements arrive green. The owner answered the M12 round on
2026-11-19 (section 1): the force is a **battalion**, played as **operations of 3-5 linked battles plus an endless
mode**, with **free saving**. This plan adapts roadmap-detail "Phase 7: M12" (slices 53-58 there) to those answers. It
keeps that structure (12.0a contract gaps, 12.0b scenario kinds, 12.1 campaign record and rules between battles, 12.2
linked operations, 12.3 phone roster interface, 12.4 review) and splits 12.1 in two because a battalion needs data and
the saves are a slice of their own: **seven slices**, each reviewable in one agent session.

Roadmap-detail numbers its slices 53-58 per phase; this plan calls them by milestone number (12.0a ... 12.4) to avoid
the clash with M11.9's slices 53-55.

## 1. The owner's answers (binding, 2026-11-19)

| Question | Answer | Where it is built |
|---|---|---|
| Force | **A battalion** (its companies and platoons); **the player picks what fights each battle**. The factions' existing templates; missing company / battalion templates added as data (add-data-entry rules: sources, confidence `medium` at most from search extracts). | 12.1a data, 12.2 selection, 12.3 screen |
| Operations | **Operations of 3-5 linked battles on connected maps; the result picks the next battle**, PLUS **an endless mode**: battles keep coming, with periodic replenishments. | 12.2 |
| Saving | **Free saving**: save and load any time between battles; several slots; export and import. | 12.1b, 12.3 |
| Experience | **Grows a little per battle and more under fire, capped; stress history stays.** | 12.0a (tally), 12.1a (rule) |
| Replacements | **Green men arrive between operations** (endless mode: at each replenishment), **not between battles of one operation.** | 12.1a |
| Ammunition and fuel | **Refilled to the standard load at replenishment** (between operations, endless-mode replenishments); **within an operation units keep what they have left; consumption logged.** | 12.1a, 12.2 |
| Recovered wounded | **Back to their old squad if there is room, else to the pool.** | 12.1a |
| New leaders | **Appointed automatically; the player can change them.** | 12.1a (rule), 12.3 (man card) |

Hard rules that bind every slice (CLAUDE.md, SPEC 4.3): the campaign package is deterministic like the sim (seeded
RNG with named streams from `sim/rng.ts`, transcendental maths only via `sim/math.ts`, no `Math.random`, no wall
clock, iteration in ID / key order); it runs battles only through an **injected `BattleRunner`** and **never imports
`ai`**; `app` may import `campaign`; `tools` wires the AI controllers into the runner. No faction literals in the
campaign code (fixture faction `xf` must run a chain). Player-facing text through `Strings.t`. Never touch
`packages/tools/golden/no-interiors`; goldens unchanged whenever the new input fields are absent.

## 2. What exists today (main 828e4e0)

- **Roster contract** (`sim/src/battle.ts`): `SoldierRecord` (identity, skills incl. `experience`, `fatigue`,
  `stress`, `strain`, `hydration`, wounds, physiology, load, `powerFitted`, status incl. "evacuated" / "captured" /
  "missing", `recoveryDays`, `diedOfWoundsTick`, `heldBy`, `powEvacuated`), `UnitInput` (key, callsign, echelon,
  `leaderIndex`, members, subunits, quality, bond, `vehicleId`, `carrierId`, `arriveS`), `VehicleRecord` (load,
  ready belts, components, status, `capturedBy`, `recovery`). The record round trip through `runBattle` is tested
  (`medical-evac`, `medical-rearrun`, `roster.test.ts`, power, logistics).
- **Result** (`BattleResult`): `forcesOut`, `wrecks`, `caches`, `logistics` per side (consumed, delivered, captured,
  destroyed), `prisoners`, scores and winner. Settlement at the end (wounded, prisoners, hulls: `settleBattle`,
  `settleVehicles`).
- **Missing for a campaign** (roadmap-detail 12.0a): terrain damage in and out (`state.terrain` holds craters, wall
  holes, vegetation loss, dug positions, but `BattleInput` cannot carry them in and `BattleResult` does not carry
  them out); wrecks of earlier battles in; `ScenarioDef` builds forces only from templates (`templates`,
  `attackerPlatoons`), so a roster cannot be fed to the generator; no per-man tally of what he went through (for
  experience); the campaign package is not under the determinism lint (eslint applies it to `sim` and `scenario`
  only) and `app` is forbidden to import it (eslint row `app: ["tools", "campaign"]`, architecture test).
- **Scenario generator** (`scenario/battle.ts`): one kind, `platoon-attack` (attack or defence, 1-2 attacking
  platoons, mounted or on foot, tanks, mortars, missile and AGL teams, artillery, drones), plus `holdBattle` (waves,
  resupply). ARCH row 9.3 "procedural scenario generator" is 🟡 (meeting engagement, ambush, withdrawal missing).
- **Data**: platoons, squads, teams, sections, crews (DE `pzgren-zug`, `jaeger-zug`, `moerser-gruppe`,
  `panzer-halbzug`, `gmw-trupp`; RU `motor-rifle-platoon`, `motor-rifle-platoon-btr`, `minomyotny-vzvod-82`,
  `tankovaya-gruppa`, `raschet-metis`, `raschet-ags`, `shturmovaya-gruppa`). **No company or battalion template, and
  no company headquarters**, in either faction or the fixture.
- **App**: one battle from URL parameters; one save slot in `localStorage` (`app/src/save.ts`, mid-battle).
- **Speed**: a platoon battle runs about 50x real time headless, `bench-vehicles` 12-13x (floor 8x). A company per side
  mounted is not measured yet (12.0b).

## 3. The design in one page

**The battalion.** A campaign starts from a faction and a carrier class (tracked / wheeled, as the platoon battles):
DE Panzergrenadierbataillon (Puma) or Jägerbataillon (GTK Boxer); RU motor rifle battalion on BMP-2 or BTR-82A; xf a
fixture battalion. Data (12.1a): a **battalion template** = battalion headquarters + three **company templates**
(company headquarters + three existing platoon templates) + the battalion's support (mortar section(s), AGL team,
missile team where the faction has one) + an attached tank section (the batch's tank sections, as "attached" in the
data note). About 300-350 men and 35-45 hulls. Off-map assets (ambulances, recovery, supply truck, military police)
stay per battle from the manifest as today: they are not persistent in stage one.

**Who fights.** Each battle has a **sector** and a **kind** (12.0b). The player commits up to **one company's worth**
(1-3 platoons, optionally the company headquarters, plus at most the support the kind allows: the mortar section, one
AGL / missile team, the tank section), cap set by the 12.0b perf measurement and kept in `core/campaign.json`. A
default pick is offered (the fittest company). Units not committed are in **reserve** (they rest). An operation step
may also have **flank battles** for one other company (data per operation template): those are **auto-resolved with
the real sim** (AI on both sides, headless, the same `BattleRunner`); the player may also auto-resolve his own battle.

**Operations.** An operation is a generated chain of **3-5 battles on connected sectors** (a short line of sector
maps, each with map kind, seed and size; the exit edge of one leads to the entry edge of the next). Each node has a
kind and posture (attack, defence with counter-attack, meeting engagement, ambush, withdrawal); **the result picks the
next node** (win: advance; loss: the enemy counter-attacks or the battalion withdraws; a draw: the same sector again,
its damage kept). It ends in success (last sector taken / held), failure (two losses in a row, or the battalion below
its combat-ineffective line), or after 5 battles. Then **replenishment** and the next operation.

**Endless mode.** No operation frame: the next battle is generated from the last result (same transition rules) on a
new or the same sector, forever; **every N battles (`endless.replenishEvery`, 3) a replenishment** as between
operations.

**The enemy.** An enemy battalion of the other faction with its own roster, **remembered with its losses**; it is
replenished on the same rhythm (its own green men). It commits units by the kind's force ratio from what it has. A
battle never starts with a side of 0 men: if the enemy has nothing to commit the node is won without a battle; if the
player has no able platoon the operation ends.

**Between battles (within an operation).** The clock advances (battle time + `hoursBetweenBattles`). Pools are
updated from `forcesOut`: killed (and died of wounds) to the dead list; "evacuated" wounded to **recovering** with
`recoveryDays`; "captured" own men to **prisoners held by the enemy**; enemy men we hold to the **enemy prisoners**
list; "missing" stays missing until the next settlement. Fatigue and shock recover with the hours, strain more slowly,
**stress history** (peak shock, strain, battles under fire, wounds) is appended per man and never erased. **Experience**
grows a little per battle and more under fire (from the per-man tally), capped. **New leaders** are appointed
automatically where one is gone. **No replacements; units keep the ammunition, fuel and loads they have**; hulls keep
their damage except what crews repaired in battle; towed or recovered hulls are repaired over `repairDays` and rejoin.
Recovered men rejoin (owner Q-A below for the timing). Consumption is logged per battle (from `BattleResult.logistics`).

**Replenishment** (between operations, endless-mode replenishments). Days pass (`daysBetweenOperations`), recovering
men whose days are up return (old squad if there is room, else the pool), **green replacements** fill empty places
(the faction's lowest quality distribution, experience from it, a new `personId`), **every unit's load and every hull's
stowage and fuel are refilled to the template's standard load** (the difference logged as delivered), destroyed and
captured hulls are replaced (owner Q-B), damaged components repaired.

**Saving.** The campaign record is plain data, versioned, migrated on load; slots in IndexedDB (several, plus an
automatic slot after every battle), export / import as a JSON file. Save and load any time between battles.

## 4. Slices

Seven slices in this order; 12.3 can start once 12.2's state machine API is merged (it can run beside the second half
of 12.2). Every slice ends with `finish-milestone` (full checks, review, documents) and a DECISIONS entry; game values
are `confidence: "low"` and listed for the owner.

### 4.1 Slice 12.0a: contract gaps (M)

Build the battle contract the campaign needs, with nothing changing when the new fields are absent.

- `BattleInput.damage?` (terrain damage from earlier battles on this sector: craters, wall holes, vegetation loss, dug
  positions) applied at setup and stamped into the navigation grids exactly as damage made during a battle;
  `BattleInput.wrecksIn?` (wrecks from earlier battles: type, side, place, heading, status) placed as wreck hulls (no
  crew; nav stamp as `isWreck`), not part of either side's force.
- `BattleResult.damageOut?` (the sector's damage at the end, the input's included) and `BattleResult.service?` (per
  `personId` of every man who took part: seconds under effective fire, seconds in contact, rounds fired, wounds taken,
  peak shock, peak strain), both produced **only when the input asks** (`rules.campaignOut: true`), so every golden
  and batch result is byte-identical.
- `ScenarioDef.forces?` (per side: roster `UnitInput`s and `VehicleRecord`s replacing the template build; the
  generator places them in its deployment zones, mounts them in their carriers) and `ScenarioDef.terrain?` (`damage`,
  `wrecks`) passed through to `BattleInput`.
- Campaign package rules: the sim's determinism lint block covers `packages/campaign/src` (eslint `files`); eslint and
  architecture-test rows (campaign: sim, data, scenario; never ai; app may import campaign: lift `app: [..., "campaign"]`);
  `campaign/src/runner.ts` with `type BattleRunner = (input: BattleInput, opts: { onProgress?(s: number): void }) =>
  BattleResult` (tools and app provide it with the AI controllers).
- `npm run campaign -- chain --faction de --battles 2` (tools CLI) as the smallest consumer: battle 1's `forcesOut`,
  `damageOut` and wrecks into battle 2 on the same map.

**Acceptance:** a property test feeds battle 1's `forcesOut` into battle 2 and checks that every field of every
record arrives (fatigue, shock, strain, hydration, wounds, physiology, `recoveryDays`, loads to the round, fitted
batteries, vehicle components, ready belts, fuel litres); a crater made in battle 1 is in battle 2's navigation grid
and a wall hole is passable; a wreck from battle 1 blocks the grid in battle 2; `npm run golden:update` is NOT needed
(goldens and the no-interiors goldens unchanged); xf runs a two-battle chain; ARCH rows added; lint fails on
`Math.random` in `packages/campaign/src`.

### 4.2 Slice 12.0b: scenario kinds and company-size battles (M; SPEC 6.9, ARCH row 9.3 🟡 -> ✅)

- `ScenarioDef.kind`: `attack` (today's `platoon-attack`, kept as an alias so every existing scenario and golden is
  unchanged), `defence-counterattack` (the defender holds; at a scheduled time it gets a counter-attack force from its
  reserve), `meeting` (both sides advance to objectives in the middle), `ambush` (the defender hidden on a route, the
  other side on the move along it: the M9 ambush rules, D4b), `withdrawal` (one side must get its units out through an
  exit zone by a time limit while the other follows up).
- Objectives as data: exit zones (units off the map edge count as saved, not lost), time limits that score
  (hold until T), reinforcement schedules (`UnitInput.arriveS`, already in the sim, from the scenario per side).
- Size: up to a company per side (3 platoons + company headquarters + support), map size from the force size;
  `bench-company` (mounted, a company each) headless and phoneperf; the cap per battle written to
  `core/campaign.json` from the measurement (the floor: headless at least 4x real time on this container; the phone
  proxy report attached to DECISIONS).
- The AI commander gets the postures the kinds need where it lacks them (move to an exit zone, follow up, hold until a
  time), through orders only.

**Acceptance:** every kind generates and runs AI-vs-AI on every map kind for 10 seeds without a stalemate flag (no
side fired for the last third of the time limit with both sides above half strength); each kind with a roster
`forces` input too; withdrawal: men leaving by the exit zone come out "fit" and count as saved; the existing
scenarios' goldens and batches unchanged; `bench-company` measured and its floor test added; ARCH row 9.3 ✅.

### 4.3 Slice 12.1a: battalion data and the campaign record, rules between battles (M)

- **Data** (add-data-entry skill; sources and `confidence: "medium"` at most from search extracts): company
  headquarters (DE Kompanieführungstrupp in a Puma / GTK Boxer; RU company command group in a BMP-2 / BTR-82A),
  company templates (DE PzGren-Kompanie and Jägerkompanie: HQ + 3 Züge; RU motor rifle company on BMP / BTR: HQ + 3
  platoons), battalion templates (HQ, 3 companies, the mortar section(s), AGL team, missile team where the faction has
  one, the attached tank section), `echelon: company | battalion`; manifest `battalionTemplates {tracked, wheeled}`;
  the same for the fixture faction xf. New strings. The data change moves the catalog fingerprint: `golden:update`
  for the fingerprint only, the event streams compared unchanged, DECISIONS line.
- **`core/campaign.json`** (game values, low): hours between battles, days between operations, experience per battle,
  per minute under effective fire, cap per battle and absolute cap, fatigue / shock / strain recovery per hour, repair
  days per component state, the replacement quality, the combat-ineffective line, the per-battle commit cap (from
  12.0b), endless `replenishEvery`.
- **`CampaignRecord`** (campaign package): version, seed and RNG stream state, clock, mode, the player's battalion
  (`UnitInput` tree + `VehicleRecord`s, each man with `service` history entries: battle id, minutes under fire, wounds,
  peak shock, strain after, experience gained), the enemy battalion (same shape), pools (recovering with days, dead,
  missing, own men held by the enemy, enemy prisoners held, replacements waiting, unassigned), a consumption log per
  battle, the battle history (kind, sector, sides, result summary), and `nextPersonId` counters.
- **Rules between battles** as pure functions: `applyResult(record, battle, result)` and `replenish(record)`: the
  pools; recovery clock; experience from `BattleResult.service` (little per battle, more under fire, capped); stress
  history appended; shock and fatigue recovered by the hours; **automatic leaders** (a unit whose leader is gone: the
  doctrine order in the template (deputy first), then rank, then experience; a platoon leader from the squads when
  none is left in the HQ; the change logged so 12.3 can show it); **no replacements and no refill within an
  operation**; replenishment: recovered men back to their old squad if there is room else to the pool, green
  replacements into empty places (lowest quality, new `personId`), loads, stowage and fuel to the template's standard
  load (logged), hulls repaired / replaced.
- `npm run campaign -- chain --faction de|ru|xf --battles 10 [--seed N]`: a fixed sequence of 12.0b kinds, one
  company of the player against the enemy's equivalent, AI both sides, a replenishment after battle 5; writes
  `reports/campaign-<stamp>.md` (strength, experience, pools, consumption per battle).

**Acceptance:** the 10-battle headless chain is reproducible (two runs, same record hash, both factions and xf); a
man hit in battle 1 with 5 recovery days is in the recovering pool and back in his squad after the replenishment (or
in the pool when his squad is full); no replacement and no refill inside an operation, both at a replenishment
(test); a unit's leader killed -> the deputy leads the next battle; experience grows more for men under fire and never
passes the cap; stress history keeps every battle; rounds conserved across the chain (start + delivered at
replenishment - consumed = end, per item).

### 4.4 Slice 12.1b: saves (S-M)

- Versioned campaign save (`CampaignSave { version, record, slotName, savedAt (string from the app, not used by the
  rules) }`), migrations table (`migrate(v -> v+1)`), **ID repair** on load (duplicate or missing `personId`s and
  `vehicleId`s renamed, leaders' indexes and `carrierId` / `vehicleId` links checked, `nextPersonId` raised past every
  id), a catalog fingerprint check that warns (data changed) and still loads.
- App storage (`app/src/campaign-store.ts`): IndexedDB with several named slots plus one automatic slot after each
  battle; export as a `.json` download, import from a file (validated, migrated, repaired). Save and load any time
  between battles; a battle in progress keeps using today's single mid-battle save, now tagged with its campaign slot.

**Acceptance:** save -> load -> continue matches an uninterrupted run (record hash after 6 battles, a save after
battle 3); an old save (version 1 fixture file in `campaign/test/fixtures`) migrates and continues; a corrupted id set
is repaired and continues; export -> import round trip is byte-identical; IndexedDB tested with a fake in Node
(fake-indexeddb is not a dependency: the store sits behind a small interface with an in-memory implementation for
tests).

### 4.5 Slice 12.2: linked operations and endless mode (M-L; split into 12.2a/b only if the session runs out)

- **Operations**: `generateOperation(record, rng)`: 3-5 nodes on connected sectors (map kind, seed, size per sector;
  the exit edge of one leads to the next), a node = kind + posture + enemy commit ratio + optional flank battle for a
  second company; the **transition table** (data in `core/campaign.json`): win / loss / draw -> next node kind and
  sector; ends in success, failure (two losses in a row or below the combat-ineffective line), or after 5 battles;
  then `replenish` and a new operation.
- **Endless mode**: `nextEndlessBattle(record)`: the next node from the last result by the same table, a new sector
  every second battle (else the same, with its damage), a replenishment every `replenishEvery` battles.
- **Sector memory**: each sector keeps its `damageOut` and wrecks; a battle there gets them as `terrain`.
- **The enemy**: its battalion commits units by the node's force ratio from what is able (fittest first), its losses
  remembered; it is replenished on the player's rhythm.
- **Choosing forces**: `proposeCommit(record, node)` (the fittest company within the cap) and `validateCommit`
  (cap, at least one able platoon, carriers with their squads); the battle input built with `ScenarioDef.forces`.
- **Auto-resolve**: flank battles always, the player's own on request: the same `BattleRunner`, AI both sides, the
  real sim (SPEC 9.3); `onProgress` for the 12.3 progress bar; results applied as for a played battle.
- **Campaign state machine** (`campaign/src/flow.ts`): `briefing -> choose forces -> battle (played or auto) ->
  after-battle -> next / replenishment / operation end`, all transitions pure and recorded, so 12.3 is only screens.
- Batch: `npm run campaign -- batch --operations 50 [--mode operations|endless --battles 30]` -> `reports/`: battles
  per operation, success rate per faction, losses, men recovering, experience spread, consumption, time per battle.

**Acceptance:** a batch of 50 operations per faction (AI plays the player's side) and 30 endless battles completes;
**no battle starts with a side of 0 men** (asserted per battle); every operation has 3-5 battles; the next node
follows the transition table (test); a sector fought twice carries its craters and wrecks; the enemy's roster at a
node is exactly its roster after its last battle (remembered losses; changed only by a replenishment); replenishment only between operations
(every `replenishEvery` battles in endless mode); the batch is reproducible from its seed.

### 4.6 Slice 12.3: phone roster interface (M; can run beside the end of 12.2)

- Screens (ui package, phone first, both looks; strings through `Strings.t`): **home** (new campaign: faction,
  carriers, operations / endless; continue; slots with load / save / rename / delete; export / import), **battalion**
  (tree of companies and platoons with strength, able / wounded / recovering bars, ammunition state, hulls),
  **briefing** (the node: sector map preview, kind, enemy estimate, time of day; choose forces with the proposed
  default and the cap; play or auto-resolve), **man card** (name, rank, role, skills with experience, condition,
  wounds and recovery days, service history with stress peaks, his squad; "make leader"), **after-battle "what
  changed" card** (killed, wounded with days, captured, experience gained, new leaders, ammunition used, hulls lost /
  damaged; operation progress), **replenishment card** (replacements arrived, men back, refilled), auto-resolve
  progress (a Web Worker running the runner, cancel-safe).
- App wiring: `?campaign=1` opens home; a played battle comes back to the after-battle card through the same flow;
  the review keeps working for campaign battles.
- `npm run screenshot -- --scene campaign` (home, battalion, briefing with choice, man card, what-changed,
  replenishment; phone and desktop; both looks).

**Acceptance:** the screenshots, LOOKed at; a Playwright test drives home -> new campaign -> briefing -> auto-resolve
-> what-changed -> save -> reload -> load -> next briefing; the owner plays two linked battles on his phone.

### 4.7 Slice 12.4: review and tuning (S)

- Batches of operations both factions and xf: tune experience gains (a survivor of a full operation under fire ends
  about +0.1-0.2, never above the cap), recovery days against the operation length, the combat-ineffective line, the
  enemy commit ratios (an operation is neither a walk-over nor hopeless: success 30-70 % per faction with the AI on
  both sides), replenishment size, auto-resolve time per battle on the phone proxy.
- Documents: SPEC 9.3 note (battalion), ROADMAP M12 ✅, ARCHITECTURE rows, HOW_IT_WORKS campaign section, STATE.

**Acceptance:** batch numbers in DECISIONS; owner's open questions (section 5) answered or listed; ROADMAP M12 ✅.

## 5. Open questions for the owner (built with option (a) unless he answers first; asked as multiple choice)

- **Q-A Recovered wounded, when:** (a) they rejoin at the first battle after their recovery days are up, inside an
  operation too (only replacements wait for the end of an operation) (b) only at a replenishment.
- **Q-B Lost vehicles:** (a) destroyed and captured hulls are replaced at replenishment with green crews where the
  crew is gone (b) not replaced (c) replaced only at every second replenishment.
- **Q-C Battle size:** (a) up to one company's worth per battle (cap from the perf measurement) (b) up to two
  companies, slower on the phone.
- **Q-D Ammunition inside an operation:** (a) units keep what they have; only in-battle deliveries from the
  operation's battalion stock (the existing off-map `stock`, drawn down across the operation) top them up (b) nothing
  at all reaches them until replenishment.
- **Q-E Saving during a campaign battle:** (a) today's single mid-battle save, tied to its slot (b) between battles
  only.

## 6. Risks

- **Auto-resolve time** on the phone (a company per side mounted may run near real time there): measured in 12.0b and
  12.2; fallback: smaller flank battles (a platoon each), never a statistical shortcut (SPEC 9.3).
- **Battalion data confidence**: company and battalion organisation from search extracts only (medium at most);
  numbers of hulls per company HQ marked low where extracts disagree.
- **Goldens**: every new output field behind `rules.campaignOut`; the data slice moves the fingerprint once.
- **Save compatibility across data changes**: the fingerprint warning plus ID repair; records hold ids, never indexes
  into catalog arrays.
