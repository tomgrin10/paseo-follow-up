import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { offerFor, compareVersions, type Channel } from "../shared/version";
import { staleUpdatePhase, type HistoryEntry, type UpdateMode, type UpdatePhase, type UpdatesView } from "../shared/updates";
import { busyText, quietWindow, QUIET_MS, CAP_MS, PROBATION_MS, type Busy } from "../shared/update-policy";
import { CHECK_INTERVAL_MS, type CheckReason, type RegistrySnapshot } from "./update-registry";
import type { Provenance } from "./update-provenance";
import type { SelfInstall } from "./release-notes";
import { settingsOf, type UpdatesFile } from "./updates";
import { MOVED_MARKER } from "./data-move";
import { announcesUpdate, notesVersion, parseChangelog } from "../shared/changelog";

/**
 * Settings → General, end to end: when to ask npm, whether a new version may be installed, when, and what to show.
 *
 * Network: on its own, one registry request every six hours, and none at all when updates are Off. A new version
 * costs two more requests once (its provenance, cached in updates.json). Installing hands off to the detached
 * watchdog (server/update-watchdog.mjs), which writes every step to updates.jsonl; this reads that log back.
 *
 * Quiet moments come from events, not polling: turn starts and ends (already patched into the directory) re-evaluate
 * a waiting update, and one timer fires when a quiet stretch would be long enough. Timers exist only while an
 * update is waiting. Agent status comes from the directory's agent list, never from timelines.
 */

export type UpdateEvent = { at: number; from: string; to: string; event: "installing" | "applied" | "updated" | "failed" | "rolling-back" | "rolled-back" | "rollback-failed"; reason?: string; pid?: number; by?: string };
export type InstallJob = { from: string; to: string; integrity: string; tarball: string };

export type UpdaterDeps = {
  directory: string;
  read(): Promise<UpdatesFile>;
  write(next: UpdatesFile): Promise<void>;
  self(): Promise<SelfInstall>;
  /** The mode before one is chosen: Install automatically on a fresh install, Tell me on an existing one. */
  defaultMode?(): Promise<UpdateMode>;
  registry: { check(reason: CheckReason): Promise<RegistrySnapshot>; snapshot(): Promise<RegistrySnapshot> };
  provenance(version: string): Promise<Provenance>;
  /** A trusted version's CHANGELOG.md from its tarball, or null. */
  changelog?(tarball: string, integrity: string): Promise<string | null>;
  /** What is busy right now. `fresh` re-reads agent status from Paseo's list (right before installing). */
  busy(fresh: boolean): Promise<Busy[]>;
  /** Starts the detached installer. Returns false when one is already running. */
  spawn(job: InstallJob): Promise<boolean>;
  /** Whether a previously started installer is still alive. */
  installerAlive(): Promise<boolean>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
  /** The isolated update harness's short timings (FOLLOW_UP_UPDATES_FAST=1); production uses the policy's. */
  timing?: { quietMs: number; probationMs: number };
};

type Ready = NonNullable<UpdatesFile["ready"]>;
const HISTORY = 20;
const UPDATED_SHOWN_MS = 7 * 24 * 3_600_000;
const TERMINAL = new Set(["updated", "failed", "rolled-back", "rollback-failed"]);
/** The installer's update steps. updates.jsonl also holds the 2.0 move's steps (`moving` … `moved`), which aren't installs. */
const INSTALL_EVENTS = new Set<string>(["installing", "applied", "updated", "failed", "rolling-back", "rolled-back", "rollback-failed"] satisfies UpdateEvent["event"][]);

async function eventsIn(directory: string): Promise<UpdateEvent[]> {
  const text = await readFile(join(directory, "updates.jsonl"), "utf8").catch(() => "");
  const lines = text.split("\n").filter(Boolean).slice(-400);
  const out: UpdateEvent[] = [];
  for (const line of lines) { try { const e = JSON.parse(line) as UpdateEvent; if (e && typeof e.at === "number" && typeof e.to === "string") out.push(e); } catch { /* a torn line */ } }
  return out;
}

/**
 * updates.jsonl, plus what a 1.x installer logged in 1.x's directory after 2.0 copied it (server/data-move.ts): the
 * update to 2.0 finishes its probation there ("applied", "updated"), after 2.0's first start made the copy. Without
 * them 2.0's history ends at the update's "installing". Can go in the release after 2.0.0, with the legacy heartbeat.
 */
