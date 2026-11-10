// Follow-up's installer and watchdog (1.4.0-beta.24). Written to plugin-data/follow-through/update-watchdog.mjs and run
// detached, because installing reloads Follow-up: the worker that asked for the update stops while this keeps going.
//
// It asks Paseo for the reviewed version (the integrity Follow-up checked must match), applies it, then watches the
// new version for ten minutes: Paseo's plugin list (status and error) and the new worker's heartbeat.json. If the new
// version fails to load, reports an error, or never reports in, it installs the old version again the same way.
// Every step goes to updates.jsonl, which Settings → General reads. Plain JavaScript with no dependencies besides
// Paseo's own daemon client (its path comes from the worker), so it runs whichever Follow-up version is installed.
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** How long after an update a new version must run cleanly before it counts as good (shared/update-policy.ts too). */
export const PROBATION_MS = 10 * 60_000;
/** How long the new version has to report in at all. */
export const LOAD_TIMEOUT_MS = 2 * 60_000;
/** How often the watchdog looks while on probation: one plugin list and one small file read. */
export const WATCH_EVERY_MS = 15_000;

/**
 * Whether the update stuck. Rolls back when Paseo reports the plugin failed, when the new version reports an error
 * during probation, or when it never reports in. A disabled plugin is the developer's choice: no rollback.
 * @param {{ now: number; appliedAt: number; to: string; plugin: { status: "running" | "disabled" | "failed" | "missing"; version: string | null; error: string | null }; heartbeat: { version: string; at: number; error: string | null } | null }} input
 * @returns {{ verdict: "wait" } | { verdict: "ok" } | { verdict: "rollback"; reason: string }}
 */
