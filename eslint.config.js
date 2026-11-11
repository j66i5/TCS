// ESLint flat config. Type-aware rules are kept light for speed; the architecture rules matter most.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const TRANSCENDENTAL = ["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "cbrt", "pow", "exp", "expm1", "log", "log2", "log10", "log1p", "hypot", "sinh", "cosh", "tanh"];

/** Packages each package must NOT import (mirror of ALLOWED_DEPS in packages/tools/test/architecture.test.ts). */
const FORBIDDEN = {
  sim: ["data", "ai", "scenario", "campaign", "render", "ui", "app", "tools"],
  data: ["ai", "scenario", "campaign", "render", "ui", "app", "tools"],
  ai: ["data", "scenario", "campaign", "render", "ui", "app", "tools"],
  scenario: ["ai", "campaign", "render", "ui", "app", "tools"],
  campaign: ["ai", "render", "ui", "app", "tools"],
  render: ["ai", "scenario", "campaign", "ui", "app", "tools"],
  ui: ["ai", "scenario", "campaign", "app", "tools"],
  app: ["tools", "campaign"],
  tools: ["render", "ui", "app"],
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "reports/**", "screenshots/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js", "packages/tools/**/*.ts", "packages/*/test/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["packages/render/**/*.ts", "packages/ui/**/*.ts", "packages/app/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
    },
  },
  ...Object.entries(FORBIDDEN).map(([pkg, banned]) => ({
    files: [`packages/${pkg}/src/**/*.ts`],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: banned.map((b) => `@tcs/${b}`), message: `Dependency direction: @tcs/${pkg} must not import this package (SPEC 4.2).` }],
      }],
    },
  })),
  {
    // The simulation is pure: no randomness except the seeded RNG, no wall clock, no DOM/Node, no
    // transcendental maths outside sim/math (SPEC 4.3 rules 1-2).
    files: ["packages/sim/src/**/*.ts"],
    ignores: ["packages/sim/src/math.ts"],
    rules: {
      "no-restricted-properties": ["error",
        { object: "Math", property: "random", message: "Use the seeded RNG (sim/rng) with a named stream." },
        ...TRANSCENDENTAL.map((p) => ({ object: "Math", property: p, message: "Route transcendental maths through sim/math." })),
      ],
      "no-restricted-globals": ["error",
        { name: "Date", message: "No wall-clock time in the simulation." },
        { name: "performance", message: "No wall-clock time in the simulation." },
        { name: "setTimeout", message: "The simulation is stepped, never scheduled." },
        { name: "setInterval", message: "The simulation is stepped, never scheduled." },
      ],
      "no-restricted-syntax": ["error", { selector: "BinaryExpression[operator='**']", message: "Use pow() from sim/math." }],
    },
  },
);
