import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// scripts/harness.mjs: machine-wide slots shared with the harness-slot shell wrapper, and no orphaned daemons.
const helper = resolve("scripts/harness.mjs");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A fake `paseo` CLI in its own directory that prints `version`. */
async function fakePaseo(dir: string, name: string, version: string) {
  const bin = join(dir, name); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "paseo"), `#!/bin/sh\necho "${version}"\n`); await chmod(join(bin, "paseo"), 0o755);
  return bin;
}
const until = async (check: () => boolean, label: string, ms = 10_000) => { for (const end = Date.now() + ms; !check();) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-slots-"));
  const children: ChildProcess[] = [];
  t.after(async () => { for (const c of children) if (c.exitCode === null) c.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, PATH: [await fakePaseo(dir, "cli", "0.15.4"), process.env.PATH].join(delimiter), HARNESS_SLOT_DIR: join(dir, "slots"), HARNESS_SLOTS: "1", HARNESS_SLOT_HELD: "", HARNESS_PASEO_CGROUP: join(dir, "no-cgroup") };
  /** A script that takes a slot, says so, then holds it until stdin closes. */
  const script = join(dir, "script.mjs");
  await writeFile(script, `import { harness, spawnTracked } from ${JSON.stringify(helper)};
const { slot } = await harness({ pollMs: 100 });
console.log("slot " + slot + " speech " + process.env.PASEO_DICTATION_ENABLED + "/" + process.env.PASEO_VOICE_MODE_ENABLED);
if (process.argv[2] === "daemon") { const d = spawnTracked("sleep", ["300"]); console.log("daemon " + d.pid); }
process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n`);
  const run = (args: string[] = [], command = process.execPath, prefix: string[] = [], extra: NodeJS.ProcessEnv = {}) => {
    const child = spawn(command, [...prefix, script, ...args], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const out = { stdout: "", stderr: "" };
    child.stdout!.on("data", d => { out.stdout += d; }); child.stderr!.on("data", d => { out.stderr += d; });
    return { child, out };
  };
  return { dir, env, run };
}

test("a second script waits for the slot with one line, then runs when the first ends; speech is off for harness daemons", async t => {
  const f = await fixture(t);
  const a = f.run(); await until(() => a.out.stdout.includes("slot 1"), "first takes the slot");
  assert.match(a.out.stdout, /speech false\/false/);
  const b = f.run(); await until(() => b.out.stderr.includes("waiting for a harness slot"), "second waits");
  await new Promise(r => setTimeout(r, 400));
  assert.equal(b.out.stdout, "", "no run while the slot is taken");
  assert.equal(b.out.stderr.match(/waiting for a harness slot/g)?.length, 1, "a single waiting line");
  a.child.stdin!.end();
  await until(() => b.out.stdout.includes("slot 1"), "second runs after the first ends");
});

test("the shell wrapper and the scripts share lock files; a script inside the wrapper's slot doesn't take another", async t => {
  const f = await fixture(t);
  await import("node:fs/promises").then(fs => fs.mkdir(f.env.HARNESS_SLOT_DIR, { recursive: true }));
  // Like harness-slot: flock holds slot1 while it runs its command.
  const wrapped = f.run([], "flock", [join(f.env.HARNESS_SLOT_DIR, "slot1"), process.execPath]);
  await until(() => wrapped.out.stdout.includes("slot null"), "runs at once inside the wrapper's slot");
  const outside = f.run(); await until(() => outside.out.stderr.includes("waiting for a harness slot"), "a script outside waits for the wrapper");
  wrapped.child.stdin!.end();
  await until(() => outside.out.stdout.includes("slot 1"), "and runs when the wrapper ends");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`${signal} (Ctrl+C, a timeout) kills the script's daemon and frees the slot`, async t => {
  const f = await fixture(t);
  const a = f.run(["daemon"]); await until(() => /daemon \d+/.test(a.out.stdout), "daemon started");
  const pid = Number(/daemon (\d+)/.exec(a.out.stdout)![1]);
  assert.ok(alive(pid));
  a.child.kill(signal);
  await until(() => a.child.exitCode !== null || a.child.signalCode !== null, "script exits");
  await until(() => !alive(pid), "daemon is gone");
  const b = f.run(); await until(() => b.out.stdout.includes("slot 1"), "slot is free");
});

test("every script that starts a Paseo daemon or a browser takes a slot, and starts daemons through spawnDaemon", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const heavy: string[] = [];
  for (const name of (await readdir("scripts")).filter(n => n.endsWith(".mjs") && n !== "harness.mjs")) {
    const source = await readFile(join("scripts", name), "utf8");
    if (!/"daemon", "run"|createPaseoDaemon\(|chromium\.launch/.test(source)) continue;
    heavy.push(name);
    assert.match(source, /from "\.\/harness\.mjs"/, `${name} imports scripts/harness.mjs`);
    assert.match(source, /^await harness\(/m, `${name} awaits harness() before its heavy work`);
    assert.doesNotMatch(source, /spawn\("paseo", \["daemon"/, `${name} starts its daemon with spawnDaemon, so it dies with the script`);
  }
  assert.ok(heavy.length >= 10, `found only ${heavy.length} harness scripts; the scan is broken`);
});

// Bug class (2026-11-12): screenshots.mjs never closed the fake GitHub server, so every run stayed alive after "done"
// and held its harness slot until an outer timeout. A script that starts a server closes it.
test("every script that starts the fake GitHub closes it, so the run exits and frees its slot", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  for (const name of (await readdir("scripts")).filter(n => n.endsWith(".mjs") && n !== "fake-github.mjs")) {
    const source = await readFile(join("scripts", name), "utf8");
    const started = /(\w+)\s*=\s*await fakeGithub\(/.exec(source);
    if (!started) continue;
    assert.match(source, new RegExp(`${started[1]}\\??\\.close\\(`), `${name} closes ${started[1]} (the fake GitHub server)`);
  }
});

test("HARNESS_SLOT_HELD runs at once, like the wrapper's re-entry; a held slot exports it to children", async t => {
  const f = await fixture(t);
  const a = f.run(); await until(() => a.out.stdout.includes("slot 1"), "first takes the only slot");
  const { spawnSync } = await import("node:child_process");
  const probe = join(f.dir, "probe.mjs");
  await writeFile(probe, `import { harness } from ${JSON.stringify(helper)};\nawait harness({ pollMs: 100 }); console.log("held " + process.env.HARNESS_SLOT_HELD);\n`);
  const reentered = spawnSync(process.execPath, [probe], { env: { ...f.env, HARNESS_SLOT_HELD: "1" }, encoding: "utf8", timeout: 5000 });
  assert.equal(reentered.stdout.trim(), "held 1", "another agent shooting against a held daemon doesn't queue");
  a.child.stdin!.end();
  await until(() => a.child.exitCode !== null, "first ends");
  const fresh = spawnSync(process.execPath, [probe], { env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(fresh.stdout.trim(), "held 1", "a script that takes a slot exports HARNESS_SLOT_HELD to what it starts");
});

test("no slot while Paseo's working set is over 75% of its cap; reclaimable cache doesn't count", async t => {
  const f = await fixture(t);
  const { mkdir } = await import("node:fs/promises");
  const cgroup = join(f.dir, "no-cgroup"); await mkdir(cgroup, { recursive: true });
  await writeFile(join(cgroup, "memory.high"), "1000\n");
  await writeFile(join(cgroup, "memory.current"), "900\n");
  await writeFile(join(cgroup, "memory.stat"), "anon 700\ninactive_file 100\nslab_reclaimable 20\n");
  const a = f.run(); await until(() => a.out.stderr.includes("waiting for a harness slot"), "waits at 78%");
  await new Promise(r => setTimeout(r, 300)); assert.equal(a.out.stdout, "");
  await writeFile(join(cgroup, "memory.stat"), "anon 600\ninactive_file 200\nslab_reclaimable 20\n");
  await until(() => a.out.stdout.includes("slot 1"), "runs at 68%, the cache being reclaimable");
});

test("a paseo CLI on PATH below the plugin's floor stops the run before it takes a slot; a good one is printed once", async t => {
  const f = await fixture(t);
  const { slotCount, paseoFloor } = await import(helper) as { slotCount: (env: object) => number; paseoFloor: () => string };
  assert.equal(slotCount({}), 2, "two slots by default, like the wrapper");
  assert.equal(paseoFloor(), "0.15.0", "the floor is paseo-plugin.json's requirements.paseo");
  const stale = await fakePaseo(f.dir, "stale", "0.7.2");
  const old = f.run([], process.execPath, [], { PATH: [stale, f.env.PATH].join(delimiter) });
  await until(() => old.child.exitCode !== null, "a stale CLI exits");
  assert.equal(old.child.exitCode, 97);
  assert.ok(old.out.stderr.includes(`wrong paseo (0.7.2 at ${join(stale, "paseo")}); need >= 0.15.0`), old.out.stderr);
  assert.equal(old.out.stdout, "", "no slot, no run");
  const beta = await fakePaseo(f.dir, "beta", "0.16.0-beta.1");
  const good = f.run([], process.execPath, [], { PATH: [beta, f.env.PATH].join(delimiter) });
  await until(() => good.out.stdout.includes("slot 1"), "a newer CLI runs");
  assert.equal(good.out.stderr.match(/^paseo /gm)?.length, 1);
  assert.ok(good.out.stderr.includes(`paseo 0.16.0-beta.1 at ${join(beta, "paseo")}\n`), good.out.stderr);
});

test("waitUntil: the deadline scales with load, so a wait sized for an idle VM survives load 30 on 8 cores", async () => {
  const { loadFactor, waitUntil } = await import(helper);
  assert.equal(loadFactor(2, 8), 1, "an idle VM keeps the base budget");
  assert.equal(loadFactor(30, 8), 3.75);
  assert.equal(loadFactor(500, 8), 6, "capped, so a broken run still ends");
  // Ready after ~120 ms: a 50 ms budget fails at factor 1 and passes at factor 4.
  const readyAt = (ms: number) => { const at = Date.now() + ms; return async () => Date.now() >= at && "ready"; };
  await assert.rejects(waitUntil("not yet", readyAt(120), { baseMs: 50, everyMs: 10, factor: () => 1 }), /not yet \(waited 0 s; budget 0 s at load factor 1\.0\)/);
  assert.equal(await waitUntil("not yet", readyAt(120), { baseMs: 50, everyMs: 10, factor: () => 4 }), "ready");
});
