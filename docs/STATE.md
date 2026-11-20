# State — handover note

_Last updated: 2026-11-20 (start menu; M12.4 campaign review and tuning, M12 complete; M12.3 phone roster interface; M12.2 linked operations and endless mode; M12.1b campaign saves; M12.1a battalion data, campaign record and rules between battles; M12.0b scenario kinds and company-size battles; M12.0a contract gaps; balance pass 4 and its review fixes: H danger close, E defence starts on its posts, F hold loose rounds, G return fire; balance pass 3 review fixes; balance pass 3 B+C: `--no-resupply` is the supply chain only, hold battle re-balanced, idle overwatch Pumas bound forward; balance pass 3 A+D: friendly hulls block fire, the app's mounted battle has the batch's tanks; balance pass 2: mounted scenarios, range rule on, smaller hold stock; M11.9c slice 55 prisoners under fire, escapes, review: MP/POW and M11 complete; M11.9b slice 54 military police; M11.9a slice 53 prisoners; balance pass after M11; M11.8 slice 52; M11.5 slice 48; M11.4b slice 47; M11.4a slice 46; M11.3 slice 45; M11.2 slice 44; M11 hold battle: a stronger defence; M11.7b recovery; M11.7a field repair; M11.6 batteries; M11.1 slice 43; sight realism review fixes; step 5; morale rework; M10 review fixes after M10.8; M10 Medical complete). The long session-by-session
history that stood here until today is kept in `docs/history/STATE-until-2026-11-14.md`; every change is also in
DECISIONS.md under its date._

## Where we are
- **Folding sub-units (2026-11-20, branch `claude/collapsible-units`; owner request; DECISIONS "Folding sub-units").**
  In the battle's unit list every unit with sub-units (a platoon) has a fold button (under its tile on the slim
  strip, at its right in the open list; >= 32 px): it hides the platoon's HQ, drone, squads and vehicles without
  selecting it; folded, "+n" hidden, the tile's men count covers the platoon, a dot shows the worst state below
  (broken, pinned/damaged, firing, lost). Folds keyed by callsign path, kept for the battle; a unit selected while
  hidden opens its platoon; Tab still cycles everything. Pure part `ui/src/collapse.ts` (10 tests); `--scene ui` has a
  company-battle fold part with checks. Owner questions in the DECISIONS entry.
- **Start menu (2026-11-20, branch `claude/start-menu`; owner request; DECISIONS "Start menu").** The app without
  parameters (or `?menu=1`) opens a main menu (`ui/src/menu.ts`, `app/src/menu.ts`, pure part
  `app/src/menu-model.ts`): Continue (the campaign in the automatic slot, the mid-battle save, the last battle started
  from the menu), Quick battle (task, side by faction name, on foot / tracked / wheeled, tanks standard / both / none,
  map, time of day, seed from the clock), Campaign (continue, new: army, carriers, operations / endless, straight to
  the briefing via `?campaign=1&new=1&...`; saves page), Hold the village (side, time, seed), Assault group (part, map,
  time, seed), More (vehicle sandbox, look). A launch only writes the URL options the app already took; any URL with a
  parameter opens what it did before. Menu buttons: the battle bar (asks first while the battle runs; behind "⋯" on a
  phone), the review ("Main menu"), the campaign home (its old "Single battle instead" now "Main menu"). Choices in
  localStorage `tcs.menu.choices`, the last launch in `tcs.menu.last`. The battle a URL builds moved unchanged from
  main.ts to `app/src/setup.ts` (`battleSetup`; default factions now from data, the same de/ru pair).
  `app/test/menu.test.ts`: every menu choice gives a URL the app builds a valid, running battle from (36 tests);
  `npm run e2e:menu` (Playwright flow, 10 checks) and `npm run screenshot -- --scene menu` (360x780, 780x360, desktop,
  both looks) pass and were looked at. Checks: typecheck, lint, data lint, build clean; `npm test` 1703 passed, 3
  timed out under a busy machine and pass alone; test:perf not run (no sim code changed). Owner questions: see that entry.
  Review fixes (UI and code reviews): a campaign battle's result can no longer be lost through Menu (its review has
  no Main menu; the bar's Menu in an ended campaign battle goes back to the campaign), the battle bar collapses into
  "⋯" instead of clipping in phone landscape, "Start a new campaign" waits for the slot read, the menu always opens on
  its first screen, wording, a 44 px look toggle, default factions pinned by a test.
- **M12 review fixes (2026-11-20, branch `claude/m12`; DECISIONS "M12 review fixes").** Three independent reviews
  (rules, behaviour, code). Fixed: `deployableMen` (crews of workshop or lost hulls are not counted anywhere the choice
  is made, `ableShare` too; a flank company that cannot fight drops the flank battle; `battleInputs` re-validates the
  choice), walking wounded without recovery days heal (`recovery.walkingWoundedDays` 3, bruises only at once), the
  app builds campaign battles with `CAMPAIGN_HOOKS` (defence on its posts, as the tools), the pending played result
  and the mid-battle save carry the record hash, `CampaignSave.rulesFingerprint` ("rules-changed" warning) and node
  checks on load, string-table keys for choice problems and "Make leader" refusals, Save / home on the briefing and
  replenishment, workshop hulls refilled at replenishment, endless steps kept to the last 30. M12 is 🟡 in ROADMAP
  until the owner's phone test and his DE/RU balance answer. `fightingValue` DE 3.0 is a placeholder for the
  mounted-battle balance pass (Puma vs BMP-2), not a measured value. Checks 2026-11-20: typecheck, lint, data lint
  clean; `npm test` 202 files, 1670 passed, 6 skipped; `npm run e2e:campaign` 12 checks; `--scene campaign` shots
  looked at (phone, both looks). `test:perf` (alone): 21 of 25; the spotting bench 7.6x, its smoke variant 7.7x,
  bench-vehicles 8.0x (7.98) and bench-tanks 7.95x miss the 8x floor; main 828e4e0 run alone right after: 7.8x, 7.5x,
  7.5x on the first three. No sim, AI or scenario code changed since M12.4: the container.
