import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater, type InstallJob } from "../server/updater";
import { EMPTY_SNAPSHOT, type CheckReason, type RegistrySnapshot } from "../server/update-registry";
import { integrityHex, judgeStatement, checkProvenance } from "../server/update-provenance";
import { run } from "../server/update-watchdog.mjs";
import type { UpdatesFile } from "../server/updates";
import type { Busy } from "../shared/update-policy";
import type { Provenance } from "../server/update-provenance";
import { announcesUpdate } from "../shared/changelog";

const INTEGRITY = "sha512-kM/c8bZm2HxcQQMwaiSMYCyjq+HTquHiLEbam/EyTedfZ9H+os1VcSNtQecqKxvKA/LyO+rOzm8ShRSOSy/QVQ==";
const HEX = "90cfdcf1b666d87c5c4103306a248c602ca3abe1d3aae1e22c46da9bf1324de75f67d1fea2cd5571236d41e72a2b1bca03f2f23beacece6f1285148e4b2fd055";

async function rig(o: { file?: UpdatesFile; installed?: string; tags?: Record<string, string>; versions?: string[]; trust?: (v: string) => Provenance; busy?: Busy[]; kind?: "npm" | "git" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "updater-"));
  let file: UpdatesFile = o.file ?? {};
  let now = 1_000_000_000_000;
  const requests: CheckReason[] = [];
  const spawned: InstallJob[] = [];
  const provenanceAsked: string[] = [];
  let busy = o.busy ?? [];
  let alive = false;
  const timers: { fn: () => void; at: number }[] = [];
  const published: RegistrySnapshot = { ...EMPTY_SNAPSHOT, etag: "x", checkedAt: now, okAt: now, tags: o.tags ?? { latest: "1.0.1", beta: "1.4.0-beta.24" }, versions: o.versions ?? ["1.0.1", "1.4.0-beta.23", "1.4.0-beta.24"] };
  let snap: RegistrySnapshot = EMPTY_SNAPSHOT;
  const updater = new Updater({
    directory,
    read: async () => file, write: async next => { file = next; },
    self: async () => ({ path: "/x", version: o.installed ?? "1.4.0-beta.23", installKind: o.kind ?? "npm", status: "running", error: null }),
    registry: { check: async reason => { requests.push(reason); snap = { ...published, checkedAt: now, okAt: now }; return snap; }, snapshot: async () => snap },
    provenance: async v => { provenanceAsked.push(v); return o.trust?.(v) ?? { ok: true, version: v, integrity: INTEGRITY, tarball: `https://r/${v}.tgz`, workflow: "w@t", publishedAt: null }; },
    busy: async () => busy,
    spawn: async job => { if (alive) return false; spawned.push(job); alive = true; return true; },
    installerAlive: async () => alive,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: h => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    updater, directory, requests, spawned, provenanceAsked, get file() { return file; },
    setBusy(b: Busy[]) { busy = b; }, setAlive(a: boolean) { alive = a; },
    advance(ms: number) { now += ms; for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); } },
    get now() { return now; },
    log: (event: Record<string, unknown>) => appendFile(join(directory, "updates.jsonl"), `${JSON.stringify({ at: now, from: "1.4.0-beta.23", to: "1.4.0-beta.24", ...event })}\n`),
  };
}

test("Off: no scheduled or Settings checks; Check now still asks npm", async () => {
  const r = await rig({ file: { mode: "off" } });
  await r.updater.start();
  await r.updater.check("settings");
  await r.updater.check("scheduled");
  assert.deepEqual(r.requests, []);
  await r.updater.check("manual");
  assert.deepEqual(r.requests, ["manual"]);
  const view = await r.updater.view();
  assert.equal(view.phase.kind, "available");
  assert.equal(view.nextCheckAt, null);
  assert.equal(view.notice, null, "Off shows no Home notice");
  assert.deepEqual(r.spawned, []);
  r.updater.stop();
});