export async function readEvents(directory: string): Promise<UpdateEvent[]> {
  const own = await eventsIn(directory);
  const marker = await readFile(join(directory, MOVED_MARKER), "utf8").then(t => JSON.parse(t) as { from?: unknown; at?: unknown }, () => null);
  const since = typeof marker?.at === "string" ? Date.parse(marker.at) : NaN;
  if (typeof marker?.from !== "string" || !Number.isFinite(since)) return own;
  const seen = new Set(own.map(e => JSON.stringify(e)));
  const later = (await eventsIn(marker.from)).filter(e => e.at >= since && !seen.has(JSON.stringify(e)));
  return later.length ? [...own, ...later].sort((a, b) => a.at - b.at).slice(-400) : own;
}

export function historyOf(events: readonly UpdateEvent[]): HistoryEntry[] {
  return events.filter(e => TERMINAL.has(e.event)).map(e => ({ at: e.at, from: e.from, to: e.to,
    result: e.event === "updated" ? "updated" as const : e.event === "rolled-back" ? "rolled-back" as const : "failed" as const,
    reason: e.reason ?? null })).reverse().slice(0, HISTORY);
}

export class Updater {
  private timer: unknown = null;
  private quietTimer: unknown = null;
  private checking = false;
  private stopped = false;
  private evaluating: Promise<void> | null = null;
  constructor(private readonly d: UpdaterDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }
  private setTimer(fn: () => void, ms: number) { return (this.d.setTimer ?? ((f, m) => { const t = setTimeout(f, m); t.unref?.(); return t; }))(fn, Math.max(1_000, ms)); }
  private clearTimer(h: unknown) { if (h != null) (this.d.clearTimer ?? (x => clearTimeout(x as NodeJS.Timeout)))(h); }

  /** Starts the six-hour schedule (nothing when Off, or when this install can't update itself). */
  async start(): Promise<void> { await this.schedule(); void this.evaluate().catch(e => this.d.log?.(`[follow-up] updates: ${e?.message ?? e}`)); }
  stop(): void { this.stopped = true; this.clearTimer(this.timer); this.clearTimer(this.quietTimer); this.timer = this.quietTimer = null; }

  private async settings() {
    const [file, me, fallback] = await Promise.all([this.d.read(), this.d.self(), this.d.defaultMode?.() ?? "notify" as const]);
    return { file, me, ...settingsOf(file, me.version, fallback) };
  }

  private async schedule(): Promise<void> {
    this.clearTimer(this.timer); this.timer = null;
    if (this.stopped) return;
    const { me, mode } = await this.settings();
    if (mode === "off" || me.installKind !== "npm") return;
    const snap = await this.d.registry.snapshot();
    const wait = snap.checkedAt == null ? 60_000 : snap.checkedAt + CHECK_INTERVAL_MS - this.now();
    this.timer = this.setTimer(() => { void this.check("scheduled").catch(() => undefined).finally(() => this.schedule()); }, wait);
  }

  /** Asks npm (when due for `reason`), then decides. Off skips scheduled and Settings checks; Check now always runs. */
  async check(reason: CheckReason): Promise<void> {
    const { me, mode } = await this.settings();
    if (me.installKind !== "npm") return;
    if (mode === "off" && reason !== "manual") return;
    this.checking = true;
    try { await this.d.registry.check(reason); } finally { this.checking = false; }
    await this.evaluate();
  }

  /** A turn started or ended somewhere: if an update is waiting for a quiet moment, look again. */
  activity(): void { void this.d.read().then(f => { if (f.ready) return this.evaluate(); }).catch(() => undefined); }

  async setSettings(change: { mode?: UpdateMode; channel?: Channel }): Promise<void> {
    const file = await this.d.read();
    const next: UpdatesFile = { ...file, ...(change.mode ? { mode: change.mode } : {}), ...(change.channel ? { channel: change.channel } : {}) };
    // A channel or mode change re-decides what's waiting.
    if (change.channel && change.channel !== file.channel) delete next.ready;
    if (change.mode && change.mode !== "auto" && next.ready && !next.ready.manual) delete next.ready;
    await this.d.write(next);
    await this.schedule();
    await this.evaluate();
  }

  async dismiss(id: string): Promise<void> {
    const file = await this.d.read();
    await this.d.write({ ...file, dismissed: [...new Set([...(file.dismissed ?? []), id])].slice(-50) });
  }