- **M12.4 built (2026-11-20, branch `claude/m12`; plan `docs/plans/m12-roster.md` 4.7).** Faction
  `fightingValue` (`factions/<id>/campaign.json`, outside the catalog; DE 3.0, RU and xf 1.0) weighs the enemy's
  commitment and can shrink its caps (`battle.enemyCapScale` 1.0: never past a company; 2.0 made a node take 18.5 min
  to auto-resolve on the phone proxy); operations are lines of 3 sectors (3-5 battles);
  experience +0.015 a battle, +0.04 a minute under effective fire, at most 0.05 a battle (a full operation under fire
  +0.11-0.17, re-weighed on recorded minutes); recovery days, combat-ineffective line 0.5 and full replenishment kept.
  Batches (1200 s, AI both sides): xf vs xf 7 of 12 operations (58 %); DE as player 8 of 8, RU 0 of 8: one Puma
  platoon beats a BMP-2 company, so no commit ratio closes the gap (a mounted-battle balance pass, owner question).
  Every 12.2 check clean (152 nodes). `npm run phoneperf -- --campaign N` times auto-resolve on the phone proxy.
  HOW_IT_WORKS campaign section, SPEC 9.3 note (battalion). Open owner questions: see "M12 open questions" below.
  Owner acceptance pending: two linked battles on his phone (`?campaign=1`).
  Checks 2026-11-20: typecheck, lint, data lint clean; `npm test` 201 files, 1661 passed, 6 skipped. `npm run
  test:perf`: 22 of 25; the spotting bench (7.3-7.9x), its smoke variant (7.3-7.4x) and bench-vehicles (7.6x) miss the
  8x floor, and main 828e4e0 misses the same floors on this container (7.8x, 7.3x): the container, not M12 (M12.4
  changed no sim code). The independent spec review was not run (no reviewer agent in that session).
- **M12 open questions (asked as multiple choice, recommended first):** Q-A recovered men rejoin inside an operation
  (built: yes) · Q-B lost hulls replaced at replenishment (built: yes) · Q-C one company's worth a battle (built: yes) ·
  Q-D ammunition inside an operation: only in-battle deliveries from the battle's own stock (built: (a)) · Q-E the
  mid-battle save tied to its slot (built: (a)) · DE/RU balance pass on the mounted battle · recovery days scaled for
  the game or kept · the same company proposed again or the fittest (rotation) · night battles from the campaign
  clock · a lost flank battle turning a main win into a draw · leaving a played battle early · battle's own craters
  slow movement · confirm the low-confidence values (`core/campaign.json`, `CRATER_NAV`, effective fire = suppression
  >= 0.1, `SCENARIO_KIND`) · saves: fingerprint mismatch only warns, one auto slot, full service history · (review)
  crews of hulls in the workshop or lost rest inside an operation, or fight on foot · `recovery.walkingWoundedDays` 3.
- **M12.3 built (2026-11-19, branch `claude/m12`; plan `docs/plans/m12-roster.md` 4.6).** `?campaign=1` opens the
  campaign page (`app/src/campaign/page.ts`): home (new campaign: faction, carriers, operations / endless; continue;
  slots load / save / rename / delete / export; import), battalion tree, man card ("Make leader"), briefing (sector
  preview, kind, who attacks, clock, enemy estimate, the choice with the proposed default and the cap; Play or
  Auto-resolve; Change forces), auto-resolve in a Web Worker (progress bars, Cancel leaves the record), what changed,
  replenishment; both looks; strings `cmp.*`. Views in `campaign/src/view.ts`; `makeLeader`, `reviseForces`. A played
  battle: `?campaign=auto&play=1`, the review's "Back to the campaign" hands `battleResultOf` back through the store's
  pending key (`?campaign=1&finish=1`). `npm run e2e:campaign` (Playwright, 11 checks) and `npm run screenshot --
  --scene campaign` (phone and desktop, both looks) pass. Owner acceptance pending: two linked battles on his phone.
  Next: 12.4 review and tuning.
- **M12.2 built (2026-11-19, branch `claude/m12`; plan `docs/plans/m12-roster.md` 4.5).** `campaign/src/operation.ts`
  (operations: a line of 3-5 sectors, node types and the transition table in `core/campaign.json`, success / failure /
  limit / no-force, flank battles for a second company, endless mode, sector memory), commit.ts (`selectables`,
  `proposeChoice`, `enemyChoice` by ratio, `validateCommit`, `commitOf`), the state machine `campaign/src/flow.ts`
  (briefing -> choose -> battle played (`finishBattle`) or `autoResolve` -> after-battle -> briefing / replenishment /
  operation-end; `autoPlay`), `npm run campaign -- batch`. 50 operations per faction and 30 endless nodes: every check
  clean (DECISIONS "M12.2"); DE as the player 52 % success, RU 2 %. A flank battle no longer appoints leaders (a man was
  held twice). No UI yet. Next: 12.3 phone roster interface.
- **M12.1b built (2026-11-19, branch `claude/m12`; plan `docs/plans/m12-roster.md` 4.4).** `campaign/src/save.ts`:
  `CampaignSave {version, record, slotName, savedAt, fingerprint}`, `CAMPAIGN_VERSION` 2, `MIGRATIONS` (1: the bare
  12.1a record; fixture `campaign/test/fixtures/campaign-v1.json`), `validateSave`, `repairIds` (duplicate / missing
  person and hull ids, crew / carrier links, leaders, counters), `readSave` (data-changed warns and loads),
  canonical `exportSave`; `continueCampaignChain` (a finished operation is replenished before the next battle);
  `app/src/campaign-store.ts` (IndexedDB or memory backend, named slots plus `auto`, export download, import from a
  file); the mid-battle save carries `campaignSlot` (`?campaign=<slot>`); `campaign -- chain --from <save>`. DE vs RU
  saved after battle 3 and continued = uninterrupted at battle 6 (`1d461639db88381f`). No UI yet (12.3 shows slots).
  Next: 12.2 operations and endless mode.