test("Tell me: a newer beta is available in Settings only, with no Home notice; nothing installs", async () => {
  const r = await rig({ file: { mode: "notify" } });
  await r.updater.check("manual");
  const view = await r.updater.view();
  assert.deepEqual(view.phase, { kind: "available", version: "1.4.0-beta.24", publishedAt: null });
  assert.equal(view.notice, null, "a beta is not a major: Settings → General shows it, Home doesn't");
  assert.deepEqual(view.channels, { stable: "1.0.1", beta: "1.4.0-beta.24" });
  assert.deepEqual(r.spawned, []);
});

test("Tell me: a new major gets a Home notice until dismissed", async () => {
  const r = await rig({ file: { mode: "notify" }, tags: { latest: "2.0.0", beta: "2.0.0" }, versions: ["1.4.0-beta.23", "2.0.0"] });
  await r.updater.check("manual");
  assert.deepEqual((await r.updater.view()).notice, { id: "available:2.0.0", kind: "available", version: "2.0.0", from: null });
  await r.updater.dismiss("available:2.0.0");
  assert.equal((await r.updater.view()).notice, null);
  assert.deepEqual(r.spawned, []);
});

test("grid (update-announcements-major-only): an available update has a Home notice only when announcesUpdate says so", async () => {
  const cases: [string, string][] = [["1.4.0-beta.23", "1.4.0-beta.24"], ["1.4.0-beta.23", "1.4.0"], ["1.4.0", "1.4.1"], ["1.4.0", "1.5.0"],
    ["1.4.0", "2.0.0-beta.0"], ["2.0.0-beta.0", "2.0.0"], ["1.4.0-beta.23", "2.0.0"], ["2.0.0", "2.1.0-beta.0"], ["2.0.0", "3.0.0"]];
  for (const [installed, offered] of cases) {
    const r = await rig({ file: { mode: "notify", channel: "beta" }, installed, tags: { latest: offered, beta: offered }, versions: [installed, offered] });
    await r.updater.check("manual");
    const view = await r.updater.view();
    assert.equal(view.phase.kind, "available", `${installed} -> ${offered}`);
    assert.equal(view.notice != null, announcesUpdate(installed, offered), `${installed} -> ${offered}`);
  }
});

test("Stable on a beta: the older stable is never offered", async () => {
  const r = await rig({ file: { mode: "auto", channel: "stable" } });
  await r.updater.check("manual");
  assert.equal((await r.updater.view()).phase.kind, "current");
  assert.deepEqual(r.spawned, []);
});

test("Automatic: waits while an agent is mid-turn, then five quiet minutes, then installs the checked artifact", async () => {
  const r = await rig({ file: { mode: "auto" }, busy: [{ kind: "agent", count: 2 }] });
  await r.updater.check("manual");
  let view = await r.updater.view();
  assert.equal(view.phase.kind, "waiting");
  assert.equal(view.phase.kind === "waiting" && view.phase.busy, "2 agents are mid-turn");
  assert.deepEqual(r.spawned, []);
  r.setBusy([]);
  r.updater.activity();
  await new Promise(res => setTimeout(res, 10));
  view = await r.updater.view();
  assert.equal(view.phase.kind === "waiting" && view.phase.busy, null);
  assert.deepEqual(r.spawned, []);
  r.advance(5 * 60_000);
  await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(r.spawned, [{ from: "1.4.0-beta.23", to: "1.4.0-beta.24", integrity: INTEGRITY, tarball: "https://r/1.4.0-beta.24.tgz" }]);
  assert.equal(r.file.ready, undefined);
});

test("Install now: installs at once when nothing runs; waits when busy unless anyway", async () => {
  const r = await rig({ file: { mode: "notify" }, busy: [{ kind: "ranker" }] });
  await r.updater.check("manual");
  await r.updater.install("1.4.0-beta.24");
  assert.deepEqual(r.spawned, []);
  const view = await r.updater.view();
  assert.equal(view.phase.kind, "waiting");
  await r.updater.install("1.4.0-beta.24", true);
  assert.equal(r.spawned.length, 1);
  await assert.rejects(r.updater.install("1.4.0-beta.24", true), /already being installed/);
});

