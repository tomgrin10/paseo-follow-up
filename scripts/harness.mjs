// Machine-wide harness slots and daemon cleanup for every script that starts a Paseo daemon or a browser.
//
// The VM is shared by many agents, so at most HARNESS_SLOTS (default 2) heavy runs go at once, and none starts while
// Paseo's working set is above 75% of its memory cap. A slot is a flock on /tmp/paseo-harness-slots/slotN, the same
// files the harness-slot shell wrapper uses, so the wrapper and these scripts share slots. Like the wrapper, a held
// slot exports HARNESS_SLOT_HELD; a script that already has it (under the wrapper, started by a script holding one, or
// shooting against another agent's held daemon with HARNESS_SLOT_HELD=1) runs at once, so nested runs never queue
// behind themselves. The lock is held by a `flock … cat` child reading a pipe from this process: it's released when
// the script ends, however it ends. Before taking a slot it checks the `paseo` CLI on PATH against the plugin's floor
// (paseo-plugin.json requirements.paseo) and refuses a stale one, instead of failing later on an unknown option.
//
// Daemons started through spawnDaemon run in their own process group, which is killed when the script exits,
// including on SIGINT, SIGTERM and SIGHUP (a CI or `timeout` kill), so no daemon or plugin process outlives the run.
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

export const slotDirectory = (env = process.env) => env.HARNESS_SLOT_DIR || "/tmp/paseo-harness-slots";
export const slotCount = (env = process.env) => { const n = Number(env.HARNESS_SLOTS); return Number.isInteger(n) && n > 0 ? n : 2; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** This process or an ancestor has a slot file open: the shell wrapper keeps the locked fd open while it runs us. */
export function insideSlot(directory = slotDirectory()) {
  if (process.env.HARNESS_SLOT_HELD) return true;
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

/**
 * Paseo's working set (memory.current minus inactive_file and slab_reclaimable) over 75% of its cap (memory.high, else
 * memory.max): a new harness daemon would push it toward the OOM line, so waiting is right. Unreadable means no gate.
 */
export function memoryBusy(cgroup = process.env.HARNESS_PASEO_CGROUP || "/sys/fs/cgroup/system.slice/paseo.service") {
  const read = name => { try { return readFileSync(join(cgroup, name), "utf8"); } catch { return null; } };
  const bytes = text => { const n = Number(text?.trim()); return Number.isFinite(n) && n > 0 ? n : null; };
  const current = bytes(read("memory.current")); const cap = bytes(read("memory.high")) ?? bytes(read("memory.max"));
  if (!current || !cap) return false;
  const stat = read("memory.stat") ?? "";
  const field = name => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(stat)?.[1] ?? 0);
  return current - field("inactive_file") - field("slab_reclaimable") > cap * 0.75;
}

const triple = text => /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "")?.slice(1).map(Number) ?? null;
const below = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
/** The lowest Paseo the plugin supports: requirements.paseo in paseo-plugin.json (">=0.14.0"). */
export const paseoFloor = () => JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8")).requirements.paseo.replace(/^\D+/, "");
/** The first executable `paseo` on PATH, or null. */
export function whichPaseo(path = process.env.PATH ?? "") {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const file = join(dir, "paseo");
    try { accessSync(file, constants.X_OK); return file; } catch { /* next */ }
  }
  return null;
}
/**
 * Prints `paseo X at /path` and throws when that CLI is below the plugin's floor: a stale CLI earlier on PATH otherwise
 * fails deep in a run, as an unknown option. No CLI is fine here: browser-only scripts don't need one.
 */
export function checkPaseo({ log = line => console.error(line) } = {}) {
  const file = whichPaseo();
  if (!file) return null;
  let version = null;
  try { version = execFileSync(file, ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }).match(/\d+\.\d+\.\d+\S*/)?.[0] ?? null; } catch { /* reported below */ }
  const floor = paseoFloor();
  if (!version || below(triple(version), triple(floor))) throw new Error(`wrong paseo (${version ?? "unknown version"} at ${file}); need >= ${floor}. Put a newer paseo first on PATH.`);
  log(`paseo ${version} at ${file}`);
  return { file, version };
}

let held = null;
/**
 * Waits for a harness slot (one "waiting for a harness slot" line while all are busy) and sets the harness env: local
 * speech off, so isolated daemons don't download and unpack a speech model on every run. Before waiting, it exits
 * (97, like the wrapper) when the paseo CLI on PATH is below the plugin's floor (checkPaseo). Call once, at the top.
 * Like the wrapper, a run already inside a slot skips the CLI check and the wait: whoever took the slot checked.
 */
export async function harness({ log = line => console.error(line), pollMs = 5_000 } = {}) {
  process.env.PASEO_DICTATION_ENABLED = "false";
  process.env.PASEO_VOICE_MODE_ENABLED = "false";
  const directory = slotDirectory();
  if (held || insideSlot(directory)) return { slot: held?.slot ?? null };
  try { checkPaseo({ log }); } catch (error) { log(error.message); process.exit(97); }
  mkdirSync(directory, { recursive: true });
  for (let waited = false; ;) {
    if (!memoryBusy()) for (let slot = 1; slot <= slotCount(); slot++) {
      const holder = await tryLock(join(directory, `slot${slot}`));
      if (holder) { held = { slot, holder }; process.env.HARNESS_SLOT_HELD = String(slot); return { slot }; }
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