  /**
   * Install now. Never for a version whose provenance failed. Without `anyway` it installs as soon as nothing is
   * running (no five idle minutes); otherwise it waits like an automatic update, and Settings offers Install anyway.
   */
  async install(version: string, anyway = false): Promise<void> {
    const { me } = await this.settings();
    if (me.installKind !== "npm") throw new Error("This copy of Follow-up isn't installed from npm, so it can't update itself. Pull and rebuild instead.");
    if (compareVersions(version, me.version) <= 0) throw new Error(`${version} isn't newer than the installed ${me.version}.`);
    const snap = await this.d.registry.snapshot();
    if (!snap.versions.includes(version)) throw new Error(`npm doesn't list ${version}. Check for updates first.`);
    const trust = await this.trust(version);
    if (!trust.ok) throw new Error(`Not installing ${version}: ${trust.reason} Install it by hand with the Paseo CLI only if you trust it.`);
    if (await this.d.installerAlive()) throw new Error("An update is already being installed.");
    const file = await this.d.read();
    const ready: Ready = file.ready?.version === version ? { ...file.ready, manual: true } : { version, since: this.now(), manual: true, lastBusyAt: null };
    await this.d.write({ ...file, ready });
    if (anyway) { await this.launch(me.version, version); return; }
    const busy = await this.d.busy(true);
    if (!busy.length) { await this.launch(me.version, version); return; }
    await this.d.write({ ...(await this.d.read()), ready: { ...ready, lastBusyAt: this.now() } });
    await this.evaluate();
  }

  /** Provenance for a version, cached per version in updates.json. A network failure isn't cached. */
  private async trust(version: string): Promise<Provenance> {
    const file = await this.d.read();
    const known = file.provenance?.[version];
    if (known) return known.ok ? { ok: true, version, integrity: known.integrity, tarball: known.tarball, workflow: known.workflow, publishedAt: null } : { ok: false, version, reason: known.reason, retry: false };
    const p = await this.d.provenance(version);
    if (p.ok || !p.retry) {
      const latest = await this.d.read();
      const entries = Object.entries({ ...latest.provenance, [version]: p.ok ? { ok: true as const, integrity: p.integrity, tarball: p.tarball, workflow: p.workflow } : { ok: false as const, reason: p.reason } }).slice(-10);
      await this.d.write({ ...latest, provenance: Object.fromEntries(entries) });
    }
    return p;
  }

  /** Notes for a trusted newer version, read once from its tarball and kept for the last three versions. */
  private async notes(version: string, trust: Extract<Provenance, { ok: true }>): Promise<void> {
    if (!this.d.changelog || (await this.d.read()).notes?.[version]) return;
    const text = await this.d.changelog(trust.tarball, trust.integrity).catch(() => null);
    if (text == null) return;
    const latest = await this.d.read();
    const entries = Object.entries({ ...latest.notes, [version]: parseChangelog(text).slice(0, 30) }).slice(-3);
    await this.d.write({ ...latest, notes: Object.fromEntries(entries) });
  }

  private async launch(from: string, to: string): Promise<void> {
    const file = await this.d.read();
    const known = file.provenance?.[to];
    if (!known?.ok) throw new Error(`Not installing ${to}: its provenance wasn't confirmed.`);
    this.clearTimer(this.quietTimer); this.quietTimer = null;
    const started = await this.d.spawn({ from, to, integrity: known.integrity, tarball: known.tarball });
    if (!started) throw new Error("An update is already being installed.");
    const { ready: _, ...rest } = await this.d.read();
    await this.d.write(rest);
  }

  /** Decides what a fresh look at the registry means. Serialized: overlapping events share one evaluation. */
  evaluate(): Promise<void> {
    if (this.evaluating) return this.evaluating;
    const run = this.decide().finally(() => { this.evaluating = null; });
    this.evaluating = run;
    return run;
  }

