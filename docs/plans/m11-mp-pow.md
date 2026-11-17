# M11 end: Military Police and prisoners of war (MP/POW): build plan

**Progress:** plan written 2026-11-17 (this file, branch `claude/m11-mp`, from main after the balance pass, merge
659292a). **Slice 53 (M11.9a) built 2026-11-17** (DECISIONS "M11.9a"; owner questions Q2, Q3 and Q8 built with the
recommended option (a) as software decisions for the owner to review). **Slice 54 (M11.9b) built 2026-11-17**
(DECISIONS "M11.9b"; Q4, Q6 and Q7 built with option (a) as software decisions). Slice 55 next; an optional slice 56
waits for an owner answer.

The last part of M11 (ROADMAP "Military police and prisoners of war", owner request 2026-11-15, placed with logistics
because it shares the rear transport and collection points). Today a man who gives up is taken where he stands and
stays there until the battle ends. This chain gives prisoners the path they have in real armies: searched where
taken, walked back by a guard to a **prisoner collection point** behind the platoon (apart from the Verwundetennest
and the supply point), kept in groups by rank, the wounded among them taken to the medics, and collected by a
**military police team** that drives in from off the map (Feldjäger for the German side, military police for the
Russian side) and takes them away. The prisoners then leave the battle as roster records held by the side that took
them.

## 1. The owner's answers (binding)

