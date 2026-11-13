import { STOP_WAIT_MS, settleWithin, type Deadline } from "./teardown";
import { DEVELOPER, type Actor } from "../shared/actor";
import { randomUUID } from "node:crypto";
import { completionBlockers, completionCheck, completionGate, revokesDone, type CompletionGate, type Workspace, type State, type Batch } from "../shared/model";
import { Store } from "./store";
import { Github } from "./github";
import { batchPrompt, messageText, tasksFor, isRecovery, needsPrObservations, type TaskWording } from "./tasks";
import { answerRecipients, developerAnswer, syncTaskQuestions, type AnswerAction } from "./questions";
import { answerMessage, isOpen as isOpenQuestion, type Question } from "../shared/questions";
import { reconcileSubmittedStacks } from "./submissions";
import { applyDiscovery, interruptionHold, startsWithAutoSend, type DiscoveredWorkspace } from "./discovery";
import { ACTIVE_SCOPE_MIGRATION, followsByDefault, migrateActiveScope } from "../shared/settings";
import { replyRecorded } from "../shared/communication";
import { DeliveryDeferred, ConversationGone, realTimers, withDeadline, type Timers } from "./delivery";
import { recordSnapshot } from "./deployment-anchor";
import { pruneUnsent } from "./batch-archive";
import { holdSuperseded, liftHold } from "../shared/status";
import { conditionId, isCapped, readSince, sendDecision, settleUnacknowledged, UNACKNOWLEDGED_MS } from "../shared/send-decision";
import { isRepair } from "../shared/task-rows";
export { settleUnacknowledged, UNACKNOWLEDGED_MS, NO_PROGRESS_CAP } from "../shared/send-decision";

export interface Runtime {
  busy: boolean; reason: string | null; archived: boolean; backgroundBusy?: boolean;
  /** Live state of the agents working tasks name (Workspace.taskAgents). Undefined: unknown, so every line naming an agent says "Agent unavailable". */
  taskAgents?: Workspace["taskAgents"];
  guarded?: boolean; guardedInterruptionId?: string;
  /** The main agent's runtime is loaded (see isLoaded). Undefined means unknown. */
  mainLoaded?: boolean;
  /** The main agent had a user message within the active window. Undefined means unknown. */
  mainRecent?: boolean;
  /** The main agent's title in Paseo. Undefined means unknown. */
  mainTitle?: string | null;
  /** The main agent's current turn id (shared/status.ts turnIdOf), when it has one. Undefined means unknown. */
  mainTurnId?: string | null;
  /** The main agent's provider conversation no longer exists. */
  gone?: string | null;
}
const GONE_REASON = "The main agent's conversation no longer exists, so Follow-up stopped sending to it. Start a new agent in this workspace to continue.";
/** A batch that asks the agent to verify it's finished and declare Done. These never go out on their own. */
export { interruptionHold };
export interface Gateway {
  /** `scope`: a nudge's pass, only those workspaces and only reads already in hand (a-nudge-costs-its-workspace). */
  discover?(state: State, workspaceId?: string, scope?: { workspaces: ReadonlySet<string> }): Promise<DiscoveredWorkspace[]>;
  observe(w: Workspace, fresh?: boolean): Promise<Runtime>;
  send(w: Workspace, batch: Batch, text: string): Promise<void>;
  prepareRecovery(w: Workspace, batch: Batch): Promise<{ agentId: string; contextPath: string }>;
  recoveryRuntime?(w: Workspace, batch: Batch): Promise<{ busy: boolean; reason: string | null }>;
  /** Whether a batch's message is in its recipient's chat (by messageId). Null: unknown, e.g. reading it would wake the agent. */
  arrived?(w: Workspace, batch: Batch): Promise<boolean | null>;
  label(w: Workspace, assigned: boolean): Promise<void>;
  /** A tick begins: the gateway may list agents once for it (a-send-lists-agents-at-most-once-per-tick). */
  tickStarted?(): void;
  /** Sends a developer message to the first available recipient; DeliveryDeferred means try again later. */
  deliver?(w: Workspace, recipients: string[], text: string, messageId: string): Promise<string>;
}

/**
 * Plain-GitHub stacks are chains of base branches: an open PR whose base isn't trunk sits on the tracked PR whose head
 * branch is that base. Fills in parents agents didn't register; never overrides one they did. Graphite PRs are left alone.
 */
export function inferBaseChains(w: Workspace): void {
  for (const pr of w.prs) {
    const s = pr.snapshot;
    if (pr.parent || s?.prWorkflow !== "github" || s.state !== "OPEN" || !s.base || s.base === s.trunk) continue;
    const parent = w.prs.find(p => p !== pr && p.repo === pr.repo && p.snapshot?.headBranch === s.base);
    if (!parent) continue;
    // No cycles: the parent must not already sit on this PR.
    let up: string | null = parent.key; const seen = new Set<string>();
    while (up && !seen.has(up)) { if (up === pr.key) break; seen.add(up); up = w.prs.find(p => p.key === up)?.parent ?? null; }
    if (up === pr.key) continue;
    pr.parent = parent.key;
  }
}
/** How long nudges gather into one read: agents often end turns within a few seconds of each other. */
export const NUDGE_MS = 2_000;
/**
 * Whether an observation carries nothing the stored snapshot lacks: primitives by value, nested fields (threads,
 * deployment, reviewers) by reference or, when the references differ, by their own JSON. A read's content can change
 * without a new observedAt (Graphite scheduling and deployments are merged into it), so observedAt alone isn't enough.
 * `ignoreReadTimes` (a workspace that isn't hot): a read that only moved observedAt is no change; the full pass every
 * OBSERVE_FULL_MS records the read time (store-writes-only-real-changes treats it as volatile too).
 */
export function sameSnapshot(a: object | null | undefined, b: object | null | undefined, ignoreReadTimes = false): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) {
    const u = x[k], v = y[k];
    if (u === v || ignoreReadTimes && k === "observedAt") continue;
    if (!u || !v || typeof u !== "object" || typeof v !== "object") return false;
    if (ignoreReadTimes && k === "deployment") { if (JSON.stringify({ ...u, observedAt: null }) !== JSON.stringify({ ...v, observedAt: null })) return false; continue; }
    if (JSON.stringify(u) !== JSON.stringify(v)) return false;
  }
  return true;
}

/**
 * A workspace whose agent may act any moment, or whose decision reads PR freshness (a declaration, Done, a send in
 * flight): every tick reads its PRs and records every read, read time included.
 */
