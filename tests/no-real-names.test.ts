import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { ALLOWED, assertNoRealNames, deniedNames, machineNames } from "../scripts/real-names.mjs";

/**
 * no-real-names-in-renders-or-fixtures (2026-11-13). The repo is public, and the harness fixtures named their workspace
 * after the company ("hero-project", "herosecurity/hero-poc", linear.app/hero...). A render or a committed file under
 * scripts/, tests/, docs/ (screenshots included) or changes/ must name no real machine, user or company. The real
 * hostname and user name come from the environment (scripts/real-names.mjs), so this guard leaks nothing itself.
 */
const root = join(import.meta.dirname, "..");
const SCANNED = ["scripts", "tests", "docs", "changes"];
const SELF = "scripts/real-names.mjs"; // the denylist's own generic words
// The guard itself: the denylist and this test, whose examples must spell the words they check.
const GUARD = new Set([SELF, "tests/no-real-names.test.ts"]);

/** A PNG's text: its tEXt, zTXt and iTXt chunks (pixel data is compressed noise and never matched). */
function pngText(buf: Buffer): string {
  const out: string[] = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const len = buf.readUInt32BE(at); const type = buf.toString("latin1", at + 4, at + 8); const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "tEXt") out.push(data.toString("latin1"));
    if (type === "zTXt") { const nul = data.indexOf(0); try { out.push(data.toString("latin1", 0, nul) + inflateSync(data.subarray(nul + 2)).toString("latin1")); } catch { out.push(data.toString("latin1")); } }
    if (type === "iTXt") out.push(data.toString("utf8"));
    at += 12 + len;
  }
  return out.join("\n");
}

const tracked = () => execFileSync("git", ["ls-files", "-z", "--", ...SCANNED], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const textOf = async (file: string) => {
  const buf = await readFile(join(root, file));
  return file.endsWith(".png") ? pngText(buf) : buf.toString("utf8");
};

test("no-real-names-in-renders-or-fixtures: no committed file under scripts/, tests/, docs/ or changes/ names the company, machine or user", async () => {
  const hits: string[] = [];
  for (const file of tracked()) {
    if (GUARD.has(file)) continue;
    const found = deniedNames(await textOf(file), file);
    if (found.length) hits.push(`${file}: ${[...new Set(found)].join(", ")}`);
  }
  assert.deepEqual(hits, [], "use fictional names (acme-*); product configuration goes in ALLOWED with a reason");
});

test("no-real-names-in-renders-or-fixtures: the denylist names no machine or user in plain text", async () => {
  const src = await readFile(join(root, SELF), "utf8");
  assert.match(src, /hostname\(\)/); assert.match(src, /userInfo\(\)/);
  for (const name of machineNames({})) assert.ok(!src.toLowerCase().includes(name.toLowerCase()), `${SELF} spells this machine's ${name}`);
});

test("no-real-names-in-renders-or-fixtures: every allowed token has a reason and is still used where it's allowed", async () => {
  for (const a of ALLOWED) {
    assert.ok(a.reason.length > 10 && /Q55/.test(a.reason), `${a.token}: a reason naming the open decision`);
    for (const file of a.files) if (file !== "<render>") assert.ok((await readFile(join(root, file), "utf8")).includes(a.token), `${file} no longer uses ${a.token}: drop it from ALLOWED`);
  }
});

test("no-real-names-in-renders-or-fixtures: what counts as a real name", () => {
  const machine = machineNames({}, "build-box.internal.example", "jane_doe");
  assert.deepEqual(machine, ["build-box.internal.example", "build-box", "jane_doe"], "hostname (full and first label) and user, read at run time");
  assert.deepEqual(machineNames({ CI: "true" }, "fv-az123", "runner"), [], "a CI runner's generic names are not checked");
  assert.deepEqual(deniedNames("Workspaces: hero-project", "tests/x.test.ts", []), ["hero"]);
  assert.deepEqual(deniedNames("https://herosecurity.slack.com/x", "tests/x.test.ts", []), ["herosecurity"]);
  assert.deepEqual(deniedNames("a heroic effort, superhero, Acme", "tests/x.test.ts", []), [], "only the word, not words containing it");
  assert.deepEqual(deniedNames("served by build-box", "<render>", machine), ["build-box"]);
  assert.deepEqual(deniedNames("example/hero-poc tracks by default", "tests/project-settings.test.ts", []), [], "an allowed token, in its file");
  assert.deepEqual(deniedNames("example/hero-poc and hero/app", "tests/project-settings.test.ts", []), ["hero"], "anything else in that file still fails");
  assert.deepEqual(deniedNames("example/hero-poc", "tests/other.test.ts", []), ["hero"], "an allowed token outside its files fails");
});

test("no-real-names-in-renders-or-fixtures: a render naming the machine or company is refused", () => {
  assert.throws(() => assertNoRealNames("Home · hero-project", "shot"), /real name \(hero\)/);
  assert.doesNotThrow(() => assertNoRealNames("Home · acme-project · dev-box", "shot"));
  assert.doesNotThrow(() => assertNoRealNames("Default tracking for example/hero-poc", "shot"), "the default-tracked repo (Q55)");
});

test("no-real-names-in-renders-or-fixtures: every render path uses the shared check", async () => {
  for (const file of ["scripts/screenshots.mjs", "scripts/check-recovery-background.mjs", "scripts/check-project-settings.mjs"]) {
    const src = await readFile(join(root, file), "utf8");
    assert.match(src, /assertNoRealNames/, file);
    assert.doesNotMatch(src, /REAL_HOST/, `${file}: no private hostname-only check`);
  }
});