| Question | Answer |
|---|---|
| When | **At the end of M11**, as a separate workflow (DECISIONS "M11 owner round (2026-11-16)"). Approved. |
| Scope | Named by the owner: **prisoner collection point, escorts, search, segregation, an off-map MP team.** |
| Law of war | Third Geneva Convention, as the owner listed it: **humane treatment; evacuation from the combat zone as soon as possible; no exposure to fire; wounded prisoners treated like own men by the medics; officers, NCOs and men kept apart; searched for weapons and documents, personal effects kept; prisoners counted as roster records out (`BattleResult`).** |
| Earlier answers that still hold | Prisoners are treated by the side holding them, by urgency only (owner 2026-11-15); surrendered men under fire crawl out of the line of fire (owner 2026-11-15); taking enemy kit only on a player order (M11 round; this plan's search is a separate, automatic step, see 4.3 and question Q2); same rules for both sides, differences only in data; nothing about breaches shown live, only in the review (M10.7 answer 7). |

## 2. How prisoners are handled today (measured 2026-11-17, main at 659292a)

How it was measured: a diagnostic script (kept outside the repository) ran the AI battles with both commanders and
counted every `surrendered`, `captured`, `surrender.walk`, `surrender.crawl`, `law.hit`/`law.breach` on a man giving
up or held, deaths and treatments of prisoners, and the end settlement (`medical.settled`). Every 10 s it sampled each
living prisoner: enemy (captor side) men within 25 m and 50 m, own men within 100 m, his suppression.

| Scenario | Seeds x limit | Men who gave up in battle | Taken prisoner in battle | Captured at the end (wounded left on enemy ground) | Surrendered, never taken |
|---|---|---|---|---|---|
| platoon (blue attacks) | 10 x 1200 s | 1 (wounded) | 1 | 13 in 3 battles | 0 |
| platoon-ru (red attacks) | 10 x 1200 s | 0 | 0 | 4 in 2 battles | 0 |
| platoon-vehicles | 6 x 1200 s | 1 (wounded) | 0 | 1 in 1 battle | 1 |
| platoon-ru-vehicles | 6 x 1200 s | 0 | 0 | 0 | 0 |
| hold-resupply (German defence) | 4 x 3600 s | 2 (wounded, one each side) | 1 | 1 in 1 battle | 0 (the other was killed before he was taken) |
| hold-resupply-ru (Russian defence) | 4 x 3600 s | 1 (panicked) | 1 | 2 in 2 battles | 0 |
| **all** | **40 battles** | **5 (0.13 a battle)** | **3** | **21 in 9 battles** | **1** |

What happens to them today:
- **Taken quickly when it happens:** 28 s and 32 s from giving up to being taken in two cases (one walked over, one
  was fetched); 1,431 s in the third (a wounded man in the hold battle who could not walk, taken only when it was
  quiet).
- **Then nothing:** a prisoner stays where he was taken until the battle ends (76 s, 137 s and 483 s here). Nobody
  is told to guard him; in every sample a captor-side man stood within 25 m, but that was the fight passing by (12,
  6 and 3 different men over the samples), not a guard. No escapes are possible. He keeps his weapon and ammunition
  in his load (he never fires: `isAble` is false), and the only way to take them is the player's "Take enemy kit".
- **Fire:** no prisoner was hit after being taken in these 40 battles; 2 deliberate breaches against a man giving up
  (hold-resupply seed 3; he died before anyone took him). Captors treated men who had given up 4 times in 3 battles (the 2026-11-15 rule).
- **The wounded left on enemy ground at the end** (21 men) are the largest group; they are settled outside battle
  time (`settleBattle`), so this chain does not touch them except to give them a holder in the roster (4.10).
- **Guards tied up: none today**, so the trade-off the roadmap wants ("guards and escorts are men not fighting")
  does not exist yet.

**What this means for the design:** in AI-against-AI battles prisoners are rare (one in eight battles). The new
machinery will hardly move the batches; its acceptance is checked in a lab with prisoners made on purpose, and in
play by the player. Whether more men should give up (or whether wounded enemies lying on ground a side holds should
be collected during the battle) is owner question Q1.

## 3. Research (search extracts only: confidence medium at most)

Web pages cannot be opened from the container; everything below comes from search-result extracts. Values taken from
it are marked `medium` at most, game values `low`.

| Point | What the extracts say | Confidence | Used for |
|---|---|---|---|
| Doctrine steps (US/NATO, also taught in German training) | "Five S's and T": **search, segregate, silence, speed (to the rear), safeguard, tag**; newer US doctrine "STRESS": search, tag, report, evacuate, segregate, safeguard (FM 3-19.40, FM 3-19.4 excerpts; USMC TBS detainee handling) | medium | the order of steps (4.2-4.7) |
| Capturing unit | guards its prisoners **until relieved**; takes them to the collecting point; non-walking wounded go to the nearest medical aid station; MPs take prisoners over **as far forward as possible** so manoeuvre units are not burdened (US MP manual extracts citing FM 3-19.40) | medium | escorts by the squad, MP hand-over, wounded to the nest |
| Forward collecting point | no set design: "anything from a guarded, roped-off area to a secured existing structure"; escort guards can be pre-positioned at collecting points | medium | the point as a marked spot, a building preferred |
| Time at the point | the latest FM 3-63 removed set time limits; detainees are moved to safety "as transport becomes available" (MP professional bulletin) | medium | MP called at once, no fixed hold time |
| Escort ratio | no per-prisoner figure in the extracts (only unit-level allocations: one MP platoon per division for escort from the division collecting point). Common teaching figure of one guard per few prisoners is not sourced here | none (game value) | `escortPerGuard` 4, low (Q3) |
| Bundeswehr Feldjäger | the Bundeswehr's military police; tasks include **Kriegsgefangenenwesen** (prisoner of war matters), custody (Gewahrsam), traffic and order service, security, investigations, documenting war crimes; a 2023 exercise ("Orange Road 2") shows prisoners brought by the brigade to a **collecting point**, registered there, questioned by field intelligence specialists, Feldjäger running transports and hand-overs; a prisoner keeps only his personal protective equipment (bundeswehr.de extracts) | medium | MP team, registration and documents, protective kit kept |
| Feldjäger vehicles | Wolf (Mercedes G) in Feldjäger service; Wolf 2 has a Feldjäger variant; ATF Dingo 1 "Feldjägertrupp" with police lights and hardtop (bundeswehr.de, esut.de, defensearchives extracts) | medium | DE MP hull: Dingo-class protected vehicle (Q4) |
| Russian military police (Военная полиция) | Charter of the Military Police (Presidential decree 161 of 25.03.2015) has sections on guarding and escorting (конвоирование) servicemen; its prisoner-of-war tasks are not in the extracts. In 2023 MP units received "Patrul" armoured vehicles (KamAZ-43502 chassis, 9-10 men) and Tigr-M (consultant.ru, rg.ru, aif.ru extracts) | medium (vehicle), low (POW role) | RU MP hull: KamAZ "Patrul" (Q4) |
| Soviet practice (history only) | in an advance the prisoner collecting point was set up about 10-12 km behind the front, a dedicated company took prisoners to the army reception point (Parlamentskaya gazeta extract) | low (historical) | not used for numbers; shows the point is well behind the front, i.e. off our map |
| GC III art. 17 | identity established by all possible means; questioning in a language he understands | medium | documents and tags are read, not taken from him |
| GC III art. 18 | articles of personal use stay with him; protective equipment (helmet, gas mask) and identity documents stay; military equipment and military documents are taken; money only on an officer's order with a receipt (ICRC/UN text extracts, summaries) | medium | search rules (4.3) |
| GC III art. 19-20 | evacuated as soon as possible to camps far enough from the combat zone; not unnecessarily exposed to danger while awaiting evacuation; evacuation humane, with food, water and medical care; wounded may stay if moving them is riskier | medium | speed to the rear, protection at the point, wounded to the nest |
| GC III segregation | officers are held apart from other ranks in camps (art. 79/97 by memory; **not confirmed by the extracts**) | low | segregation by NATO rank code (4.5) |

Sources (search results): globalsecurity.org FM 3-19.40 ch. 3-4 and FM 3-19.4 ch. 7; theblackvault.com MP manual
ch. 7; trngcmd.marines.mil TBS "Detainee Handling"; home.army.mil MP bulletin "Detention Operations in Large Scale
Combat Operations"; bundeswehr.de Feldjäger pages and "Feldjäger Übung Orange Road 2 2023"; esut.de "Wolf 2";
defensearchives.de "Development and variants of the Dingo 1 and 2"; consultant.ru (Устав военной полиции); rg.ru and
aif.ru on "Patrul"; icrc.org GC III (Russian text); avalon.law.yale.edu and un.org GC III.

## 4. Design

Same rules for both sides; numbers in a new data block; faction differences only in data (the MP template and hull,
documents items). Everything is off where a battle has no prisoners: no per-tick cost without them.

### 4.1 A prisoner's path

`Captive.state` grows (moves forward only, as today, except an escape, 4.8):

```
surrendered -> captured -> (searched) -> escorted -> held (at the point) -> boarding -> evacuated (off the map)
                       \-> to the nest (cannot walk: carried; treated; goes with the wounded)
```

New optional fields on `Captive` (no schema bump needed: optional plain data; the RNG stream "prisoners" is created
on first use): `by` (the holding side), `group` ("officer" | "nco" | "man", from his rank), `searched` (tick),
`escort` (the man walking him), `point` (the collection point), `evacTick`, `vehicle`. The roster gets
`SoldierRecord.heldBy` (side) and `powEvacuated` (tick) (4.10).

### 4.2 The prisoner collection point

- A `RearPoint` of a new kind **"prisoners"** (the store exists; the kind union grows), one per platoon that holds
  prisoners, sited when its first prisoner is taken: behind the platoon (away from the enemy contacts it knows, as
  the nest), `pcp.behindM` 100-200 m, hidden from those contacts (a building's ground floor preferred: "a secured
  existing structure"), reachable by a wheeled hull (the MP drives in), **at least `pcp.apartM` 50 m from the
  Verwundetennest and from the supply point** (both ways, as the supply point keeps from the nest), no closer than
  `pcp.enemyM` 250 m to a known enemy.
- **Moved back** when a known enemy comes within `pcp.enemyM` or rounds land within `pcp.fireM` 30 m (4.7): the guard
  walks the prisoners to the new spot.
- Player order **`prisonerPoint`** (Move tray, like "Supply point"; drag the marker): put it here; refused with a
  radio reason on top of the nest or the supply point.
- Map: a marker of our own art (a ring with a "PW"-style letter pair from the string table, no real military symbol
  copied), own colour; the enemy's when known. Both looks; flat elsewhere byte-identical.

### 4.3 Search (rule 9: counted items, one `transferItems`)

- When it is quiet (the captor's unit not fired on for `fetchQuietSeconds`, the existing gate), the captor or the
  escort searches each prisoner (`searchPrisoner` action, `search.seconds` 30 per man, low; standing, exposed like
  any man on foot). Interrupted by fire, progress kept.
- **Taken** (into the searcher's container, then whatever he cannot carry within `search.maxKg` into a **cache** at
  the collection point, a captured cache of the holding side, M11.3, which the captor's men may use like any captured
  cache): his weapon item (`weaponItem`, the M11.2 rifle items; the ledger counts a weapon in the hands as its item),
  magazines, belts, loose rounds, grenades, rockets, launchers, radios, night goggles, thermal sights, drones and
  their batteries, and **documents**.
- **Kept** (GC III art. 18): items marked `prisonerKeeps: true` in the item data (helmet, vest, water, rations,
  first-aid kit and medical items, identity tag, armband, rescue blanket). A new item field, default false; the
  data lint checks that every item of a category "protective/personal" says it explicitly.
- **Documents**: a new counted item per faction (`de-dokumente`, `ru-dokumenty`; "maps, orders, notebook", 0.3 kg,
  game value, low) carried by every leader (team leader and up) in the unit templates. Taken in the search (event
  `pow.searched` with what was taken; `pow.documents` for a hook to M13 intelligence). Identity tags stay with him
  (art. 17: identity is read, the tag not taken; the dead keep the M10 tag rule).
- Disarming is lawful: no conduct record (as "Take enemy kit"). "Take enemy kit" stays the player's order for
  *using* enemy kit; the search is automatic (Q2).

### 4.4 Escorts

- Who: one man of the capturing squad (or the nearest squad of the platoon), never the leader, a machine gunner, a
  medic or a first responder, a man carrying, a man in a drill (the M11.4a bearer filter). Not while his unit is in an
  assault or fired on within 30 s: prisoners then wait where they are, sitting with hands visible, and the captor's
  squad counts as their guard.
- One escort walks up to `escort.perGuard` 4 prisoners of one group (4.5) at the prisoners' walk
  (`surrender.walkSpeedFactor` of a walk), the prisoners 3-5 m ahead of him on a route through cover where there is
  one (`routeBetween`, the existing covered-leg search). Under fire: everyone down, the prisoners crawl out of the line
  of fire (the existing crawl), then on.
- At the point the escort **stays as a guard** until the MP arrives (guards needed: `ceil(prisoners /
  guard.perGuard)` with `guard.perGuard` 6 at the point, low); extra escorts walk back to their squad at once. A guard
  is out of the fight: he fires only in self-defence within 50 m (the medic rule's gate) and takes no orders but
  "Release guard" (4.9).
- Card and list show it ("escorting 3 prisoners", "guard (5 prisoners)").

### 4.5 Segregation (and silence)

- Group from his rank's NATO code: "OF-*" officer, "OR-5" and up NCO, else man (`segregation.ncoFrom` "OR-5" in
  data; a faction without NATO codes, like fixture `xf`, puts everyone in "man").
- An escort walks one group only; at the point each group has its own spot `segregation.apartM` 10 m from the others.
- Effect in the sim: an unsegregated point (groups mixed because only one guard was there) raises the escape chance
  (`escape.mixedFactor` 2, low; leaders organise). "Silence" is not modelled beyond this (no talking in the sim).

### 4.6 Wounded prisoners

- A prisoner who cannot walk is not escorted: the captor's medics treat him by urgency (the 2026-11-15 rule, kept),
  then he is **carried to the captor's Verwundetennest** by the existing carrying parties (protected while carrying)
  and taken back by the captor's ambulance or a rear run with the own wounded, by urgency alone (GC I art. 12). Roster:
  "captured", `heldBy` the captor, evacuated by the captor (the M10.6b role-1 outcome at `byCaptor`, already in data).
- A walking wounded prisoner goes to the point with the others; the MP takes him too; one who gets worse at the point
  (cannot walk) is carried to the nest.

### 4.7 Not exposed to fire

- The point is sited out of known enemy sight and range (4.2) and moved when threatened or when rounds land within
  `pcp.fireM` (the guard leads the move, prisoners crawl first when suppressed).
- New conduct records (review only, no radio line): `law.exposure` when a side keeps prisoners for more than
  `exposure.seconds` 60 within `pcp.enemyM` of a known enemy or suppressed, without moving them (the player can cause
  it by "hold here"; the AI never should); the existing `law.hit` "prisoner" counts hits on them.
- Prisoners on the escort route count as protected like a carrying party for recognition (`protectionNow`
  "prisoner", already a `HitProtection` kind): the M10.7 misidentification and deliberate-breach machinery applies.

### 4.8 Escapes (rare)

- A prisoner who can walk, with no fit man of the holding side within `guard.watchM` 25 m who can see him, rolls every
  minute against `escape.perMinute` 0.02 (low; x `escape.darkFactor` 2 at night by `light`, x `escape.smokeFactor` 2
  in smoke, x `escape.mixedFactor` 2 when groups are mixed, x 0.5 once searched). Draws from the new named stream
  "prisoners".
- An escaping man runs to the nearest own unit he knew of; enemies who see him keep the "surrendered" flag for
  `escape.graceSeconds` 10 (GC III art. 42: weapons against escaping prisoners only as an extreme measure; our guards
  never fire at them); when he reaches a fit own man within 30 m he is free (`captive` back to null: the one
  exception to "moves forward only", logged in DECISIONS); searched men come back unarmed (they can pick up kit by
  the existing routes). Recaptured: back to "surrendered".
- Off by a rule for labs (`rules.prisonerEscapes`, default on; Q5).

### 4.9 Military police team off the map

- `OffMapKind` gains **"mp"**. Manifest `mp: { template, count }`: DE one **Feldjägertrupp** (3 men) in a protected
  Dingo-class hull (`de-dingo2-feldjaeger`, about 8 places), RU one **military police section** (3 men) in a KamAZ
  "Patrul" (`ru-kamaz-patrul-vp`, about 8-10 places), fixture `xf` one `xf-wagon` crew. New hull data through the
  add-data-entry skill (seats, mass, drive from public figures, medium at most; armour as a light protected hull,
  low). Created after every other entity (ids of existing battles unchanged, as the other assets).
- **Called** automatically when a collection point holds its first prisoner (one call per point; the next run when it
  comes back `mp.backS` later if more are waiting) or by the player (**"Call military police"**, card of a unit
  with prisoners; phone under "⋯"); delay `mp.delayS` 900-1800 s (game value, low; Q6). Radio: "military police
  requested, about N min".
- **The run** (generic off-map run code of M10.6a/M11.4b/M11.7b): comes on at the edge behind the point, drives to it,
  halts, **takes over the guard** (its men get out; the squad guards walk back to their squads at once), registers and
  loads the walking prisoners (`mp.loadS` 20 s a man, low; officers first, then NCOs, then men; one group per run when
  it cannot take everyone), leaves, and is gone off the map: those aboard are **evacuated as prisoners**
  (`pow.evacuated`; roster `heldBy`, `powEvacuated`). Holds back 300 m short while the point is under fire (the
  recovery vehicle's rule). Stranded on the map: "lost", an ordinary hull; its prisoners get out and wait.
- The MP hull is not a protected vehicle (no emblem): it can be fired on lawfully; its prisoners aboard are protected
  persons (a hit on it with prisoners aboard is a `law.hit` "prisoner").

### 4.10 BattleResult and roster

- A captured man's record stays in his own force's `forcesOut` with status "captured" (as today) and the new
  `heldBy` (side) and, when the MP took him, `powEvacuated` (tick); a wounded prisoner evacuated by the captor keeps
  "captured" too (not "evacuated", which means his own side took him back).
- **New `BattleResult.prisoners`**: per holding side, the men it holds at the end: `{ holder, side, unitKey,
  personIndex, group, wounded, evacuated: "mp" | "medical" | "held", documents }`; `SideResult.prisonersTaken`,
  `prisonersEvacuated`, `prisonersEscaped`. Input for M12 (the roster) and M13 (intelligence).
- End settlement (`settleBattle`): a man who surrendered but was never taken goes to the side holding the ground
  around him (the M10.6b rule for wounded), as "captured" with `heldBy`, or back to his own side ("fit"/"wounded")
  when his side holds it (today he stays "surrendered" for good: owner default 2026-11-12, Q7).

### 4.11 AI and player

- **AI:** nothing to order: siting, search, escorts, guard, MP call and moving the point are automatic for both
  sides. The commander does not count guards and escorts as fighting men in its strength (they show up as a cost);
  it never orders a guard away while prisoners would be left alone with an enemy within 250 m.
- **Player:** rule **"Prisoners: escort automatically / ask me"** (Rules panel, like the ammunition requests);
  orders **`prisonerPoint`**, **`escortPrisoners`** (a unit sends escorts now for its prisoners, even under the gate),
  **`releaseGuard`** (the guard goes back to his squad; prisoners left alone can escape; refused for the last guard
  when an enemy is within 250 m unless confirmed), **`callMp`**. Card lines: "Prisoners 4 (1 NCO) · guard 1 · MP in
  12 min". Sidebar tile mark for a guard. Order refusals on the radio with string keys.

### 4.12 Review, record and batch

- **Conduct tab, new "Prisoners" block** per side: taken (officers / NCOs / men), searched (weapons, rounds, documents
  taken), escorted (escorts sent, mean walk), at the point (guard minutes: men out of the fight), wounded prisoners
  treated / carried to the nest / evacuated, handed to the MP and evacuated, escaped, still held at the end, under
  fire at the point (seconds), exposures (`law.exposure`), hits on prisoners (the existing aimed/incidental lines).
- Battle record version 12 (`pow` per side); batch line "Prisoners" (taken, evacuated, escaped, guard minutes per
  battle).

### 4.13 Data (new core file `core/prisoners.json`, bundled by the `core/**` glob)

`pcp` (behindM 100-200, apartM 50, enemyM 250, fireM 30), `search` (seconds 30, maxKg 15), `escort` (perGuard 4,
gapM 3-5), `guard` (perGuard 6, watchM 25, selfDefenceM 50), `segregation` (ncoFrom "OR-5", apartM 10), `escape`
(perMinute 0.02, darkFactor 2, smokeFactor 2, mixedFactor 2, searchedFactor 0.5, graceSeconds 10), `exposure`
(seconds 60), `mp` (delayS 900-1800, loadS 20, backS 1800, waitShortM 300). All game values, low, except where
section 3 gives a source. New item field `prisonerKeeps`; documents items; MP templates and hulls; manifest `mp`.

### 4.14 Rules kept (CLAUDE.md hard rules)

Deterministic (stream "prisoners" for escapes; the MP delay from the "medical"-style stream of its own, "mp"); orders
are the only input (`prisonerPoint`, `escortPrisoners`, `releaseGuard`, `callMp`); state plain and serialisable (new
optional fields only; a schema bump with a migration only if a store is added, none planned); events carry keys
(`pow.*`, `law.exposure`); text through `Strings.t`; no faction literals (groups from NATO codes, MP from the
manifest); every item moved by `transferItems` (conservation guard exact, a test); wounds stay records; prisoners stay
entities (an evacuated prisoner is parked off the map aboard the MP hull, like the evacuated wounded).

### 4.15 Goldens and performance

New data changes the catalog fingerprint: `npm run golden:update` with a DECISIONS line in each slice that changes
data or behaviour; event streams change only in battles with prisoners (few) and by the MP assets' ids (created last,
so earlier ids stay). Never touch `packages/tools/golden/no-interiors`. The prisoner system runs at 1 Hz, staggered by
id, only over captives (a list kept per tick of the captive ids: zero work without prisoners); the escape and guard
checks scan men within 25 m through the soldier grid. Each slice: `npm run test:perf` alone (bench-vehicles above its
8x floor).

## 5. The slices

Three slices, one session each, in this order. Each ends with `npm run check` run alone, `npm run test:perf` alone,
the lab, batches (platoon, platoon-ru 20 seeds x 1200 s; hold-resupply both ways 10 seeds), DECISIONS.md, STATE.md,
ROADMAP, HOW_IT_WORKS "Prisoners", golden update where needed, and screenshots (phone and desktop, looked at).

### Slice 53 (M11.9a): collection point, search, segregation, escorts, wounded prisoners to the nest

**What.** 4.1-4.6 and the point's marker: `RearPoint` kind "prisoners" with siting, apart from the nest and supply
point, moved when threatened; `searchPrisoner` action (taken / kept by `prisonerKeeps`, documents items for leaders,
overflow into a captured cache at the point); groups by NATO code; escorts (bearer filter, `perGuard`), guards at the
point (out of the fight, self-defence only); wounded prisoners carried to the captor's nest and evacuated with the own
wounded; orders `prisonerPoint`, `escortPrisoners`, `releaseGuard`; card and list lines; `core/prisoners.json`;
`prisonerKeeps` on every personal and protective item; `de-dokumente`, `ru-dokumenty`, xf fixture documents.

**Acceptance.**
- Lab `npm run lab -- prisoners` part 1 (new): a German and a Russian squad each take 6 prisoners (1 officer, 1 NCO, 4
  men; made to give up) 200 m in front of their platoon: time from taken to searched = 30 s a man per searcher (to
  the second); arrival at the point within the hand calculation (walk speed x factor, route length) +-10 %; after the
  search no weapon, round, grenade, rocket, radio, goggle or document on any prisoner and every `prisonerKeeps` item
  still on him; groups never mixed in 20 runs when two escorts were free; guards = ceil(n / 6); the point never within
  50 m of the nest or supply point; a prisoner who cannot walk reaches the captor's nest.
- Conservation guard exact over the lab and hold-resupply 6 seeds (items and rounds).
- Tests (`tools/test/prisoners.test.ts`): siting rules; search taken/kept per item; documents per leader; overflow
  cache; escort filter (never leader, gunner, medic, responder); no escort under fire or in an assault; segregation by
  NATO code and the xf fallback; guard count; orders and refusals; save/load mid-escort and mid-search; same rules for
  both sides.
- Batches: winners within noise of main (prisoners rare); guard minutes reported.
- Screenshots `--scene prisoners` (new) shots 1-4: a search (searcher and prisoner, hands up), an escort walking 3
  prisoners, the collection point with three groups and a guard, the card lines; photo and flat, phone and desktop.

### Slice 54 (M11.9b): the military police team, evacuation, roster and result

**What.** 4.9-4.10: `OffMapKind` "mp", manifest `mp`, MP templates and hulls (DE Dingo-class Feldjäger hull, RU KamAZ
"Patrul", xf wagon; add-data-entry skill, confidence medium at most), the automatic call and `callMp`, the run (on at
the edge, waits short under fire, takes over the guard, loads by group, leaves), prisoners evacuated
(`pow.evacuated`), guards freed; roster `heldBy`, `powEvacuated`; `BattleResult.prisoners`, `SideResult` counts; end
settlement of surrendered-never-taken men (if Q7 says so); Wounded/units tab rows for the MP run.

**Acceptance.**
- Lab part 2: call to the edge = the drawn delay (to the second); call to arrival = delay + the hull's drive alone
  +-10 % in 9 of 10 runs per faction; guards back with their squads within 30 s of the MP taking over; places never
  exceeded; officers loaded first; everyone aboard evacuated off the map; a second run for the rest.
- Tests: assets parked and skipped from tick 0 (the architecture test covers the new kind); the run end to end; the
  player's call and refusals ("no prisoners", "already on its way", "none left"); stranded hull; roster round trip
  (a "captured" record with `heldBy` placed in a later battle is a prisoner from the first tick, as today); result
  counts; save/load on the way, loading and away.
- Goldens regenerated (fingerprint, MP assets); event streams with the MP assets stripped equal main's except the
  prisoner battles. Perf alone.
- Screenshots `--scene prisoners` shots 5-6: the MP hull at the point taking over, prisoners boarding; both looks.

### Slice 55 (M11.9c): under fire, escapes, laws of war, AI, review and batch

**What.** 4.7-4.8, 4.11-4.12: the point moved under fire or threat; `law.exposure`; escapes (stream "prisoners",
`rules.prisonerEscapes`), recapture; the player rule "escort automatically / ask me"; AI strength and guard handling;
the Conduct tab "Prisoners" block, battle record version 12, batch line "Prisoners"; HOW_IT_WORKS.

**Acceptance.**
- Lab part 3: rounds landing 20 m from the point: prisoners moved within 60 s, none hit in 20 runs with fire 300 m
  away; part 4: unguarded prisoners, 1,000 prisoner-minutes: escapes within +-30 % of the data chance, night x2,
  searched x0.5; with a guard in sight: none.
- Tests: exposure recorded only past 60 s and not when moving; escape free only when reaching an own man; guards never
  fire at an escaping prisoner; recapture; rule toggle; AI never releases the last guard with an enemy near; review
  lines from a recorded battle.
- Batches: as slice 53, plus the "Prisoners" batch line; hold battle winners within noise.
- Screenshots `--scene prisoners` shots 7-8: the review's Prisoners block, the point moving under fire.

### Slice 56 (optional, only if the owner says so in Q1): more prisoners in the battles

Either (a) wounded enemies lying on ground a side holds are collected during the battle when it is quiet (searched,
treated, carried to the nest: GC I art. 15 "search for and collect the wounded"), or (b) a tuning pass on surrender
(today 0.13 men a battle in the AI battles). Measured before and after; batches.

## 6. Open points for the owner (multiple choice, recommended first)

1. **Q1 Prisoners are rare (5 men gave up in 40 AI battles).** (a) Leave surrender as it is; MP/POW matters mostly in
   the player's battles and the campaign (recommended) · (b) also collect wounded enemies lying on held ground during
   the battle (slice 56a) · (c) make surrender more likely (slice 56b).
2. **Q2 Search.** (a) Automatic for every prisoner, kit to the searcher or a captured cache at the point
   (recommended) · (b) only on a player order, like "Take enemy kit" · (c) automatic, but kit is left at the point
   for nobody to use.
3. **Q3 Escort ratio (no sourced figure found).** (a) One escort per 4 prisoners on the move, one guard per 6 at the
   point (recommended) · (b) one per 2 / one per 4 (safer, costs more men) · (c) one per 6 / one per 10.
4. **Q4 MP vehicles.** (a) DE Dingo-class Feldjäger vehicle, RU KamAZ "Patrul" (recommended) · (b) DE Wolf, RU
   Tigr-M (smaller, two runs for a squad of prisoners) · (c) a truck for both.
5. **Q5 Escapes.** (a) Rare escapes from unguarded prisoners, more at night or in smoke (recommended) · (b) no
   escapes at all · (c) escapes also from guarded prisoners, rarely.
6. **Q6 MP delay.** (a) 15-30 minutes (recommended) · (b) 10-15 minutes, like the ambulance · (c) 30-60 minutes.
7. **Q7 Surrendered but never taken at the end.** (a) Settled like the wounded: held by the side holding the ground
   (recommended) · (b) stay "surrendered" as today.
8. **Q8 Guards in the fight.** (a) Guards fire only in self-defence within 50 m (recommended) · (b) guards fight
   normally from the point · (c) guards cannot fire at all.
