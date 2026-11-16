# State — handover note

_Last updated: 2026-11-16 (M11.1 slice 43; sight realism review fixes; step 5; morale rework; M10 review fixes after M10.8; M10 Medical complete). The long session-by-session
history that stood here until today is kept in `docs/history/STATE-until-2026-11-14.md`; every change is also in
DECISIONS.md under its date._

## Where we are
- **M11.1 (slice 43) built (2026-11-16, branch `claude/m11-logistics`).** Consumption lab (`npm run lab -- consumption`),
  `moveCharge` and the ledger with a conservation guard (every scenario exact; two leaks fixed: vehicle smoke salvos and a late wave's
  ammunition, now an `items.delivered` event),
  packaging data (cans, tins, bandoliers, crates; low), loose rounds on the men, `refillMagazines` in quiet moments,
  late-arriving units (`UnitInput.arriveS`) and the 60-minute `hold-resupply` battle in three waves (app
  `?scenario=hold`), machine guns rapid then sustained and no trickle while an enemy is known. Numbers in DECISIONS
  "M11.1". **Open for the owner:** platoon and platoon-ru attacker wins 8 of 10 (top of the 2-8 band; base 6 and 8;
  mostly from the loose rounds and refilling); defenders still fire far below the sources (they see little); in hold-resupply the German
  defence often breaks early, so a defending machine gun runs dry in only 1 of 6 battles without resupply (squads
  out of loaded spares by minute 30: met); suppressive fire at known places built but off (wasted rounds). Slice 44
  (redistribution, casualties' ammunition) is next.
- **M11 Logistics: plan written (2026-11-16, branch `claude/m11-logistics`).** `docs/plans/m11-logistics.md`: the owner's
  answers (DECISIONS "M11 owner round (2026-11-16)"), the measured consumption (nobody runs short today: battles end
  early and men fire little), research on loads and packaging (medium at most), and slices 43-48 and 52 for this
  chain; repair (50-51) and batteries (49) are built in parallel sessions. No code changed yet; slice 43 is next.
- **Sight realism: review fixes (2026-11-16, branch `claude/sight-realism`).** Men of a set-up mortar or missile team
  stay at their post instead of looking for a lost enemy; a man stands up to look only when there is no fight (else
  he kneels or steps aside) and lies down again afterwards even with no posture of his own; a man crawling, bolting
  or going to cover no longer fires on the move at a close enemy; a man lying still on a roof is no longer hidden as
  if in grass, and men at upper windows see men lying still better (they look down); how well a still man blends in is drawn once
  per posture where he is, not again at each look; a few tuning numbers moved into the data. The commander's
  re-siting costs about a third of what it did (headless platoon 33x -> 54x real time, base 48-51x; bench-vehicles 12-13x, floor 8x). Batches: platoon 6 of
  10 attacker wins (base 8), platoon-ru 8 (base 8; step 5 had 10), mounted 9 and 1 as before. Numbers in DECISIONS
  "Sight realism: review fixes". Open: re-acquisition in the platoon defence 17.5 % (goal 30 %); village-occupy
  attackers pinned in the open still hardly fire back at the house (a pinned man fires only within 50 m); a prone
  enemy beside a lone walker's path is often missed (attention to the side and rear).
- **Sight realism, step 5 of 5: squads shift to see a lost enemy again (2026-11-16, branch `claude/sight-realism`).**
  The computer commander, in defence, looks at each squad and the platoon leader's men every 10 s: a man who has seen
  no enemy for 6 s (not pinned or under fire) is moved, crawling or walking, to the best spot within 35 m of his
  place (50 m once the whole squad has seen nothing for 30 s; inside the objective's ring plus 15 m) from which a
  kneeling man sees where the enemy is known to be, at most half a squad at a time; an enemy drawing away is followed
  by up to half a steady squad for a minute; a blind base of fire in the attack slides along its support line. Sim
  and data unchanged. Platoon defence blind-idle to sighted 1.74 -> 0.35, fully blind squad-time 15.2 -> 2.6 %,
  re-acquisition 13 -> 29 %; batches as before (breaks 33 -> 29 of 40). Numbers in DECISIONS "Sight realism, step
  5". Open: re-acquisition just short (defence 29 %, goal 30 %; attack 13 %, goal 15 %); village-occupy defenders
  (scripted sides, no commander) still blind at windows; platoon-ru 10 of 10 (the baseline was 8, inside the band;
  corrected by the review fixes) and the mounted scenarios 9 and 1 of 10 outside the 2-8 band, as at the baseline;
  platoon breaks above the morale rework's 17 of 40.
- **Sight realism, step 4 of 5: a man who has lost a known enemy looks for him (2026-11-15, branch
  `claude/sight-realism`).** After 4 s without seeing any enemy, a halted man who is not pinned or firing turns to the
  enemy he knows, kneels or stands up for 3 s if that would show him, else moves 2-6 m aside to the least exposed spot
  that does (once every 15 s; not in an ambush, a held sector, a cease-fire or "hold fire"); indoors, a man moves to
  another free window of his house that sees the enemy (every 20 s at most). The drills' side-step shares the new
  `systems/peek.ts`. Platoon defence blind-idle to sighted 2.39 -> 1.74, fully blind squad-time 23.9 -> 15.2 %;
  village attackers blind-idle 21 -> 4 %; engage and spotting labs unchanged. Numbers in DECISIONS "Sight realism,
  step 4". Open: platoon defence re-acquisition 13 % (goal 20 %: the attackers lie in crops that nothing near shows);
  village defenders still blind at windows (the windows that see are all manned); platoon breaks up (27 -> 33 of 40);
  platoon-ru attack 10 of 10 (seeds 11-20: 9 of 10, as before). Step 5 (squads moving to see) is next.
- **Sight realism, step 3 of 5: hidden men stay hidden (2026-11-15, branch `claude/sight-realism`).** Crops, grass,
  scrub and trees hide a man behind them about four times as well as before (cover seeking keeps the old figures, and
  so do thermal sights); a man holding still among plants or in a room blends in (each man a little better or worse,
  the same for every enemy); a man lying still is hidden by the open ground itself far off (not to drones or thermal
  sights); once seen, a man who lies still and quiet must be found again; crawling and firing far off show less; a
  heard shot makes a man look harder that way; a dark room hides a man by day, more if he stays back from the window;
  rifle optics help only where a man looks. Open-ground rows unchanged; every spotting target met; the battle census
  of new sightings of men lying still in the open 414 -> 259 m. Numbers in DECISIONS "Sight realism, step 3". Open:
  defenders now sit blind far more (platoon defence blind-idle to sighted 1.20 -> 2.39, fully blind squad-time 6.4 ->
  23.9 %) — step 4 (moving to see again) is the fix; walking across an enemy's front still 55/72 within 15 s; values
  low confidence (game values, no source page could be opened).
- **Sight realism, step 2 of 5: an enemy close in front gets shot at (2026-11-15, branch `claude/sight-realism`).**
  Rule "return" now lets a man fire at an enemy he sees within 100 m without waiting to be fired on; a moving unit
  goes to ground when it sees an enemy anew within 150 m (75 m in the dark); runners, assaults and pushes fire on the
  move within 75 m; pinned men fire back within 50 m; an enemy within 40 m in front is fired at whatever else a man is
  doing (care waits). Spotting itself is unchanged. Numbers in DECISIONS "Sight realism, step 2". Open: walking across
  an enemy's front 76 % within 15 s (goal 80 %: the misses never spot the prone man — step 3's spotting work); drill
  fire at an objective still ignores an enemy at 40-100 m.
- **Sight realism, step 1 of 5: measuring tools and baseline (2026-11-15, branch `claude/sight-realism`, on the
  morale rework; owner request "make the line of sight more realistic").** No behaviour change yet. New labs:
  `npm run lab -- engage` (does a man shoot an enemy right in front of him?), `npm run lab -- reacquire` (men who
  know where an enemy is but cannot see him and do nothing; enemies in front not engaged) and the sight realism and
  retention rows in `npm run lab -- spotting`. The before numbers and batches are in DECISIONS "Sight realism:
  baseline". Next steps: harder spotting where it should be (vegetation, posture, stillness, range, losing sight of
  a man who lies still), prompt fire at an enemy close in front, and men and squads moving to see a lost enemy again.