- **M12.1a built (2026-11-19, branch `claude/m12`; plan `docs/plans/m12-roster.md` 4.3).** Battalion data: company
  headquarters in their own hull (DE Kompaniefuehrungstrupp in a Puma / GTK Boxer, RU company command group in a BMP-2 /
  BTR-82A), company templates (HQ + 3 existing platoons), battalion templates (HQ, 3 companies, mortar section, AGL team,
  RU Metis team, an attached tank section; DE 340 / 354 men and 42 hulls, RU 298 / 316 and 33, xf 107 and 20), manifest
  `battalionTemplates`, ranks Hauptmann / Major / Oberstleutnant and kapitan / mayor / podpolkovnik (insignia element
  `wreath`); goldens: the fingerprint only (events, orders and forcesOut of all 12 identical). `core/campaign.json`
  clock, operation, endless, experience, recovery, repair, replacements, combat-ineffective. `CampaignRecord` (both
  battalions, establishment, pools, workshop, lost hulls, service history, consumption log, battle history, campaign
  RNG); `applyResult` / `replenish` (pure); automatic leaders; `proposeCommit` (the fittest company within the cap);
  the books (`forceHoldings`, `bookedChange`: exact in every chain); `npm run campaign -- chain` (10 battles, a
  replenishment after 5; the old one-map chain is `campaign -- sector`). Next: 12.1b saves.
- **M12.0b built (2026-11-19, branch `claude/m12`; plan `docs/plans/m12-roster.md` 4.2).** Scenario kinds attack
  (`platoon-attack` unchanged), defence-counterattack (reserve mounted at 40 %), meeting, ambush (to an exit at the far
  edge), withdrawal (hold until 35 %, out by the own edge); exit zones (`rules.exits`: men out are `evacuated` `via:
  "exit"`, saved and fit; hulls `exited`; "side-withdrew"), objectives scoring at a time (`untilS`), late units with
  their hulls; `ForceInput.plan` read by the AI (`ai/postures.ts` `planControllers`: reserve counter-attack, ambush,
  transit, withdraw, follow, break-off by the own edge); a company per side (`size: "company"`), maps from the force;
  `bench-company` 14x real time headless (floor test 4x), cap in `core/campaign.json`; `npm run lab -- kinds`: 300
  battles (foot 200, roster 60, mounted 40) without a stalemate. Company HQ data and the battalion: 12.1a. Next: 12.1a.
- **M12.0a built (2026-11-19, branch `claude/m12`; plan `docs/plans/m12-roster.md` 4.1).** `BattleInput.damage`
  (holes, craters, vegetation loss, dug positions of earlier battles on the map) and `wrecksIn` (crewless hulls of
  side `WRECK_SIDE`, old side in `wreckIn`); `BattleResult.damageOut` and `service` (per man: seconds under effective
  fire and in contact, rounds, wounds, peak shock and strain) only with `rules.campaignOut` (goldens unchanged);
  craters carried in are rough ground (`CRATER_NAV`); `ScenarioDef.forces` (roster units and hulls placed and mounted
  by the generator) and `terrain`; campaign package under the sim lint, `BattleRunner` injected (tools `aiRunner`),
  `fieldForce` / `sectorTerrain` / `runChain`; `npm run campaign -- chain --faction de|ru|xf`. Next: 12.0b scenario
  kinds and company-size battles. Open owner question: should a battle's own craters slow movement too (goldens move)?
- **Balance pass 4 (2026-11-19, branch `claude/balance-4`; owner decisions 2026-11-19 E-H).** H: danger close for
  bursting rounds (`dangerRadiusM` from the fragment data, `stationDangerM`, AGL teams; the gunner-seat floor bug in
  `friendInLine` fixed): own men hit by own vehicle gunners in 10 seeds 11 -> 0 (platoon-vehicles), 22 -> 0
  (platoon-ru-vehicles). E: the defence's hulls start on their hull-down posts (`ai/start-posts.ts`, scenario hook
  `defenceStartPosts`, `onPost`); platoon-vehicles stays above the band (Puma APFSDS penetrates the hulls on their posts
  from 490-640 m; owner question). F: hold defenders keep a quarter of their loose rounds (`HOLD.defenderLooseShare`
  0.25). G: men under effective fire return fire at the shooter's known place (`soldier.returnFire`, `suppress`
  "return"; diagnosis: mortar smoke hid the shooters, men only fired at enemies they saw) and a comrade on the very
  same spot no longer blocks a man's fire (`SAME_SPOT_M`). Hold, seeds 1-20, holds with / without the chain: German
  14 / 10 (+20), Russian 12 / 6 (+30) (F alone: +10 / +5); defences lost with the attack losing <= 5 men: 6 -> 4 of
  120. Review fixes: a station fires over own men's heads (`friendInLine` `over`, `gunnery.overClearM` etc.) and one gate
  (`stationHeld`) chooses targets and holds bursts, the crew passing over targets it cannot fire at and saying why; no
  two men on one place in a house (occupy, bearers back, return from an errand: `freePlaceNear`, `placesTaken`).
  After them: platoon battles (20 x 1,200 s, attacker wins) platoon 7, platoon-ru 7, platoon-ru-vehicles 8,
  platoon-vehicles 13 (26 / 40): all in the band. Hold, 40 seeds each way: German 26 / 18 holds (+20), Russian 19 / 17
  (+5, below the 10-point target: owner question; noise is about 11 points). Own men hit by own gunners in 10 seeds:
  1 and 1. Numbers in DECISIONS "Balance pass 4".
