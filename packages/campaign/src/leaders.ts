/**
 * AUTOMATIC LEADERS (M12.1a; owner 2026-11-19: appointed automatically, the player can change them in M12.3). A unit
 * whose template has a leader and whose leader is gone gets one, top down (a company before its platoons, a platoon
 * before its squads): the best of its own men and of its direct sub-units' leaders, by
 *   1. a leader's role (data `leader: true`: the deputies and commanders),
 *   2. rank (grade),
 *   3. experience,
 *   4. his own unit's man before a sub-unit's leader, then the order of the roster.
 * Medical personnel never lead (their protection, GC I art. 24). A sub-unit's leader chosen moves up into the unit's
 * headquarters (his old unit then gets its own leader the same way): so a platoon whose headquarters is gone is led by
 * its deputy, the senior squad or vehicle commander. Every appointment is logged.
 */
import type { DataSet } from "@tcs/data";
import type { SoldierRecord, UnitInput } from "@tcs/sim";
import type { CampaignForce, CampaignLogEntry, CampaignRecord, CampaignSide } from "./record";

const MEDICAL_PERSONNEL = new Set(["medic", "stretcherBearer", "ambulanceCrew"]);

export function canLead(data: DataSet, faction: string, m: SoldierRecord): boolean {
  const lvl = data.factions[faction]?.roles[m.role]?.medical?.level;
  return lvl === undefined || !MEDICAL_PERSONNEL.has(lvl);
}

/** Leadership score (higher first): leader's role, grade, experience. */
function score(data: DataSet, faction: string, m: SoldierRecord): [number, number, number] {
  const p = data.factions[faction]!;
  return [p.roles[m.role]?.leader === true ? 1 : 0, p.ranks[m.rank]?.grade ?? 0, m.skills["experience"] ?? 0];
}

function better(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Appoint leaders where they are missing (see the file comment); returns the log entries. */
export function appointLeaders(data: DataSet, f: CampaignForce, battle: number, side: CampaignSide, lost: ReadonlyMap<string, string> = new Map()): CampaignLogEntry[] {
  const log: CampaignLogEntry[] = [];
  const walk = (u: UnitInput) => {
    const t = data.factions[f.faction]?.units[f.establishment[u.key] ?? ""];
    const wantsLeader = (t?.leaderIndex ?? u.leaderIndex) >= 0;
    if (wantsLeader && (u.leaderIndex < 0 || u.leaderIndex >= u.members.length)) {
      let best: { m: SoldierRecord; s: [number, number, number]; sub: UnitInput | null } | null = null;
      const consider = (m: SoldierRecord, sub: UnitInput | null) => {
        if (!canLead(data, f.faction, m)) return;
        const s = score(data, f.faction, m);
        if (best === null || better(s, best.s)) best = { m, s, sub };
      };
      for (const m of u.members) consider(m, null);
      for (const su of u.subunits) { const l = su.leaderIndex >= 0 ? su.members[su.leaderIndex] : undefined; if (l) consider(l, su); }
      const b = best as { m: SoldierRecord; s: [number, number, number]; sub: UnitInput | null } | null;
      if (b) {
        if (b.sub) {
          b.sub.members = b.sub.members.filter((x) => x !== b.m);
          b.sub.leaderIndex = -1;
          u.members.push(b.m);
        }
        u.leaderIndex = u.members.indexOf(b.m);
        const replaced = lost.get(u.key);
        log.push({ battle, side, kind: "leader", unitKey: u.key, personId: b.m.personId, how: b.sub ? "sub" : "own", ...(replaced !== undefined ? { replaced } : {}) });
      }
    }
    u.subunits.forEach(walk);
  };
  walk(f.battalion);
  return log;
}

/** Why "Make leader" was refused (review M12, rule 12: the UI says it through `cmp.leaderRefused.<key>`). */
export class LeaderError extends Error {
  constructor(readonly key: "committed" | "notInUnit" | "alreadyLeads" | "medic", message: string) { super(message); this.name = "LeaderError"; }
}

/**
 * M12.3 "Make leader" (owner 2026-11-19: leaders are appointed automatically, the player can change them): the man
 * becomes his unit's leader (the old leader stays in the unit). Refused (a `LeaderError`) when he is not in a unit of the
 * player's battalion, already leads it, is medical personnel, or the forces of a battle are already confirmed (phase
 * "battle": the battle is built from the record). Logged as a leader entry with `how: "player"`. Pure: a new record.
 */
export function makeLeader(data: DataSet, record0: CampaignRecord, personId: string): CampaignRecord {
  if (record0.flow?.phase === "battle") throw new LeaderError("committed", "the forces are committed: leaders change after the battle");
  const record = JSON.parse(JSON.stringify(record0)) as CampaignRecord;
  const f = record.sides.player;
  const walk = (u: UnitInput): UnitInput | null => {
    if (u.members.some((m) => m.personId === personId)) return u;
    for (const s of u.subunits) { const x = walk(s); if (x) return x; }
    return null;
  };
  const u = walk(f.battalion);
  if (!u) throw new LeaderError("notInUnit", `${personId} is not in a unit of the battalion`);
  const i = u.members.findIndex((m) => m.personId === personId);
  if (u.leaderIndex === i) throw new LeaderError("alreadyLeads", `${personId} already leads ${u.key}`);
  if (!canLead(data, f.faction, u.members[i]!)) throw new LeaderError("medic", `${personId} is medical personnel and cannot lead`);
  const old = u.leaderIndex >= 0 ? u.members[u.leaderIndex]?.personId : undefined;
  u.leaderIndex = i;
  record.log.push({ battle: record.battles, side: "player", kind: "leader", unitKey: u.key, personId, how: "player", ...(old !== undefined ? { replaced: old } : {}) });
  return record;
}