test("Provenance that fails: untrusted, never installed, not even by Install now; checked once", async () => {
  const r = await rig({ file: { mode: "auto" }, trust: v => ({ ok: false, version: v, reason: "It was built from github.com/someone/else, not github.com/tomgrin10/paseo-follow-up.", retry: false }) });
  await r.updater.check("manual");
  const view = await r.updater.view();
  assert.equal(view.phase.kind, "untrusted");
  await assert.rejects(r.updater.install("1.4.0-beta.24", true), /Not installing 1.4.0-beta.24: It was built from/);
  await r.updater.evaluate();
  assert.deepEqual(r.spawned, []);
  assert.deepEqual(r.provenanceAsked, ["1.4.0-beta.24"]);
});

test("Rolled back: shown with a notice, and never retried automatically", async () => {
  const r = await rig({ file: { mode: "auto" } });
  await r.log({ event: "installing" });
  await r.log({ event: "applied" });
  await r.log({ event: "rolling-back", reason: "It failed to load: boom" });
  await r.log({ event: "rolled-back", reason: "It failed to load: boom" });
  await r.updater.check("manual");
  r.advance(10 * 60_000);
  await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(r.spawned, []);
  const view = await r.updater.view();
  assert.equal(view.phase.kind, "rolled-back");
  assert.equal(view.notice?.kind, "rolled-back");
  assert.equal(view.history[0]?.result, "rolled-back");
  assert.equal(view.history[0]?.reason, "It failed to load: boom");
});

test("While the installer runs: installing, then settling after apply; updated afterwards", async () => {
  const r = await rig({ installed: "1.4.0-beta.24", file: { mode: "auto" } });
  r.setAlive(true);
  await r.log({ event: "installing" });
  assert.equal((await r.updater.view()).phase.kind, "installing");
  await r.log({ event: "applied" });
  const settling = (await r.updater.view()).phase;
  assert.equal(settling.kind, "settling");
  r.setAlive(false);
  await r.log({ event: "updated" });
  const view = await r.updater.view();
  assert.deepEqual(view.phase, { kind: "updated", version: "1.4.0-beta.24", from: "1.4.0-beta.23", at: r.now });
  assert.equal(view.history[0]?.result, "updated");
});

test("An installer that died mid-way reads as failed", async () => {
  const r = await rig({ file: { mode: "notify" } });
  await r.log({ event: "installing" });
  const view = await r.updater.view();
  assert.equal(view.phase.kind, "install-failed");
});

test("A checkout can't update itself: no checks, no installs", async () => {
  const r = await rig({ kind: "git", file: { mode: "auto" } });
  await r.updater.check("manual");
  assert.deepEqual(r.requests, []);
  await assert.rejects(r.updater.install("1.4.0-beta.24"), /isn't installed from npm/);
});

test("provenance: the statement must be for this file, built by this repository", () => {
  assert.equal(integrityHex(INTEGRITY), HEX);
  const statement = (repo: string, digest = HEX) => ({ subject: [{ name: "pkg:npm/paseo-follow-up@1.4.0-beta.22", digest: { sha512: digest } }], predicate: { buildDefinition: { externalParameters: { workflow: { repository: repo } } } } });
  const input = { name: "paseo-follow-up", version: "1.4.0-beta.22", integrity: INTEGRITY };
  assert.equal(judgeStatement(statement("https://github.com/tomgrin10/paseo-follow-up"), input), null);
  assert.match(judgeStatement(statement("https://github.com/someone/fork"), input)!, /built from github.com\/someone\/fork/);
  assert.match(judgeStatement(statement("https://github.com/tomgrin10/paseo-follow-up", "00"), input)!, /different file/);
  assert.match(judgeStatement(statement("https://github.com/tomgrin10/paseo-follow-up"), { ...input, version: "1.4.0-beta.23" })!, /different package or version/);
});

test("provenance: reads the version's dist and its SLSA attestation; no attestation is untrusted", async () => {
  const payload = Buffer.from(JSON.stringify({ subject: [{ name: "pkg:npm/paseo-follow-up@2.0.0", digest: { sha512: HEX } }], predicate: { buildDefinition: { externalParameters: { workflow: { repository: "https://github.com/tomgrin10/paseo-follow-up", path: ".github/workflows/publish-npm.yml", ref: "refs/tags/v2.0.0" } } } } })).toString("base64");
  const respond = (body: unknown, status = 200) => ({ status, headers: { get: () => null }, json: async () => body });
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    if (url.endsWith("/paseo-follow-up/2.0.0")) return respond({ dist: { integrity: INTEGRITY, tarball: "https://r/t.tgz", attestations: { url: "https://r/att" } } });
    if (url.endsWith("/paseo-follow-up/2.0.1")) return respond({ dist: { integrity: INTEGRITY, tarball: "https://r/t.tgz" } });
    if (url === "https://r/att") return respond({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload } } }] });
    return respond({}, 404);
  };
  const ok = await checkProvenance({ fetch, registry: "https://r/", name: "paseo-follow-up", version: "2.0.0" });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.workflow, ".github/workflows/publish-npm.yml@refs/tags/v2.0.0");
  const bare = await checkProvenance({ fetch, registry: "https://r/", name: "paseo-follow-up", version: "2.0.1" });
  assert.deepEqual(bare, { ok: false, version: "2.0.1", reason: "It was published without provenance.", retry: false });
});

