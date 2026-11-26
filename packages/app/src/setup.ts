/**
 * The battle a URL asks for (start menu step: moved out of main.ts unchanged, so a test can build the battle input
 * of every URL the start menu makes, the same way the app does). `?campaign=<slot>&play=1` is not here: its input
 * comes from the campaign record (campaign/battle.ts) and only the controllers are chosen here.
 *
 * Owner rule (start menu): every URL that worked before works the same; the menu only writes these URLs.
 */
import type { DataSet } from "@tcs/data";
import { buildScenario, demoBattle, holdBattle, MAP_KINDS, mountedTanks, SCENARIO_KINDS, startRulesFor, vehicleBattle, withoutRecovery, type MapKind, type ScenarioKind } from "@tcs/scenario";
import { commanderController, defenceStartPosts, sideCommander, vehicleWanderController, waveCommanders, wanderController } from "@tcs/ai";
import { environmentAt, parseTimeOfDay, type BattleInput, type Controller, type ForceStart } from "@tcs/sim";
import { carriersParam, defaultTanksApply, tanksParam } from "./params";

export interface BattleSetup {
  input: BattleInput;
  ai: Controller[];
  /** `?scenario=` (default "platoon"). */
  scenario: string;
  playerSide: "blue" | "red";
  enemySide: "blue" | "red";
  seed: number;
  /** The map kind asked for (undefined: "flat" or not a kind); a campaign battle: the kind of its sector's map. */
  mapKind: MapKind | undefined;
  factions: [string, string];
  /** Review step 5: the rules the player's units start with, by his side's role (`startRulesFor`; null: the
   *  catalog's default, a battle without roles). Laid on his force as `ForceInput.start`. */
  start: ForceStart | null;
}

/**
 * The two factions a battle without `?factions=` is fought between: the first two playable (non-fixture) factions in
 * id order, as data (before the start menu the literal "de,ru", the same pair with today's data). One faction only:
 * against itself; none playable: the first factions at all (the fixture data set).
 */
export function defaultFactions(data: DataSet): [string, string] {
  const ids = Object.keys(data.factions).sort();
  const real = ids.filter((f) => data.factions[f]!.manifest.fixture !== true);
  const pool = real.length > 0 ? real : ids;
  const a = pool[0] ?? "", b = pool[1] ?? a;
  return [a, b];
}

