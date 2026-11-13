/**
 * Architecture guards (SPEC 4.2, 4.3). These scan the source text, so they catch violations even in
 * code paths no other test exercises.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PKG = join(ROOT, "packages");

/** Which @tcs packages each package may import. The dependency direction of the project. */
export const ALLOWED_DEPS: Record<string, string[]> = {
  sim: [],
  data: ["sim"],
  ai: ["sim"],
  scenario: ["sim", "data"],
  campaign: ["sim", "data", "scenario"],
  render: ["sim", "data"],
  ui: ["sim", "data", "render"],
  app: ["sim", "data", "scenario", "ai", "render", "ui"],
  tools: ["sim", "data", "scenario", "ai", "campaign"],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");

/** Strip comments so documentation may mention forbidden things. */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** Also strip string literals, so "window" as a data value is not mistaken for the DOM global. */
const stripStrings = (t: string) => t.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

describe("package dependency direction", () => {
  for (const [pkg, allowed] of Object.entries(ALLOWED_DEPS)) {
    it(`${pkg} imports only from: ${allowed.join(", ") || "(no other @tcs package)"}`, () => {
      const bad: string[] = [];
      for (const f of sourceFiles(join(PKG, pkg, "src"))) {
        for (const imp of importsOf(readFileSync(f, "utf8"))) {
          const m = /^@tcs\/([a-z]+)/.exec(imp);
          if (m && m[1] !== pkg && !allowed.includes(m[1]!)) bad.push(`${relative(ROOT, f)} imports ${imp}`);
          if (imp.startsWith("../") && imp.split("/").filter((s) => s === "..").length > 3) bad.push(`${relative(ROOT, f)} reaches across packages via ${imp}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("simulation purity (packages/sim)", () => {
  const files = sourceFiles(join(PKG, "sim", "src"));
  it("imports no third-party or Node modules", () => {
    const bad: string[] = [];
    for (const f of files) for (const imp of importsOf(readFileSync(f, "utf8"))) if (!imp.startsWith(".")) bad.push(`${relative(ROOT, f)}: ${imp}`);
    expect(bad).toEqual([]);
  });
  it("uses no Math.random, wall-clock time, timers or DOM", () => {
    const pat = /\bMath\.random\b|\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\bwindow\b|\bdocument\b|\bprocess\b|\bglobalThis\b/;
    const bad = files.filter((f) => pat.test(stripStrings(stripComments(readFileSync(f, "utf8"))))).map((f) => relative(ROOT, f));
    expect(bad).toEqual([]);
  });
  it("scenario/map generation also avoids Math.random and engine-dependent maths", () => {
    const pat = /\bMath\.(random|sin|cos|tan|asin|acos|atan|atan2|sqrt|cbrt|pow|exp|log|hypot)\b|\*\*/;
    const bad = sourceFiles(join(PKG, "scenario", "src")).filter((f) => pat.test(stripComments(readFileSync(f, "utf8")))).map((f) => relative(ROOT, f));
    expect(bad).toEqual([]);
  });
  it("routes transcendental maths through sim/math only", () => {
    const pat = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sqrt|cbrt|pow|exp|expm1|log|log2|log10|log1p|hypot|sinh|cosh|tanh)\b|\*\*/;
    const bad = files.filter((f) => !f.endsWith(join("sim", "src", "math.ts")) && pat.test(stripComments(readFileSync(f, "utf8")))).map((f) => relative(ROOT, f));
    expect(bad).toEqual([]);
  });
});

describe("map painters are pure (plan photo decision 3)", () => {
  // The photo painter runs in a worker and in Node tests: no Pixi, no DOM, no randomness, no clock.
  const files = [...sourceFiles(join(PKG, "render", "src", "photo")), join(PKG, "render", "src", "flat", "paint.ts"), join(PKG, "render", "src", "tile-queue.ts")];
  it("import only @tcs/sim, @tcs/data (types) and each other", () => {
    const bad: string[] = [];
    for (const f of files) for (const imp of importsOf(readFileSync(f, "utf8"))) if (!imp.startsWith(".") && imp !== "@tcs/sim" && imp !== "@tcs/data") bad.push(`${relative(ROOT, f)}: ${imp}`);
    expect(bad).toEqual([]);
  });
  it("use no Math.random, clock, timers or DOM", () => {
    const pat = /\bMath\.random\b|\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\bwindow\b|\bdocument\b/;
    const bad = files.filter((f) => pat.test(stripStrings(stripComments(readFileSync(f, "utf8"))))).map((f) => relative(ROOT, f));
    expect(bad).toEqual([]);
  });
});

describe("no faction is hard-coded (SPEC 4.3 rule 8)", () => {
  it("engine packages contain no faction ID literals", () => {
    // Faction IDs and IDs prefixed with one (de-puma, ru-pg7vl, xf-cart), the fixture faction included (M7.1c).
    const factionIds = [...readdirSync(join(PKG, "data", "factions")), ...readdirSync(join(PKG, "data", "fixtures", "factions"))];
    const pat = new RegExp(`["'\`](${factionIds.join("|")})(-[a-z0-9-]+)?["'\`]`);
    const bad: string[] = [];
    for (const pkg of ["sim", "ai", "render", "ui", "scenario"]) {
      for (const f of sourceFiles(join(PKG, pkg, "src"))) {
        const t = stripComments(readFileSync(f, "utf8"));
        const m = pat.exec(t);
        if (m) bad.push(`${relative(ROOT, f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("men aboard vehicles are gated (A7, plan §15 M7.1c)", () => {
  /** Loops over the soldier stores and calls that list a unit's men: each must skip men aboard, or say why not. */
  const LOOP = /state\.(soldier|identity|mover|weapon|fire)\.(entries|values|keys)\(\)|\bunitSoldiers\(|\ballMembers\(|\bsideKnowledge\(/;
  const GATE = /isMounted\(|isExposed\(|footSoldiers\(|\.mount\b|mounted: ok/;
  /** Not gated yet, with the reason (logged in DECISIONS.md). Empty since M7.2 (surrender gated). */
  const NOT_YET: string[] = [];
  it("every soldier loop and unit-men call in sim, ai, render and app has a mount gate or a `mounted: ok` marker", () => {
    const bad: string[] = [];
    for (const pkg of ["sim", "ai", "render", "app"]) {
      for (const f of sourceFiles(join(PKG, pkg, "src"))) {
        if (NOT_YET.some((n) => f.endsWith(n))) continue;
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
          const code = stripComments(line);
          if (!LOOP.test(code) || /^\s*export function/.test(line)) return;
          // The gate may sit on the line itself, a marker comment just above, or the next few lines.
          const near = lines.slice(Math.max(0, i - 2), i + 4).join("\n");
          if (!GATE.test(near)) bad.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("men's routes know building interiors (M7.5c)", () => {
  it("every findPath call in sim and ai goes through routeBetween or carries an `outdoor: ok` marker", () => {
    const bad: string[] = [];
    for (const pkg of ["sim", "ai"]) {
      for (const f of sourceFiles(join(PKG, pkg, "src"))) {
        if (f.endsWith("nav.ts") || f.endsWith("interior-nav.ts")) continue; // the search itself, and routeBetween
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!/\bfindPath\(/.test(stripComments(line))) return;
          const near = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
          if (!/outdoor: ok/.test(near)) bad.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("soldier heights know upper floors (M7.5d)", () => {
  it("every heightAt call in sim systems and ai goes through standZ or carries a `ground: ok` marker", () => {
    const bad: string[] = [];
    const dirs = [join(PKG, "sim", "src", "systems"), join(PKG, "ai", "src")];
    for (const dir of dirs) {
      for (const f of sourceFiles(dir)) {
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!/\bheightAt\(/.test(stripComments(line))) return;
          const near = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
          if (!/ground: ok/.test(near)) bad.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("app data bundle", () => {
  it("bundles every data folder the Node loader reads (core/**, factions/**)", () => {
    const text = readFileSync(join(PKG, "app", "src", "data.ts"), "utf8");
    expect(text).toContain('"../../data/core/**/*.json"');
    expect(text).toContain('"../../data/factions/**/*.json"');
  });
});