  private async decide(): Promise<void> {
    if (this.stopped) return;
    const { me, mode, channel } = await this.settings();
    if (me.installKind !== "npm") return;
    if (await this.d.installerAlive()) return;
    const snap = await this.d.registry.snapshot();
    const offer = offerFor(me.version, channel, snap.tags, snap.versions);
    let file = await this.d.read();
    if (offer.kind !== "update") { if (file.ready) { const { ready: _, ...rest } = file; await this.d.write(rest); } return; }
    const target = offer.version;
    if (file.ready && file.ready.version !== target) { const { ready: _, ...rest } = file; file = rest; await this.d.write(file); }
    const trust = await this.trust(target);
    if (!trust.ok) return;
    await this.notes(target, trust);
    const manual = file.ready?.manual === true;
    if (mode !== "auto" && !manual) return;
    if (!manual && await this.blocked(target, snap)) return;
    const ready: Ready = file.ready ?? { version: target, since: this.now(), manual: false, lastBusyAt: null };
    const busy = await this.d.busy(false);
    const decision = quietWindow({ now: this.now(), readySince: ready.since, lastBusyAt: ready.lastBusyAt ?? null, busy, quietMs: this.d.timing?.quietMs });
    if (decision.install) {
      // Right before installing, look at Paseo's live agent list rather than the cached directory.
      const live = await this.d.busy(true);
      if (!live.length) { await this.launch(me.version, target); return; }
      await this.d.write({ ...(await this.d.read()), ready: { ...ready, lastBusyAt: this.now() } });
      this.wake(this.d.timing?.quietMs ?? QUIET_MS);
      return;
    }
    const next: Ready = decision.why === "busy" ? { ...ready, lastBusyAt: this.now() } : ready;
    if (JSON.stringify(next) !== JSON.stringify(file.ready)) await this.d.write({ ...(await this.d.read()), ready: next });
    // Busy agents re-trigger on their next turn end; background jobs don't, so look again after a quiet stretch.
    if (decision.why === "settling") this.wake(decision.at - this.now());
    else if (busy.some(b => b.kind !== "agent")) this.wake(this.d.timing?.quietMs ?? QUIET_MS);
    else this.wake(ready.since + CAP_MS - this.now());
  }

  private wake(ms: number) {
    this.clearTimer(this.quietTimer);
    this.quietTimer = this.setTimer(() => { this.quietTimer = null; void this.evaluate().catch(() => undefined); }, ms);
  }

  /** An automatic update never retries a version that was rolled back, nor one that failed since the last check. */
  private async blocked(version: string, snap: RegistrySnapshot): Promise<boolean> {
    const events = await readEvents(this.d.directory);
    const last = [...events].reverse().find(e => e.to === version && TERMINAL.has(e.event));
    if (!last) return false;
    if (last.event === "rolled-back" || last.event === "rollback-failed") return true;
    return last.event === "failed" && (snap.okAt ?? 0) <= last.at;
  }

  async view(): Promise<UpdatesView> {
    const { file, me, mode, channel } = await this.settings();
    const snap = await this.d.registry.snapshot();
    const now = this.now();
    const events = await readEvents(this.d.directory);
    const channels = { stable: offerVersion("stable", snap), beta: offerVersion("beta", snap) };
    const base = { version: me.version, installKind: me.installKind, mode, channel, channels, checkedAt: snap.okAt, registryError: snap.error,
      nextCheckAt: mode === "off" || me.installKind !== "npm" ? null : (snap.checkedAt ?? now) + CHECK_INTERVAL_MS, pendingNotes: [] as UpdatesView["pendingNotes"], history: historyOf(events) };
    const phase = await this.phase(file, me.version, mode, channel, snap, events, now);
    const dismissed = new Set(file.dismissed ?? []);
    let notice: UpdatesView["notice"] = null;
    if (me.installKind === "npm") {
      if (phase.kind === "rolled-back") notice = { id: `rolled-back:${phase.version}`, kind: "rolled-back", version: phase.version, from: phase.from };
      // Only a new major earns a Home notice (announcesUpdate, the one rule for update prompts); any other available
      // version stays a quiet row in Settings → General. The rollback notice reports a failure, not an update.
      else if (phase.kind === "available" && mode === "notify" && announcesUpdate(me.version, phase.version)) notice = { id: `available:${phase.version}`, kind: "available", version: phase.version, from: null };
      if (notice && dismissed.has(notice.id)) notice = null;
    }
    // Notes for what's on offer: every version after the installed one, from the newest version's own changelog.
    const offered = "version" in phase && compareVersions(phase.version, me.version) > 0 ? phase.version : null;
    const pendingNotes = offered ? (file.notes?.[offered] ?? []).filter(n => compareVersions(n.version, notesVersion(me.version)) > 0 && compareVersions(n.version, notesVersion(offered)) <= 0) : [];
    return { ...base, pendingNotes, phase, notice };
  }