function fakeDaemon(o: { failNew?: boolean; serve?: string }) {
  const calls: string[] = [];
  let installed = "1.4.0-beta.23";
  const client = {
    previewPluginUpdates: async ({ target }: { target: { version: string } }) => {
      calls.push(`preview ${target.version}`);
      return [{ id: "follow-through", outcome: "update", links: [], proposal: { id: "follow-through", expected: {}, target: { kind: "npm", version: target.version, integrity: o.serve ?? INTEGRITY, resolved: `https://r/${target.version}.tgz` } } }];
    },
    applyPluginUpdates: async ([p]: { target: { version: string } }[]) => { calls.push(`apply ${p!.target.version}`); installed = p!.target.version; return [{ id: "follow-through", outcome: "updated" }]; },
    listPlugins: async () => [{ id: "follow-through", status: o.failNew && installed !== "1.4.0-beta.23" ? "failed" : "running", error: o.failNew && installed !== "1.4.0-beta.23" ? "SyntaxError" : undefined, installation: { currentRevision: installed } }],
    close: async () => undefined,
  };
  return { client, calls };
}

test("watchdog: applies the checked artifact, keeps it once probation passes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-"));
  const { client, calls } = fakeDaemon({});
  let now = 1_000;
  const job = { directory, pluginId: "follow-through", from: "1.4.0-beta.23", to: "1.4.0-beta.24", integrity: INTEGRITY, tarball: "https://r/1.4.0-beta.24.tgz", clientEntry: "", daemon: {} };
  const result = await run(job, { connect: async () => client, now: () => now, sleep: async ms => { now += ms; if (now < 30_000) await writeFile(join(directory, "heartbeat.json"), JSON.stringify({ version: "1.4.0-beta.24", at: now, error: null })); } });
  assert.equal(result, "updated");
  assert.deepEqual(calls, ["preview 1.4.0-beta.24", "apply 1.4.0-beta.24"]);
  const events = (await readFile(join(directory, "updates.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l).event);
  assert.deepEqual(events, ["installing", "applied", "updated"]);
});

test("watchdog: a version that fails to load is rolled back to the old one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-"));
  const { client, calls } = fakeDaemon({ failNew: true });
  let now = 1_000;
  const job = { directory, pluginId: "follow-through", from: "1.4.0-beta.23", to: "1.4.0-beta.24", integrity: INTEGRITY, tarball: "https://r/1.4.0-beta.24.tgz", clientEntry: "", daemon: {} };
  const result = await run(job, { connect: async () => client, now: () => now, sleep: async ms => { now += ms; } });
  assert.equal(result, "rolled-back");
  assert.deepEqual(calls, ["preview 1.4.0-beta.24", "apply 1.4.0-beta.24", "preview 1.4.0-beta.23", "apply 1.4.0-beta.23"]);
  const last = (await readFile(join(directory, "updates.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l)).pop();
  assert.equal(last.event, "rolled-back");
  assert.equal(last.reason, "It failed to load: SyntaxError");
});

test("watchdog: a different artifact than the one checked is never applied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-"));
  const { client, calls } = fakeDaemon({ serve: "sha512-AAAA" });
  const job = { directory, pluginId: "follow-through", from: "1.4.0-beta.23", to: "1.4.0-beta.24", integrity: INTEGRITY, tarball: "https://r/1.4.0-beta.24.tgz", clientEntry: "", daemon: {} };
  assert.equal(await run(job, { connect: async () => client, sleep: async () => undefined }), "failed");
  assert.deepEqual(calls, ["preview 1.4.0-beta.24"]);
});

