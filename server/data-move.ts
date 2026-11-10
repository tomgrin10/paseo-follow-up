import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, LEGACY_DATA_DIR, recoveryShimSource } from "../shared/legacy";

/**
 * 2.0's one-time data move: `plugin-data/<1.x dir>` is copied to `plugin-data/follow-up` by the first start that finds
 * the new directory missing. It runs synchronously at the top of contribute(), before anything writes to the new
 * directory. The copy goes to a temporary sibling and is renamed into place, so a crash leaves nothing or the whole
 * copy, and of two starters only one rename wins. A second start finds the directory and does nothing.
 *
 * The old directory is never deleted or edited: it is 1.x's backup, and what a rollback to 1.x finds. The exceptions
 * are two compatibility files, the recovery shim (below) and the heartbeat the 1.x installer watches (index.server.ts).
 */
export type DataMove = { status: "moved" | "present" | "fresh"; from?: string; to: string; waitedForOldWorker?: boolean; replaced?: string };
/** Files that belong to a live process, not to the data: never copied. */
const LIVE = new Set(["worker.lock", "worker.lock.recovery", "heartbeat.json", "update-watchdog.lock", "hooks-enabled.json"]);
export const MOVED_MARKER = "migrated-from.json";

export function dataDirs(paseoHome: string) {
  return { directory: join(paseoHome, "plugin-data", DATA_DIR), legacy: join(paseoHome, "plugin-data", LEGACY_DATA_DIR) };
}

/** The new directory is a move whose source 1.x changed afterwards (2.0 never writes 1.x's state.json). */
function staleCopy(directory: string, legacy: string): boolean {
  try {
    const copied = JSON.parse(readFileSync(join(directory, MOVED_MARKER), "utf8")).sourceStateMtime;
    return typeof copied === "number" && statSync(join(legacy, "state.json")).mtimeMs > copied;
  } catch { return false; }
}

function oldWorkerAlive(legacy: string): boolean {
  let pid = NaN;
  try { pid = Number(readFileSync(join(legacy, "worker.lock"), "utf8").split(":")[0]); } catch { return false; }
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The move disables 1.x before it installs 2.0, so the old worker is normally gone. If one still holds the old lock
 * (both ids installed by hand), wait up to `waitMs` for it; then copy anyway. Its writes are atomic per file, so the
 * copy is consistent file by file, and the two installs are the move's to sort out (server/plugin-move.ts).
 */
export function moveData(paseoHome: string, options: { version?: string; waitMs?: number } = {}): DataMove {
  const { directory, legacy } = dataDirs(paseoHome);
  let replaced: string | undefined;
  if (existsSync(directory)) {
    if (!staleCopy(directory, legacy)) return { status: "present", to: directory };
    // A 2.0 that failed its first start was rolled back to 1.x, which kept working in the old directory. That copy is
    // older than 1.x's data now: keep it as a backup and copy again.
    replaced = join(paseoHome, "plugin-data", `.${DATA_DIR}.before-${Date.now()}`);
    renameSync(directory, replaced);
  }
  if (!existsSync(legacy)) return { status: "fresh", to: directory };
  let waited = false;
  for (let left = options.waitMs ?? 10_000; left > 0 && oldWorkerAlive(legacy); left -= 250) { waited = true; pause(250); }
  mkdirSync(join(paseoHome, "plugin-data"), { recursive: true, mode: 0o700 });
  const temporary = join(paseoHome, "plugin-data", `.${DATA_DIR}.move-${process.pid}-${randomUUID()}`);
  try {
    cpSync(legacy, temporary, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, filter: source => !LIVE.has(source.slice(legacy.length + 1)) });
    let sourceStateMtime: number | null = null;
    try { sourceStateMtime = statSync(join(legacy, "state.json")).mtimeMs; } catch { /* 1.x never saved state */ }
    writeFileSync(join(temporary, MOVED_MARKER), JSON.stringify({ from: legacy, at: new Date().toISOString(), version: options.version ?? null, sourceStateMtime }), { mode: 0o600 });
    try { renameSync(temporary, directory); }
    catch (error) {
      // Another starter won the rename: its copy is the copy.
      if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return { status: "present", to: directory };
      throw error;
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  try { writeRecoveryShim(paseoHome); } catch { /* recovery agents from 1.x fall back to the hook's CLI hint */ }
  return { status: "moved", from: legacy, to: directory, ...(waited ? { waitedForOldWorker: true } : {}), ...(replaced ? { replaced } : {}) };
}

/** 1.x recovery agents run the old directory's mcp.mjs; after the move it runs the current bridge. Idempotent. */
export function writeRecoveryShim(paseoHome: string): boolean {
  const { directory, legacy } = dataDirs(paseoHome);
  const old = join(legacy, "mcp.mjs");
  if (!existsSync(old)) return false;
  const shim = recoveryShimSource(join(directory, "mcp.mjs"));
  if (readFileSync(old, "utf8") === shim) return false;
  const temporary = `${old}.${randomUUID()}`;
  writeFileSync(temporary, shim, { mode: 0o600 });
  renameSync(temporary, old);
  return true;
}

/**
 * The 1.x installer (#61) reads heartbeat.json in the old directory during probation; without this a good update to
 * 2.0 is rolled back after two minutes. Written only while the old directory exists. Can go in the release after 2.0.0.
 */
export function writeLegacyHeartbeat(paseoHome: string, body: string): void {
  const { legacy } = dataDirs(paseoHome);
  if (!existsSync(legacy)) return;
  const temporary = join(legacy, `heartbeat.json.${randomUUID()}`);
  writeFileSync(temporary, body, { mode: 0o600 });
  renameSync(temporary, join(legacy, "heartbeat.json"));
}