- **Balance pass 3 (2026-11-18, branch `claude/balance-3`; owner decisions 2026-11-18), parts A and D.** A: a hull of
  the shooter's side (and the men aboard) in the line of fire blocks it for every `friendInLine` caller
  (`hullInLine`, fire.ts; own hull and wrecks excluded): own-side hull hits in 10 seeds x 600 s platoon-vehicles 10
  (9 penetrations) -> 0, platoon-ru-vehicles 10 -> 0. D: `mountedTanks` (scenario/battle.ts) gives the batch's tank
  sections to platoon-vehicles / platoon-ru-vehicles and to the app's mounted battle without `tanks=` (`tanks=0`:
  none); `platoon-ru-vehicles-tanks` (identical to platoon-ru-vehicles) removed. Numbers in DECISIONS "Balance pass 3".
  B: `rules.resupply: false` (`--no-resupply`) is the supply chain only; men refilling from their own loose rounds and
  the squad evening out read `rules.refill` (`--no-refill`). Hold battle: no loose rounds on the defenders
  (`HOLD.defenderLooseShare` 0), a full point (`pointShare` 1), waves at 600 / 1,500 / 2,400 s; 20 seeds x 3,600 s,
  holds with / without the chain: German defence 11 / 5 (+30 points), Russian 12 / 4 (+40). C: an attacking side's
  overwatch carriers idle 75 s bound to a hull-down post up to 150 m ahead, 100 m behind the foremost man, off known
  threats (`overwatchBounds`, ai/tanks.ts; `mounting.overwatchBound`). 20 seeds x 1,200 s attacker wins: platoon 10,
  platoon-ru 7, platoon-ru-vehicles 11, **platoon-vehicles 16 (out of band; seeds 21-40: 13; 29 / 40)**: the defence
  loses 4.75 of 5 hulls, T-90Ms penetrated in the side/rear by Puma 30 mm in the first 4 minutes (owner question).
  Review fixes (2026-11-19): bounds only to posts the hull can drive to (no repeats), never farther from the
  objective, at most 1.5 x 150 m, out of known enemy hulls' reach, not while re-arming; a crewman working outside his
  hull blocks fire; the app's default tanks only in the tracked, non-assault battle; unknown `tanks=` warns. Re-measured:
  platoon-vehicles 16 / 20 (28 / 40), the others unchanged; hold on 40 seeds: German 28 / 13, Russian 20 / 9 of 40.
- **Balance pass 2 (2026-11-18, branch `claude/mounted-balance`; owner decisions 2026-11-17).** The range rule
  lifted under fire is on (`decisions.rangeRuleLiftsUnderFire`); the platoon battle's defence digs hasty holes
  (`SCENARIO_HASTY_DEPTH_M` 0.6 m, `rules.prepared[].depthM`; the hold battle keeps 1.2 m); the dead-ground start
  search counts thermal sights (heat >= 0.001); a defending side's carriers whose squads are out take hull-down posts
  with the tank code (`TankArgs.carrierCrews`); platoon-ru-vehicles has the attack's two T-72B3M, platoon-vehicles a
  defending section of two T-90M. Hold battle: defenders start with one loaded magazine or belt per stack
  (`HOLD.defenderMagazineShare` 0.25, loose rounds full) and a half supply point (`HOLD.pointShare` 0.5). 20 seeds x
  1,200 s, attacker wins: platoon 10, platoon-ru 7, platoon-vehicles 10 (was 16; 12 after the review fixes), platoon-ru-vehicles 12 (was 1; 10 after); hold
  (20 x 3,600 s, holds with / without resupply): German defence 11 / 3, Russian 12 / 4 (+40 points both). Numbers in
  DECISIONS "Balance pass 2". Review fixes: the defence's carriers are sited in pairs on one home and never share a
  post (`TANKS.carrierPair`, `samePostM`, `HullDownOpts.avoid`); platoon-vehicles 24 / 40, platoon-ru-vehicles 20 / 40
  (seeds 1-40). The hold battle's gap is the men refilling from their own pockets (`--no-resupply` switches that off),
  not the supply chain: own pockets only (`--no-point --no-deliveries`, new) holds 10 and 12 of 20 (owner question).
  Open (balance pass 3 fixed the first two): the hull-blocks-fire bug (`friendInLine`), the app's mounted battle has no tanks unless `tanks=` is given,
  the German overwatch Pumas that never move up (platoon-vehicles stalls on points).
- **M11.9c (slice 55) built (2026-11-17, branch `claude/m11-mp`): MP/POW done, M11 complete.** A collection point is
  moved at once when rounds land within 30 m of it (at least 60 m from them; not one the player placed); prisoners kept
  over 60 s near a known enemy or under fire without being moved are a `law.exposure` (review only). Rare escapes (Q5
  built with option (a)): an unwatched walking prisoner tries once a minute (2 %, x2 dark, x2 smoke, x2 groups mixed,
  x0.5 searched; stream "prisoners"; `rules.prisonerEscapes`), runs to his side, the enemy keeps the surrendered flag
  10 s, guards never fire, free within 30 m of his own men (`captive` null: the one way back), recaptured within 5 m.
  Rules row "Prisoners: escort automatically / ask me". Record version 12 (`pow` per holding side), the Conduct tab's
  Prisoners block, the batch's Prisoners line. Lab parts 3-4 met; batches identical to slice 54 but one hold battle;
  perf 20/24 alone (container noise, base 23/24 in between; re-run on a quieter machine). Numbers in DECISIONS
  "M11.9c". Optional slice 56 waits for owner Q1.
- **M11.9b (slice 54) built (2026-11-17, branch `claude/m11-mp`).** The military police: each side's MP team waits off
  the map (DE Feldjägertrupp in a Dingo-class `de-dingo2-feldjaeger`, 5 places; RU military police section in a KamAZ
  "Patrul", 7 places; created after every other entity), is called when a collection point holds its first prisoner
  (or by "Call MP"; refusals no prisoners / already coming / none left), comes 15-30 min later, waits 300 m short
  while the point is under fire, turns and backs up to the point, takes over the guard (squad guards released at
  once), boards the walking prisoners 20 s a man, officers first, never over its places, and takes them off the map
  (evacuated: `captive.evacTick`); back 30 min later for the rest; stranded = an ordinary hull, its prisoners wait at
  the point again. Roster `heldBy`, `powEvacuated`; `BattleResult.prisoners`, `SideResult.prisonersTaken` /
  `prisonersEvacuated`; end settlement of men who gave up but were never taken by the side holding the ground (Q7).
  Owner questions Q4, Q6, Q7 built with option (a) for review. Numbers in DECISIONS "M11.9b". Slice 55 (escapes,
  exposure, under fire, AI, review) next.
