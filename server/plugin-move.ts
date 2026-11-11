import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { quietWindow, QUIET_MS, type Busy } from "../shared/update-policy";
import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "../shared/legacy";
import { moveView, type MoveView } from "../shared/plugin-move";
import { readEvents } from "./updater";
import type { SelfInstall } from "./release-notes";
import type { MoveJob } from "./update-watchdog.mjs";

/**
 * When to move an upgraded install from 1.x's plugin id to Follow-up's (the move itself is runMove in
 * server/update-watchdog.mjs). Only an npm install under the old id moves, and only when an update could install:
 * no installer alive (this one's or a 1.x installer still on probation), and the same quiet rule (no agent mid-turn,
 * nothing busy, a quiet stretch). A move that failed or rolled back isn't retried by itself; retry() asks again.
 * move.json keeps when the move became ready and the last busy time, like updates.json's `ready`.
 */
type MoveFile = { since: number; lastBusyAt: number | null; retryAsked?: boolean };
export type MoveDeps = {
  directory: string;
  self(): Promise<SelfInstall>;
  busy(fresh: boolean): Promise<Busy[]>;
  /** Any installer alive: Follow-up's own, or a 1.x installer (#61) still watching its update to this version. */
  installerAlive(): Promise<boolean>;
  spawn(job: Pick<MoveJob, "oldId" | "newId" | "version">): Promise<boolean>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  quietMs?: number;
};

export class PluginMove {
  private timer: unknown = null;
  private stopped = false;
  private evaluating: Promise<void> | null = null;
  constructor(private d: MoveDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }
  private get path() { return join(this.d.directory, "move.json"); }
  private async read(): Promise<MoveFile | null> { return readFile(this.path, "utf8").then(t => JSON.parse(t) as MoveFile, () => null); }
  private async write(file: MoveFile) { const tmp = `${this.path}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(file), { mode: 0o600 }); await rename(tmp, this.path); }
  private wake(ms: number) {
    if (this.timer) (this.d.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = (this.d.setTimer ?? setTimeout)(() => { this.timer = null; void this.evaluate().catch(() => undefined); }, Math.max(1_000, ms));
  }
  stop() { this.stopped = true; if (this.timer) (this.d.clearTimer ?? clearTimeout)(this.timer as never); this.timer = null; }

  async view(): Promise<MoveView> {
    const [me, events, moving, file] = await Promise.all([this.d.self(), readEvents(this.d.directory), this.d.installerAlive(), this.read()]);
    return moveView({ id: me.id, installKind: me.installKind, events, moving, now: this.now(), retryAsked: !!file?.retryAsked });
  }

  /** A turn started or ended, or the worker is ready: look again. Serialized. */
  evaluate(): Promise<void> {
    if (this.evaluating) return this.evaluating;
    return this.evaluating = this.decide().finally(() => { this.evaluating = null; });
  }

  /** Settings → General's Retry, or the retry_move tool: ask for one more move, under the same quiet rule. */
  async retry(): Promise<MoveView> {
    const view = await this.view();
    if (view.phase !== "rolled-back" && view.phase !== "failed") throw new Error(view.phase === "moved" || view.phase === "none" ? "Follow-up already runs under its new plugin id." : view.phase === "manual" ? "This copy isn't installed from npm; move it by hand (see Settings → General)." : "The move is already on its way.");
    await this.write({ since: this.now(), lastBusyAt: null, retryAsked: true });
    // The ask is recorded; the quiet-rule check (it asks Paseo who is busy) runs after the reply.
    void this.evaluate().catch(() => undefined);
    return this.view();
  }

  private async decide(): Promise<void> {
    if (this.stopped) return;
    const view = await this.view();
    // An installer is alive (ours, or a 1.x one still on probation for this version): look again after it.
    if (view.phase === "moving") { this.wake(this.d.quietMs ?? QUIET_MS); return; }
    if (view.phase !== "waiting") return;
    const me = await this.d.self();
    const stored = await this.read();
    const file = stored ?? { since: this.now(), lastBusyAt: null };
    if (!stored) await this.write(file);
    const busy = await this.d.busy(false);
    const decision = quietWindow({ now: this.now(), readySince: file.since, lastBusyAt: file.lastBusyAt, busy, quietMs: this.d.quietMs });
    if (decision.install) {
      const live = await this.d.busy(true);
      if (!live.length && !await this.d.installerAlive()) {
        if (await this.d.spawn({ oldId: LEGACY_PLUGIN_ID, newId: PLUGIN_ID, version: me.version })) { await this.write({ since: file.since, lastBusyAt: file.lastBusyAt }); return; }
      }
      await this.write({ ...file, lastBusyAt: this.now() });
      this.wake(this.d.quietMs ?? QUIET_MS);
      return;
    }
    if (decision.why === "busy") await this.write({ ...file, lastBusyAt: this.now() });
    this.wake(decision.why === "settling" ? decision.at - this.now() : this.d.quietMs ?? QUIET_MS);
  }
}