  /**
   * The phase, settled against what runs: a phase tied to a version at or below the running one (an installer that died
   * before a newer version went in from outside, a failure or rollback since superseded) reads as current or updated
   * (`staleUpdatePhase`, invariant `update-phase-never-outlives-its-version`). Recomputed from updates.jsonl on every
   * view, so a load or a check always settles it; nothing is persisted that could outlive it.
   */
  private async phase(file: UpdatesFile, running: string, mode: UpdateMode, channel: Channel, snap: RegistrySnapshot, all: UpdateEvent[], now: number): Promise<UpdatePhase> {
    const events = all.filter(e => INSTALL_EVENTS.has(e.event));
    const phase = await this.rawPhase(file, running, mode, channel, snap, events, now);
    if (!staleUpdatePhase(phase, running, await this.d.installerAlive())) return phase;
    const terminal = [...events].reverse().find(e => TERMINAL.has(e.event));
    return this.settled(terminal, running, now);
  }

  private settled(terminal: UpdateEvent | undefined, running: string, now: number): UpdatePhase {
    if (terminal?.event === "updated" && terminal.to === running && now - terminal.at < UPDATED_SHOWN_MS) return { kind: "updated", version: running, from: terminal.from, at: terminal.at };
    return { kind: "current" };
  }

  private async rawPhase(file: UpdatesFile, running: string, mode: UpdateMode, channel: Channel, snap: RegistrySnapshot, events: UpdateEvent[], now: number): Promise<UpdatePhase> {
    if (this.checking) return { kind: "checking" };
    const last = events[events.length - 1];
    if (last && !TERMINAL.has(last.event)) {
      if (await this.d.installerAlive()) {
        const applied = [...events].reverse().find(e => e.event === "applied" && e.to === last.to);
        if (last.event === "applied" || last.event === "rolling-back") return applied ? { kind: "settling", version: last.to, from: last.from, at: applied.at, until: applied.at + (this.d.timing?.probationMs ?? PROBATION_MS) } : { kind: "installing", version: last.to, since: last.at };
        return { kind: "installing", version: last.to, since: last.at };
      }
      // The installer stopped without saying how it went: report what is running now.
      if (running !== last.to) return { kind: "install-failed", version: last.to, reason: "The installer stopped before it finished.", at: last.at };
    }
    const terminal = [...events].reverse().find(e => TERMINAL.has(e.event));
    const offer = offerFor(running, channel, snap.tags, snap.versions);
    if (offer.kind === "update") {
      const v = offer.version;
      const known = file.provenance?.[v];
      if (known && !known.ok) return { kind: "untrusted", version: v, reason: known.reason };
      if (terminal?.to === v && (terminal.event === "rolled-back" || terminal.event === "rollback-failed")) return { kind: "rolled-back", version: v, from: terminal.from, reason: terminal.reason ?? "It didn't start cleanly.", at: terminal.at };
      if (terminal?.to === v && terminal.event === "failed") return { kind: "install-failed", version: v, reason: terminal.reason ?? "Paseo couldn't install it.", at: terminal.at };
      const ready = file.ready?.version === v ? file.ready : null;
      if (ready && (mode === "auto" || ready.manual)) {
        const busy = await this.d.busy(false);
        const decision = quietWindow({ now, readySince: ready.since, lastBusyAt: ready.lastBusyAt ?? null, busy, quietMs: this.d.timing?.quietMs });
        return { kind: "waiting", version: v, busy: busy.length ? busyText(busy) : null, idleAt: decision.install ? null : decision.why === "settling" ? decision.at : null,
          capAt: ready.since + CAP_MS, capped: now - ready.since >= CAP_MS };
      }
      return { kind: "available", version: v, publishedAt: null };
    }
    if (terminal && TERMINAL.has(terminal.event) && terminal.event !== "updated" && terminal.to !== running && compareVersions(terminal.to, running) > 0 && (terminal.event === "rolled-back" || terminal.event === "rollback-failed"))
      return { kind: "rolled-back", version: terminal.to, from: terminal.from, reason: terminal.reason ?? "It didn't start cleanly.", at: terminal.at };
    return this.settled(terminal, running, now);
  }
}

const offerVersion = (channel: Channel, snap: RegistrySnapshot) => {
  const o = offerFor("0.0.0-0", channel, snap.tags, snap.versions);
  return o.kind === "none" ? null : o.version;
};