- **M11.9a (slice 53) built (2026-11-17, branch `claude/m11-mp`; plan `docs/plans/m11-mp-pow.md`).** Prisoners of war:
  a platoon taking a prisoner sets up a prisoner collection point (150 m back, hidden, wheeled-reachable, 50 m from
  its nest and supply point both ways, 250 m from known enemies, moved back when one comes near; `prisonerPoint`);
  once its squad has been quiet 30 s an escort (one per 4 of one group, the bearer filter) searches each prisoner
  (30 s: weapon, ammunition, radios, sights, batteries, documents taken as counted items, `prisonerKeeps` kit kept;
  what he took beyond 15 kg into a captured cache at the point) and walks them back 3-5 m behind at their pace; groups
  officer / NCO / man by NATO rank code, 10 m apart; one guard per 6 stays, out of the fight (self-defence within 50
  m); wounded prisoners who cannot walk are carried to the captors' nest and evacuated with their wounded. Orders
  `escortPrisoners`, `releaseGuard`; card and man-box lines; the point's marker; documents for every leader; weapon
  items for MG5, G28, PKP, SVD. `lab -- prisoners` 40 of 40 on every check; batches within noise; goldens regenerated.
  Owner questions Q2, Q3, Q8 built with option (a) for review. Numbers in DECISIONS "M11.9a". Slice 54 (the MP team,
  roster and result) next.
- **Balance pass after M11 (2026-11-17, branch `claude/balance-m11`; owner: "Rebalance next").** The platoon battle's
  defender is now a prepared defence (`rules.prepared`, the hold battle's fighting positions dug where the commander
  sites its men in the first 60-90 s; `ScenarioDef.prepared: false` for the old open defence). 20 seeds x 1,200 s,
  attacker wins before -> after: platoon 14 -> 9, platoon-ru 19 -> 12 (both in the 2-8 of 10 band, near the middle);
  platoon-vehicles 16 of 20 and platoon-ru-vehicles 1 of 20 stay outside (the Puma decides the mounted battles; owner
  question). Built and switched off: the defence's 300 m range rule lifted while fired on
  (`decisions.rangeRuleLiftsUnderFire`). Hold battle unchanged; the owner relaxed its resupply target to 10-17 points,
  but the current build shows 5 / -5 points over 20 seeds each way (open). Numbers in DECISIONS "Balance pass after M11".
- **M11.8 (slice 52) built (2026-11-17, branch `claude/m11-logistics`).** The commander's logistics (`ai/logistics.ts`):
  a supply point still holding ammunition with a known enemy within 100 m moves 100 m back (the crates stay as a plain
  cache; up to 4 short men near it fill up first); a low (under 40 %), quiet, halted squad with no enemy within 200 m and
  no crate near sends its shortest men, at most half, to an own cache within 400 m (captured ones too). The rest of the
  AI's supply was already in the sim for both sides (asking, bearers, deliveries, re-arming, shelling enemy caches).
  Review: a fourth tab, Logistics (fired by weapon type, dry men at the end, delivered by bearers / vehicles / off map,
  taken, captured and lost, requests and waits, fuel, re-arming; repair, recovery, batteries and water rows moved there
  from the Battle tab). Record version 11; `BattleResult.logistics` per side (consumed, delivered, captured, destroyed;
  sums equal the conservation tally); batch logistics table. Platoon batches and hold winners unchanged; goldens
  unchanged. **Balance NOT met:** 20 seeds each way, holds with / without resupply: German defence 14 / 10, Russian 16 /
  13 (need 25 points apart and 30-70 %); defenders hardly run dry (0.3 of 10.7 armed men at the end) — the defence falls
  to casualties first. A "defenders already half spent" option (`defenderLoadShare`, off) erased the difference (9/9,
  13/13). **Open for the owner:** how should resupply decide the hold battle (longer battle or more waves, a tougher
  defence, a smaller starting supply)? Numbers in DECISIONS "M11.8". M11 chain (43-48, 52) complete; MP/POW next.
- **M11.5 (slice 48) built (2026-11-17, branch `claude/m11-logistics`).** Re-arming and refuelling: a halted hull within
  15 m of an own cache or supply truck takes back its stowage (whole items, a minute plus 1.2 s a kg; reactive tiles
  moved as items only) and fills its tank from 20 l fuel cans (a minute each) or the truck's pump (100 l a minute
  above a 100 l reserve: the truck's own tank stands in for a tanker); idle hulls below half their stowed ammunition
  or a quarter of their tank drive to a cache within 300 m, else go on a supply run (which now also refuels from the
  stock); deliveries bring what the platoon's hulls lack; an order stops it (2 min before it starts again). Fuel items
  have `chargeKind: "diesel"`; every litre burnt is an `items.burnt` event and the conservation guard checks litres
  (exact). On-map mortar teams under 10 rounds send a man to a cache within 150 m (the tube stays set up); the top-up
  puts rounds 8 m behind on-map tubes. Card "Fuel 640 / 900 l · re-arming", list "re-arming"; `lab -- rearm` 8 of 8
  equal to the hand calculation; `--scene supply` shots 9-10. All batches identical to the base (no hull ran low in
  any battle). Numbers in DECISIONS "M11.5". Slice 52 (the AI's logistics, the Logistics review tab, balance) next.
  New low-confidence data: `de-jerrycan`, `ru-jerrycan`, `supply.rearm`, `refuel`, `mortarFetch`.
- **M11.4b (slice 47) built (2026-11-16, branch `claude/m11-logistics`).** Supplies from off the map: each side may
  have an off-map stock (`stock` store, schema 24; everything leaving it is `items.delivered`, conservation exact); a
  supply truck per side (HX2 / Ural-4320, manifest `supply`) is called when a supply point falls below 30 % of its fill
  or by "Order a delivery" (bar; phone under "⋯"), comes after 10-20 min, unloads into the point and leaves; combat
  vehicles' rear runs restock their stowage and bring up to 400 kg to the point ("Restock" for a hull, automatic below
  half stowage); the off-map mortar allotment is topped up (hold battle: 6 rounds per 10 min); ammunition put into an
  ambulance on the player's order is a recorded breach (`law.misuse`, Conduct tab) and the ambulance is unprotected
  while it carries it (the AI never does it: 0 in 120 battles). `lab -- resupply` part 2 within 0.4 %; `--no-deliveries`;
  `--scene supply` shots 7-8. Platoon batches unchanged. Hold battle 20 seeds each way, none / foot / all: defender
  holds 10/12/15 and 13/13/15; squads dry at the end medians 0/0/0 (acceptance "fewer dry" NOT met: hardly any squad
  runs dry, one automatic delivery in 40 battles). Deviations: no delivery to on-map mortar tubes (slice 48), the truck
  drawn as a plain hull. **Open for the owner:** a smaller starting supply point in the hold battle so deliveries
  matter? Numbers in DECISIONS "M11.4b". Slice 48 (re-arming and refuelling vehicles) next.
