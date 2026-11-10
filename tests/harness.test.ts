import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// scripts/harness.mjs: machine-wide slots shared with the harness-slot shell wrapper, and no orphaned daemons.
const helper = resolve("scripts/harness.mjs");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, label: string, ms = 10_000) => { for (const end = Date.now() + ms; !check();) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "follow-slots-"));
  const children: ChildProcess[] = [];
  t.after(async () => { for (const c of children) if (c.exitCode === null) c.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, HARNESS_SLOT_DIR: join(dir, "slots"), HARNESS_SLOTS: "1", HARNESS_SLOT: "" };
  /** A script that takes a slot, says so, then holds it until stdin closes. */
  const script = join(dir, "script.mjs");
  await writeFile(script, `import { harness, spawnTracked } from ${JSON.stringify(helper)};
const { slot } = await harness({ pollMs: 100 });
console.log("slot " + slot + " speech " + process.env.PASEO_DICTATION_ENABLED + "/" + process.env.PASEO_VOICE_MODE_ENABLED);
if (process.argv[2] === "daemon") { const d = spawnTracked("sleep", ["300"]); console.log("daemon " + d.pid); }
process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n`);
  const run = (args: string[] = [], command = process.execPath, prefix: string[] = []) => {
    const child = spawn(command, [...prefix, script, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
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