export function probation({ now, appliedAt, to, plugin, heartbeat, probationMs = PROBATION_MS, loadTimeoutMs = LOAD_TIMEOUT_MS }) {
  const elapsed = now - appliedAt;
  if (plugin.status === "disabled") return { verdict: "ok" };
  if (plugin.status === "failed") return { verdict: "rollback", reason: plugin.error ? `It failed to load: ${plugin.error}` : "It failed to load." };
  if (plugin.status === "missing") return { verdict: "rollback", reason: "Paseo no longer lists Follow-up." };
  if (plugin.version && plugin.version !== to) return { verdict: "rollback", reason: `Paseo still runs ${plugin.version}.` };
  const mine = heartbeat && heartbeat.version === to && heartbeat.at >= appliedAt ? heartbeat : null;
  if (mine?.error) return { verdict: "rollback", reason: `It reported an error: ${mine.error}` };
  if (!mine) return elapsed >= loadTimeoutMs ? { verdict: "rollback", reason: "It didn't start within two minutes." } : { verdict: "wait" };
  return elapsed >= probationMs ? { verdict: "ok" } : { verdict: "wait" };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clip = (text, n = 300) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * One install. `job`: { directory, pluginId, from, to, integrity, tarball, clientEntry, daemon, rollbackOnly? }.
 * `job.timing` ({ probationMs, loadTimeoutMs, watchEveryMs }) shortens the watch for the isolated update harness only.
 * `io` is injectable for tests: { connect(), now(), sleep(ms) }.
 */
export async function run(job, io = {}) {
  const now = io.now ?? Date.now;
  const timing = job.timing ?? {};
  const wait = io.sleep ?? sleep;
  const log = event => appendFile(join(job.directory, "updates.jsonl"), `${JSON.stringify({ at: now(), from: job.from, to: job.to, ...event })}\n`, { mode: 0o600 });
  const connect = io.connect ?? (async () => {
    const { DaemonClient } = createRequire(import.meta.url)(job.clientEntry);
    const client = new DaemonClient({ ...job.daemon, clientId: "follow-through-updater" });
    await client.connect();
    return client;
  });
  let client = null;
  const daemon = async () => {
    if (client) return client;
    client = await connect();
    return client;
  };
  const drop = async () => { const c = client; client = null; await c?.close?.().catch?.(() => undefined); };
  /** preview + apply to `version`; `expect` pins the reviewed artifact. Returns null or the reason it failed. */
  const install = async (version, expect) => {
    const c = await daemon();
    const previews = await c.previewPluginUpdates({ pluginId: job.pluginId, target: { kind: "npm", version } });
    const preview = previews.find(p => p.id === job.pluginId);
    if (!preview) return "Paseo doesn't list Follow-up.";
    if (preview.outcome === "error") return clip(preview.error) || "Paseo couldn't prepare it.";
    if (preview.outcome === "current") return null;
    if (preview.outcome !== "update" || !preview.proposal) return `Paseo can't update this install (${preview.outcome}).`;
    const target = preview.proposal.target;
    if (expect && (target.kind !== "npm" || target.integrity !== expect.integrity || target.resolved !== expect.tarball)) return "npm now serves a different file than the one Follow-up checked.";
    const [result] = await c.applyPluginUpdates([preview.proposal]);
    if (!result || result.outcome !== "updated") return clip(result?.error) || "Paseo couldn't install it.";
    return null;
  };
  const observe = async () => {
    let plugin;
    try {
      const rows = await (await daemon()).listPlugins();
      const row = rows.find(p => p.id === job.pluginId);
      plugin = row ? { status: row.status, version: row.installation?.currentRevision ?? null, error: row.error ?? null } : { status: "missing", version: null, error: null };
    } catch {
      await drop();
      return null; // the daemon is busy reloading: look again next round
    }
    const heartbeat = await readFile(join(job.directory, "heartbeat.json"), "utf8").then(JSON.parse, () => null);
    return { plugin, heartbeat };
  };
  const rollback = async reason => {
    await log({ event: "rolling-back", reason });
    let failed = null;
    try { failed = await install(job.from, null); } catch (e) { failed = clip(e?.message ?? e); await drop(); }
    if (failed) await log({ event: "rollback-failed", reason: `${reason} Going back to ${job.from} failed too: ${failed}` });
    else await log({ event: "rolled-back", reason });
  };

  try {
    await log({ event: "installing", pid: process.pid });
    // The new worker can report in before apply returns, so probation counts from before the install started.
    const appliedAt = now();
    let failed;
    try { failed = await install(job.to, { integrity: job.integrity, tarball: job.tarball }); } catch (e) { failed = clip(e?.message ?? e) || "Paseo couldn't install it."; await drop(); }
    if (failed) { await log({ event: "failed", reason: failed }); return "failed"; }
    await log({ event: "applied", pid: process.pid });
    for (;;) {
      await wait(timing.watchEveryMs ?? WATCH_EVERY_MS);
      const seen = await observe();
      if (!seen) { if (now() - appliedAt >= (timing.loadTimeoutMs ?? LOAD_TIMEOUT_MS) * 2) { await rollback("Paseo stopped answering after the update."); return "rolled-back"; } continue; }
      const verdict = probation({ now: now(), appliedAt, to: job.to, ...seen, ...timing });
      if (verdict.verdict === "ok") { await log({ event: "updated" }); return "updated"; }
      if (verdict.verdict === "rollback") { await rollback(verdict.reason); return "rolled-back"; }
    }
  } finally {
    await drop();
    await rm(join(job.directory, "update-watchdog.lock"), { force: true }).catch(() => undefined);
  }
}

// Run as a script: the job comes in the environment (it carries the daemon password, so never on the command line).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void (async () => {
  const job = JSON.parse(process.env.FOLLOW_UP_UPDATE_JOB ?? "null");
  delete process.env.FOLLOW_UP_UPDATE_JOB;
  if (!job) process.exit(2);
  await writeFile(join(job.directory, "update-watchdog.lock"), JSON.stringify({ pid: process.pid, to: job.to }), { mode: 0o600 });
  await run(job).catch(async e => {
    await appendFile(join(job.directory, "updates.jsonl"), `${JSON.stringify({ at: Date.now(), from: job.from, to: job.to, event: "failed", reason: clip(e?.message ?? e) || "The installer stopped." })}\n`).catch(() => undefined);
  });
  process.exit(0);
})();