- **M11.4a (slice 46) built (2026-11-16, branch `claude/m11-logistics`).** Resupply on foot: every squad on foot
  looks at its rounds every 2 s; quiet and halted with an own crate within 60 m, its short men go and fill up; below
  40 % of its standard load (or a gunner under one belt) it radios for ammunition (at most every 2 min) and its platoon
  sends up to two bearers (headquarters first, then the asking squad's rear man; never a gunner, leader, medic or first
  responder, never a squad in a drill or fired on within 30 s) who walk to the supply point, load a crate (40 kg for
  two, 25 kg for one) and carry it to the squad leader with the carry store (cover when fired on, rests); the crate
  lies there as a cache the squad takes from. Player: rule "Ammunition requests: send bearers / ask me" (Rules panel),
  "Send bearers" on the card while a request waits, "Fetch ammunition" (order bar; phone under "⋯"). `lab -- resupply`
  (400 m: within 1 % of the hand calculation), `--scene supply` shots 5-6. Platoon batches unchanged (no supply
  point). Hold battle, 6 seeds each way: bearer trips are rare (German defence 3, Russian 6; 0 from a unit in an
  assault or fired on); defenders' dry men 2 and 2 against 11 and 4 without resupply; the Russian defence's machine
  guns run dry in 1 battle instead of 4. Deviations: the crate is put down beside the leader (no hand-out walk), no
  covered-route choice, "Bring ammunition to" is the card's "Send bearers". **Open for the owner:** medics and first
  responders never carry ammunition (law-of-war reading, software decision); bearers walk rather than run. Numbers
  in DECISIONS "M11.4a". Slice 47 (vehicle runs and off-map deliveries) next.
- **M11.3 (slice 45) built (2026-11-16, branch `claude/m11-logistics`).** Supply points and caches: a `cache` store
  (schema 23) for every pile on the ground (the hold battle's crates are the defending platoon's supply point; the
  M11.2 piles outside the nest are caches), kept 50 m apart from the Verwundetennest both ways and no ammunition within
  15 m of any nest (owner); seen by the enemy within 250 m with a line of sight; HE bursts and fires beside it set it
  off (chance per kg of filling; a 120 mm round on it 6 in 10, a 152/155 mm shell always), a cook-off burns 30-120 s
  losing its contents step by step with its grenades going off (ledger exact); captured after 10 s with an enemy at it
  and none of its side within 50 m (owner); orders `supplyPoint` (Move tray, or drag the marker) and `resupplyAt`
  ("Resupply": men fill magazines, belts and bandoliers at the crate and walk back; four radio refusals); the AI shells
  enemy caches it has seen when it has nothing better; crate icons at every zoom; `lab -- cache`, `bench-caches` (within
  5 % of bench), `--scene supply`. Platoon batches unchanged; hold battle defender wins 4 -> 3 of 6 (id shift, no cache
  event in the changed seeds). Deviations: no automatic siting in battle yet (deliveries site it, slices 46-47),
  grenades not taken at a cache. Numbers in DECISIONS "M11.3". Slice 46 (resupply on foot) next.
- **M11.2 (slice 44) built (2026-11-16, branch `claude/m11-logistics`).** From the interrupted WIP branch
  `claude/m11-wip-44`, reviewed and finished. Quiet, halted squads even out ammunition (belts to the gunner first, then
  magazines, then loose rounds; `bringAmmo` + `transferItems`); own casualties' ammunition is taken only after
  treatment (or known dead) by the nearest low man (0 cases before treatment in 20 seeds of each platoon scenario and
  hold-resupply); the Verwundetennest holds none (handed to a man of the platoon, else a pile 30 m outside: slice 45
  makes piles caches); "Take enemy kit" on the player's order only (fitting ammunition, else a rifle swap: rifles have
  `weaponItem`s, the ledger counts a weapon in the hands as its item). Review additions: men walk back to their place
  after a hand-over or taking; consolidation waits until the squad has stood still 20 s. `lab -- redistribute` 8 of 8.
  Hold battle: defender wins 2 -> 4 of 6 (13 of 20), median 309 rounds taken from casualties per battle. **Open for the
  owner:** attacker wins in the foot platoon battles rose (platoon 7 -> 9 of 10, 15 of 20; platoon-ru 9 -> 10, 19 of
  20). Numbers in DECISIONS "M11.2". Slice 45 (supply points and caches) built next (above).
- **M11 hold battle: a stronger defence (2026-11-16, branch `claude/m11-logistics`).** Owner: dig the defenders in,
  fewer attacker mortar rounds. New minimal fighting positions (`sim/positions.ts`, data `core/ballistics.json`
  `fightingPosition`, low): a side with `rules.prepared` digs a hole under each man halted outdoors in a window
  (hold battle 60-90 s, where the commander sites them); the rim stops rounds, fragments and blast that come in
  below it (only head and weapon show); men keep their holes (cover seeking, side steps, drone hiding, re-siting,
  bearers under fire), morale counts a hole as cover; drawn as a hole in spoil. Attacker mortar share 1/3 -> 1/6.
  6 seeds x 60 min: wave 2 / wave 3 reached 5/4 and 6/5 without resupply (before 5/4, 4/4), defender wins 2 and 2
  (before 0, 0), with resupply 2 and 3 (before 3, 1); squads out of spares by minute 30 met; a machine gun dry by
  minute 45 NOT met (2 and 1 of 6). Numbers in DECISIONS "M11 hold battle: a stronger defence". Slice 44 next.
