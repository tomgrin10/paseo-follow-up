import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initialReducedMotion, rememberReducedMotion } from "../shared/motion";

/**
 * Reduced motion has to be right on the first render. The system setting arrives asynchronously, so a component that
 * reads it once at mount (a mount-only effect, a state initialiser) used to start its fade before it knew, and then
 * kept running it: Getting started's step fade did, and so did the intro example's timer.
 */
test("the first render already knows: web reads the media query synchronously, and a resolved value is remembered", () => {
  rememberReducedMotion(null);
  assert.equal(initialReducedMotion({ matchMedia: q => ({ matches: q === "(prefers-reduced-motion: reduce)" }) }), true, "web: the media query, before any promise");
  assert.equal(initialReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(initialReducedMotion({}), false, "native, never resolved: assume motion until the system answers");
  rememberReducedMotion(true);
  assert.equal(initialReducedMotion({}), true, "native: a later mount starts from the answer an earlier one got");
  assert.equal(initialReducedMotion({ matchMedia: () => ({ matches: false }) }), true, "the last answer wins over the query (it came from a change event)");
  rememberReducedMotion(null);
  assert.equal(initialReducedMotion({ matchMedia: () => { throw new Error("no media queries"); } }), false, "a throwing matchMedia never breaks a render");
});

/** Every effect or initialiser that reads `reduced` (from useReducedMotion) must follow it when it changes. */
test("invariant: nothing reads reduced motion only at mount", async () => {
  const offenders: string[] = [];
  for (const name of (await readdir("client")).filter(n => n.endsWith(".tsx"))) {
    const source = await readFile(join("client", name), "utf8");
    if (!source.includes("useReducedMotion()")) continue;
    // A mount-only effect that reads it: decides once, before the answer arrives.
    for (const m of source.matchAll(/use(?:Layout)?Effect\(\(\) => \{([\s\S]*?)\}, \[\]\)/g)) if (/\breduced\b/.test(m[1])) offenders.push(`${name}: a mount-only effect reads reduced (add it to the deps)`);
    // State seeded from it: the seed is the not-yet-known value and never updates. Derive it in render instead.
    for (const m of source.matchAll(/useState\(([^;\n]*)\)/g)) if (/\breduced\b/.test(m[1])) offenders.push(`${name}: useState(${m[1].trim()}) seeds state from reduced (derive it in render)`);
  }
  assert.deepEqual(offenders, []);
});

test("useReducedMotion starts from initialReducedMotion and remembers every answer", async () => {
  const source = await readFile("client/motion.tsx", "utf8");
  assert.match(source, /useState\(\(\) => initialReducedMotion\(/, "the first render uses the synchronous read");
  assert.match(source, /rememberReducedMotion\(/, "answers are remembered for later mounts");
});
