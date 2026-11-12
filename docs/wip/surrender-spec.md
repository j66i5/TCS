# Surrender (M6.6) — implementation spec

Base: Design 1 (the best-scoring: `isAble` as the one gate, a sticky flag on the observer's own contact, a `surrenderSystem` with no random draw, nothing the owner did not ask for). Grafted from the reviews: a forward-only `captive` field as the record, dedicated events, one "man lost" predicate, the fire stop at the able check, no "heard" contacts in the trigger, a fire tap that refuses, and the guard, invariant and strings tests.

Everything below was checked against the code at commit `2a6afb8`; line numbers are from that commit. Some line numbers in the earlier code maps were wrong (morale.ts, the `Contact` type, the renderer's casualty branch) — use the ones here. Nothing in the repository was modified.

All paths are under `/home/user/TCS`.

---

## 1. Readings fixed by this spec, and questions for the owner

### 1.1 Readings (record each in the DECISIONS entry)

| # | Point | What this spec implements |
|---|---|---|
| 1 | "can no longer fight or walk" | He can do **neither**: `wounds.length > 0 && !impair.canWalk && !impair.canFight`. Kept in one function, `isDowned`, so the owner's answer to Q1 changes one token. |
| 2 | "an enemy he knows of" | One of **his own contacts**: kind `seen` or `reported` (not `heard`), no older than `decisions.contactLostSeconds` (10 s, reused), not flagged surrendered, and the man it names is not himself a casualty. Distance is from his true position to the contact's estimated position. |
| 3 | "no fit comrade near" | No other man of his side within `comradeNearM` who is able, can walk and fight, and is not panicked or routed (true positions: a man knows where his mates are). |
| 4 | "enemies who see him" | Any enemy whose own scan confirms sight of him this tick. No recognition range, no shout. |
| 5 | "reaches him (a few metres)" | A fit enemy within `captureM` with a clear straight line between them (geometry only, no spotting roll). Checked every tick. |
| 6 | Permanence | Surrender and capture are final for the battle. |
| 7 | Comrades' morale | A surrender adds no stress to nearby men. A surrendering leader still causes the existing leader-loss blow, because it comes from the shared helper. |
| 8 | Not reached by the end | He stays "surrendered" in the roster record. |
| 9 | Prisoner record entering a battle | Placed out of the fight from tick 0, as killed and incapacitated records already are. |
| 10 | Grenades | A prisoner no longer dives from a grenade (he fails `isAble`). Deliberate simplification. |
| 11 | Commander's safety checks | Its own prisoners still block its mortars and grenades near them. |
| 12 | Area fire | Fire at a point, mortars, grenades and stray rounds can still hit him. Only target choice changes. |

Point 5 resolves a disagreement between the reviewers: two wanted plain proximity, one wanted the captor to "see" him so nobody captures through a wall. A geometric line check gives the second without tying capture to spotting rolls or tracking slots.

### 1.2 Questions for the owner

Ask with AskUserQuestion, recommended option first (CLAUDE.md). None blocks this slice; the spec implements the first option of Q1, Q3, Q4 and Q5.

- **Q1 — "can no longer fight or walk".** (a) can do neither (recommended, the literal reading, implemented); (b) either one.
  Facts to give him, from a run made for this spec (`platoon`, seeds 1–3, 900 s each, 177 men, 79 wounded):
  - 11 men were at some point conscious and able to neither walk nor fight; 32 could not do at least one.
  - 24 could not fight but could walk; 3 could not walk but could fight (a man can be in more than one count over time).
  - A living, conscious enemy truly within 50 m: 0 of the 11, 4 of the 32 (all in seed 1).
  - Panicked or routed men with an enemy within 60 m: 0.
  - Why: pain is at least the worst wound's severity (`systems/wounds.ts:146`) and fades at 0.0004/s; a man cannot fight from pain 0.6 and cannot walk from a leg wound of 0.45. So a leg wound of 0.6 or more means neither; a torso wound of 0.6 or more stops fighting only.
  - Script: `/tmp/claude-0/-home-user-TCS/28cdc926-c673-5190-a31a-6954631594a4/scratchpad/downed2.ts`; output: `/tmp/claude-0/-home-user-TCS/28cdc926-c673-5190-a31a-6954631594a4/scratchpad/downed2-platoon3.out`.
- **Q2 — taking prisoners.** (a) as a later slice, one nearby enemy who is not under fire walks over to take him, switchable off by a data value (recommended: otherwise most men stay "surrendered"); (b) only when an enemy happens to come within 3 m (implemented now).
- **Q3 — seeing the surrender.** (a) at any distance he can be seen (implemented, his wording); (b) only within a recognition distance such as 300 m.
- **Q4 — surrendered but never reached.** (a) the record says "surrendered" and the campaign decides later (implemented); (b) counted as captured if his side lost.
- **Q5 — a comrade giving up frightens the men near him.** (a) no (implemented; avoids chains of surrenders); (b) yes, like a comrade falling.

Tell the owner plainly: in today's AI platoon battles surrender will be rare, because wounded and panicked men are seldom within 30–50 m of an enemy. It shows in close assaults (the attack lab) and when the player closes in.

---

## 2. State, types and schema

### `/home/user/TCS/packages/sim/src/components.ts`

Add:

```ts
/** Why a man gave up (carried by the `surrendered` event). */
export type SurrenderReason = "wounded" | "panicked" | "routed";

/** A man who has given up. Moves forward only: null -> surrendered -> captured. Never back. */
export interface Captive { state: "surrendered" | "captured"; /** Tick at which he gave up. */ tick: number }
```

- `SoldierState` (line 54): add `captive: Captive | null;` after `casualty` (line 82). Doc: the one source of truth for surrender; `casualty` stays physical, so a prisoner can also be incapacitated or killed.
- `casualty` doc (line 81): say it is physical only and that surrender lives in `captive`.
- `Behaviour` (lines 50–51): union unchanged. Add a comment: `"surrendered"` is set together with `captive` and is never overwritten while `captive !== null`; it is for display and the `behaviour.changed` event; code asks `isCaptive`. There is no `"captured"` behaviour.
- `Contact` (lines 108–119): add

```ts
/** He knows this enemy has given up: he saw it, or a comrade told him. Absent until set; never cleared while the contact lasts. */
surrendered?: true;
```

`ContactReport.contact` (line 126) carries it automatically. Never write `surrendered: undefined` into a stored object.

### `/home/user/TCS/packages/sim/src/state.ts`

`STATE_SCHEMA_VERSION` 14 → 15 (line 36). No serialiser code is needed: the soldier store and contact reports serialise as plain data. Old saves are refused (no migration), as today.

Invariant to hold after every tick: `captive !== null` ⇒ `mental.behaviour === "surrendered"`, no fire task, no action, `intent === null`, `evade === null`, no waypoints, not any unit's leader.

---

## 3. Predicates — `/home/user/TCS/packages/sim/src/impair.ts`

Parameter type for all of them: `DeepReadonly<SoldierState>` (`import type { DeepReadonly } from "./state"`; type-only, no runtime cycle). A mutable `SoldierState` is assignable to it, so `SimView` callers (objectives, knowledge, ai, app, render) need no cast.

| Function | Definition |
|---|---|
| `isConscious(s)` | `s !== undefined && alive && consciousness >= 0.5` |
| `isCaptive(s)` | `s !== undefined && s.captive !== null` |
| `isAble(s)` (line 24, changed) | `isConscious(s) && s.captive === null`. New doc: "Alive, conscious and still in the fight (not a prisoner): can take orders and act for his side." |
| `canReport(s)` (line 29) | unchanged text; now excludes prisoners |
| `isFit(s)` | `isAble(s) && canWalk && canFight && behaviour !== "panicked" && behaviour !== "routed"` |
| `isOut(s)` | `s.casualty !== "none" \|\| s.captive !== null` — the one definition of "man lost", counted once per man |
| `rosterStatus(s)` | `!alive` → `"killed"`; else `captive` → its `state`; else `casualty === "incapacitated"` → `"incapacitated"`; else `wounds.length > 0` → `"wounded"`; else `"fit"` |

Precedence everywhere: killed > captured > surrendered > incapacitated > wounded > fit.

Which predicate decides what:

| Question | Predicate |
|---|---|
| Obeys orders, fires, throws, calls fire, radios, scans, hears, receives reports, leads, holds an objective, counts for arrival and drills, shares ammunition, takes stress and suppression, reacts to grenades | `isAble` |
| Lost to his side: score, commander's losses, unit panel, review heading, attack lab | `isOut` |
| A fit comrade; a man who can take a prisoner | `isFit` |
| Roster record, review row, `SideResult` | `rosterStatus` |
| May an enemy choose him as a target | the chooser's own `Contact.surrendered` flag — never his real state |
| Spotting target, hit by rounds and blast, bleeding | unchanged: every living man |

The `isAble` change covers these call sites with no edit (each verified): `contacts.ts` 84, 117, 154, 161; `decisions.ts` 165, 183, 211, 222; `drills.ts` 31, 35, 186, 222, 254; `fire.ts` 94, 189, 209; `grenades.ts` 37, 198, 239, 269–270; `morale.ts` 30, 39, 45, 122, 125; `movement.ts` 127; `objectives.ts` 24; `orders.ts` 149, 159; `spotting.ts` 51; `support.ts` 50; `wounds.ts` 179, 187.

Sites with their own inline check, which must be edited by hand (section 7): `knowledge.ts:28`, `commander.ts` 26/62/65/67, `app/src/main.ts` 85/348/382–385, `run.ts` 58–68, `setup.ts` 148–154, `labs/attack.ts` 37/48, `cli/screenshot.ts` 121/160.

---

## 4. Data — one block, four identical copies

Key names must be identical in all four; `packages/data/src/catalog.ts:56` fills the catalog through a cast that hides a mismatch.

1. `/home/user/TCS/packages/data/core/behaviour.json` — after `"drills"` (ends line 73), before `"sources"`:

```json
"surrender": { "stepSeconds": 1, "downedEnemyM": 50, "comradeNearM": 30, "caughtEnemyM": 30, "captureM": 3 },
```

Append to the one-line `note` (line 76): "Surrender (owner 2026-11-12): a conscious wounded man who can neither walk nor fight gives up when an enemy he has seen or been told of in the last 10 s (decisions.contactLostSeconds) is within 50 m and no fit comrade (able, can walk and fight, not panicked or routed) is within 30 m; a panicked or routed man gives up when such an enemy is within 30 m; a fit enemy within 3 m takes a surrendered man prisoner; each man reconsiders once a second. Game values from the owner's approximate distances, the same for every faction; 0 switches a rule off." Keep `sources: []`, `confidence: "low"`.

2. `/home/user/TCS/packages/data/src/schemas.ts` — in `BehaviourFile`, after the `drills` object (lines 271–274):

```ts
surrender: z.object({ stepSeconds: Num(0.1, 10), downedEnemyM: Num(0, 500), comradeNearM: Num(0, 500), caughtEnemyM: Num(0, 500), captureM: Num(0, 50) }).strict(),
```

3. `/home/user/TCS/packages/sim/src/catalog.ts` — in `BehaviourDef`, after `drills` (lines 229–233):

```ts
/** Surrender (owner 2026-11-12): the same for every side. 0 switches a rule off. */
surrender: { stepSeconds: number; downedEnemyM: number; comradeNearM: number; caughtEnemyM: number; captureM: number };
```

4. `/home/user/TCS/packages/sim/test/helpers.ts` — in `testCatalog.behaviour`, after `drills` (lines 100–103): the same values as the data.

| Key | Value | Meaning |
|---|---|---|
| `stepSeconds` | 1 | How often each man reconsiders (staggered by ID). Capture is not paced by it. |
| `downedEnemyM` | 50 | Owner. A known enemy this close makes a downed, lone man give up. 0 = off. |
| `comradeNearM` | 30 | Owner. A fit comrade this close stops it. 0 = nobody counts as near. |
| `caughtEnemyM` | 30 | Owner. A known enemy this close makes a panicked or routed man give up. 0 = off. |
| `captureM` | 3 | Owner ("a few metres"). 0 = no capture. |

Reused, no new value: `decisions.contactLostSeconds` (10) for "still knows of him"; `SCENARIO_POINTS.perManDown` = 5 (`packages/scenario/src/battle.ts:37`, used at :106) for the cost.

No faction or doctrine key, no faction literal (rule 8). No random stream is added.

---

## 5. The surrender system — new `/home/user/TCS/packages/sim/src/systems/surrender.ts`

Header doc: the owner's four rules, the readings of section 1.1, the data keys. Imports: `isAble`, `isFit` from `../impair`; `sight`, `eyeHeightM`, `TARGET_POINT_M` from `../los`; `heightAt` from `../terrain`; `secondsToTicks`; `takeOutOfFight` from `./wounds`. Squared distances only; no `sqrt`, no `**`, no RNG. Iterate `state.soldier.entries()` (ID order) only.

### `surrenderSystem(ctx, state, events)`

One pass over `state.soldier.entries()`:

1. If `s.captive !== null`: if `s.captive.state === "surrendered"`, he is alive and `captureM > 0`, look for a captor (below) and, if found, call `capture`. Then `continue`. This runs **every tick**, so a man running past cannot skip the 3 m circle.
2. Otherwise, only when `(id + tick) % every === 0` (`every = max(1, secondsToTicks(stepSeconds))`) and `isAble(s)`: `const reason = givesUp(...)`; if not null, `surrender(...)`.

### `isDowned(s)` (exported)

`s.wounds.length > 0 && !s.impair.canWalk && !s.impair.canFight`. Comment: the owner's "can no longer fight or walk", read as neither; Q1 may change `&&` to `||`.

### `givesUp(ctx, state, id, s): SurrenderReason | null`

- `scared` = behaviour is `"panicked"` or `"routed"`; `downed` = `isDowned(s)`. If neither, return null (no further work).
- `d2` = squared distance to his **nearest known enemy**: the minimum over `s.contacts` of `(c.x - me.x)² + (c.y - me.y)²`, skipping a contact when any of these holds:
  - `c.kind === "heard"` (a sound gives him nobody to give himself up to, and its position is a guess with 35 % range error);
  - `c.surrendered === true`;
  - `tick - c.tick > secondsToTicks(decisions.contactLostSeconds)`;
  - the man it names is missing or has `casualty !== "none"` (a fallen man is nobody to surrender to; the same look `decisions.ts:75` already takes).
- If `downed && downedEnemyM > 0 && d2 <= downedEnemyM²` and **no** other man of his side with `isFit` stands within `comradeNearM` (true positions, squared compare; the scan runs only when the enemy condition already holds): return `"wounded"`.
- Else if `scared && caughtEnemyM > 0 && d2 <= caughtEnemyM²`: return his behaviour (`"panicked"` or `"routed"`). Comrades nearby do not matter here (owner rule).
- Else null.

### `surrender(ctx, state, events, id, reason)` (exported, also for tests)

In this order:

1. `s.captive = { state: "surrendered", tick: state.tick }` — first, so `isAble(s)` is false for everything that follows.
2. `from = s.mental.behaviour`; `s.mental.behaviour = "surrendered"`; `s.intent = null`; `s.evade = null`.
3. Emit `behaviour.changed {from, to: "surrendered"}`, then `surrendered {soldier, side, reason}`.
4. `takeOutOfFight(ctx, state, events, id, "surrendered", null)` (section 6): he stops, his fire task and action end, the lead passes on, his unit's fire ends if he was the last firer. No radio.

He keeps his posture, his position, his weapon and his counted items (rules 9 and 10).

### Capture

Captor = the first man in ID order who is on the other side, `isFit`, within `captureM` (squared true distance), and has a clear straight line to him: `sight(ctx, cx, cy, heightAt(map, cx, cy) + eyeHeightM(ctx, captorPosture), px, py, heightAt(map, px, py) + TARGET_POINT_M[prisonerPosture]).blockedBy === null`.

`capture(state, events, id, by)`: `s.captive.state = "captured"`; emit `captured {soldier, side, by}`. Behaviour stays `"surrendered"`; no `behaviour.changed`. An unconscious surrendered man can be taken; a dead one cannot. A man who never surrendered is never captured.

### Slot — `/home/user/TCS/packages/sim/src/sim.ts`

Import `surrenderSystem` and call it between `contactSystem` (line 106) and `decisionSystem` (line 107). Comment: his contacts and behaviour are fresh; no decision, drill or objective check in this tick treats him as a fighter; enemies flag him at their next scan (at most about 1 s later).

Also add to `/home/user/TCS/packages/sim/src/index.ts`: `export { surrender, surrenderSystem } from "./systems/surrender";` (tools tests need `surrender`).

---

## 6. `/home/user/TCS/packages/sim/src/systems/wounds.ts`

### Extract `takeOutOfFight`

```ts
/** Take a man out of the fight where he is: he stops, his fire task and action end, the lead passes on,
 *  and his unit's fire ends if he was the last man firing. Shared by a new casualty and a surrender.
 *  `reportKey`: the radio message a comrade sends about it, or null for none. */
export function takeOutOfFight(ctx, state, events, id, interruptReason: string, reportKey: string | null): void
```

Body = today's lines 168–172 and 174–195 **in the same order**, so events keep their order: clear the mover (168–169); `hadTask` / `state.fire.delete` (170–171); `interruptAction(state, events, id, interruptReason)` (172); leader handover with `isAble` plus `leaderLost` (179–183); the comrade's radio (184–189) only when `reportKey !== null`, using `reportKey` as the key; `fire.ceased "unable"` (191–195).

### `refreshStatus` (line 152)

- Line 164 becomes `if (s.captive === null) s.mental.behaviour = "incapacitated";`.
- After `if (!first) return;`: `s.posture = "prone"; s.postureTo = null; takeOutOfFight(ctx, state, events, id, "casualty", s.captive !== null ? null : "radio.manDown");`. For a prisoner the helper is idempotent (nothing left to stop, the lead already passed on) and no "man down" is radioed.
- Line 159 stays: it only resets `"incapacitated"`, which a prisoner never has, so a prisoner who comes round is still a prisoner.
- The `casualty` event is still emitted when a prisoner passes out or dies (truthful; the timeline shows it).

`woundSystem` is unchanged: prisoners keep bleeding and can die.

---

## 7. How the surrender becomes known, and who must respect it

Rule: an enemy holds fire only once **he** knows, and he knows only through `surrendered: true` on his own contact for that man. No target choice may read the target's `captive` or behaviour. The existing truth reads (`decisions.ts:75` and `:241` on `es.casualty`, `orders.ts:280` on `physiology.alive`) stay as they are and are not extended.

### 7.1 `/home/user/TCS/packages/sim/src/systems/contacts.ts`

All four edits are no-ops while nobody has surrendered.

1. `learn()` (line 45) — first line inside `if (i >= 0)`, before the early return at line 49:
   `if (c.surrendered === true && old.surrendered !== true) old.surrendered = true;`
   A vaguer report that says "he gave up" is then not thrown away, and nothing ever clears the flag. A new contact keeps it through the `{ ...c }` spread at line 53.
2. Own-sight loop (lines 95–104) — the only place the flag is created (his own eyes, this tick: `e.lastTick === tick`):

```ts
const k = findContact(s.contacts, e.target), isNew = k < 0;
const gaveUp = isCaptive(state.soldier.get(e.target));
const c: Omit<Contact, "reportedTick"> = { target: e.target, x: t.x, y: t.y, errM: ..., kind: "seen", tick, ...(gaveUp ? { surrendered: true as const } : {}) };
const news = isNew || (gaveUp && s.contacts[k]!.surrendered !== true);
learn(ctx, s.contacts, c, -1e9, tick);
fresh.push({ who: id, c, isNew, news });
```

   Add `news` to the `fresh` element type (line 76); in the heard loop `news = isNew`.
3. Pass-on (line 153): `!f.isNew` → `!f.news`, so a newly seen surrender goes out at once instead of after `reportEverySeconds` (10 s).
4. Comrade skip (line 164): add `&& (reported.surrendered !== true || ms!.contacts[k]!.surrendered === true)`, so a comrade who knows the position as well but lacks the flag is still told.
5. Call-out (line 171): add `&& f.c.surrendered !== true` — no "contact!" call about a prisoner.

Unchanged: reports are not relayed again; delivery, hearing and sharing already exclude prisoners through `isAble`/`canReport`; forgetting (line 187) drops the flag with the contact, and it comes back on the next sighting.

### 7.2 Target-choice sites that must skip a man the chooser knows has surrendered

| File and place | Change |
|---|---|
| `systems/decisions.ts` `pickTarget`, after line 71 | `if (c.surrendered) continue;` |
| `systems/decisions.ts` own-fire continuation, line 241 | add `\|\| c.surrendered === true` to the stop condition |
| `systems/decisions.ts` `threatOf`, loop at line 95 | `if (c.surrendered) continue;` (a known prisoner is no threat to take cover from) |
| `systems/fire.ts` `fireSystem`, right after the able check at line 209 | `if (task.contact !== undefined && s.contacts.find((k) => k.target === task.contact)?.surrendered === true) { stop("no-target"); continue; }` — every tick, for ordered, drill and own tasks. Mandatory: `decisions.ts` only cancels own tasks, and `fireSystem` runs before `contactSystem`. Not inside or after the line-of-fire block (lines 244–271). |
| `systems/orders.ts` case `"fire"`, lines 281–284 | after finding `c`: `if (c?.surrendered === true) continue;` (he halts with the others but gets no task; his earlier task, if any, is left alone). If nobody gets a task the existing `"unable"` return at line 292 applies. No check at validation. |
| `systems/drills.ts` `knownEnemy`, line 71 | skip flagged contacts |
| `systems/drills.ts` cover-fire pick, loop at line 171 | skip flagged contacts (falling back to fire at the point is area fire, accepted) |
| `packages/ai/src/commander.ts` | section 8 |
| `packages/sim/src/knowledge.ts`, `packages/app/src/main.ts` fire tap | section 8 |

`systems/morale.ts` `fireRateFactor` (line 90): add `case "surrendered":` to the `return 0` group as a backstop.

Timing: at most about 1 s from the surrender to the first watcher's flag (scan interval), ordered fire stops on the next tick after the flag, comrades learn after the voice or radio delay.

---

## 8. Remaining per-file changes

### Sim

- **`/home/user/TCS/packages/sim/src/systems/drills.ts`**, rout branch (line 186): after computing `men`, add
  `if (men.length === 0 && unitSoldiers(state, uid).some((m) => isCaptive(state.soldier.get(m)))) { u.drill = null; return; }`
  The unit stays broken and no `radio.rallied` is sent. The condition is narrow on purpose: the existing case where every runner fell is unchanged, so battles without a surrender do not change.
- **`/home/user/TCS/packages/sim/src/systems/objectives.ts`**: `battleScore` (line 75) counts `isOut(state.soldier.req(id))`. Header (lines 4–7): men down are killed, incapacitated, surrendered or captured; a side whose last men surrendered is eliminated. `standing` needs no edit; its cast can go.
- **`/home/user/TCS/packages/sim/src/knowledge.ts`**: line 28 → `if (!isAble(s) || side differs) continue;`. Collect `flagged = new Set<EntityId>()` of every target any source man's contact flags (membership only, never iterated). `KnownEnemy` (lines 12–21) gains `surrendered: boolean`, set to `flagged.has(target)` — OR over all men, not only the most precise contact.
- **`/home/user/TCS/packages/sim/src/events.ts`**: add
  `| { kind: "surrendered"; tick: number; soldier: EntityId; side: SideId; reason: SurrenderReason }`
  `| { kind: "captured"; tick: number; soldier: EntityId; side: SideId; by: EntityId }`
  (`side` is the prisoner's). The `fire.ceased` union is unchanged.
- **`/home/user/TCS/packages/sim/src/setup.ts`**: `addSoldier` literal (lines 97–116) gets `captive: null`. After the casualty block (117–121): `if (rec.status === "surrendered" || rec.status === "captured") { s.captive = { state: rec.status, tick: 0 }; s.mental.behaviour = "surrendered"; }`. `soldierRecordFromState` (148–154): `status = rosterStatus(s)`; wounds, physiology and load stay.
- **`/home/user/TCS/packages/sim/src/battle.ts`**: `SoldierRecord.status` (line 41) adds `"surrendered" | "captured"`; doc: such a record placed in a battle is a prisoner from the first tick. `SideResult` (81–88) adds `surrendered: number; captured: number`; doc: living prisoners, so `soldiersStart = soldiersFit + wounded + killed + surrendered + captured`.
- **`/home/user/TCS/packages/sim/src/run.ts`** `summarize` (58–68): by `rosterStatus`: killed, captured, surrendered, else `wounds.length > 0` → wounded, else fit. A wounded prisoner is a prisoner, not "wounded".

### AI — `/home/user/TCS/packages/ai/src/commander.ts`

Import `isCaptive`, `isOut` from `@tcs/sim`. It reads only its own men's state and contacts.

- `able` (26): `s !== undefined && !isOut(s) && s.mental.behaviour !== "routed"`.
- `caller` (62): replace the inline copy with `able(s) && s.impair.canSpeak`.
- `fitShare` (65): men with `!isOut`. `down` (67): men with `isOut`.
- Skip `c.surrendered` contacts in all six loops: defence mortar centroid (90), recon count (145), recon mortar aim (149), assault mortar aim (181), base-of-fire target (198), grenade target (216).
- In those loops skip the contacts of its own **prisoners** only (`isCaptive`), not of dead or unconscious men: dropping those too would change battles without a surrender.
- Friend-safety checks (96, 177, 219): unchanged.

`/home/user/TCS/packages/ai/src/shootout.ts`: no change (a truth-based regression script firing at a point); add one doc line.

### App — `/home/user/TCS/packages/app/src/main.ts`

Import `isOut`, `rosterStatus` from `@tcs/sim`.

- `unitMen` (85): filter `s !== undefined && !isOut(s)`.
- Fire tap (212–222): take all known markers within the tap radius, nearest first. If one that is not `surrendered` exists, fire at it as a contact. Else if any marker was hit, issue **no order** and show `hud.radio(strings.t("order.surrenderedTarget"), …)`. Else fire at the point, as now. (Falling through to point fire would shoot the prisoner.)
- `handleEvents` (252–277): new branch for `e.kind === "surrendered" || e.kind === "captured"`: push a timeline line `strings.t(`timeline.${e.kind}`, { side, name: family, callsign })` in the man's side colour.
- `showUnit` (348): `if (isOut(s)) { down++; continue; }` — prisoners count as down and stay out of the behaviour summary.
- `showAar` (382–385): row by `rosterStatus`:

| Status | Text key | Order |
|---|---|---|
| killed | `status.killed` | 0 |
| captured | `status.captured`, or `status.capturedWounded {zones}` if he has a non-blunt wound | 1 |
| surrendered | `status.surrendered`, or `status.surrenderedWounded {zones}` | 2 |
| incapacitated | `status.incapacitated` | 3 |
| wounded | `status.wounded {zones}` (blunt wounds only: `status.fit`, as now) | 4 |
| fit | `status.fit` | 5 |

  The side heading's count is `sc.scores.find((x) => x.side === sd.id)?.menDown ?? 0`, so it equals the score by construction.
- Optional: the debug `able` at line 285 → `isAble`.
- No change to `AarRecord` or the heat map.

### Render — `/home/user/TCS/packages/render/src/renderer.ts`

- `Overlay.known` item (line 31): add `surrendered?: boolean`.
- New helper `drawWhiteFlag(g, x, y, r)`: with `k = Math.max(r, 4)`, a pole from `(x + 0.6k, y)` up to `(x + 0.6k, y - 2.6k)` and a white rectangle `1.4k × 0.9k` at its top with a thin dark outline.
- Soldier loop: `const prisoner = isCaptive(sol)`.
  - Casualty branch (line 319): before its `continue` (line 329), draw the flag for a prisoner who is not killed.
  - Otherwise: draw the body as now; for a prisoner skip the behaviour ring (340–343) and the heading line (346–347), draw the flag, and for `captive.state === "captured"` add a white square outline around him.
- `drawKnown` (line 463): when `k.surrendered`, draw the flag at the marker — before the `continue` of the heard branch too.

Own men come from the true state, as now. Enemies get the flag only from what the side knows.

### Tools

- **`/home/user/TCS/packages/tools/src/cli/batch.ts`**: `Row` (line 20) gains `prisoners: Record<string, number>` (surrendered + captured per side); a line "Mean surrendered or captured per side" next to line 55; a column "prisoners blue/red" (lines 60–62); the note at line 58 says men down include prisoners. `casualties` stays wounded + killed.
- **`/home/user/TCS/packages/tools/src/cli/headless.ts`** (line 35): also print `surrendered` and `captured`.
- **`/home/user/TCS/packages/tools/src/labs/attack.ts`**: `fit` (37) → `!isOut`; `routedOrDown` (48) → `isOut || routed`; add `attackerPrisoners` / `defenderPrisoners` to `AttackRun` (men with `captive !== null` at the end) and a "Mean surrendered or captured" line beside line 87.
- **`/home/user/TCS/packages/tools/src/cli/screenshot.ts`**: line 121 also counts prisoners; line 160 skips `isOut` men; add a staged prisoner picture (two blue men made prisoners through `t.sim`, one of them captured, Debug on) so the flag can be looked at.

---

## 9. Events, strings, review and map symbol

Events: `behaviour.changed` (to `"surrendered"`), `surrendered`, `captured` — ids and enum values only (rule 12). `BattleResult.eventCounts` counts the new kinds automatically.

`/home/user/TCS/packages/data/core/strings.en.json` (strings are not part of the catalog fingerprint; no faction overrides; the fixture faction falls back to core):

| Key | Text |
|---|---|
| `behaviour.surrendered` | `surrendered` |
| `behaviour.incapacitated` | `incapacitated` (closes an existing gap so the coverage test can be total) |
| `status.surrendered` | `surrendered` |
| `status.captured` | `taken prisoner` |
| `status.surrenderedWounded` | `surrendered, wounded ({zones})` |
| `status.capturedWounded` | `taken prisoner, wounded ({zones})` |
| `timeline.surrendered` | `{side}: {name} ({callsign}) surrendered` |
| `timeline.captured` | `{side}: {name} ({callsign}) taken prisoner` |
| `order.surrenderedTarget` | `He has surrendered - your men will not fire at him.` |
| `aar.reason.side-eliminated` (reworded) | `{loser} has nobody left standing (all down, fled or surrendered).` |
| `aar.score` (reworded) | `{side}: {objectives} for objectives held, {down} men lost (down or surrendered) - score {score}.` |
| `aar.sideHead` (reworded) | `{side}: {down} of {total} down or surrendered` |

`/home/user/TCS/packages/ui/src/aar.ts` needs no change. A unit whose ordered fire stops because its target surrendered radios the existing `radio.noTarget`.

---

## 10. Tests

Sim tests follow `morale.test.ts` / `drills.test.ts`: header comment, imports from `../src/index`, own `unitOf` / `run` / `setup` on `armedInput` (physiology `"none"`, so a wounded man is stable), plain-English `it` names. Make a downed man from real records: push a `legL` wound of severity 0.7, set `physiology.pain = 0.7`, call `refreshStatus(sim.ctx, sim.state, new EventSink(), id)`; never set `impair` flags. For enemies to see each other quickly, place them about 40 m apart, standing, facing each other (red `heading: Math.PI`). `surrenderSystem` may be called directly, as `morale.test.ts` calls `moraleSystem`.

### New `/home/user/TCS/packages/sim/test/surrender.test.ts`

| # | Test name | Asserts |
|---|---|---|
| 1 | a downed man alone gives up when an enemy he has seen is within 50 m; he then takes no orders, fires nothing and cannot report | `surrendered` event with `reason: "wounded"` and `behaviour.changed` to `"surrendered"` within 3 s; `captive.state === "surrendered"`; `isAble` and `canReport` false; no fire task; a move order leaves his waypoints empty and his position unchanged |
| 2 | he does not give up with a fit comrade within 30 m, with the nearest enemy 80 m away, or when the enemy he knows is himself down | no `surrendered` event in 10 s in each case |
| 3 | an enemy known only by sound does not count; the same contact reported does | contacts set directly, `surrenderSystem` called on his step tick: `kind: "heard"` → no event; `kind: "reported"` → event |
| 4 | a comrade who is panicked, downed or himself a prisoner is not a fit comrade | the downed man gives up in each case |
| 5 | an unconscious man never gives up; a wounded man who can still walk, or still fight, does not either | leg wound 0.5 without pain; abdomen wound with pain 0.72; `consciousness = 0` — no event |
| 6 | a panicked man gives up with a known enemy within 30 m even beside his comrades, and not at 40 m | stress 1; `reason: "panicked"` at 25 m; nothing at 40 m |
| 7 | a routed runner gives up and stops where he is | `reason: "routed"`; waypoints empty; position constant afterwards |
| 8 | a surrendering leader hands the lead to the next able man | `unit.leader` is another, able man; comrades' stress rose |
| 9 | until an enemy has seen it he can still be chosen as a target; once seen, those men hold their fire | red on rule `free`: on the surrender tick red contacts lack the flag; within 2 s every red `seen` contact on him has `surrendered: true`, no red fire task names him and none is created in the next 10 s |
| 10 | an ordered fire task at him stops once the shooter knows; fire ordered at the point beside him goes on | fire order with `contact`: task gone and `fire.ceased` reason `"no-target"`; point order: task still there after 5 s |
| 11 | a fire order naming a man the unit knows has surrendered is answered "unable" | no fire task created; `radio.unable` |
| 12 | a comrade who cannot see him is told at once, and a vaguer report still carries the news | a red man behind a wall within voice range gets `surrendered: true` within about 2 s (not 10 s); a recipient whose own contact is more precise gets the flag and keeps his own position |
| 13 | an enemy who comes within 3 m takes him prisoner; a panicked enemy, a downed enemy and a man behind a wall do not | `captured` event with `by`, exactly once; `captive.state === "captured"`; none in the three negative cases |
| 14 | a prisoner who passes out and comes round is still a prisoner, and nobody radios "man down" about him | after `consciousness = 0` + `refreshStatus`: casualty `incapacitated`, behaviour `"surrendered"`, no `radio.manDown`; after `consciousness = 1`: casualty `none`, `isAble` false |
| 15 | a prisoner who is later killed costs his side once | `battleScore` `menDown` rises by 1 at surrender and stays |
| 16 | the same rule holds for both sides | cases 1, 6 and 13 with blue and red swapped give the mirrored events |
| 17 | the roster shows him as surrendered or captured, and such a record placed in a new battle is out of the fight | `soldierRecordFromState` status; `runBattle` sides satisfy start = fit + wounded + killed + surrendered + captured; `createSim` with `status: "captured"` gives `captive` set, `isAble` false |
| 18 | a value of 0 switches each rule off | `downedEnemyM: 0`, `caughtEnemyM: 0`, `captureM: 0` set per test as in `morale.test.ts:45–47` |
| 19 | surrender is deterministic across save and load | save with one man surrendered and a flagged report in flight; `loadSim({ ...input, orders: [] }, saveSim(sim))`; equal `hashState` after 30 s |

### Additions to existing sim tests

| File | Test name | Asserts |
|---|---|---|
| `packages/sim/test/objectives.test.ts` | surrendered and captured men count as men down and neither take nor hold an objective | score lower by `casualtyPoints` each; holder unchanged with only prisoners inside |
| `packages/sim/test/objectives.test.ts` | a side whose last men have all surrendered loses at once | `battle.ended` reason `side-eliminated`, loser set |
| `packages/sim/test/drills.test.ts` | a broken unit whose runners all surrender is not reported rallied and stays broken | no `radio.rallied`; `broken` true; `drill` null |
| `packages/sim/test/contacts.test.ts` | the side's picture marks an enemy surrendered if any able man knows it, and leaves out what its own prisoners know | `sideKnowledge(...).surrendered`; a prisoner's contacts absent |
| `packages/sim/test/contacts.test.ts` | a contact without the flag is saved exactly as before | `JSON.stringify(saveSim(sim))` has no `"surrendered"` key when nobody surrendered |

Re-run and inspect: `drills.test.ts` break-and-rally (lines 70–93: panicked men 40 m from the enemy, must still rout and rally), `grenades.test.ts` and `wounds.test.ts` (men within a few metres of the enemy, one comrade far away). If one changes because a man now surrenders, set that test's surrender distances to 0 locally; do not weaken the shared test catalog.

### Tools tests

| File | Test name | Asserts |
|---|---|---|
| new `packages/tools/test/surrender-invariants.test.ts` | prisoners never act again (staged close fight) | Two real squads (`demoBattle`, flat map, `frontM` 40, both `free`, blue assaults at 2 s; three seeds). At 3 s two red men get stress 1 and one gets a leg wound plus pain through `refreshStatus`. The test **fails** unless at least one `surrendered` and one `captured` event occur across the runs. Every tick, for each man with `captive !== null`: no fire task, no action, `intent` and `evade` null, no waypoints, position unchanged, behaviour `"surrendered"`, not a unit leader; after his surrender tick he is never `shot.fired.shooter`, `grenade.launched.soldier`, `radio.from` or `action.started.actor`; his state only moves forward; at most one `surrendered` then one `captured` event. Each second: `battleScore` `menDown` equals the count of `isOut`. |
| `packages/tools/test/architecture.test.ts` | surrender is known, not read (fog of war) | comments stripped: no `.captive`, `isCaptive(` or `isOut(` in `sim/src/systems/decisions.ts`, `fire.ts`, `orders.ts`; no `.captive` in `drills.ts`, `knowledge.ts`, `ai/src/commander.ts`; no `=== "surrendered"` or `!== "surrendered"` anywhere in `packages/sim/src` or `packages/ai/src` |
| new `packages/tools/test/strings-coverage.test.ts` | every state a man can be in has its text | a list typed `satisfies Record<Behaviour, true>` has `behaviour.<v>`; killed, captured, surrendered, incapacitated, wounded, fit have `status.<v>`; the two wounded-prisoner keys, both timeline keys and `order.surrenderedTarget` exist |
| `packages/tools/test/commander.test.ts` | the commander orders no fire at a man its men know has surrendered | controller `loadState` with phase `"assault"` and `lastHe` set; every blue man's contacts set to one contact near the objective. Flagged: the `fire` orders carry no `contact` and there is no `grenade` order. Unflagged (control): a `fire` order names it. |

---

## 11. Order of work and verification

Use the project skills: `start-milestone` first, `add-data-entry` for the data edit, `balance-report` for the batches, `finish-milestone` at the end. Branch first.

1. **Before any change**, on main: `npm run batch -- --scenario platoon --runs 10 --seconds 900` and `npm run batch -- --scenario demo --runs 50 --seconds 120`. Keep both JSON files.
2. Implement; `npm run typecheck`; `npx vitest run packages/sim/test/surrender.test.ts`.
3. **Zero-change check.** Temporarily set `downedEnemyM`, `caughtEnemyM` and `captureM` to 0 in `core/behaviour.json` (do not commit) and repeat step 1. Per seed, `durationS`, `endReason`, `winner`, `scores`, `casualties` and `orders` must be identical to main (`hash` and `wallMs` differ). Any difference means a changed path is not a no-op: find it before going on. Restore the values.
4. With the owner's values: the two batches again plus `--scenario platoon-ru`, and `npm run lab -- attack`. Record prisoners per side and any change in win rate. A batch showing about zero surrenders is expected (section 1.2) and is **not** evidence that the feature works; the evidence is the sim tests and the staged invariant test.
5. Write the DECISIONS entry, then `npm run golden:update`.
6. `npm run check` on its own (timing tests), then `npm run test:determinism`.
7. `npm run screenshot`, then look at the pictures: the white flag on own men and on known enemies, phone and desktop; no `[[…]]` in the unit panel or the review.

---

## 12. Documents

- **`/home/user/TCS/docs/DECISIONS.md`**: append at the real end of the file (after "Owner: no path trace for every soldier", line 1185; the file has 1188 lines). The owner's surrender entry is at lines 1136–1146 and is not the last. Title `## 2026-11-12 — Surrender: implementation and game values`. Contents: the twelve readings of section 1.1; the values; the "enemy he knows of" definition; the drills change; the partition of `SideResult`; the measured frequency; the batch and attack-lab tables; "Golden replays regenerated (catalog fingerprint; schema 15)".
- **`/home/user/TCS/docs/ARCHITECTURE.md`**: new `## 16q. Surrender` after 16p (before `## 17`, line 488): the system slot, `captive`, the predicate table, the contact flag and where it is created, capture, events, schema 15. Amend 16i (the flag and the news rule), 16j (`KnownEnemy.surrendered`), 16k ("No new state fields" no longer the last word; prisoners are skipped), 16m (rout branch), 16o (standing and men down), and the event list in section 8.
- **`/home/user/TCS/docs/HOW_IT_WORKS.md`**: new `## Surrender` between "Squad drills" (line 338) and "Does an attack work?" (line 351); update "Winning" and the review text (lines 16–20); the test count (line 389); "What is not there yet" (line 403: no escorting, no fetching of prisoners).
- **`/home/user/TCS/docs/DATA_GUIDE.md`** "Change how fire frightens men" (lines 193–203): one sentence on `surrender` (0 switches a rule off); say to run `npm run lab -- attack` after a change.
- **`/home/user/TCS/docs/ROADMAP.md`**: `### M6.6 Surrender` between M6.5 (line 152) and `## Stage B` (line 163), with the owner's request and the acceptance: all tests of section 10 green; zero-change check passed.
- **`/home/user/TCS/docs/STATE.md`**: "Current milestone", "What works", and under "Open questions for the owner" (line 176) the five questions and the new low-confidence values.

---

## 13. Risks and known limits

- **Rare in AI battles.** Under the "neither" reading no wounded man met the distance condition in three measured platoon battles. Captures are rarer still: nobody walks to a prisoner. Most will end as "surrendered"; the score is the same.
- **`isAble` now also means "not a prisoner".** Future code that needs "conscious" only (medical care, vehicle crews) must use `isConscious`. Prisoners no longer dive from grenades.
- **Existing tests near the distances** (section 10) and the attack lab thresholds in `packages/tools/test/lab-attack.test.ts` (wall-only success ≤ 0.25, support better, more than two kinds of ending) may move: `fit` now counts prisoners as lost, so "defender lost half" can come sooner.
- **Close assaults can end in group surrenders**: panicked men within 30 m of a known enemy give up even beside fit comrades (owner rule), and a surrendering leader adds the leader-loss blow.
- **Still hit by area fire.** Point fire, the drills' fall-back to the objective point, mortars, grenades and strays ignore the flag.
- **A broken unit whose runners all gave up stays broken for good**, even if an unconscious man of it later comes round.
- **Two downed men can give up to each other** if the second does not re-sight the first on his next scan.
- **Recognition at any spotting range** (up to 1,200 m), and a nearby prisoner takes one of an observer's six tracking slots.
- **Roster**: a prisoner record placed in a later battle counts as lost from the first tick; the campaign must decide whether to field him.
- **Hashes**: the new field changes every state hash and the data block changes the fingerprint; all goldens are regenerated and browser saves stop loading.
- **Four copies of the data block** can drift in key names without a compile error; the loader test and the test catalog's typecheck are the guard.

## 14. Not in this slice

A recognition range, a shouted surrender, a man walking over to take a prisoner, stress on comrades from a surrender, a hands-up posture, grenade reactions for prisoners, eviction of prisoners from tracking slots, new radio phrases, escorting or disarming prisoners, medical care by the captor, and turning "surrendered" into "captured" by who holds the field. Each is either an owner question (section 1.2) or later work.