- **M11.7b Recovery (2026-11-16, branch `claude/medical-ambulance-smoke`, roadmap-detail slice 51).** Each side with
  vehicles has a recovery vehicle off the map (Bergepanzer 3 Büffel: tows up to 70 t; BREM-1: up to 50 t, refuses a
  Leopard 2; fixture `xf-tug`). The player's Recover button (selected crew's immobilised or abandoned hull) or the AI
  commander (hopeless hulls, when quiet) calls it: it comes after 10-20 min, waits 300 m short while the hull is
  under fire, reverses up, a man hooks up outside (2 / 4 min), tows the hull off the map at 8 km/h; the hull is
  towed away with its crew (roster `recovery: towed`). At the end the damaged hulls left are recovered or captured
  by the side holding the ground (`VehicleRecord.recovery`, `capturedBy`). `lab -- repair` part B, `--no-recovery`,
  `?recovery=0|1`, `--scene recovery`. Goldens: event streams with the recovery vehicles stripped are main's (plus
  the end settlement); with them, the mounted battles diverge from the id shift of later entities only. Decisions
  in DECISIONS "M11.7b" (software decisions, owner to review). Next: M11.8 or the logistics slices (other session).
- **M11.7a Field repair (2026-11-16, branch `claude/medical-ambulance-smoke`, roadmap-detail slice 50).** Crews fix
  light damage themselves with time and the spare parts aboard (counted items): a broken track (two links, two men
  outside, about 45 min), a holed 8x8 wheel side (no part, 20 min, a GTK's driver alone 36), the coax (spare barrel,
  11 min, works 6 in 10), the radio (17 min, 5 in 10). They start when the hull is quiet (no hit 60 s, crew not
  under fire 20 s, no enemy known within 300 m for outside work); the men outside are exposed like men on foot;
  hits, fire, a move stop the work, progress kept. Repair button (skips the quiet minute), card lines, tile, review
  row, `npm run lab -- repair`, `--no-repair`, `?repair=0`, `--scene repair`. Goldens: event streams unchanged,
  fingerprint only. All decisions "software decision, not asked; owner to review" (DECISIONS "M11.7a"). Slice 51
  M11.7b recovery built next (above).
  Open: track repairs rarely finish in 20-minute battles (owner question below).
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
- M12.3 (2026-11-19): (1) please play two linked battles on your phone (`?campaign=1`: new campaign, Play the first
  battle, back to the campaign, continue to the second) and say what feels wrong; (2) the campaign clock is shown from
  06:00 on day 1 but every battle is fought in daylight: should campaign battles take the clock's time of day (night
  battles, M9.1)?; (3) the enemy estimate in the briefing is his committed men rounded to 5 / 10 and his vehicles by
  type: show less (only "about a company") or more?; (4) a played battle hands its result back only through the
  review's "Back to the campaign" button: also offer to leave a battle early (withdraw everyone, counted as a loss)?
