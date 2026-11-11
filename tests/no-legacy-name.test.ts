import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { EXEMPT, LEGACY, trackedFiles } from "../scripts/rename-legacy-name.mjs";

/**
 * Follow-up 2.0 is 100% Follow-up. The product's old internal name may appear only in CHANGELOG.md (history stays as
 * written) and shared/legacy.ts, the one module that recognises what 1.x left behind (its data directory, labels,
 * env vars, message prefixes, hook marker and registrations). Everything else uses the new name; run
 * `node scripts/rename-legacy-name.mjs` to fix the mechanical cases, and route legacy recognition through
 * shared/legacy.ts.
 */
test("no tracked file outside the legacy module uses the old name", () => {
  const hits: string[] = [];
  for (const file of trackedFiles()) {
    if (EXEMPT.includes(file)) continue;
    if (LEGACY.test(file)) { hits.push(`${file} (path)`); continue; }
    if (!existsSync(file)) continue;
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue; // binary
    buffer.toString("utf8").split("\n").forEach((line, i) => { if (LEGACY.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(hits.slice(0, 40), [], `${hits.length} use(s) of the old name; run node scripts/rename-legacy-name.mjs`);
});

test("the legacy module and the changelog are the only exemptions", () => {
  assert.deepEqual([...EXEMPT].sort(), ["CHANGELOG.md", "shared/legacy.ts"]);
});
