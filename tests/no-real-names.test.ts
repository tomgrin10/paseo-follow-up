import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { COMPANY_HASHES, EXCLUDED, NAME_HASHES, RENDER_ALLOW, TICKET_HASHES, assertNoRealNames, deniedNames, hashWord, machineNames } from "../scripts/real-names.mjs";

/**
 * no-real-names-in-renders-or-fixtures (2026-11-13). The repo is public, and the harness fixtures named their workspace,
 * repos and chat hosts after the company, and tests carried colleagues' names and logins, a customer and real ticket
 * keys. No render and no committed file (screenshots' text included) may name the real machine, its user, the company,
 * its people, customers or tickets. The company words are stored only as hashes and
 * the machine names are read at run time (scripts/real-names.mjs), so this guard leaks nothing itself. The examples
 * below use an injected fictional denylist ("globex"), never the real words.
 */
const root = join(import.meta.dirname, "..");
const BINARY = /\.(jpe?g|gif|webp|ico|woff2?|zip|tgz)$/;
const SELF = "scripts/real-names.mjs";
const FICTIONAL = [hashWord("globex"), hashWord("globexcorp")];
const exact = (w: string) => createHash("sha256").update(w).digest("hex");

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

const tracked = () => execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(f => f && !BINARY.test(f));
const textOf = async (file: string) => {
  const buf = await readFile(join(root, file));
  return file.endsWith(".png") ? pngText(buf) : buf.toString("utf8");
};

test("no-real-names-in-renders-or-fixtures: no committed file names the company, its people, customers or tickets, the machine or its user", async () => {
  const hits: string[] = [];
  for (const file of tracked()) {
    if (Object.hasOwn(EXCLUDED, file)) continue;
    const found = deniedNames(await textOf(file));
    if (found.length) hits.push(`${file}: ${found.length} hit(s)`);
  }
  assert.deepEqual(hits, [], "use fictional names (acme-*)");
});

test("no-real-names-in-renders-or-fixtures: the denylist stores the company only as hashes, and no machine or user", async () => {
  const src = await readFile(join(root, SELF), "utf8");
  assert.match(src, /hostname\(\)/); assert.match(src, /userInfo\(\)/);
  for (const list of [COMPANY_HASHES, NAME_HASHES, TICKET_HASHES]) assert.ok(list.length > 0 && list.every(h => /^[0-9a-f]{64}$/.test(h)), "sha256 hex only");
  assert.deepEqual(deniedNames(src), [], `${SELF} spells a denied word`);
  for (const name of machineNames()) assert.ok(!src.toLowerCase().includes(name.toLowerCase()), `${SELF} spells this machine's name`);
});

test("no-real-names-in-renders-or-fixtures: every excluded path exists and names the PR that removes it", async () => {
  for (const [file, reason] of Object.entries(EXCLUDED)) {
    assert.equal(reason, "removed by the Q55 host-config PR", file);
    await readFile(join(root, file)); // a path that's gone drops off the list
  }
});

test("no-real-names-in-renders-or-fixtures: what counts as a real name", () => {
  const machine = machineNames({}, "build-box.internal.example", "jane_doe");
  assert.deepEqual(machine, ["build-box.internal.example", "build-box", "jane_doe"], "hostname (full and first label) and user, read at run time");
  assert.deepEqual(machineNames({ CI: "true" }, "fv-az123", "runner"), [], "a CI runner's generic names are not checked");
  const opts = { machine: [], hashes: FICTIONAL };
  assert.deepEqual(deniedNames("Workspaces: globex-project", opts), ["globex"], "hyphen compounds split into words");
  assert.deepEqual(deniedNames("https://GlobexCorp.slack.com/x", opts), ["globexcorp"], "dot compounds, any case");
  assert.deepEqual(deniedNames("org/globex_app", opts), ["globex"], "slash and underscore too");
  assert.deepEqual(deniedNames("globexian, superglobex, Acme", opts), [], "only the word, not words containing it");
  assert.deepEqual(deniedNames("served by build-box", { machine, hashes: FICTIONAL }), ["build-box"]);
  const people = { machine: [], hashes: [], names: [exact("Zelda")], tickets: [hashWord("glx")] };
  assert.deepEqual(deniedNames("Zelda asked twice", people), ["Zelda"], "a person's or customer's name, capitalised");
  assert.deepEqual(deniedNames("zelda-config, ZELDA", people), [], "names match only as a capitalised word");
  assert.deepEqual(deniedNames("Fix GLX-1312 and glx-7", people), ["GLX-1312", "glx-7", "GLX"], "a ticket prefix followed by digits (and its capitals)");
  assert.deepEqual(deniedNames("team GLX, key `GLX-${n}`", people), ["GLX-${", "GLX"], "a team key in capitals, and a template key");
  assert.deepEqual(deniedNames("glx team, Glx, ACME-1312, xglx-12", people), [], "lower-case words, another prefix, or inside a word");
  assert.deepEqual(deniedNames("example/globex-poc tracks by default", { ...opts, allow: ["example/globex-poc"] }), [], "an allowed run-time value");
  assert.deepEqual(deniedNames("example/globex-poc and globex/app", { ...opts, allow: ["example/globex-poc"] }), ["globex"], "anything else still fails");
});

test("no-real-names-in-renders-or-fixtures: a render naming the machine or company is refused", () => {
  for (const name of machineNames()) assert.throws(() => assertNoRealNames(`served by ${name}`, "shot"), /real name/);
  assert.doesNotThrow(() => assertNoRealNames("Home · acme-project · dev-box", "shot"));
  assert.doesNotThrow(() => assertNoRealNames(`Default tracking for ${RENDER_ALLOW[0]}`, "shot"), "the default-tracked repo, read from product code");
  assert.doesNotThrow(() => assertNoRealNames("Default tracking for acme/app", "shot", ["acme/app"]));
});

test("no-real-names-in-renders-or-fixtures: every render path uses the shared check", async () => {
  // No script keeps a private hostname-only check (a new render script copying the old pattern fails here).
  for (const file of execFileSync("git", ["ls-files", "scripts"], { cwd: root, encoding: "utf8" }).split("\n").filter(f => f.endsWith(".mjs"))) {
    assert.doesNotMatch(await readFile(join(root, file), "utf8"), /REAL_HOST/, `${file}: use assertNoRealNames`);
  }
  for (const file of ["scripts/screenshots.mjs", "scripts/check-recovery-background.mjs", "scripts/check-project-settings.mjs", "scripts/check-view-settings.mjs"]) {
    const src = await readFile(join(root, file), "utf8");
    assert.match(src, /assertNoRealNames/, file);
    assert.doesNotMatch(src, /REAL_HOST/, `${file}: no private hostname-only check`);
  }
});
