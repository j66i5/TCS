/** The "insignia" step (owner 2026-11-14): rank insignia drawn from data, status pictograms from the soldier. */
import { describe, expect, it } from "vitest";
import { buildAppearance, Strings } from "@tcs/data";
import { createSim, simHash } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { manDetail, manStatus, unitMenRows } from "../src/card";
import { insigniaSvg } from "../src/insignia";
import { MAN_STATUSES, STATUS_COLOUR, statusPictogram } from "../src/pictograms";
import { unitTiles } from "../src/sidebar";

describe("rank insignia", () => {
  const data = loadData(true);
  const app = buildAppearance(data, ["de", "ru", "xf"]);
  it("every rank of every faction draws as an SVG board in its colours; the devices follow the data", () => {
    for (const f of ["de", "ru", "xf"]) {
      const ins = app.insignia![f]!;
      for (const r of Object.keys(data.factions[f]!.ranks)) {
        const svg = insigniaSvg(ins, r, 26, "Name");
        expect(svg, `${f} ${r}`).toMatch(/^<svg[^>]*class="hud-insignia"[^>]*>.*<\/svg>$/s);
        expect(svg).toContain(ins.base);
        expect(svg).toContain('aria-label="Name"');
      }
    }
    const de = app.insignia!["de"]!, ru = app.insignia!["ru"]!;
    // A private's board is plain; more grade, more devices.
    expect(insigniaSvg(de, "schuetze")).not.toContain("<g fill");
    const count = (svg: string, tag: string) => svg.split(`<${tag}`).length - 1;
    expect(count(insigniaSvg(de, "hauptgefreiter"), "path")).toBe(1 + 3);
    expect(count(insigniaSvg(ru, "serzhant"), "rect")).toBe(3);
    expect(count(insigniaSvg(ru, "starshiy-leytenant"), "polygon")).toBe(3);
    expect(count(insigniaSvg(de, "oberleutnant"), "polygon")).toBe(2);
    // No data: nothing drawn (the row keeps its place).
    expect(insigniaSvg(undefined, "schuetze")).toBe("");
    expect(insigniaSvg(de, "nobody")).toBe("");
  });
});

describe("status pictograms", () => {
  const strings = new Strings(loadData(), "en");
  it("one labelled drawing per status, each with its own colour and a string-table label", () => {
    for (const st of MAN_STATUSES) {
      const svg = statusPictogram(st, 20, strings.t(`card.status.${st}`));
      expect(svg).toMatch(/^<svg[^>]*class="hud-picto"[^>]*>.*<\/svg>$/s);
      expect(svg).toContain(STATUS_COLOUR[st]);
      expect(strings.t(`card.status.${st}`)).not.toMatch(/^\[\[/);
    }
    expect(new Set(Object.values(STATUS_COLOUR)).size).toBe(MAN_STATUSES.length);
  });
  it("follows the soldier, worst first, and reads the state without changing it", () => {
    const sim = createSim(getScenario("platoon-vehicles").build(loadData(), 1, 600));
    const cat = sim.ctx.catalog;
    const squad = unitTiles(sim.state, "blue", cat).find((t) => t.kind === "infantry")!;
    const h = simHash(sim);
    const rows = unitMenRows(sim.state, cat, squad.unit);
    expect(simHash(sim)).toBe(h);
    expect(rows.every((r) => r.status === "mounted")).toBe(true); // the platoon starts mounted
    const id = rows[1]!.id;
    const s = sim.state.soldier.req(id);
    const keep = structuredClone(s);
    delete s.mount;
    expect(manStatus(s)).toBe("ready");
    s.mental.behaviour = "shaken";
    expect(manStatus(s)).toBe("shaken");
    s.mental.behaviour = "pinned";
    expect(manStatus(s)).toBe("pinned");
    const wound = { id: 1, zone: "armL", mechanism: "penetrating", severity: 0.1, bleedingLps: 0.001, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] };
    s.wounds.push(wound as never);
    expect(manStatus(s)).toBe("wounded");
    wound.severity = 0.4;
    expect(manStatus(s)).toBe("serious");
    expect(manDetail(sim.state, cat, id)!.status).toBe("serious");
    s.casualty = "incapacitated";
    expect(manStatus(s)).toBe("down");
    s.captive = { state: "surrendered", tick: 0 };
    expect(manStatus(s)).toBe("surrendered");
    s.captive = { state: "captured", tick: 0 };
    expect(manStatus(s)).toBe("captured");
    s.casualty = "killed";
    expect(manStatus(s)).toBe("dead");
    Object.assign(s, keep);
  });
});
