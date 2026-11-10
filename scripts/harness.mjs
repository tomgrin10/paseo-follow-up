// Machine-wide harness slots and daemon cleanup for every script that starts a Paseo daemon or a browser.
//
// The VM is shared by many agents, so at most HARNESS_SLOTS (default 2) heavy runs go at once. A slot is a flock on
// /tmp/paseo-harness-slots/slotN, the same files the shared harness-slot shell wrapper uses, so the shell wrapper and
// these scripts share slots. A script already inside a slot (under the wrapper, or started by a script holding one)
// doesn't take a second, so nested runs never deadlock. The lock is held by a `flock … cat` child reading a pipe
// from this process: it's released when the script ends, however it ends.
//
// Daemons started through spawnDaemon run in their own process group, which is killed when the script exits,
// including on SIGINT, SIGTERM and SIGHUP (a CI or `timeout` kill), so no daemon or plugin process outlives the run.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const slotDirectory = (env = process.env) => env.HARNESS_SLOT_DIR || "/tmp/paseo-harness-slots";
export const slotCount = (env = process.env) => { const n = Number(env.HARNESS_SLOTS); return Number.isInteger(n) && n > 0 ? n : 2; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** This process or an ancestor has a slot file open: the shell wrapper keeps the locked fd open while it runs us. */
export function insideSlot(directory = slotDirectory()) {
  if (process.env.HARNESS_SLOT) return true;
  for (let pid = process.pid, hops = 0; pid > 1 && hops < 64; hops++) {
    try { for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { if (readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith(`${directory}/slot`)) return true; } catch { /* closed meanwhile */ } } } catch { /* not ours to read */ }
    try { pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1]); } catch { break; }
  }
  return false;
}

/** flock runs `cat` only once it holds the lock, so a line echoed back through cat means the slot is ours. */
function tryLock(path) {
  return new Promise(resolve => {
    const holder = spawn("flock", ["--nonblock", path, "cat"], { stdio: ["pipe", "pipe", "ignore"] });
    const done = value => { holder.stdout.removeAllListeners("data"); resolve(value); };
    holder.stdout.once("data", () => {
      holder.stdout.resume(); holder.stdout.unref?.(); holder.stdin.unref?.(); holder.unref();
      done(holder);
    });
    holder.once("exit", () => done(null));
    holder.once("error", () => done(null));
    holder.stdin.on("error", () => undefined); // busy: flock exits without reading
    holder.stdin.write("held\n");
  });
}

let held = null;
/**
 * Waits for a harness slot (one "waiting for a harness slot" line while all are busy) and sets the harness env: local
 * speech off, so isolated daemons don't download and unpack a speech model on every run. Call once, at the top.
 */
export async function harness({ log = line => console.error(line), pollMs = 5_000 } = {}) {
  process.env.PASEO_DICTATION_ENABLED = "false";
  process.env.PASEO_VOICE_MODE_ENABLED = "false";
  const directory = slotDirectory();
  if (held || insideSlot(directory)) return { slot: held?.slot ?? null };
  mkdirSync(directory, { recursive: true });
  for (let waited = false; ;) {
    for (let slot = 1; slot <= slotCount(); slot++) {
      const holder = await tryLock(join(directory, `slot${slot}`));
      if (holder) { held = { slot, holder }; process.env.HARNESS_SLOT = String(slot); return { slot }; }
    }
    if (!waited) { log("waiting for a harness slot"); waited = true; }
    await sleep(pollMs);
  }
}

const groups = new Set();
const cleanups = new Set();
/** Runs `work` before the process ends on a signal (e.g. an in-process daemon's stop), at most 10 s. */
export function onShutdown(work) { cleanups.add(work); return () => cleanups.delete(work); }
const killGroups = signal => { for (const pid of groups) { try { process.kill(-pid, signal); } catch { groups.delete(pid); } } };

/** spawn() in its own process group, killed with the script. */
export function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true });
  if (child.pid) { groups.add(child.pid); child.once("exit", () => { try { process.kill(-child.pid, 0); } catch { groups.delete(child.pid); } }); }
  return child;
}
/** `paseo …` (normally `daemon run --home <isolated home>`), killed with the script. */
export const spawnDaemon = (args, options) => spawnTracked("paseo", args, options);

process.once("exit", () => killGroups("SIGTERM"));
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.once(signal, () => {
  void (async () => {
    await Promise.race([Promise.allSettled([...cleanups].map(work => work())), sleep(10_000)]);
    killGroups("SIGTERM");
    for (let i = 0; i < 20 && groups.size; i++) { await sleep(250); killGroups(0); }
    killGroups("SIGKILL");
    process.exit(code);
  })();
});
