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

describe("no faction is hard-coded (SPEC 4.3 rule 8)", () => {
  it("engine packages contain no faction ID literals", () => {
    const factionIds = readdirSync(join(PKG, "data", "factions"));
    const pat = new RegExp(`["'\`](${factionIds.join("|")})["'\`]`);
    const bad: string[] = [];
    for (const pkg of ["sim", "ai", "render", "ui"]) {
      for (const f of sourceFiles(join(PKG, pkg, "src"))) {
        const t = stripComments(readFileSync(f, "utf8"));
        const m = pat.exec(t);
        if (m) bad.push(`${relative(ROOT, f)}: ${m[0]}`);
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