- **Morale rework (2026-11-15, branch `claude/morale-rework`; owner report "morale is almost always at 100").**
  morale = resolve x (1 - shock) x (1 - strain) per man (`mental.morale` is now the sim's value; `mental.stress` is the
  shock, new `strain`, `nerve`, `why`, `flee`); the four driver groups (leadership/cohesion, losses/wounded,
  fire/danger, success/support), graded states with hysteresis (shaken 0.60/0.70, pinned by quality, panicked
  0.25/0.40 cowering or fleeing 50-150 m), the leader's `rally` action, `Unit.morale` with breaks for any echelon
  (rout drill; platoon leader's squad rally), quality block in `qualities.json`, AI no assault by pinned/broken/badly
  shaken squads, group surrender of broken outflanked defenders. UI: Morale bar with state word, "Why"/"Helping"
  reasons, second badge in the Men list, squad morale in the unit list. Lab `npm run lab -- morale`. Batches and the
  acceptance table in DECISIONS "Morale rework". Review fixes (DECISIONS "Morale rework: review fixes"): each man
  one loss, squads' break guard from their own men under fire, no break within 2 min of a rally, defenders hold to 40 %
  losses. **Open:** platoon breaks still end 17 of 40 batch battles (baseline 11, target 5-35 %), casualties -23 %,
  outflanking rare (0.7 % of squad-time; no flanking lab yet), the five owner questions of the design (aboard men, fleeing, an
  explicit Rally order — not built, automatic only —, squad breaks, fresh troops below 100 %); order delays and
  pinned men refusing moves (design section 7) not built.
- **Slice 42, M7.6d Russian assault group and support weapons (2026-11-15, branch `claude/medical-ambulance-smoke`,
  parallel session).** The GTK Boxer with the 40 mm GMW as a variant (`de-boxer-gtk-gmw`; the Jaegerzug's Boxer 1 and
  3 carry it), the SVD in the BTR squad, automatic grenade launcher teams on foot (`crewServed.kind "agl"`, the
  missile team's post state reused: `systems/agl-team.ts`; AGS-30 `raschet-ags`, GMW `gmw-trupp` data and lab only),
  the RPO-A (disposable, no launcher item, `role antiPersonnel`, thermobaric `enclosedFactor` filling the room), the
  assault group `shturmovaya-gruppa` (opt-in: headless `assault-group`, app `?assault=1`), `bench-agl`, the drop table
  solved exactly above 6 degrees, expenditure `grenadeMg`. Labs `agl`, `house rocket`, gunnery / armour / range /
  fragmentation rows; `--scene assault`, `--scene wheeled` with the GMW. Golden `platoon-vehicles-wheeled-s1`
  regenerated (intended); the others replay the same orders. Tables and misses in DECISIONS "M7.6d". **Open for the
  owner** (all low): the two-and-two GMW mix, the 40 mm penetration and filling, the SVD in BTR squads (disputed),
  the assault group's composition, the thermobaric factor, AGL lethality against prone men (high: a still group
  lying in the open is saturated), the wheeled Jaeger attack still 0 of 10 (BTR losses up, not tuned). Deferred: AGS
  high-angle fire, MRO-A / RShG-2, burns, an RPO step in the clear drill, the GMW's exposed reload.
- **M10 review fixes (2026-11-15, branch `claude/medical-review-fixes`, on main after M10.8 merged; M10 complete).** Grenade orders at
  recognised protected people are refused too, and a refused order changes nothing (drills, errands, carrying
  parties, boarding); the AI commander no longer orders fire at enemies its men spare (refusals 43-53 → 0-1 per 10
  battles); bearers are protected only once they carry; far casualties reachable (route cap 20 000); carer
  reassignment loops gone; the nest medic is someone who can work; evacuated men in a returning hull are out of the
  battle (no repeated rear runs); bruises under armour and settled roster wounds are not settled again, recovery days
  survive the roster round trip, an "evacuated" record is refused as input; ambulance crews wear the armband and the
  medic has a kit (`ambulanceCrew` level); the Wounded tab, review tabs and map got the UX fixes (DECISIONS "M10
  Medical: review fixes", with the before/after table). Open: the plan's acceptance targets marked 🔶 in ROADMAP; a
  responder upstairs cannot drag (floor-aware drag later); `npm test` wall time.
- **Slice 41, M7.6c Wheeled carriers and their platoons (2026-11-15, branch `claude/medical-ambulance-smoke`, parallel
  session; not pushed).** GTK Boxer (`de-boxer-gtk`: FLW 200 with a 12.7 mm sMG worked by the commander, 2 crew + 8)
  and BTR-82A (`ru-btr82a`: 2A72 + PKTM, 3 + 7); the 8-man Jaegergruppe and the Jaegerzug in four Boxers; the BTR
  squad (7, + assistant MG) and the BTR platoon in three BTR-82A. Manifest `platoonTemplates {tracked, wheeled}`,
  `ScenarioDef.carriers`, headless `--carriers`, app `?vehicles=tracked|wheeled|<blue>,<red>`; `crewTemplateOf`
  takes the platoon's carriage crews. Scenarios `platoon-vehicles-wheeled`, `platoon-ru-vehicles-wheeled`,
  `platoon-vehicles-mixed`; golden `platoon-vehicles-wheeled-s1`; drive / gunnery / mount / armour / anti-tank lab
  rows; `--scene wheeled`. Existing battles bit-identical in their events (fingerprint-only golden update).
  Batches (10 x 1200 s): Jaeger attack in GTKs 0 of 10 (Pumas 5), BTR attack 5 of 10 (BMP-2 1): the 30 mm outguns
  the 12.7 mm; not tuned. **Open for the owner** (all low): the GTK 2 + 8 split and the Jaegergruppe composition,
  the BTR armour equivalents, no SVD, the wheeled balance (the GMW 40 mm in slice 42 is the lever); the Russian
  squads' duplicate callsigns ("Gruppa 1" twice, pre-existing). **Next: slice 42 M7.6d** (assault group, AGS / GMW,
  SVD).
- **Slice 40, M7.6b Tanks in battle (2026-11-15, branch `claude/medical-ambulance-smoke` after slice 39; not pushed
  while PR #59 is open).** Gunnery aims at the lowest aim point the line clears (a hull-down tank can now be engaged;
  golden `platoon-vehicles-s1` regenerated) and judges that zone's plate and tiles; tank sections in data
  (`panzer-halbzug`, `tankovaya-gruppa`, `tankovaya-gruppa-t90m`, xf `tortoise-pair`); scenario `tanks` /
  `tankTemplates`; AI tank overwatch (`ai/src/tanks.ts`, `siteHullDown`); batch lines "Vehicles by type", "Kills by
  shooter", tiles and tank rounds; `bench-tanks` 11.9x (floor 8x); golden `platoon-vehicles-tanks-s1`;
  `--scene tanks-battle`. Balance: DE attack wins 4 -> 9 of 10 with two Leopards, RU attack 0 -> 5 with two T-72B3M;
  missed: Leopards are never lost (0.0 per battle) and take 37 % of the BMP-2 losses (40 % wanted); the T-72B3M are
  killed only by Puma 30 mm side shots. Tables in DECISIONS "M7.6b". Performance (test:perf alone): bench-vehicles
  12.2x, bench-combined 4.7x, bench-medical 16.3x, bench-tanks 11.9x. Open for the owner: the TANKS values and the
  section attachments (low), vehicle points for tanks, a Russian "tanks lead" doctrine, CLAUDE.md's command list
  (add `?tanks=`, the new tools scenarios and `--scene tanks-battle`). **Next: slice 41 M7.6c.**
- **M10 Medical: ✅ complete (2026-11-15, with the review fixes)** (SPEC 9.1, pulled forward by the owner), plan `docs/plans/roadmap-detail.md`
  Phase 1, slices 2-17 — **all built** (slices 5 and 12 from parallel sessions, merged); ROADMAP lists each slice and
  DECISIONS has the details. The chain: the "medical" physiology (M10.1), self-aid and buddy aid (M10.2), carers and
  first responders (M10.3a), triage and care under fire (M10.3b), carrying parties (M10.4a) and into vehicles
  (M10.4b), the D2 battle record and `main.ts` split, the Verwundetennest and platoon medic (M10.5), off-map
  ambulances (M10.6a), combat vehicles' rear runs, Role 1 and the end-of-battle settlement (M10.6b), recognition and
  respect (M10.7a, owner Q-7: fire orders at recognised protected people are refused), breaches and medic
  self-defence (M10.7b), and the review's Medical and Conduct tabs from `sim/src/medstats.ts` `medicalSummary` plus
  the batch "Medical" block and the balance report (M10.8, record version 7). **Next: the owner plays a battle on
  his phone and answers the numbers question (keep / adjust named values / faster care); then the debt slot (D3, D4)
  and M8 per ROADMAP.** Balance at 2400 s (DECISIONS M10.8): deaths of wounds −26 %, potentially preventable −30 %
  with care; collection to the nest (2-33 %) and evacuation (0-7 %) are the weak links. Merged origin/main (PR #72,
  D3 phone pass) before slice 17.
- **Every owner question for M10 is already answered** (DECISIONS.md 2026-11-14: "Owner answers for the medical
  system", "Owner answers: M7.5e follow-ups, round A and medical round 1", "Owner answers: medical rounds 2 and 3").
  Those answers override any option still listed in the plan. In short: the full chain from self-aid to an aid
  station off the map; research defaults for the numbers (medium at most), reviewed by the owner after playing;
  DE one Einsatzersthelfer B per Gruppe plus a Sanitäter in the Zug HQ, RU one rifleman-medic per platoon; Russian
  rubber tourniquet and powder ×1.4 time, ×0.8 success; realistic ambulance delays (10-15 min plus drive time) and
  an end-of-battle roll; helpers in contact: the first responder plus at most one comrade per casualty; triage tag
  on the map and the card; a Wounded sidebar tab; bearers are riflemen tasked by the platoon leader; new Boxer
  ambulance and BMM hulls; an order to fire at a recognised protected target is **refused** (the men will not fire;
  a short radio note says why); incidental hits on protected people get their own list in the review; breaches
  are shown only in the review; air evacuation later.
- **D4a done (2026-11-15, parallel session; DECISIONS "D4a"):** the AI attack keeps a reserve (committed when the
  assault falters), its base of fire bounds forward or its men step aside when own men mask it, and shifts fire to
  depth; rushes are 16 m. Batch line "Attack (D4a)". Open: "support masked" fell 35 %, not the 50 % asked. D4b done too
  (DECISIONS "D4b"): fire distribution, low aim at heard/reported men (0.3 m), `ambush` and `defendArc` orders
  (Fire tray, card chip; `lab -- ambush`), hesitation of shaken men. Open: the win band (owner question).
- **Order after M10** (owner): a debt slot (D3 phone pass, D4 infantry tactics with 3-5 s rushes of 15-20 m), then
  M8 → M9 → M7.6 (tanks, wheeled carriers, Jäger/BTR platoons) → M11 (minimum, after measuring ammunition use) →
  M12 → M13. One short debt slot after every milestone.
- **Balance batches:** 1200 s routinely, 2400 s at milestone ends (owner). For speed (owner): 10 seeds before and
  after, only the scenarios a slice affects; `npm run check` once at the end of a slice, alone; `npm run test:perf`
  only when a slice adds per-tick per-man work; screenshots only for visible changes.

**M8 Indirect fire and smoke — built in a parallel session (branch `claude/m8-smoke-fires`, PRs #42 merged, #50
open; DECISIONS "M8.1" … "M8.6", plan Phase 3 slices 21-28).** Smoke clouds are volumes (height, build-up, fade,
drift and plumes in wind; `sim/src/smoke.ts`); the call for fire runs request, processing, shot, flight, splash, with
the first-round error by location method and planned targets; observers (men, vehicle sights; drone kind reserved)
correct by skill; on-map mortar teams (DE 120 mm, RU 2B14 / 2B11: set-up, range band, rounds as items, heard and
seen, slowed by losses and suppression; `platoon-mortars`); off-map PzH 2000 / 2S19 batteries (opt-in: airburst,
danger close 600 m, illumination as data, abstract counter-battery); the AI lays screens across the line and calls
the guns beyond danger close; the fire support pop-up per asset with screens by drag and "splash N s". Labs `smoke`,
`indirect`, `artillery`. Open: M8.5's balance, observer siting and the Russian mounted attack (A4) wait for D4;
planned targets by the player need a deployment phase; the owner's phone play-test of the pop-up. Debt slot after
M8 (slice 29): `?look=classic` deleted, perf re-baselined, `docs/research/low-confidence.md` (264 entries).
**Drones (2026-11-14, roadmap-detail slice 34 "M9.4a", same branch; DECISIONS "M9.4a").** One quadcopter at each
platoon HQ (DE Funker, RU commander): launched by the `drone` order into an entity with its own battery, a busy
operator, cameras that search the ground below, a feed over the radio with the usual delay, a sidebar tile where
Move means fly and Halt brings it home. `npm run lab -- drone`, `--scene drone`, scenario `bench-drones`. The AI
AI keeps its drones up 220 m short of the enemy at 120 m (M9.4b); men see and hear enemy drones (in `seen`, not
contacts), call them out and fire at those within 200 m (abstract hit box, `droneHitChance`). M9.5: a call is
located by the drone (or an off-map reconnaissance drone, `?air=blue`) when that is better, and drones read the falls.
M9.6 (2026-11-15): flares give light; AI night drills (illumination calls, night attack distances, night
fire discipline); men hide from enemy drones; review rows (drones, enemies found by drone, fire missions by location
method); batches day and night reported, not re-tuned (no agreed band). Open: the owner's play-test.

**Main battle tanks: data and labs (2026-11-14, roadmap-detail slice 39 "M7.6a", parallel session; DECISIONS
"M7.6a").**
- New tanks: Leopard 2A7V (4 crew, loader, 42 rounds) and T-90M / T-72B3M (3 crew, carousel autoloader, Refleks-M
  through the gun as its own weapon entry).
- New data and engine pieces:
  - weapon type `tank-gun` and `startLoaded`;
  - `missileBeyondM` per weapon;
  - materials `composite-heavy` and `composite-cast`;
  - explosive reactive tiles as counted items, one item id per face (`reactive` item block,
    `armour.tiles[].coverage`, used up per hit met, a tandem's main jet beats most of a tile);
  - the crew's armour judgement (`faceNeed`) counts the tiles it expects.
- The fixture's `xf-tortoise` covers all of this for rule 8.
- Tanks are in no battle scenario yet. Only the labs, `--scene tanks` and the app's
  `?scenario=vehicles&crew=leopard2a7v-besatzung,t90m-ekipazh` use them. The default vehicle crews skip vehicles
  without passenger seats.
- Lab rows: `armour` (tiles full and spent), `antitank` (PzF3 against the T-90M, RPG-7 against the Leopard),
  `gunnery` (4 km field), `drive` and `missile` (Refleks).
- Existing battles are unchanged: the goldens moved only by the fingerprint.
- **Next: slice 40 (M7.6b)**: AI use with infantry, a tank scenario, the vehicle batch, tank perf.

**Hand smoke grenades (2026-11-14, roadmap-detail slice 5 "D1", parallel session; DECISIONS "D1").** DM45 and
RDG-2 as counted items (one per squad man), thrown by the grenade action, smoke as the existing concealment; "Smoke
grenade" in the Fire tray; units screen themselves on a withdrawal and on a move under fire; hook
`screenCasualty` for the medical line's drag (not called yet). `npm run lab -- smoke`, `--scene smoke`.
**Men down, identity tags, crawling, prisoners' care (owner requests 2026-11-15; DECISIONS of that date).** A dead
man is "down, state unknown" to his comrades until one checks him (they come and drag him into cover meanwhile);
then his identity tag (DE half Erkennungsmarke, RU lichny znak; faction data) is taken when it is quiet; casualties
who cannot walk crawl into cover; surrendered men under fire crawl out of the line of fire; prisoners are treated by
the side holding them, carers sent by urgency first. The surrendered-under-fog report: sight checked, the stale
white flag now fades with its marker.
## Baselines (2026-11-14, before medical)
- **Attacker wins, 20 seeds × 1200 s** (M7.5e follow-ups, DECISIONS "slice s0-clear"): village (platoon) 5/20,
  mounted village (platoon-vehicles) 5/20; farmland 10/20 (M7.5e polish); Russian mounted attack 0/10 (900 s,
  waits for M8.5 mortars and M9.3 missiles, owner A4). **After M10.1** (10 seeds × 1200 s): village 0/10 (20 seeds:
  1/20; men with broken legs may be why), mounted village 6/10, platoon-ru 6/10: watch in M10.8.
- **After M10.3a** (10 seeds × 1200 s, care on): village 0/10, mounted village 6/10, platoon-ru 6/10; median time to
  first treatment 67-157 s; the side with carers fires about a quarter to a third fewer rounds.
- **After M10.3b** (10 seeds × 1200 s, `--no-medical` → care on): preventable deaths (died of wounds after a
  life-threatening need) per battle blue/red: platoon 3.8/2.6 → 1.4/2.6, mounted village 2.9/3.4 → 2.0/3.1,
  platoon-ru 2.5/1.6 → 1.3/1.0 (−32 % overall; the plan's −40 % met for the German side on foot and the Russian
  attack, not for the Russian defenders). Attacker wins with care: village 4/10, mounted village 5/10, platoon-ru
  6/10.
- **After M10.4a** (10 seeds × 1200 s, care on): attacker wins village 2/10, mounted village 3/10, platoon-ru 5/10
  (before the slice 4/10, 5/10, 6/10: noise; carrying is only used for drags to cover so far). `lab -- carry`: every
  method within 10 % of the data on flat, slope, house and stairs.
- **After M10.4b** (10 seeds × 1200 s, care on; mounted battles only, the others do not mount): see DECISIONS
  "M10.4b" for the before/after table.
- **Performance** (this container, `npm run test:perf -- --silent=false` alone, two runs): bench 16× / 19×,
  spotting 9.7× / 9.3×, **bench-vehicles 8.8× / 9.6×** (floor 8×), bench-combined 3.7× / 3.9× (floor 3×), 20,000
  projectiles 3.8× / 4.3×, render 1.2 ms per frame. The hull-hit variant flakes (known noise). After M10.3a: bench
  19× / 17×, spotting 10.8× / 8.9×, bench-vehicles 10.6× / 8.4×, bench-combined 4.0× / 4.0×; the profiler pass
  (DECISIONS M10.3a) found path finding (19 %) and movement (10 %) on top, medical not visible.
- **Test time:** `npm test` 201 s → 160 s (shared map cache, `isolate: false` for sim and data, two redundant
  re-runs trimmed; the plan's 120 s is not met: long battle tests). `npm run test:quick` (sim, data, render, ui;
  514 tests) 29 s: use it while working, `npm run check` alone at the end of a slice (5 min 55 s, green).
- **Merged from the parallel sessions (2026-11-14):** slice 5 D1 hand smoke grenades (DM45, RDG-2, one per squad
  man, "Smoke grenade" in the Fire tray, `npm run lab -- smoke`, `--scene smoke`, hook `screenCasualty` for the
  medical drag) and slice 12 M10.6-data wheeled ambulance hulls (Boxer ambulance `de-boxer-san`, BMM `ru-bmm`,
  xf `xf-litter-cart`; `--scene ambulances`; no ambulance behaviour yet: slice 13).

**Dismounted missile teams (2026-11-14, roadmap-detail slice 33 "M9.3b", parallel session; DECISIONS "M9.3b").**
A Russian Metis-M team (`raschet-metis`: 9P151 launch post, four 9M131, crew of 3) as a unit of its own, opt-in per
scenario with `missileTeams: true` (on in `platoon-vehicles`, `platoon-ru-vehicles`, the app's mounted battle
unless `?missiles=0`; new `bench-missile-team`). Crew-served life shared with the mortars (`crewServed` item block:
packed / setting / ready, pack on move, auto-deploy, post taken over); `systems/missile-team.ts` fires on its own
(anti-tank rule) or on a fire "at" order, guided by missiles.ts from the stored sight point (gunner pinned while
guiding, moves wait). AI: overwatch post (`siteOverwatch`), moves on after each launch, attacker's carriers wait for
it only while it can be set up within 90 s; the attacker's team starts in dead ground. `npm run lab -- missile-team`.
Open (owner): in `platoon-ru-vehicles` the team sets up but fires almost never (Pumas on a reverse slope; Russian
wins 2 -> 0 of 10) — closer posts or a forward move are a tuning question. Fast crossing hulls (>= 10 m/s) beyond
500 m are always missed (shared guidance lag). Not done: a German ground team, tripod sprite, Deploy/Pack buttons.

**Guided missiles on vehicles (2026-11-14, roadmap-detail slice 32 "M9.3a", parallel session; DECISIONS "M9.3a").**
Guidance kinds wire / beam riding / fire-and-forget (seeker, flies on to the last point seen, top attack); the Puma's
MELLS Spike LR (2 ready, reloaded from the roof by an exposed crewman); launch warning and smoke; xf beam dart.
`npm run lab -- missile` has rows per kind. Next on this line: M9.3b dismounted missile teams (Metis-M at company
level), then the drones.

**Sensor physics (2026-11-14, roadmap-detail slice 31 "M9.2", parallel session; DECISIONS "M9.2").** Thermal
sensors see heat (men, hot and cooled hulls, firing, burning; heat comes through vegetation better; thermal blankets),
a man's sight and goggles help only within their arc; thermal weapon sights as items (DE one per Trupp, RU one per
platoon; low); goggle numbers kept as built; batteries reserved. `npm run lab -- thermal`. Next on this line: M9.3a
guided missiles on vehicles (if the coordinator keeps this line on M9).

**Night and light (2026-11-14, roadmap-detail slice 30 "M9.1", parallel session; DECISIONS "M9.1").** Light follows
the clock in a battle with a sky (`?time=HH:MM&moon=`, tools `--time`): sun and moon table in `core/spotting.json`
`night`; muzzle flashes and gun flashes light the shooter at night, tracers show him more; the night look tints the
map and men, flashes, bursts and fires stay lit. Daylight battles unchanged (states identical to main). Owner M9
round still open: the night look took default (a). `npm run lab -- night`, `--scene night`. Next on this line: M9.2
sensor physics (thermal, goggle numbers).


## What works (short; details in HOW_IT_WORKS.md and ARCHITECTURE.md)
- **Foundations:** deterministic 60 Hz sim with named RNG streams, serialisable state and hash, orders through a
  comms model, events with string keys, counted items, interruptible actions, wound records with a simple
  physiology, battle as a function with roster records in and out, save games, data packs with a validating loader
  and lint, the `xf` fixture faction, headless / batch / golden / lab / screenshot tools, CI and Pages deploy.
- **Map:** procedural village, woodland edge, farmland and industrial maps (2 × 2 km), buildings with rooms,
  inner walls, doorways, stairs and upper floors; navigation for foot, wheeled and tracked; terrain damage.
- **Fighting:** real projectiles (drag, penetration, ricochet), aiming error from skill, posture, fatigue, pulse;
  body zones, helmets and plates; grenades and fragments; under-barrel launchers; machine guns; anti-tank rockets;
  BMP-2 Konkurs-M missile; mortars and smoke with ranging rounds.
- **Senses:** line of sight over terrain, walls, roofs and woods; probabilistic detection; contacts seen, heard
  and reported (by voice and radio through the comms model); fog of war (enemy men in sight drawn as figures).
- **Behaviour:** suppression, stress and morale; soldier decisions (fire, cover, ammunition hand-over, grenades,
  close combat); squad drills (react to contact, bound, assault, withdraw, break and rally); surrender and
  prisoners; houses (defend with a mixed spread, leave a trap, clear room by room); AI commander for attack and
  defence (siting, fall-back, covering fire, assault tempo, clearing on the approach).
- **Vehicles:** Puma and BMP-2 with drive model, crews, mount and dismount, turrets and guns, armour and
  components, fires and bail-outs, cross-loading, casualties loaded within 5 m of the ramp.
- **Interface:** Firefight-style order bar, unit card and men's box, drag-to-move, LOS preview, facing handle,
  unit sidebar, floor switch, Clear and Occupy, fire support pop-up, keyboard, photo-like map (flat and classic
  looks too), after-action review, save and load; phone layout.

## What is weak or missing (honest list)
- **Medical care ends at the platoon's Verwundetennest so far:** a man treats himself, a free comrade within 3 m
  treats him (M10.2), or a carer runs over (M10.3a) and under fire gets him into cover within 15 m (M10.3b); squads
  take their wounded into their vehicles (M10.4b); bearers carry casualties back to the nest, where the medic sees to
  them (M10.5), but nobody evacuates them further yet (M10.6); a platoon shot to pieces has nobody left to carry
  (the share reaching the nest by 2400 s is below the plan's 60 % for defenders, see DECISIONS M10.5); the Russians
  have no medic on the map, so their tags are seldom put right; the player has no button yet for "get out with the
  wounded" (an order flag; not in the Wounded tab either: D3); carriers' extra
  tiredness from the load is not modelled (the data's rests stand for it). The Russian defenders' casualties gain little from care (one rifleman-medic per platoon; men
  in houses are not dragged): watch in M10.5 (the medic) and M10.8. Only 54-86 % of the
  casualties who live past 2 minutes get any care in 10-seed batches (plan target 70 %): carers are hit on the way,
  and under fire few are willing; tuning waits for M10.8. Wound values
  are game values (low) reviewed once by the owner (2026-11-11); the medical numbers (`core/medical.json`, mostly
  low, a few medium) wait for his review after M10.8.
- **Attacks rarely win in villages** (5/20) and the Russian mounted attack never does (0/10): accepted for now;
  re-tuning only in the named balance slices (M10.8, D4, M8.5, M9.6).
- **Performance headroom is small:** bench-vehicles sits close to its 8× floor; every medical slice marked [perf]
  measures it alone twice.
- **Phone smoothness unmeasured on a real phone** (the container's software renderer is far slower). D3 built the
  `?perf=1` read-out (Copy sends the numbers) and `npm run phoneperf`; the owner's numbers decide the sim-in-a-worker
  question.
- **Pre-interiors goldens** (`packages/tools/golden/no-interiors/`, six files) have been skipped since 2026-11-13
  (the data changed). The plan proposes deleting them; they are kept untouched until the owner says so (see
  "Open questions").
- Data from search extracts only (web pages cannot be opened here): confidence medium at most, many values low.
- D3 (2026-11-15) closed the UI leftovers (gun on the card, list over the card, no-line-of-fire warning, drag
  ghosts, casualties in the flat look) and moved the roof atlas into a worker; F2 probe (`npm run probe`) and F3 4 km
  numbers in DECISIONS "D3". Open: "get out with the wounded" button.

## Live build
https://j66i5.github.io/TCS/ — deployed automatically from `main` after every merge.

## Open questions for the owner

- M11.1 (2026-11-16, low): loose rounds carried (DE one 140-round bandolier, RU four 30-round packs), cans in the
  vehicles (Puma/Boxer 2 x 840 + 2 x 200, BMP-2/BTR-82A one 5.45 and one 7.62 x 54R tin), crate counts of 40 mm and hand
  grenades, refilling 1.2 s a round by hand and 0.4 s from clips; the attacker wins of platoon and platoon-ru now 8 of
  10 (top of the band 2-8); suppressive fire at known places (built, off); the hold battle's German defence breaking early.
- Sight realism step 3 (2026-11-15, all low; `core/spotting.json` `conceal`, `core/terrain/vegetation.json`): the
  vegetation concealment and backdrop figures, the conspicuity spread (sigma 0.8), the kept-sight decay (5 s, floor
  20), the ground clutter for men lying still (250 m), the firing reveal by range (half at 200 m), the dark room (0.25
  by day, half again back from the window, firing 6), the cued search (x3, 10 degrees, 50 m, three directions).

- M7.6c (2026-11-15, low unless noted; `docs/research/low-confidence.md`): GTK 2 crew + 8 (inference from "max 10
  persons"), the FLW 200's rates, limits, smoke fit and 9 stowed belts, the GTK rear 22 mm; the 12.7 mm round's
  penetration and drag; the 2A72's 330 rpm and 100 AP / 200 HE split; the BTR-82A armour equivalents (front 10 mm at
  64 degrees, sides 14, rear 13), its door times; the Jaegergruppe composition and the Gruppenfuehrer a Feldwebel; the
  BTR squad's assistant MG (medium) and no SVD; the wheeled balance (Jaeger attack 0 of 10).

- M9 owner round answered 2026-11-14 (DECISIONS "Owner answers: M9 round"): night look and goggles as built. Low-confidence M9.1/M9.2 values: thermal heats, sight arcs, who
  carries thermal sights (DE marksman per Trupp, RU platoon commander), blankets issued to nobody; M9.1: the sun table (one date), full-moon light 0.12, flash light 0.8, tracers x3.
- **Pre-interiors goldens:** delete the six skipped files in `packages/tools/golden/no-interiors/` (they have tested
  nothing since 2026-11-13; the plan recommends deleting, and updating the CLAUDE.md note), or keep them?
- Data reviews whenever convenient (lists in the earlier STATE, `docs/history/STATE-until-2026-11-14.md`, "Open
  questions"): Konkurs-M values, vehicle data of M7.1b-M7.4b, behaviour game values, squad tables, ranks and names.
- Realistic ranks (2026-11-15, DECISIONS "Realistic ranks per role", low/medium, search extracts only): one rank per
  slot; DE Puma Kommandant Feldwebel and HQ Puma (Zugtruppfuehrer) Hauptfeldwebel, Sanitaeter Stabsunteroffizier,
  marksman Oberstabsgefreiter (new rank, insignia positions inferred); RU first squad leader = deputy (starshiy
  serzhant). Zugfuehrer Leutnant or Oberleutnant?
- Now (M10.8 done): the medical numbers table in DECISIONS (keep, adjust named values, or faster care for gameplay), after playing on the phone.
- D1 (low confidence, for review): the DM45's cloud (10 m, 60 s), smoke grenades per man (one), the screen rules
  (15 m, once a minute, on withdrawals and moves under fire).
- M7.6a tanks (low confidence, for review):
  - Armour: Leopard turret front 850 mm and hull front 640 mm of heavy composite. The T-90M is 550 / 480 mm and the
    T-72B3M 430 / 420 mm of cast armour with filler; hull sides are 80 mm steel.
    - With these values DM63A1 at 2 km gets through the Leopard's own hull front (850 against 800), and 3BM60
      does so from about 1 km.
    - The crew's armour judgement uses hull plates only (as before), so a turret-front hit can be misjudged.
  - Reactive tiles:
    - add values: Relikt +344 / +750 / +312, Kontakt-5 +250 / +625 / +62, trigger 150 mm;
    - coverage and tiles fitted per face, e.g. T-90M turret front 0.85 of 26.
  - Loading and refill: 6 s with 2.5 times that without the loader; autoloader 7 / 7.5 s; refill of the ready rack
    120 s (Leopard) and 240 s (T-90M / T-72B3M).
  - Rounds:
    - 3OF26 is from memory: the search for it was refused.
    - Refleks-M flight: 280 m/s launch, 300 m/s cruise, turn rate.
    - 3BM42 as the T-72B3M's round: its newer autoloader may take 3BM59/60.
    - DM63A1 penetration 680 mm RHA at 2 km.
  - Mobility: reverse speeds (Leopard 31 km/h; T-90M 4.8 and T-72B3M 4.2 km/h on one gear) and pivot rates
    (30 / 20 deg/s).
  - Gunnery: armour-piercing hits 100 % at 3 km on a still hull side-on, which may be too good.
  - Crew personal weapons: a G36 or AK-74M with two magazines (the real MP7 / P8 are not in the data).
  - The 2A8 and Trophy wait for M14.5.
- M10.6-data (low confidence, for review): Boxer ambulance and BMM armour, components, gear bands, reverse speeds,
  steering, ramp and loading times, extinguishers, signatures; the medic's rank and load.