- M12.2 (2026-11-19): new low game values in `core/campaign.json`: campaign battles 1200 s; operations of 3-5 sectors
  (at least 3, at most 5 battles; failure only from the third); first node attack / attack / meeting / defend, later
  sectors attack / attack / meeting / pursue / ambush; a flank battle in 30 % of nodes; the six node types and their
  enemy ratios (0.7 when the player attacks or ambushes, 1.0 with support otherwise); the transition table (a loss in
  an attack is followed by the enemy's counter-attack on the same sector; a lost defence by a withdrawal a sector
  back); endless: a new sector every 2 nodes. To decide: (1) RU as the player succeeds in 1 of 50 operations, DE in 26:
  12.4 tunes ratios, but the Puma vs BMP-2 gap from 12.1a remains; (2) a flank battle's result does not change the
  next node (only the main battle's does): should a lost flank turn a main win into a draw?; (3) the enemy commits
  platoons of any company (fittest first) while the player commits a whole company: keep?; (4) the batch used 300 s
  battles (time) - most end at the time limit, so draws repeat sectors: is 1200 s the right campaign battle length?
- M12.1b (2026-11-19): saves built as planned (Q-E (a): the one mid-battle save, tied to its campaign slot). To
  confirm: a save made with other data (catalog fingerprint changed) only warns and loads; the automatic slot is a
  single slot overwritten after every battle (not a rolling history); a save grows with the service history (DE
  battalion about 1 MB after 3 battles, 1.5 MB after 6): keep the full per-battle history, or fold old entries?
- M12.1a (2026-11-19): built with option (a) of plan section 5: **Q-A** a recovered man rejoins at the first battle
  after his days are up, inside an operation too (`recovery.rejoinWithinOperation`); **Q-B** destroyed and captured
  hulls are replaced at a replenishment (`repair.replaceLost`). New low game values in `core/campaign.json`: 12 h between
  battles, 7 days between operations, operations of 5 battles in the chain, experience +0.005 a battle and +0.004 a
  minute under effective fire (at most +0.04 a battle, cap 0.9), fatigue -0.05 / shock -0.1 / strain -0.01 an hour,
  7 recovery days and 3 workshop days when a battle settled none, green replacements of the conscript level,
  combat-ineffective below half. New organisation data (low/medium from search extracts): the company HQs (who is in
  them, their hulls and ranks), the battalions' support (one mortar section, one AGL team, RU one Metis team, an attached
  tank section; staff, supply and reconnaissance not modelled), the leader rule (leader's role, then rank, then
  experience; a sub-unit's leader moves up when the HQ has nobody; medics never lead). Questions: (1) the medical
  settlement's recovery days are months (60-400 days in the chains), so nobody evacuated is back within ten battles:
  keep (realistic) or shorten for the campaign? (2) in the 10-battle chains Germany won 9 of 10 as the player and
  8 of 10 as the enemy (in the German chain the Russian battalion lost 468 dead, its replacements included): balance belongs to 12.4, but is the lopsided Puma
  versus BMP-2 result expected? (3) the company that fought rests: the next battle takes the fittest company, so the
  battalion rotates its companies; or should the player's choice (12.2) default to the same company?
- M11.9a prisoners (2026-11-17; plan `docs/plans/m11-mp-pow.md` section 6): built with the recommended option, to be
  confirmed: **Q2** search automatic for every prisoner, kit to the searcher, beyond 15 kg into a captured cache at the
  point; **Q3** one escort per 4 on the move, one guard per 6 at the point; **Q8** guards fire only in self-defence
  within 50 m. M11.9b built with the recommended option, to be confirmed: **Q4** MP vehicles DE Dingo-class
  Feldjäger vehicle (5 places), RU KamAZ "Patrul" (7 places); **Q6** MP delay 15-30 min; **Q7** a man who gave up but
  was never taken goes to the side holding the ground at the end. M11.9c built with the recommended option, to be
  confirmed: **Q5** rare escapes from unguarded prisoners, more at night or in smoke (2 % a minute unwatched, game
  values). Still open for slice 56: **Q1** (prisoners are rare: leave / collect wounded enemies / more surrenders). New
  low data (M11.9c): point moved when rounds land within 30 m (60 m away), exposure after 60 s, escape factors
  (x2 dark below light 0.3, x2 smoke, x2 mixed within 5 m, x0.5 searched), watched within 25 m, grace 10 s, free within
  30 m, recaptured within 5 m. New low data (M11.9b): the two MP hulls (mass,
  drive, seats, armour 12 / 8 mm all low), `mp` (delay 900-1800 s, 20 s a prisoner, back 1,800 s, wait 300 m short,
  give up after 1,200 s), three men per MP team. New low data:
  `core/prisoners.json` (point 150 m back (100-200), 50 m apart, 250 m from the enemy; search 30 s, 15 kg; groups 10 m
  apart; guard 5 m off), documents 0.3 kg per leader; NCOs from OR-5 (the Russian mladshiy serzhant, OR-4 in the data,
  counts as a man: should OR-4 be NCO?). A defence under fire never sends escorts (30 s quiet rule): its prisoners wait
  where they were taken until it is quiet or the player orders "Escort prisoners".
- M11.5 re-arming and refuelling (2026-11-17; new data low: `de-jerrycan` 4.2 kg / `ru-jerrycan` 4.5 kg empty, 20 l;
  core/supply.json `rearm` (60 s to start, 1.2 s a kg, quiet 20 s, ask below 50 %, drive up to 300 m), `refuel` (cans
  20 l a minute, pump 100 l a minute, 60 s set-up, ask below 25 %, truck keeps 100 l), `mortarFetch` (below 10 rounds,
  150 m, 30 kg, 3 s a round)). No tanker vehicle in the data: the supply truck pumps from its own tank. Should the
  hold battle or a new scenario make vehicles run low (no battle today uses half its stowage or a quarter of its fuel)?

- M11 hold battle (2026-11-16): fighting-position values are game values, low confidence (hole 1 m wide, up to 1.2 m
  deep; head and weapon 0.1-0.3 m above the rim by posture); positions only prepared before the battle, no digging
  in battle. Defending machine guns still rarely run dry in 45 min (they see and fire little); seed 4 of
  hold-resupply still breaks in the first wave.

- M11.7b recovery (2026-11-16; new data low unless noted: `de-bergepanzer3` (body, mass 54.3 t, drive, armour,
  components, the third crewman), `ru-brem1` (body, drive 618 kW, armour, components; mass 41 t and crew of three
  medium), their `recovery` blocks (tow limits 70 t / 50 t, 8 km/h, hook-up 120 s by one man / 240 s by two), the
  roles `bergemechaniker` and `slesar-remontnik`, the fuel items, core/repair.json `recovery` (delay 600-1200 s,
  approach 25 m, gap 1.5 m, wait 300 m short while hit within 120 s or an enemy within 300 m, quiet 60 s, give up
  after 600 s waiting, abandoned hull 0.5 workshop days), one recovery vehicle per side (manifest count)).
  Questions: one recovery vehicle per battle enough (the BREM-L / BREM-K of BMP and BTR battalions, Bergepanzer 2,
  Boxer recovery module later)? Unarmed in game (their MG left out)? Who calls: only the player and the AI
  commander, never automatically? Towed to the entry edge (no on-map collection point)? Crew rides along with the
  towed hull, passengers get out first? At the end, hulls on ground the enemy holds are captured (with a damaged
  hull that still drives never captured)? A towed hull still costs its score points this battle?
- M11.7a field repair (2026-11-16, all low, `core/repair.json`, vehicles' `repair` blocks): task times (track 90,
  wheels 40, coax 10, radio 15 man-minutes), restore levels (track 0.8, wheels 0.5), chances (coax 0.6, radio 0.5),
  the quiet rule (60 s, 20 s, 300 m), the work rate (experience, driver x1.25), part masses (track links 30/20/17/8
  kg, barrels 2-3 kg, tool kits 40 kg). Timing: a track takes about 45 minutes, so in a 20-minute battle it is
  almost never fixed — keep realistic / compress repair times / only coax and radio in battle? Who works (driver
  and loader/gunner outside, commander stays), abandoned hulls not repaired in battle, coax parts used even when
  the repair fails.

- M11.6 batteries and water (2026-11-16, low unless noted; DECISIONS "M11.6 stage 1"): radio pack 30 Wh / 0.35 kg,
  DE radio 6 h (medium), RU radio 8 h, goggle cell 4 Wh, DE goggle 50 h, RU 40 h, thermal set 12 Wh, DE thermal 7 h
  (medium), RU 5 h; change times 10 / 20 / 15 s; spares radio 2, goggle 1, thermal 2; night devices on below light
  0.3; fitted batteries start at 30-100 % of full; lull change below 10 %; water 2000 ml at 0.8 g/ml (canteens folded in).
  Stage 2 (radio silence): should a radio carrier who is down or killed take his unit off the net (now: his radio still
  counts)? Should an order already received when the radio goes flat still arrive (now: yes)?
  Stage 4 (water, `core/body.json` `physiology.hydration`): loss 0.15 L/h at rest + 0.8 L/h at full exertion (medium,
  TB MED 507 / USARIEM), only in battles of 2 h or more; effects from a 1.6 L deficit (2 % of 80 kg, medium) to full at
  4.8 L (6 %); he sips 250 ml when 0.72 L down and not under fire (suppression <= 0.1); at full deficit fatigue builds
  x2, recovers x0.5, aim error x1.3 (low). Drinking is instant (no action). A man who comes in dry (roster) into a short
  battle can still drink but loses no more water.
  Stage 5 (review, batch, lab): the review's supply rows (batteries changed and flat by kind, drone relaunches, unit
  time off the net, water drunk) and `npm run lab -- batteries` (3 h night patrol, both platoons; `reports/lab-batteries.md`).
  Should the lab's night be static (a defence) instead of a patrol? Static, nobody drinks within 3 h.

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
