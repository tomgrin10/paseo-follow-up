import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Invariant publish-gate-checks-run-on-every-pr. 2026-11-11: the publish workflow ran `npm run test:install`, PR CI
// didn't, so #116 merged green and v2.0.0-rc.3 failed at publish. Every check the publish job runs, and every CLI it
// installs for them, runs in PR CI too, in a job triggered by pull_request.
const steps = (yaml: string) => [...yaml.matchAll(/^\s*(?:-\s+)?run:\s*(.+)$/gm)].map(m => m[1].trim());
const checks = (yaml: string) => steps(yaml).filter(s => /^npm (run \S+|pack --dry-run|test)\b/.test(s)).map(s => s.split(/\s+#/)[0]);
const clis = (yaml: string) => steps(yaml).filter(s => /^npm install (-g|--global)\b/.test(s)).flatMap(s => s.split(/\s+/).filter(w => /^@?[\w./-]+@[\w.-]+$/.test(w) && !w.startsWith("npm@")));

test("publish-gate-checks-run-on-every-pr: PR CI runs every check and CLI the publish workflow gates on", async () => {
  const publish = await readFile(".github/workflows/publish-npm.yml", "utf8");
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /^on:\s*\n(\s+.*\n)*?\s+pull_request:/m, "ci.yml runs on pull_request");
  assert.ok(checks(publish).includes("npm run test:install"), "the publish gate still runs test:install");
  assert.deepEqual(checks(publish).filter(c => !checks(ci).includes(c)), [], "publish checks missing from PR CI");
  assert.deepEqual(clis(publish).filter(c => !clis(ci).includes(c)), [], "CLIs (and versions) the publish checks use but PR CI doesn't install");
});