export function isHot(w: Workspace): boolean {
  return w.runtimeBusy || w.backgroundBusy || !!w.declaration || !!w.completion || w.batches.some(b => ["sending", "sent"].includes(b.state)) || w.prActions.some(a => a.state === "sending");
}

/** The longest an untouched workspace goes without a full observation pass (its time-based rules run then). */
export const OBSERVE_FULL_MS = 60_000;

export class Engine {
  error: string | null = null;
  private recoveryOperations = new Set<Promise<Workspace>>();
  private running: Promise<void> | null = null;
  private stopped = false;
  /** Set by the resource governor: while true, background refresh (scans, observation, auto-sends) waits. */
  paused: () => boolean = () => false;
  /** Set by the worker: while true (a fresh install mid-setup), batches queue but nothing is sent on its own. */
  autoSendsHeld: () => boolean = () => false;
  /** Where pruned never-sent batches go (see pruneUnsent); the worker appends them to an archive file. */
  archive: (workspaceId: string, batches: Batch[]) => Promise<void> = async () => {};
  /** Set by the worker: logs a workspace whose status surfaces contradict each other (server/status-check.ts). */
  statusCheck: (w: Workspace, now: number, inputs?: string) => Promise<void> = async () => {};
  /** Background refreshes skipped while paused, for tests and the resource check. */
  skipped = 0;
  constructor(readonly store: Store, private github: Pick<Github, "observe">, private gateway: Gateway, private now = Date.now, private settleMs = 60_000, private nudgeMs = NUDGE_MS) {}
  async recover(): Promise<void> {
    await this.store.mutate(state => {
      for (const w of state.workspaces) {
        const eligible = tasksFor(w, this.now(), this.wording);
        for (const b of w.batches.filter(b => b.state === "pending" && !isRecovery(b))) {
          b.tasks = b.tasks.filter(t => t.kind !== "obligation" || eligible.some(e => e.key === t.key && e.fingerprint === t.fingerprint));
          if (!b.tasks.length) { b.state = "cancelled"; b.result = "No triggered task is due. Unscheduled work remains in Tasks."; }
        }
        for (const b of w.batches) if (isRecovery(b) && b.state === "pending" && !b.enable_manual_recovery) { b.state = "cancelled"; b.result = "Recovery is now optional. Run recovery when needed; registered work continues independently."; }
        if (["Recovery stopped or failed. Check the recovery agent before retrying.", "Recovery acknowledgment was refused. Check the identity error on this batch."].includes(w.hold ?? "")) w.hold = null;
      }

      for (const w of state.workspaces) for (const a of w.prActions) if (a.state === "sending") { a.state = "uncertain"; a.result = `Follow-up reloaded before ${a.kind === "request_reviewers" ? "GitHub confirmed the review request" : w.prs.some(p => a.prs.includes(p.key) && p.snapshot?.prWorkflow === "github") ? "GitHub confirmed the action" : "Graphite confirmed the action"}. Check state before sending another request.`; }
      for (const w of state.workspaces) for (const q of w.questions) if (q.answer?.delivery.state === "sending") q.answer.delivery = { ...q.answer.delivery, state: "unconfirmed", reason: "Follow-up reloaded before Paseo confirmed the answer. Check the agent's chat before resending." };
      // 2.0 betas before Q49 blocked a batch whose capped condition went out twice; the cap is per task now.
      for (const w of state.workspaces) for (const b of w.batches) if (b.state === "blocked" && b.unacknowledged) b.state = "completed";
      // The retired 3-strike rule blocked a message before it went out; the per-task cap decides now, so it is re-formed.
      for (const w of state.workspaces) for (const b of w.batches) if (b.state === "blocked" && !b.sentAt) { b.state = "cancelled"; b.result = "Re-formed under the per-task cap"; }
      for (const w of state.workspaces) for (const b of w.batches) if (b.state === "sending") {
        b.state = "uncertain";
        b.result = "Follow-up reloaded mid-send. It checks the agent's chat for the message and sends it only if it never arrived.";
      }
    });
  }
  /** How repair tasks are worded per repository (review-fix command, GitHub restacks). Empty: the original wording. */
  wording: TaskWording = {};
  private runningBackground = false;
  /** Per workspace: the state object its last tick left, that tick's runtime (JSON) and when it last observed in full. */
  /** The discovery rows (JSON) the last tick applied, and the state that write left. */
  private lastDiscovery: { rows: string; state: State; at: number } | null = null;
  private observedPass = new Map<string, { w: Workspace; runtime: string; at: number }>();
  /** How many full per-workspace observation writes ran (tests). */
  observationWrites = 0;
  /**
   * One refresh at a time. The timer passes `background`, which lets PR polling back off for settled repositories;
   * the developer's Refresh gets a fresh read. Turn ends, actions and agent tools go through `nudge` instead. A fresh request that
   * arrives during a background tick runs right after it instead of being folded into it. `workspaceId` narrows a
   * fresh read to that workspace's PRs (opening its panel).
   */
  tick(o: { background?: boolean; workspaceId?: string; affected?: Set<string> } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // A nudge (affected) is a background read, but it reacts to something that just happened: like a fresh request,
    // it runs after a background tick in flight instead of being folded into it.
    if (this.running) return this.runningBackground && (!o.background || o.affected) ? this.running.then(() => this.tick(o)) : this.running;
    this.runningBackground = !!o.background;
    // One tick saves and derives once (a-tick-copies-the-state-at-most-once, Store.batch).
    this.running = this.store.batch(() => this.run(o)).catch(() => { this.error = "Follow-up refresh failed. Saved work is intact; refresh will retry."; }).finally(() => { this.running = null; });
    return this.running;
  }
  /** Reads one workspace's PRs fresh and records what came back, nothing else (a Refresh of a dormant workspace). */
  private async refreshPrs(w: Workspace): Promise<void> {
    const observations = await this.github.observe(w.prs, { background: true, fresh: new Set(w.prs.map(p => p.key)) });
    await this.store.mutateWorkspace(w.id, current => {
      for (const p of current.prs) {
        const observed = observations.get(p.key);
        if (!observed) continue;
        p.error = observed.error;
        if (observed.snapshot) recordSnapshot(p, observed.snapshot, this.now());
      }
    });
  }
  private nudged: Set<string> | "all" | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeWaiters: (() => void)[] = [];
  /**
   * Something changed in a workspace (an agent's turn ended, an action ran, a tool registered a PR): read its PRs soon,
   * with the per-PR backoff, and nothing else's (a-turn-end-never-reads-other-workspaces-prs). Nudges inside
   * `nudgeMs` share one read. No workspace: every workspace, as the timer would. 2026-11-12: every turn end and
   * action ran a full fresh read of every tracked PR, and the account's shared GraphQL budget ran out.
   */
  nudge(workspaceId?: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!workspaceId) this.nudged = "all";
    else if (this.nudged !== "all") { const set: Set<string> = this.nudged ?? new Set(); set.add(workspaceId); this.nudged = set; }
    return new Promise(resolve => {
      this.nudgeWaiters.push(resolve);
      this.nudgeTimer ??= setTimeout(() => {
        const scope = this.nudged, waiters = this.nudgeWaiters;
        this.nudged = null; this.nudgeWaiters = []; this.nudgeTimer = null;
        void this.tick(scope === "all" || !scope ? { background: true } : { background: true, affected: scope }).finally(() => waiters.forEach(w => w()));
      }, this.nudgeMs);
    });
  }
  private async run(o: { background?: boolean; workspaceId?: string; affected?: Set<string> } = {}): Promise<void> {
    if (this.paused()) { this.skipped++; return; }
    this.gateway.tickStarted?.();
    const saved = await this.store.snapshot();
    if (this.stopped) return;
    if (this.gateway.discover && !(o.affected && await this.discoverScoped(saved, o.affected))) {
      const discovered = await this.gateway.discover(saved);
      // Discovery's write copies the whole state; skip it when the rows and the state are what the last one left
      // (a-tick-copies-the-state-at-most-once), at most OBSERVE_FULL_MS (its time-based rules run then). The rows are
      // ~150 small objects, so their JSON is cheap.
      const rowsKey = JSON.stringify(discovered);
      const lastDiscovery = this.lastDiscovery;
      const fresh = !lastDiscovery || lastDiscovery.rows !== rowsKey || lastDiscovery.state !== saved || this.now() - lastDiscovery.at >= OBSERVE_FULL_MS;
      if (fresh) await this.store.mutate(state => {
        applyDiscovery(state, discovered.filter(row => followsByDefault(state, row) || saved.workspaces.some(w => w.id === row.id && w.enable_tracking && !w.archived)), this.now());
        migrateActiveScope(state, new Set(discovered.filter(row => row.active !== false).map(row => row.id)));
      });
      this.lastDiscovery = { rows: rowsKey, state: await this.store.snapshot(), at: fresh ? this.now() : lastDiscovery!.at };
    }
    // Dormant workspaces stay listed but cost nothing: no PR or agent observation until they're active again.
    const current = await this.store.snapshot();
    const active = current.workspaces.filter(w => w.enable_tracking && !w.archived && !w.dormant);
    // The developer's Refresh of a dormant workspace still reads its PRs (only its PRs: no agent observation, repairs or
    // sends). Before 2.0.1-beta.2 it read nothing, so a stale PR error there outlived every Refresh.
    const asleep = o.workspaceId ? current.workspaces.find(w => w.id === o.workspaceId && w.enable_tracking && !w.archived && w.dormant) : undefined;
    if (asleep) await this.refreshPrs(asleep);
    if (!active.length) { this.error = null; return; }
    // Busy workspaces keep every-tick PR reads: their agent may push or answer review at any moment.
    const keys = (ws: Workspace[]) => new Set(ws.flatMap(w => w.prs.map(p => p.key)));
    const hot = keys(active.filter(isHot));
    const read = o.affected ? active.filter(w => o.affected!.has(w.id)) : active;
    const observations = await this.github.observe(read.flatMap(w => w.prs), o.background || o.workspaceId ? { background: true, hot, fresh: keys(active.filter(w => w.id === o.workspaceId)) } : {});
    // A nudge observes only its workspaces (a-nudge-costs-its-workspace); the timer's tick observes every active one.
    for (const original of o.affected ? read : active) {
      if (this.stopped) return;
      const runtime = await this.gateway.observe(original).catch((): Runtime => ({ busy: false, reason: "Agent state unavailable; refresh will retry", archived: false }));
      const pruned: Batch[] = [];
      // An untouched workspace isn't copied (a-tick-copies-the-state-at-most-once): same state object as the last pass
      // left, same runtime, no PR read or error it hasn't recorded, and a full pass under OBSERVE_FULL_MS ago (time-based
      // rules, like the 120 s acknowledgement, run on that pass). The checks cost a ~200-byte JSON and a shallow compare per PR.
      const runtimeKey = JSON.stringify(runtime);
      const last = this.observedPass.get(original.id);
      const untouched = !!last && last.w === original && last.runtime === runtimeKey && this.now() - last.at < OBSERVE_FULL_MS && o.workspaceId !== original.id &&
        original.prs.every(p => { const seen = observations.get(p.key); return !seen || seen.error === p.error && sameSnapshot(seen.snapshot, p.snapshot, !isHot(original)); });
      if (!untouched) this.observationWrites++;
      if (!untouched) await this.store.mutateWorkspace(original.id, w => {
        w.runtimeBusy = runtime.busy; w.runtimeReason = runtime.reason; w.taskAgents = runtime.taskAgents;
        w.backgroundBusy = runtime.backgroundBusy ?? false;
        if (runtime.mainTitle !== undefined && (w.mainAgentTitle ?? null) !== runtime.mainTitle) w.mainAgentTitle = runtime.mainTitle;
        if (runtime.gone && w.goneAgent?.agentId !== w.mainAgentId) w.goneAgent = { agentId: w.mainAgentId, at: new Date(this.now()).toISOString(), reason: runtime.gone };
        if (w.goneAgent?.agentId === w.mainAgentId) w.runtimeReason = GONE_REASON;
        if (runtime.guardedInterruptionId && w.interruption && w.hold === interruptionHold(w.interruption.kind)) {
          w.hold = null; w.interruption.guardPauseId = runtime.guardedInterruptionId;
        }
        if (runtime.archived) w.archived = true;
        // Repair path for a missed turn start (a reload, a restart): the main agent is on a newer turn than the failed one.
        if (runtime.mainTurnId !== undefined && holdSuperseded(w, { agentId: w.mainAgentId, turnId: runtime.mainTurnId })) liftHold(w);
        for (const p of w.prs) {
          const observed = observations.get(p.key);
          if (!observed) continue;
          p.error = observed.error;
          if (observed.snapshot) recordSnapshot(p, observed.snapshot, this.now());
        }
        reconcileSubmittedStacks(w);
        inferBaseChains(w);
        if (w.archived) return;
        this.reconcile(w);
        pruned.push(...pruneUnsent(w));
        syncTaskQuestions(w, this.now());
        const unacknowledged = w.batches.find(b => b.state === "sent" && !isRecovery(b));
        if (unacknowledged && (runtime.guarded || runtime.busy || runtime.backgroundBusy || original.runtimeReason?.startsWith("Waiting for Session Guard"))) unacknowledged.activityAt = new Date(this.now()).toISOString();
        if (unacknowledged && !runtime.busy && !runtime.reason && this.now() - Date.parse(unacknowledged.activityAt ?? unacknowledged.sentAt!) > UNACKNOWLEDGED_MS) {
          if (unacknowledged.acknowledgmentError) {
            unacknowledged.state = "blocked";
            unacknowledged.result = `Acknowledgment was refused for agent ${unacknowledged.acknowledgmentError.agentId}: ${unacknowledged.acknowledgmentError.error}`;
          } else {
            // No routine retry: GitHub says what's left. Still-open tasks ride the next message at once.
            settleUnacknowledged(w, unacknowledged, tasksFor(w, this.now(), this.wording), this.now());
            this.reconcile(w);
          }
        }
        if (w.completion && revokesDone(w, this.now())) w.completion = null;
        if (w.completion) settleDoneChecks(w, this.now());
        if (w.declaration && !w.completion) {
          const gate = completionGate(w, this.now());
          if (gate.blockers.some(b => b.owner !== "wait")) w.declaration = null;
          else if (!gate.blockers.length) acceptDeclaration(w, gate, this.now());
        }
      });
      if (pruned.length) await this.archive(original.id, pruned).catch(() => undefined);
      for (const b of (await this.store.snapshot()).workspaces.find(w => w.id === original.id)!.batches.filter(b => isRecovery(b) && b.state === "sent")) {
        const status = await this.gateway.recoveryRuntime?.(original, b).catch(() => ({ busy: true, reason: "Recovery status unavailable" }));
        if (status?.busy) await this.store.mutateWorkspace(original.id, w => {
          const current = w.batches.find(x => x.id === b.id)!;
          if (current.state === "sent") current.activityAt = new Date(this.now()).toISOString();
        });
        if (!status?.busy && this.now() - Date.parse(b.activityAt ?? b.sentAt!) > UNACKNOWLEDGED_MS) await this.store.mutateWorkspace(original.id, w => {
          const current = w.batches.find(x => x.id === b.id)!;
          if (current.state !== "sent") return;
          // The same rule as repairs: the recovery's work is the PR list, so a list that caught up is done.
          if (!current.acknowledgmentError && w.inventory && w.inventory.syncedRevision >= Number(current.tasks[0]?.fingerprint ?? Infinity)) {
            current.state = "completed"; current.unacknowledged = true; current.settledAt = new Date(this.now()).toISOString();
            current.result = "Recovery ended without an acknowledgment; the PR list is up to date.";
            return;
          }
          current.state = "blocked"; current.result = current.acknowledgmentError ? `Acknowledgment was refused for agent ${current.acknowledgmentError.agentId}: ${current.acknowledgmentError.error}` : status?.reason ?? "Recovery finished without an accepted acknowledgment. Check its result before retrying.";
        });
      }
      for (const q of findWorkspace(await this.store.snapshot(), original.id).questions.filter(q => q.answer?.delivery.state === "queued")) await this.deliverAnswer(original.id, q.id).catch(() => undefined);
      await this.checkArrivals(original.id);
      let current = findWorkspace(await this.store.snapshot(), original.id);
      // Persist the holds that live only in this refresh, so every surface can say why repairs wait (shared/status.ts).
      const sendWait = this.autoSendsHeld() ? "setup" : runtime.mainLoaded === false || runtime.mainRecent === false ? "unloaded" : null;
      if ((current.sendWait ?? null) !== sendWait) { await this.store.mutateWorkspace(original.id, w => { w.sendWait = sendWait; }); current = findWorkspace(await this.store.snapshot(), original.id); }
      // The refresh's runtime state is persisted above, so this reads the same inputs as every surface's line
      // (shared/send-decision.ts). It never loads an idle agent (sendWait "unloaded") or sends the Done check.
      const pending = current.batches.find(b => b.state === "pending" && !isRecovery(b));
      if (pending && sendDecision(current, this.now(), { settleMs: this.settleMs, batch: pending }).send)
        await this.dispatch(current.id, pending.id, true).catch(async (error: unknown) => {
          // A refusal is the line's reason until the next try (one per settle window), never swallowed.
          const reason = error instanceof Error ? error.message : String(error);
          await this.store.mutateWorkspace(original.id, w => {
            const b = w.batches.find(b => b.id === pending.id);
            if (b?.state === "pending") b.refusal = { reason, at: new Date(this.now()).toISOString() };
          });
        });
      current = findWorkspace(await this.store.snapshot(), original.id);
      const done = !current.archived && !!current.completion && completionBlockers(current, this.now()).length === 0;
      if (done || current.managedDoneLabel) {
        if (done && !current.managedDoneLabel) await this.store.mutateWorkspace(current.id, w => { w.managedDoneLabel = true; });
        await this.gateway.label(current, done);
        if (!done) await this.store.mutateWorkspace(current.id, w => { w.managedDoneLabel = false; });
      }
      const after = findWorkspace(await this.store.snapshot(), original.id);
      this.observedPass.set(original.id, { w: after, runtime: runtimeKey, at: untouched ? last!.at : this.now() });
      await this.statusCheck(after, this.now(), runtimeKey).catch(() => undefined);
    }
    this.error = null;
  }
  /**
   * A nudge's discovery (a-nudge-costs-its-workspace): only the nudged workspaces, only their dirty agents' kept turn
   * reads, each applied with a one-workspace mutation. 2026-11-13 (run Y, the CI live shape): every turn end's nudge ran
   * discovery over all 140 workspaces and a whole-state copy, and the burst grew V8's committed pages from 87 to 165 MB.
   * False when a nudged workspace needs the whole state (not yet saved, parked by the active-scope migration, or the
   * migration not yet run): the full discovery runs instead.
   */
  private async discoverScoped(saved: State, affected: ReadonlySet<string>): Promise<boolean> {
    if (!saved.migrations?.includes(ACTIVE_SCOPE_MIGRATION)) return false;
    if ([...affected].some(id => !saved.workspaces.some(w => w.id === id) || saved.autoSendsParked?.includes(id))) return false;
    const rows = await this.gateway.discover!(saved, undefined, { workspaces: affected });
    for (const row of rows) {
      const current = await this.store.snapshot();
      if (!followsByDefault(current, row) && !current.workspaces.some(w => w.id === row.id && w.enable_tracking && !w.archived)) continue;
      await this.store.mutateWorkspace(row.id, w => applyDiscovery({ ...current, workspaces: current.workspaces.map(x => x.id === w.id ? w : x) }, [row], this.now()));
    }
    return true;
  }
  async activate(workspaceId: string): Promise<Workspace> {
    if (this.stopped || !this.gateway.discover) throw new Error("Workspace tracking is unavailable");
    const rows = await this.gateway.discover(await this.store.snapshot(), workspaceId);
    if (!rows.some(row => row.id === workspaceId)) throw new Error("This workspace has no available main agent");
    await this.store.mutate(state => {
      applyDiscovery(state, rows.filter(row => row.id === workspaceId), this.now());
      const w = findWorkspace(state, workspaceId);
      if (!w.enable_tracking && startsWithAutoSend(state, w)) w.enable_auto_sends = true;
      w.enable_tracking = true;
      // Following again ends an opt-out.
      if (state.workspaceOptOuts?.includes(workspaceId)) state.workspaceOptOuts = state.workspaceOptOuts.filter(id => id !== workspaceId);
    });
    const activated = findWorkspace(await this.store.snapshot(), workspaceId);
    void this.tick();
    return activated;
  }
  /** Records the developer's answer, then sends it unless they chose to copy it. */
  async answer(workspaceId: string, questionId: string, choice: string, words: string | undefined, action: AnswerAction, actor: Actor = DEVELOPER): Promise<{ workspace: Workspace; question: Question }> {
    await this.store.mutateWorkspace(workspaceId, w => {
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      developerAnswer(w, questionId, choice, words, action, this.now(), actor);
      if (!w.questions.some(isOpenQuestion)) w.updatedAt = new Date(this.now()).toISOString();
    });
    // Recorded as "sending": the reply goes back now and the message after it. Reaching a dormant agent can take Paseo
    // longer than the 30 s a plugin RPC gets; the question shows sending → sent (or queued, unconfirmed) as it lands.
    if (action !== "copy" && action !== "chat") this.later(() => this.deliverAnswer(workspaceId, questionId));
    const workspace = findWorkspace(await this.store.snapshot(), workspaceId);
    return { workspace, question: workspace.questions.find(q => q.id === questionId)! };
  }
  /** Work that runs after an RPC replied. Its outcome lands on the record; tests await `idle()`. */
  private deliveries = new Set<Promise<unknown>>();
  private later(work: () => Promise<unknown>): void {
    const p = work().catch(error => console.warn(`[follow-up] background delivery failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => this.deliveries.delete(p));
    this.deliveries.add(p);
  }
  async idle(): Promise<void> { while (this.deliveries.size) await Promise.allSettled([...this.deliveries]); }
  /** One delivery attempt's cap: past it the answer reads "unconfirmed" instead of "sending" forever. */
  deliveryAttemptMs = 120_000;
  /** The attempt deadline runs on this; tests inject fake timers (see Timers). */
  timers: Timers = realTimers;
  private async deliverAnswer(workspaceId: string, questionId: string): Promise<void> {
    const w = findWorkspace(await this.store.snapshot(), workspaceId);
    const q = w.questions.find(q => q.id === questionId);
    if (!q?.answer?.delivery.messageId || !["sending", "queued"].includes(q.answer.delivery.state)) return;
    let outcome: { state: "sent" | "queued" | "unconfirmed"; to: string | null; reason: string | null };
    try {
      if (!this.gateway.deliver) throw new DeliveryDeferred("Messaging is unavailable in this Paseo version; copy the answer instead.");
      const to = await withDeadline(this.gateway.deliver(w, answerRecipients(w, q), answerMessage(q, q.answer.choice, q.answer.words), q.answer.delivery.messageId), this.deliveryAttemptMs, "Paseo didn't confirm the answer in time", this.timers);
      outcome = { state: "sent", to, reason: null };
    } catch (error) {
      outcome = error instanceof DeliveryDeferred
        ? { state: "queued", to: null, reason: error.message }
        : { state: "unconfirmed", to: null, reason: "Paseo didn't confirm the message. Check the agent's chat before resending." };
    }
    await this.store.mutateWorkspace(workspaceId, w => {
      const current = w.questions.find(x => x.id === questionId);
      if (!current?.answer || current.answer.delivery.messageId !== q.answer!.delivery.messageId) return;
      current.answer.delivery = { ...current.answer.delivery, ...outcome, at: new Date(this.now()).toISOString() };
    });
  }
  async sendPending(workspaceId: string, batchId: string): Promise<Workspace> {
    const before = findWorkspace(await this.store.snapshot(), workspaceId).batches.find(b => b.id === batchId);
    if (before && isRecovery(before)) return this.sendRecoveryPending(workspaceId, batchId);
    const reviewedTasks = JSON.stringify(before?.tasks);
    await this.tick();
    const current = findWorkspace(await this.store.snapshot(), workspaceId);
    if (!current.enable_tracking || current.archived || this.stopped) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
    if (current.hold) throw new Error(current.hold);
    if (current.batches.some(b => !isRecovery(b) && ["sending", "sent", "blocked", "uncertain"].includes(b.state))) throw new Error("Resolve the outstanding batch before sending another");
    const batch = current.batches.find(b => b.id === batchId && b.state === "pending");
    if (!batch) throw new Error("This batch has changed or resolved; refresh the queue");
    if (JSON.stringify(batch.tasks) !== reviewedTasks) throw new Error("Tasks changed during refresh. Review the updated batch before sending.");
    return this.dispatch(workspaceId, batchId, false);
  }
  private async dispatch(workspaceId: string, batchId: string, automatic: boolean): Promise<Workspace> {
    const current = findWorkspace(await this.store.snapshot(), workspaceId);
    const batch = current.batches.find(b => b.id === batchId && b.state === "pending");
    if (batch && isRecovery(batch)) throw new Error("Recovery requires its own explicit action.");
    if (!batch || !current.enable_tracking || current.archived || current.hold || this.stopped || (automatic && (!current.enable_auto_sends || this.autoSendsHeld()))) throw new Error("Workspace or queue is no longer ready to send");
    if (current.goneAgent?.agentId === current.mainAgentId) throw new Error(GONE_REASON);
    if (needsPrObservations(current, batch) && current.prs.some(p => p.error || !p.snapshot?.complete)) throw new Error("PR status is incomplete; refresh before sending repairs");
    const runtime = await this.gateway.observe(current, true);
    if (runtime.busy || runtime.backgroundBusy || runtime.reason || runtime.archived) throw new Error(runtime.reason ?? "The workspace has active agent work. Send when it is idle.");
    const claimed = await this.store.mutateWorkspace(workspaceId, w => {
      const b = w.batches.find(b => b.id === batchId);
      if (this.stopped || !w.enable_tracking || w.archived || w.hold || (automatic && !w.enable_auto_sends) || !b || b.state !== "pending" || w.batches.some(other => other.id !== b.id && !isRecovery(other) && ["sending", "sent", "blocked", "uncertain"].includes(other.state))) throw new Error("Workspace or queue changed; refresh before sending");
      const eligible = tasksFor(w, this.now(), this.wording);
      if (b.tasks.some(t => t.kind === "obligation" && !eligible.some(e => e.key === t.key && e.fingerprint === t.fingerprint))) throw new Error("Task dependencies changed or deployment evidence expired. Refresh before sending.");
      b.state = "sending"; delete b.refusal;
      return { w, b };
    });
    return this.deliver(claimed, workspaceId, batchId);
  }
  async startRecovery(workspaceId: string): Promise<Workspace> {
    const batchId = randomUUID();
    await this.store.mutateWorkspace(workspaceId, w => {
      if (!w.enable_tracking || w.archived || this.stopped) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      if (w.batches.some(b => isRecovery(b) && (["pending", "sending", "sent", "uncertain"].includes(b.state) || b.state === "blocked" && !b.settledAt))) throw new Error("Check the existing recovery before starting another.");
      w.batches.push({ id: batchId, enable_manual_recovery: true, messageId: randomUUID(), tasks: [{ key: `inventory:${w.id}`, kind: "inventory", target: w.id, title: "Recover workspace PR stacks and remaining work", fingerprint: String(w.inventory?.revision ?? 1) }], state: "pending", attempts: 1, createdAt: new Date(this.now()).toISOString(), sentAt: null, settledAt: null, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] });
    });
    return this.sendRecoveryPending(workspaceId, batchId);
  }
  private async sendRecoveryPending(workspaceId: string, batchId: string): Promise<Workspace> {
    const claimed = await this.store.mutateWorkspace(workspaceId, w => {
      const b = w.batches.find(b => b.id === batchId);
      if (this.stopped || !w.enable_tracking || w.archived || !b || !isRecovery(b) || b.state !== "pending" || w.batches.some(other => other.id !== b.id && isRecovery(other) && (["pending", "sending", "sent", "uncertain"].includes(other.state) || other.state === "blocked" && !other.settledAt))) throw new Error("Recovery changed or another recovery is active.");
      b.state = "sending"; return { w, b };
    });
    const operation = this.deliver(claimed, workspaceId, batchId);
    this.recoveryOperations.add(operation);
    void operation.then(() => this.recoveryOperations.delete(operation), () => this.recoveryOperations.delete(operation));
    return findWorkspace(await this.store.snapshot(), workspaceId);
  }
  private async deliver(claimed: { w: Workspace; b: Batch }, workspaceId: string, batchId: string): Promise<Workspace> {
    let sending = false;
    try {
      if (isRecovery(claimed.b)) {
        const recovery = await this.gateway.prepareRecovery(claimed.w, claimed.b);
        await this.store.mutateWorkspace(workspaceId, w => {
          const b = w.batches.find(b => b.id === batchId)!;
          b.recipientAgentId = recovery.agentId; b.contextPath = recovery.contextPath;
        });
        claimed.b.recipientAgentId = recovery.agentId; claimed.b.contextPath = recovery.contextPath;
      } else {
        claimed.b.recipientAgentId = claimed.w.mainAgentId;
        await this.store.mutateWorkspace(workspaceId, w => { w.batches.find(b => b.id === batchId)!.recipientAgentId = claimed.w.mainAgentId; });
      }
      if (this.stopped) throw new Error("Follow-up stopped before delivery");
      sending = true;
      await this.gateway.send(claimed.w, claimed.b, batchPrompt(claimed.w, claimed.b));
      await this.store.mutateWorkspace(workspaceId, w => {
        const b = w.batches.find(b => b.id === batchId)!;
        if (b.state === "sending") { b.state = "sent"; b.sentAt = new Date(this.now()).toISOString(); }
      });
    } catch (error) {
      await this.store.mutateWorkspace(workspaceId, w => {
        const b = w.batches.find(b => b.id === batchId)!;
        if (b.state === "sending" && error instanceof ConversationGone) {
          // Nothing reached the agent. Keep the batch for a new agent and stop retrying this one.
          b.state = "pending"; b.result = ""; b.recipientAgentId = null;
          w.goneAgent = { agentId: error.agentId, at: new Date(this.now()).toISOString(), reason: error.message };
          w.runtimeReason = GONE_REASON;
          return;
        }
        if (b.state === "sending" && error instanceof DeliveryDeferred) {
          b.state = "pending"; b.result = "";
          if (!isRecovery(b)) w.runtimeReason = error.message;
          return;
        }
        if (b.state === "sending") { b.state = sending ? "uncertain" : "blocked"; b.result = sending ? "Delivery could not be confirmed. Check the assigned agent before retrying." : `Could not prepare the recovery agent: ${error instanceof Error ? error.message : "Unknown error"}`; }
      });
    }
    return findWorkspace(await this.store.snapshot(), workspaceId);
  }
  /** When each uncertain batch's chat was last read, so an unknown answer is asked again at most once a minute. */
  private arrivalChecks = new Map<string, number>();
  /**
   * A batch left uncertain (a reload or a lost reply mid-send): read the recipient's chat for its messageId. There:
   * it was sent. Not there: back to the queue under the same messageId, so it goes out once. Unknown (reading would
   * wake the agent): it stays uncertain and asks the developer to check.
   */
  private async checkArrivals(workspaceId: string): Promise<void> {
    if (!this.gateway.arrived) return;
    const w = findWorkspace(await this.store.snapshot(), workspaceId);
    for (const b of w.batches.filter(b => b.state === "uncertain" && !isRecovery(b))) {
      if (this.now() - (this.arrivalChecks.get(b.id) ?? -Infinity) < 60_000) continue;
      this.arrivalChecks.set(b.id, this.now());
      const arrived = await this.gateway.arrived(w, b).catch(() => null);
      if (arrived === null) continue;
      await this.store.mutateWorkspace(workspaceId, current => {
        const x = current.batches.find(x => x.id === b.id);
        if (x?.state !== "uncertain") return;
        const at = new Date(this.now()).toISOString();
        if (arrived) { x.state = "sent"; x.sentAt ??= at; x.activityAt = at; x.result = ""; }
        else { x.state = "pending"; x.sentAt = null; x.result = ""; x.recipientAgentId = null; }
      });
      this.arrivalChecks.delete(b.id);
    }
  }
  private reconcile(w: Workspace): void {
    const tasks = tasksFor(w, this.now(), this.wording);
    // Hysteresis: a queued Done check survives the agent's own turns; only a real change (new work, Done) ends it.
    const queuedCheck = w.batches.find(b => b.state === "pending" && completionCheck(b));
    if (queuedCheck && w.runtimeBusy && !tasks.some(t => t.kind === "completion")) tasks.push(...tasksFor({ ...w, runtimeBusy: false }, this.now(), this.wording).filter(t => t.kind === "completion"));
    // One cap (Q49): a send that left a PR condition as it was, acknowledged or not, delivered nothing GitHub shows, so
    // the condition goes out again until it has gone out NO_PROGRESS_CAP times unchanged. An acknowledged one waits
    // for a GitHub read newer than the acknowledgment, so a fix GitHub hasn't shown yet is never sent twice.
    const delivered = new Set(w.batches.filter(b => ["sending", "sent", "completed", "blocked", "uncertain"].includes(b.state) && !(b.state === "completed" && b.unacknowledged))
      .flatMap(b => b.tasks.filter(t => b.state !== "completed" || !isRepair(t) || !readSince(w, t, b.settledAt)).map(conditionId)));
    const open = tasks.filter(t => !delivered.has(conditionId(t)));
    // One rule for every task in a message (Q49): a task the developer keeps for themselves, or a condition that went
    // out NO_PROGRESS_CAP times unchanged, stays out of it; only that task waits, the rest go out.
    const manual = new Set(w.manualTasks ?? []);
    const held: NonNullable<Workspace["heldTasks"]> = [];
    for (const t of open) if (t.kind !== "completion" && (manual.has(t.key) || isCapped(w, t))) held.push({ task: t, held: manual.has(t.key) ? "manual" : "capped" });
    const fresh = open.filter(t => !held.some(h => h.task === t));
    if (held.length || w.heldTasks?.length) w.heldTasks = held;
    let pending = w.batches.find(b => b.state === "pending" && !isRecovery(b));
    if (!fresh.length) {
      if (pending) { pending.state = "cancelled"; pending.result = "Conditions resolved before delivery"; }
      if (w.nextMessage) w.nextMessage = null;
      return;
    }
    if (pending) {
      // One queued message per workspace, updated in place: the settle clock stays at the first queued task, so a
      // flapping check can't keep it "in a moment" forever. A changed list gets a fresh try after a refusal.
      if (JSON.stringify(pending.tasks) !== JSON.stringify(fresh)) { pending.tasks = fresh; delete pending.refusal; }
    } else {
      pending = { id: randomUUID(), messageId: randomUUID(), tasks: fresh, state: "pending", createdAt: new Date(this.now()).toISOString(), sentAt: null, settledAt: null, attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] };
      w.batches.push(pending);
    }
    w.nextMessage = pending.state === "pending" ? messageText(w, pending) : null;
    // New repairs or tasks reopen the work; the Done check itself does not.
    if (fresh.some(t => t.kind !== "completion")) { w.completion = null; w.declaration = null; }
  }
  /**
   * Accepts Done when nothing the agent or developer must do remains. A deploy Follow-up can't confirm is not a
   * blocker: Done is recorded with a "Deploy not confirmed by Follow-up" note and the agent's summary as evidence.
   * Repeating it is a no-op (alreadyDone), and `next` tells the agent whether anything is its to fix.
   */
  async declareDone(agentId: string, message: string, workspaceId?: string): Promise<DoneResult> {
    const current = ownedWorkspace(await this.store.snapshot(), agentId, workspaceId);
    // Delivery may wait for this very turn to finish, so declarations observe independently.
    const [runtime, observations] = await Promise.all([
      this.gateway.observe(current, true),
      this.github.observe(current.prs),
    ]);
    return this.store.mutate(state => {
      const w = ownedWorkspace(state, agentId, workspaceId);
      w.runtimeBusy = runtime.busy; w.runtimeReason = runtime.reason; w.taskAgents = runtime.taskAgents;
      w.backgroundBusy = runtime.backgroundBusy ?? false;
      if (runtime.archived) w.archived = true;
      for (const pr of w.prs) {
        const observation = observations.get(pr.key);
        pr.error = observation?.error ?? (observation?.snapshot ? null : "PR status unavailable during completion verification");
        if (observation?.snapshot) recordSnapshot(pr, observation.snapshot, this.now());
      }
      // The declaration is made inside the owner's turn; that foreground turn is allowed.
      const gate = completionGate({ ...w, runtimeBusy: false }, this.now());
      if (w.archived) gate.blockers.push({ owner: "developer", text: "Workspace is archived" });
      const blockers = gate.blockers.map(b => b.text);
      if (gate.blockers.length) {
        // Nothing left for the agent or developer: keep the declaration and let Follow-up finish it, so nobody retries.
        const stored = gate.blockers.every(b => b.owner === "wait");
        w.declaration = stored ? { summary: message, at: new Date(this.now()).toISOString() } : null;
        return { workspace: w, blockers, unconfirmed: gate.unconfirmed, alreadyDone: false, next: doneGuidance(gate, false, stored) };
      }
      w.declaration = null;
      const alreadyDone = !!w.completion;
      settleDoneChecks(w, this.now());
      if (!alreadyDone) w.completion = { summary: message, declaredAt: new Date(this.now()).toISOString(), ...(gate.unconfirmed.length ? { unconfirmed: gate.unconfirmed } : {}) };
      return { workspace: w, blockers, unconfirmed: gate.unconfirmed, alreadyDone, next: doneGuidance(gate, alreadyDone) };
    });
  }
  async acknowledge(agentId: string, batchId: string, outcome: "completed" | "blocked", result: string, workspaceId?: string): Promise<Workspace> {
    // Resolved on the snapshot, written to that one workspace (a-send-never-clones-the-whole-state), re-checked inside.
    const target = agentWorkspace(await this.store.snapshot(), agentId, "read", workspaceId);
    const w = await this.store.mutateWorkspace(target.id, w => {
      agentWorkspace({ version: 1, workspaces: [w] }, agentId, "read", w.id);
      requireTracking(w, agentId);
      const b = w.batches.find(b => b.id === batchId);
      if (!b || !["sending", "sent", "blocked", "uncertain"].includes(b.state)) throw new Error("Batch is not awaiting acknowledgment.");
      if ((b.recipientAgentId ?? w.mainAgentId) !== agentId) throw new Error(`Only the assigned agent can acknowledge this batch: expected agent ${b.recipientAgentId ?? w.mainAgentId}, received agent ${agentId}.`);
      if (outcome === "completed" && b.tasks.some(t => t.kind === "obligation" && w.obligations.some(o => o.id === t.target && o.communication && o.status !== "waived" && (o.status !== "done" || !replyRecorded(o.communication))))) throw new Error("Record the sent reply on each communication task before completing this batch, or acknowledge blocked with the posting/access reason.");
      b.state = outcome; b.result = result; b.acknowledgmentError = null; b.settledAt = new Date(this.now()).toISOString();
      if (outcome === "completed" && w.inventory) for (const task of b.tasks.filter(t => t.kind === "inventory"))
        w.inventory.syncedRevision = Math.max(w.inventory.syncedRevision, Number(task.fingerprint));
      return w;
    });
    return w;
  }
  /** How long stop waits on a pass or recovery in flight (worker-stop-never-waits-on-a-stuck-pass); tests shorten it. */
  stopWaitMs = STOP_WAIT_MS;
  /** Stops new passes and waits for the one in flight until the stop's deadline for the one in flight; a pass that outlives it can't write (Store.close). */
  async stop(within?: Deadline): Promise<void> { this.stopped = true; if (this.nudgeTimer) clearTimeout(this.nudgeTimer); this.nudgeTimer = null; this.nudgeWaiters.splice(0).forEach(w => w()); await settleWithin(Promise.allSettled([this.running, ...this.recoveryOperations]), within ?? this.stopWaitMs); }
}

export type DoneResult = { workspace: Workspace; blockers: string[]; unconfirmed: string[]; alreadyDone: boolean; next: string };
/** The declare_done reply in words: what's missing, who can move it, and whether calling again could help. */
/** Done answers every open Done check: a queued one is cancelled, a sent one counts as acknowledged. */
function settleDoneChecks(w: Workspace, now: number): void {
  for (const b of w.batches.filter(b => completionCheck(b) && ["pending", "sending", "sent", "blocked", "uncertain"].includes(b.state))) {
    const sent = b.state !== "pending";
    b.state = sent ? "completed" : "cancelled"; b.result = "The main agent declared Done."; if (sent) b.settledAt = new Date(now).toISOString();
  }
}
/** Records a stored declaration as Done; the Done check it answers is no longer needed. */
function acceptDeclaration(w: Workspace, gate: CompletionGate, now: number): void {
  w.completion = { summary: w.declaration!.summary, declaredAt: new Date(now).toISOString(), ...(gate.unconfirmed.length ? { unconfirmed: gate.unconfirmed } : {}) };
  w.declaration = null;
  settleDoneChecks(w, now);
}
export function doneGuidance(gate: CompletionGate, alreadyDone = false, stored = false): string {
  const note = gate.unconfirmed.length ? ` Follow-up couldn't confirm what production serves for ${gate.unconfirmed.join(", ")}, so Done carries "Deploy not confirmed by Follow-up" with your summary as the evidence.` : "";
  if (!gate.blockers.length) return alreadyDone ? `Already Done; nothing changed. Don't call declare_done again.${note}` : `Done accepted.${note} Nothing else to do; the developer archives the workspace.`;
  const yours = gate.blockers.filter(b => b.owner === "agent").map(b => b.text);
  const theirs = gate.blockers.filter(b => b.owner !== "agent").map(b => `${b.text} (${b.owner === "developer" ? "needs the developer" : "Follow-up rechecks on its own"})`);
  const parts = [yours.length ? `Yours to fix, then call declare_done again: ${yours.join("; ")}.` : "", theirs.length ? `Not yours to fix: ${theirs.join("; ")}.` : ""];
  if (stored) parts.push("Follow-up kept your declaration and records Done on its own once these clear. Don't call declare_done again; end the turn.");
  else if (!yours.length) parts.push("Don't call declare_done again until one of these changes; end the turn. If the developer needs to act, say so once.");
  return `Not Done yet. ${parts.filter(Boolean).join(" ")}`;
}

export function findWorkspace(state: State, id: string): Workspace {
  const w = state.workspaces.find(w => w.id === id);
  if (!w) throw new Error("Workspace tracking is initializing; try again shortly.");
  return w;
}
function relatedWorkspace(state: State, agentId: string, workspaceId?: string): Workspace | undefined {
  if (workspaceId) return state.workspaces.find(w => w.id === workspaceId);
  return state.workspaces.find(w => w.mainAgentId === agentId || w.batches.some(b => b.recipientAgentId === agentId));
}
function accessError(w: Workspace | undefined, agentId: string, access: "read" | "write", workspaceId?: string): Error {
  return new Error(`Cannot ${access} follow-up for workspace ${w?.id ?? workspaceId ?? "unknown"}: expected main agent ${w?.mainAgentId ?? "not recorded"}, received agent ${agentId}. Only the main agent or its assigned recovery agent has access. Recorded recovery recipients: ${w?.batches.filter(b => isRecovery(b)).map(b => b.recipientAgentId).filter(Boolean).join(", ") || "none"}.`);
}
function requireTracking(w: Workspace, agentId: string): void {
  if (!w.enable_tracking) throw new Error(`Tracking is inactive for workspace ${w.id}: expected main agent ${w.mainAgentId}, received agent ${agentId}. Saved ownership is intact; agent tools cannot enable tracking.`);
}
export function ownedWorkspace(state: State, agentId: string, workspaceId?: string): Workspace {
  const w = relatedWorkspace(state, agentId, workspaceId);
  if (!w || w.mainAgentId !== agentId) throw new Error(`Only the workspace's main agent can declare completion. Workspace ${w?.id ?? workspaceId ?? "unknown"}: expected main agent ${w?.mainAgentId ?? "not recorded"}, received agent ${agentId}.`);
  requireTracking(w, agentId);
  return w;
}
export function agentWorkspace(state: State, agentId: string, access: "read" | "write" = "write", workspaceId?: string, scope: "owner" | "pr" = "owner"): Workspace {
  const w = relatedWorkspace(state, agentId, workspaceId);
  const recovery = w?.batches.some(b => b.recipientAgentId === agentId && isRecovery(b) && (access === "read" || ["sending", "sent", "uncertain"].includes(b.state) || b.state === "blocked" && !b.settledAt));
  const contributor = scope === "pr" && w?.enable_tracking && !w.archived && w.contributorAgentIds?.includes(agentId);
  if (!w || (w.mainAgentId !== agentId && !recovery && !contributor)) throw accessError(w, agentId, access, workspaceId);
  if (access === "write") requireTracking(w, agentId);
  return w;
}