test("General's phone line: up to date with the version, or what's going on", async () => {
  const { generalSummary } = await import("../shared/updates");
  const v = { version: "1.4.0-beta.24", installKind: "npm" as const };
  assert.equal(generalSummary({ ...v, phase: { kind: "current" } }), "Up to date · 1.4.0-beta.24");
  assert.equal(generalSummary({ ...v, phase: { kind: "available", version: "1.4.0-beta.25", publishedAt: null } }), "Update available · 1.4.0-beta.25");
  assert.equal(generalSummary({ ...v, phase: { kind: "rolled-back", version: "1.4.0-beta.25", from: "1.4.0-beta.24", reason: "x", at: 0 } }), "Update to 1.4.0-beta.25 rolled back");
  assert.equal(generalSummary({ ...v, installKind: "git", phase: { kind: "current" } }), "Follow-up 1.4.0-beta.24 · managed by your checkout");
});

test("pending notes: read from the new version's verified tarball, only versions after the installed one", async () => {
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { mkdir } = await import("node:fs/promises");
  const { tarballChangelog } = await import("../server/update-provenance");
  const dir = await mkdtemp(join(tmpdir(), "tarball-"));
  await mkdir(join(dir, "package"));
  await writeFile(join(dir, "package/package.json"), "{}");
  await writeFile(join(dir, "package/CHANGELOG.md"), "# Changelog\n\n## 1.4.0-beta.24 (2026-11-11)\n\n- New thing.\n\n## 1.4.0-beta.23 (2026-11-10)\n\n- Old thing.\n");
  execFileSync("tar", ["-czf", join(dir, "t.tgz"), "-C", dir, "package"]);
  const bytes = await readFile(join(dir, "t.tgz"));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const fetch = async () => ({ status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer });
  const text = await tarballChangelog({ fetch, tarball: "https://r/t.tgz", integrity });
  assert.match(text!, /New thing/);
  assert.equal(await tarballChangelog({ fetch, tarball: "https://r/t.tgz", integrity: "sha512-AAAA" }), null, "a different file is never read");
  const r = await rig({ file: { mode: "notify" } });
  (r.updater as unknown as { d: { changelog: () => Promise<string> } }).d.changelog = async () => text!;
  await r.updater.check("manual");
  const view = await r.updater.view();
  assert.deepEqual(view.pendingNotes.map(n => n.version), ["1.4.0-beta.24"]);
  assert.deepEqual(view.pendingNotes[0]!.items, ["New thing."]);
});

test("status copy: a reason without a full stop never runs into the next sentence; settling says the next minute", async () => {
  const { statusCopy } = await import("../shared/updates");
  const view = { version: "1.4.0-beta.24", installKind: "npm" as const, mode: "auto" as const, channel: "beta" as const, channels: { stable: null, beta: null }, checkedAt: 0, nextCheckAt: null, registryError: null, pendingNotes: [], history: [], notice: null };
  const rolled = statusCopy({ ...view, phase: { kind: "rolled-back", version: "1.4.0-beta.25", from: "1.4.0-beta.24", reason: "It reported an error: couldn't open its saved state", at: 0 } }, 0);
  assert.match(rolled.detail, /saved state\. You're on 1\.4\.0-beta\.24 again\./);
  const failed = statusCopy({ ...view, phase: { kind: "install-failed", version: "1.4.0-beta.25", reason: "Paseo couldn't install it.", at: 0 } }, 0);
  assert.match(failed.detail, /install it\. Nothing changed\./);
  const settling = statusCopy({ ...view, phase: { kind: "settling", version: "1.4.0-beta.25", from: "1.4.0-beta.24", at: 0, until: 60_000 } }, 0);
  assert.match(settling.detail, /If it fails within the next minute,/);
});