/** Build the battle and its enemy controllers from the URL (`campaignInput`: a campaign battle's own input). */
export function battleSetup(data: DataSet, params: URLSearchParams, campaignInput: BattleInput | null = null, warn: (msg: string) => void = (m) => console.warn(m)): BattleSetup {
  const campaign = campaignInput !== null;
  const seed = Number(params.get("seed") ?? 1) >>> 0;
  const fp = params.get("factions");
  const factions = (fp !== null ? fp.split(",") : defaultFactions(data)) as [string, string];
  const mapParam = params.get("map") ?? "village";
  const mapKind = (MAP_KINDS as readonly string[]).includes(mapParam) ? (mapParam as MapKind) : undefined;

  // M6 first playable: the generated platoon battle (?scenario=demo for the old one-squad sandbox).
  // ?side=blue|red picks your side, ?attacker=blue|red who attacks; the AI commands the other side.
  const scenario = params.get("scenario") ?? "platoon";
  const playerSide = campaign ? "blue" : params.get("side") === "red" ? "red" : "blue";
  const enemySide = playerSide === "blue" ? "red" : "blue";
  // M7.6d: &assault=1: red's platoon is its assault group (on foot) with its AGS team, red attacking unless
  // &attacker= says otherwise.
  const assault = params.get("assault") === "1";
  const attacker = params.get("attacker") === "red" || (assault && params.get("attacker") === null) ? "red" : "blue";
  // The platoon battle starts with its vehicles (attacker mounted) by default since M7.4a (owner Q26: vehicles
  // can now be knocked out and the Panzerfaust and RPG work); &vehicles=0 gives the battle on foot.
  // M7.6c: &vehicles=wheeled (or tracked, or <blue>,<red>) picks the carrier class of each side's platoon.
  const vp = carriersParam(params.get("vehicles"), warn);
  const withVehicles = vp.vehicles;
  const limit = Number(params.get("limit") ?? 2400) || 2400;
  // ?scenario=vehicles (M7.1c): IFV platoons with their squads on foot; vehicles appear nowhere else yet.
  const input = campaignInput ?? (scenario === "demo"
    ? demoBattle(data, { seed, factions, timeLimitSeconds: 3600, mapKind, mapSeed: seed })
    : scenario === "hold"
    // M11.1 ?scenario=hold: hold the village against three waves (60 min); &attacker=blue swaps the sides.
    ? holdBattle(data, { seed, factions, defender: params.get("attacker") === "blue" ? "red" : "blue", ...(params.get("limit") ? { timeLimitSeconds: limit } : {}) })
    : scenario === "vehicles"
    ? vehicleBattle(data, { seed, factions, mapKind: mapKind ?? "farmland", timeLimitSeconds: limit, ...(vp.carriers ? { carriers: vp.carriers } : {}), ...crewParam(params.get("crew")), ...(params.get("recovery") === "1" ? { recovery: true } : {}) })
    : buildScenario(data, { kind: kindParam(params.get("kind"), warn), ...(params.get("size") === "company" ? { size: "company" as const } : {}), seed, mapKind: mapKind ?? "village", factions, attacker, timeLimitSeconds: limit, ...(withVehicles ? { vehicles: true } : {}), ...(vp.carriers ? { carriers: vp.carriers } : {}), ...(params.get("mortars") === "1" ? { mortars: true } : {}), ...(withVehicles && params.get("missiles") !== "0" ? { missileTeams: true } : {}), ...(params.get("artillery") === "1" ? { artillery: true } : {}), ...(params.get("air") ? { airRecon: params.get("air")!.split(",").filter((x) => x === "blue" || x === "red") } : {}), ...tanksParam(params.get("tanks"), params.get("tankCrew"), defaultTanksApply(vp, assault) ? mountedTanks(data, factions, attacker) : null, warn), ...(assault ? { assaultGroup: "red" as const, aglTeams: attacker === "red" ? "attacker" as const : "defender" as const } : {}) }, { defenceStartPosts })); // (balance pass 4: the defence's hulls start on their posts)
  // ?time=HH:MM (M9.1): the battle at that local time, the light following the clock; &moon=0..1 (default a half moon).
  const timeOfDay = parseTimeOfDay(params.get("time"));
  if (timeOfDay !== null) input.environment = environmentAt(input.catalog, timeOfDay, Number(params.get("moon") ?? 0.5));
  // ?repair=0 (M11.7a): no field repair by the crews.
  if (params.get("repair") === "0") input.rules.repair = false;
  // ?recovery=0 (M11.7b): no recovery vehicles; ?recovery=1: the vehicles scenario gets them too.
  if (params.get("recovery") === "0") withoutRecovery(input);
  // Review step 5 (owner Q4): the player's units start "At will" when his side attacks, "Return" when it defends, a
  // laid ambush when it lies in wait (scenario `startRulesFor`). Battle input on HIS force only: the enemy's commander
  // gives its own orders as before. (A campaign battle the player plays too: one rule for "the player's units".)
  const ownForce = input.forces.find((f) => f.side === playerSide);
  const start = (ownForce ? startRulesFor(ownForce) : undefined) ?? null;
  if (ownForce && start) ownForce.start = start;
  // ?ai=0: no enemy controller (screenshots: a scene the enemy must not walk into).
  const ai = params.get("ai") === "0" ? [] : campaign ? [sideCommander(enemySide, input)] : scenario === "demo" ? [wanderController(enemySide, seed + 1000, input.map, 30)]
    : scenario === "vehicles" ? [vehicleWanderController(enemySide, seed + 1000, input.map, 60)]
    : scenario === "hold" && input.forces.find((f) => f.side === enemySide)?.posture === "attack" ? [waveCommanders(enemySide, input)]
    // (M12.0b: a battle of a scenario kind: the enemy's commander by its plan.)
    : [input.forces.find((f) => f.side === enemySide)?.plan ? sideCommander(enemySide, input) : commanderController(enemySide, input)];
  // (Verification fix: a campaign battle's URL has no `map=`: its map's kind is in the input.)
  const builtKind = (MAP_KINDS as readonly string[]).includes(input.map.meta.kind) ? (input.map.meta.kind as MapKind) : undefined;
  return { input, ai, scenario, playerSide, enemySide, seed, mapKind: campaign ? builtKind : mapKind, factions, start };
}

/** `&crew=<blue template>,<red template>` (M10.6-data): the vehicles scenario with other crew templates (data ids),
 *  e.g. the ambulance crews for `npm run screenshot -- --scene ambulances`. */
function crewParam(v: string | null): { crewTemplates?: [string, string] } {
  const parts = (v ?? "").split(",").filter((x) => x.length > 0);
  return parts.length === 2 ? { crewTemplates: [parts[0]!, parts[1]!] } : {};
}

/** M12.0b `&kind=`: a scenario kind (attack, defence-counterattack, meeting, ambush, withdrawal); else the platoon attack. */
function kindParam(v: string | null, warn: (msg: string) => void): ScenarioKind {
  if (v === null) return "platoon-attack";
  if ((SCENARIO_KINDS as readonly string[]).includes(v)) return v as ScenarioKind;
  warn(`kind=${v}: not a scenario kind (${SCENARIO_KINDS.join(", ")}); the platoon attack`);
  return "platoon-attack";
}
