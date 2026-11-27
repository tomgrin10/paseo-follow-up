import { followUpObligations } from "../shared/follow-up";
import { taskSchedule } from "../shared/task-trigger";
import { STOP_WAIT_MS, settleWithin, type Deadline } from "./teardown";
import { DEVELOPER, type Actor } from "../shared/actor";
import { randomUUID } from "node:crypto";
import { completionBlockers, completionCheck, completionGate, revokesDone, type CompletionGate, type Workspace, type State, type Batch, type Task } from "../shared/model";
import { Store } from "./store";
import { Github } from "./github";
import { batchPrompt, messageText, tasksFor, isRecovery, needsPrObservations, type TaskWording } from "./tasks";
import { answerRecipients, developerAnswer, dismissQuestion, undoDismiss, syncTaskQuestions, type AnswerAction } from "./questions";
import { answerMessage, isOpen as isOpenQuestion, type Question } from "../shared/questions";
import { reconcileSubmittedStacks } from "./submissions";
import { applyDiscovery, interruptionHold, startsWithAutoSend, type DiscoveredWorkspace } from "./discovery";
import { ACTIVE_SCOPE_MIGRATION, followsByDefault, migrateActiveScope } from "../shared/settings";
import { replyRecorded } from "../shared/communication";
import { DeliveryDeferred, ConversationGone } from "./delivery";
import type { CheckWatches } from "./check-watches";
import type { ScheduledTasks } from "./scheduled-tasks";
import type { MessageQueue, Resolution, Target } from "./message-queue";
import type { ImageRef } from "../shared/images";
import { PASEO_UNREACHABLE, deliveryOf, type NewQueueItem, type QueueItem, type QueueItemInput } from "../shared/queue";
import { recordSnapshot } from "./deployment-anchor";
import { pruneUnsent } from "./batch-archive";
import { holdSuperseded, liftHold } from "../shared/status";
import { agentAnswered, DEFAULT_MAX_AUTO_SENDS, runningAutoTurns, changedNotGone, conditionId, holdsQueue, inProgressHolds, IN_PROGRESS_MAX_MS, isCapped, MAIN_WAIT, movedOnReason, personHeld, personPart, QUIET_WAIT, readSince, repairWait, sendDecision, settleUnacknowledged, stillApplies, stuckRepair, UNACKNOWLEDGED_MS, type MainWait } from "../shared/send-decision";
import { isRepair } from "../shared/task-rows";
export { settleUnacknowledged, UNACKNOWLEDGED_MS, NO_PROGRESS_CAP, repairWait, QUIET_WAIT } from "../shared/send-decision";

export interface Runtime {
  busy: boolean; reason: string | null; archived: boolean; backgroundBusy?: boolean;
  /**
   * What the main agent itself is doing that holds a repair (Workspace.mainBusy, Q96 = A). `busy` and `backgroundBusy`
   * are the whole workspace (Done, "all work finished"); only this decides a repair. Undefined: unknown, so a repair
   * treats the workspace's busy as the main agent's (repairWait).
   */
  mainBusy?: MainWait | null;
  /** Live state of the agents working tasks name (Workspace.taskAgents). Undefined: unknown, so every line naming an agent says "Agent unavailable". */
  taskAgents?: Workspace["taskAgents"];
  guarded?: boolean; guardedInterruptionId?: string;
  /** The main agent's runtime is loaded (see isLoaded). Undefined means unknown. Never gates a send (Q177): a send resumes it. */
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
  /**
   * Paseo 0.17.1+ draws Follow-up's Done as a sidebar row badge (client/row-badges.tsx), so the worker writes no
   * Done label there and takes back one it wrote before (row-badges-replace-sidebar-labels). Absent or false: the label.
   */
  rowBadges?(): Promise<boolean>;
  /** A tick begins: the gateway may list agents once for it (a-send-lists-agents-at-most-once-per-tick). */
  tickStarted?(): void;
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
  constructor(readonly store: Store, private github: Pick<Github, "observe"> & Partial<Pick<Github, "waitUntil" | "off">>, private gateway: Gateway, private now = Date.now, private settleMs = 60_000, private nudgeMs = NUDGE_MS) {}
  async recover(): Promise<void> {
    await this.store.mutate(state => {
      for (const w of state.workspaces) {
        const eligible = tasksFor(w, this.now(), this.wording);
        for (const b of w.batches.filter(b => b.state === "pending" && !isRecovery(b))) {
          b.tasks = b.tasks.filter(t => t.kind !== "obligation" || eligible.some(e => e.key === t.key && e.fingerprint === t.fingerprint));
          if (!b.tasks.length) { b.state = "cancelled"; b.result = "No triggered task is due. Unscheduled work remains in Tasks."; }
        }
        // A batch left blocked or unconfirmed by a release before a-batch-item-leaves-once-nothing-applies, whose PRs
        // have since merged or changed, settles at start-up, dormant workspaces included (no tick observes those).
        if (w.enable_tracking && !w.archived) settleMoot(w, eligible, this.now());
        const healed = healBatches(w);
        if (healed.restored || healed.relabelled || healed.duplicates) console.warn(`[follow-up] healed batches in ${w.id}: ${healed.restored} answered restored, ${healed.relabelled} relabelled as updated, ${healed.duplicates} duplicates set aside`);
        for (const b of w.batches) if (isRecovery(b) && b.state === "pending" && !b.enable_manual_recovery) { b.state = "cancelled"; b.result = "Recovery is now optional. Run recovery when needed; registered work continues independently."; }
        if (["Recovery stopped or failed. Check the recovery agent before retrying.", "Recovery acknowledgment was refused. Check the identity error on this batch."].includes(w.hold ?? "")) w.hold = null;
      }

      for (const w of state.workspaces) for (const a of w.prActions) if (a.state === "sending") { a.state = "uncertain"; a.result = `Follow-up reloaded before ${a.kind === "request_reviewers" ? "GitHub confirmed the review request" : w.prs.some(p => a.prs.includes(p.key) && p.snapshot?.prWorkflow === "github") ? "GitHub confirmed the action" : "Graphite confirmed the action"}. Check state before sending another request.`; }
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
  private observedPass = new Map<string, { w: Workspace; runtime: string; at: number; dueAt: number }>();
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
  /**
   * When Follow-up's GitHub reads resume for this workspace's open PRs, while the account's budget is under the reserve
   * (`Github.waitUntil`): the earliest reset among their repositories, or null when reads run. Merged and closed PRs
   * aren't read anyway, so a workspace with only those says nothing.
   */
  private githubWait(w: Workspace): string | null {
    if (!this.github.waitUntil) return null;
    const until = [...new Set(w.prs.filter(p => p.snapshot?.state !== "MERGED" && p.snapshot?.state !== "CLOSED").map(p => p.repo))]
      .map(repo => this.github.waitUntil!(repo)).filter((t): t is number => t !== null && t > this.now());
    return until.length ? new Date(Math.min(...until)).toISOString() : null;
  }
  /** Reads one workspace's PRs fresh and records what came back, nothing else (a Refresh of a dormant workspace). */
  private async refreshPrs(w: Workspace): Promise<void> {
    // GitHub off (works-without-github) is one fact for the host; observe reads nothing then.
    const off = (await this.github.off?.().catch(() => null)) ?? null;
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
    if (this.paused()) {
      // The governor holds background work (discovery, agent reads, auto-sends), never a read the developer starts
      // (a-read-the-developer-starts-never-waits-on-the-governor, invariant 106): Refresh still reads that workspace's
      // PRs, the dormant path's read (no agent observation, repairs or sends). 2026-11-23: Refresh did nothing at all
      // while the machine was busy.
      const asked = !o.background && !o.affected && o.workspaceId ? (await this.store.snapshot()).workspaces.find(w => w.id === o.workspaceId && w.enable_tracking && !w.archived) : undefined;
      if (asked) await this.refreshPrs(asked); else this.skipped++;
      return;
    }
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
    if (!active.length) { await this.afterPass(o.affected); this.error = null; return; }
    // Busy workspaces keep every-tick PR reads: their agent may push or answer review at any moment.
    const keys = (ws: Workspace[]) => new Set(ws.flatMap(w => w.prs.map(p => p.key)));
    const hot = keys(active.filter(isHot));
    const read = o.affected ? active.filter(w => o.affected!.has(w.id)) : active;
    // GitHub off (works-without-github) is one fact for the host; observe reads nothing then.
    const off = (await this.github.off?.().catch(() => null)) ?? null;
    const observations = await this.github.observe(read.flatMap(w => w.prs), o.background || o.workspaceId ? { background: true, hot, fresh: keys(active.filter(w => w.id === o.workspaceId)), watched: this.checkWatches?.watched() } : {});
    // A nudge observes only its workspaces (a-nudge-costs-its-workspace); the timer's tick observes every active one.
    for (const original of o.affected ? read : active) {
      if (this.stopped) return;
      const runtime = await this.gateway.observe(original).catch((): Runtime => ({ busy: false, reason: "Agent state unavailable; refresh will retry", archived: false }));
      const pruned: Batch[] = [];
      // An untouched workspace isn't copied (a-tick-copies-the-state-at-most-once): same state object as the last pass
      // left, same runtime, no PR read or error it hasn't recorded, and a full pass under OBSERVE_FULL_MS ago (time-based
      // rules, like the 120 s acknowledgement, run on that pass). The checks cost a ~200-byte JSON and a shallow compare per PR.
      const runtimeKey = JSON.stringify(runtime);
      const githubWait = this.githubWait(original);
      const githubOff = original.prs.length ? off : null;
      const last = this.observedPass.get(original.id);
      // A scheduled task due since the last pass makes it a full pass, so a trigger fires at its time, not up to a minute late.
      const untouched = (original.githubWait?.until ?? null) === githubWait && (original.githubOff ?? null) === githubOff && !!last && last.w === original && last.runtime === runtimeKey && this.now() - last.at < OBSERVE_FULL_MS && this.now() < last.dueAt && o.workspaceId !== original.id &&
        original.prs.every(p => { const seen = observations.get(p.key); return !seen || seen.error === p.error && sameSnapshot(seen.snapshot, p.snapshot, !isHot(original) && !awaitsRead(original)); });
      if (!untouched) this.observationWrites++;
      if (!untouched) await this.store.mutateWorkspace(original.id, w => {
        w.runtimeBusy = runtime.busy; w.runtimeReason = runtime.reason; w.taskAgents = runtime.taskAgents;
        w.backgroundBusy = runtime.backgroundBusy ?? false;
        w.mainBusy = repairWait(runtime);
        if ((w.githubWait?.until ?? null) !== githubWait) w.githubWait = githubWait ? { until: githubWait } : null;
        if ((w.githubOff ?? null) !== githubOff) w.githubOff = githubOff;
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
        // Other agents' work (a subagent, a background job, a turn that never ends) keeps a sent message open only up to
        // IN_PROGRESS_MAX_MS after it went out: a busy signal that can't clear never holds the queue forever. The main
        // agent's own work (its turn, Session Guard) always does.
        const othersOnly = !!unacknowledged && !runtime.guarded && !repairWait(runtime) && (runtime.busy || !!runtime.backgroundBusy);
        const othersExpired = othersOnly && this.now() - Date.parse(unacknowledged!.sentAt!) > IN_PROGRESS_MAX_MS;
        if (unacknowledged && !othersExpired && (runtime.guarded || runtime.busy || runtime.backgroundBusy || original.runtimeReason?.startsWith("Waiting for Session Guard"))) unacknowledged.activityAt = new Date(this.now()).toISOString();
        if (unacknowledged && (!runtime.busy || othersExpired) && !runtime.reason && this.now() - Date.parse(unacknowledged.activityAt ?? unacknowledged.sentAt!) > UNACKNOWLEDGED_MS) {
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
      let current = findWorkspace(await this.store.snapshot(), original.id);
      // Persist the holds that live only in this refresh, so every surface can say why repairs wait (shared/status.ts).
      // Q177: whether Paseo has the main agent loaded never decides an Auto-send (a send resumes it); the active window
      // does (stale), and so does the limit on Follow-up-started turns (invariant 133).
      let sendWait: Workspace["sendWait"] = this.autoSendsHeld() ? "setup" : runtime.mainRecent === false ? "stale" : null;
      const pending = current.batches.find(b => b.state === "pending" && !isRecovery(b));
      if (!sendWait && pending && !pending.automatic && sendDecision({ ...current, sendWait: null }, this.now(), { settleMs: this.settleMs, batch: pending }).send && !await this.turnFree(current.id, pending)) sendWait = "limit";
      if ((current.sendWait ?? null) !== sendWait) { await this.store.mutateWorkspace(original.id, w => { w.sendWait = sendWait; }); current = findWorkspace(await this.store.snapshot(), original.id); }
      // The refresh's runtime state is persisted above, so this reads the same inputs as every surface's line
      // (shared/send-decision.ts). It never sends past the active window or the limit, or sends the Done check.
      if (pending && sendDecision(current, this.now(), { settleMs: this.settleMs, batch: pending }).send)
        await this.dispatch(current.id, pending.id, true).catch(async (error: unknown) => {
          // A refusal is the line's reason until the next try (one per settle window), never swallowed.
          const reason = error instanceof Error ? error.message : String(error);
          await this.store.mutateWorkspace(original.id, w => {
            const b = w.batches.find(b => b.id === pending.id);
            if (b?.state === "pending") b.refusal = { reason, at: new Date(this.now()).toISOString() };
          });
        });
      // A repair the queue holds for its agent (a running turn, Session Guard, a permission prompt) goes as soon as this
      // tick sees the agent free, never on the retry ladder's next step (up to 5 min later; 2026-11-16 harness: a repair
      // held by Session Guard, and once one held by a turn, waited out the ladder after the agent was idle). The holds
      // this tick can't see clear on their own: Paseo unreachable (the probe), the previous message, GitHub's answer.
      const held = current.batches.find(b => b.state === "pending" && !isRecovery(b));
      const heldItem = held && this.queue?.get(repairItemId(current.id, held.id));
      // An Auto send keeps its own pace (a refusal retries once per settle window: the-send-line-matches-the-send-decision);
      // only the developer's Send, or any repair waiting out a turn, goes on this tick.
      const due = heldItem?.state === "queued" && !!heldItem.reason && (MAIN_WAITS.has(heldItem.reason) || !heldItem.ref.automatic && heldAgentSide(heldItem.reason));
      if (due && !repairWait(runtime) && !runtime.reason) await this.queue!.retry(heldItem!.id).catch(() => undefined);
      current = findWorkspace(await this.store.snapshot(), original.id);
      const done = !current.archived && !!current.completion && completionBlockers(current, this.now()).length === 0;
      // On a host with row badges the client's Done badge says it; a label we wrote before comes off once.
      const labelled = done && !(await this.gateway.rowBadges?.().catch(() => false));
      if (labelled || current.managedDoneLabel) {
        if (labelled && !current.managedDoneLabel) await this.store.mutateWorkspace(current.id, w => { w.managedDoneLabel = true; });
        await this.gateway.label(current, labelled);
        if (!labelled) await this.store.mutateWorkspace(current.id, w => { w.managedDoneLabel = false; });
      }
      const after = findWorkspace(await this.store.snapshot(), original.id);
      this.observedPass.set(original.id, { w: after, runtime: runtimeKey, at: untouched ? last!.at : this.now(), dueAt: nextDue(after, this.now()) });
      await this.statusCheck(after, this.now(), runtimeKey).catch(() => undefined);
    }
    await this.afterPass(o.affected);
    this.error = null;
  }
  /**
   * Wait for checks (server/check-watches.ts): agents waiting on a PR's checks hear from the reads this pass just made,
   * never from a read of their own (waiting-for-checks-adds-no-github-read). A nudge's pass judges only its workspaces.
   */
  checkWatches: Pick<CheckWatches, "watched" | "evaluate"> | null = null;
  /** Scheduled tasks (server/scheduled-tasks.ts): a task's time trigger fires from the pass its due time started. */
  scheduledTasks: Pick<ScheduledTasks, "evaluate"> | null = null;
  private async afterPass(affected?: ReadonlySet<string>): Promise<void> {
    if (this.stopped) return;
    if (this.checkWatches) await this.checkWatches.evaluate(affected).catch(error => console.warn(`[follow-up] couldn't check the waits for checks: ${error instanceof Error ? error.message : String(error)}`));
    if (this.scheduledTasks && !this.stopped) await this.scheduledTasks.evaluate(affected).catch(error => console.warn(`[follow-up] couldn't send the scheduled tasks: ${error instanceof Error ? error.message : String(error)}`));
  }
  /**
   * A nudge's discovery (a-nudge-costs-its-workspace): only the nudged workspaces and their dirty agents (the kept turn
   * read, else a read of that agent), each applied with a one-workspace mutation. 2026-11-13 (run Y, the CI live shape): every turn end's nudge ran
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
  /**
   * Invariant 133: a free Auto-send turn for this batch. Turns running (runningAutoTurns) plus older batches already
   * waiting for one (sendWait "limit", still pending elsewhere) stay under the limit, so turns go oldest first.
   */
  private async turnFree(workspaceId: string, batch: Batch): Promise<boolean> {
    const state = await this.store.snapshot();
    const limit = state.maxAutoSends ?? DEFAULT_MAX_AUTO_SENDS;
    const now = this.now();
    const live = state.workspaces.filter(w => w.enable_tracking && !w.archived && !w.dormant);
    const ahead = live.filter(w => w.id !== workspaceId && w.sendWait === "limit" && w.enable_auto_sends &&
      w.batches.some(b => b.state === "pending" && !isRecovery(b) && !b.automatic && b.createdAt < batch.createdAt)).length;
    return runningAutoTurns(live, now) + ahead < limit;
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
    // Its PRs fresh, everything else with the usual backoff: before 2026-11-19 this was a full fresh read of every
    // tracked PR (~100 GraphQL points per follow at 100 open PRs).
    void this.tick({ background: true, workspaceId });
    return activated;
  }
  /** Records the developer's answer, then queues it unless they chose to copy it or put it in chat. */
  async answer(workspaceId: string, questionId: string, choice: string, words: string | undefined, action: AnswerAction, actor: Actor = DEVELOPER, images: ImageRef[] = []): Promise<{ workspace: Workspace; question: Question }> {
    await this.store.mutateWorkspace(workspaceId, w => {
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      developerAnswer(w, questionId, choice, words, action, this.now(), actor);
      if (!w.questions.some(isOpenQuestion)) w.updatedAt = new Date(this.now()).toISOString();
    });
    // Recorded: the reply goes back now. The message goes through the queue (server/message-queue.ts), which saves it
    // before sending, retries what never left, and reads the chat before resending what may have.
    const recorded = findWorkspace(await this.store.snapshot(), workspaceId).questions.find(q => q.id === questionId)!;
    if (this.queue && (action === "send" || action === "resend")) {
      const id = answerItemId(workspaceId, recorded);
      const queued = this.queue.get(id);
      if (action === "resend" && queued && !["sent", "cancelled"].includes(queued.state)) await this.queue.retry(id);
      else this.queue.enqueue({ ...this.answerItem(workspaceId, recorded, action === "resend"), ...(images.length ? { images } : {}) });
    }
    const workspace = findWorkspace(await this.store.snapshot(), workspaceId);
    return { workspace, question: workspace.questions.find(q => q.id === questionId)! };
  }
  /**
   * The developer dismisses a question (or an agent for them), or undoes that. Only the record changes: nothing is
   * queued or sent, so the agent spends no turn on it (dismissing-a-question-sends-the-agent-nothing).
   */
  async dismiss(workspaceId: string, questionId: string, undo: boolean, actor: Actor = DEVELOPER): Promise<{ workspace: Workspace; question: Question }> {
    await this.store.mutateWorkspace(workspaceId, w => {
      if (undo) undoDismiss(w, questionId); else dismissQuestion(w, questionId, actor, this.now());
      w.updatedAt = new Date(this.now()).toISOString();
    });
    const workspace = findWorkspace(await this.store.snapshot(), workspaceId);
    return { workspace, question: workspace.questions.find(q => q.id === questionId)! };
  }
  /** The queue that carries answers; the worker attaches it (tests may leave it off: answers are then only recorded). */
  private queue: MessageQueue | null = null;
  attachQueue(queue: MessageQueue): void {
    this.queue = queue;
    queue.register("answer", { resolve: item => this.resolveAnswer(item), project: item => this.projectAnswer(item) });
    queue.register("repair", { resolve: item => this.resolveRepair(item), project: item => this.projectRepair(item), companions: (key, target) => this.rideAlong(key, target) });
    queue.register("recovery", { resolve: item => this.resolveRecovery(item), project: item => this.projectRepair(item) });
  }
  private answerItem(workspaceId: string, q: Question, now = false): NewQueueItem {
    const a = q.answer!;
    return { id: answerItemId(workspaceId, q), kind: "answer", key: workspaceId, ref: { workspaceId, questionId: q.id }, messageId: a.delivery.messageId!,
      text: answerMessage(q, a.choice, a.words), priority: "now", state: "queued", ...(now ? { nextAt: new Date(this.now()).toISOString() } : {}) };
  }
  /**
   * Every start: an answer its record still shows as on its way, with no queue item, joins the queue (the upgrade from
   * the per-answer sender, or a queue.json that was lost). One that may have left (sending, unconfirmed, retrying) is
   * `uncertain`, so the chat is read before it is sent again.
   */
  async adoptAnswers(): Promise<void> {
    if (!this.queue) return;
    const queue = this.queue;
    const inputs: QueueItemInput[] = [];
    const at = new Date(this.now()).toISOString();
    for (const w of (await this.store.snapshot()).workspaces) for (const q of w.questions) {
      const d = q.answer?.delivery;
      if (!d?.messageId || !["sending", "queued", "unconfirmed", "retrying", "failed"].includes(d.state) || queue.get(answerItemId(w.id, q))) continue;
      const left = d.state !== "queued";
      inputs.push({ ...this.answerItem(w.id, q), state: d.state === "failed" ? "failed" : left ? "uncertain" : "queued", nextAt: d.state === "failed" ? null : at, reason: d.reason ?? null,
        envelope: left ? { messageId: d.messageId, to: d.to, at: d.at } : null, createdAt: d.at });
    }
    await queue.adopt("answers-v1", inputs);
  }
  private async resolveAnswer(item: QueueItem): Promise<Resolution> {
    const w = (await this.store.snapshot()).workspaces.find(w => w.id === item.ref.workspaceId);
    if (!w) return { cancel: "The workspace is gone, so the answer wasn't sent." };
    if (w.archived) return { cancel: "The workspace was archived, so the answer wasn't sent." };
    if (!w.enable_tracking) return { cancel: "Follow-up stopped following this workspace, so the answer wasn't sent." };
    const q = w.questions.find(q => q.id === item.ref.questionId);
    if (!q?.answer || q.answer.delivery.messageId !== item.messageId) return { settled: "cancelled", reason: "The answer was replaced." };
    if (["sent", "recorded", "signed-off"].includes(q.answer.delivery.state)) return { settled: "sent" };
    // Resolved now, not when queued: an asker archived or replaced since falls back to the workspace's main agent.
    return { target: { workspaceId: w.id, recipients: answerRecipients(w, q) } };
  }
  private async projectAnswer(item: QueueItem): Promise<void> {
    const state = deliveryOf(item);
    const snapshot = (await this.store.snapshot()).workspaces.find(w => w.id === item.ref.workspaceId);
    const before = snapshot?.questions.find(q => q.id === item.ref.questionId)?.answer?.delivery;
    if (!before || before.messageId !== item.messageId || ["recorded", "signed-off"].includes(before.state)) return;
    const to = item.to ?? item.envelope?.to ?? before.to;
    const receipt = state === "sent" ? item.receipt ?? null : null;
    if (before.state === state && before.reason === item.reason && (before.nextAt ?? null) === item.nextAt && before.to === to && JSON.stringify(before.receipt ?? null) === JSON.stringify(receipt)) return;
    await this.store.mutateWorkspace(item.ref.workspaceId, w => {
      const a = w.questions.find(q => q.id === item.ref.questionId)?.answer;
      if (!a || a.delivery.messageId !== item.messageId || ["recorded", "signed-off"].includes(a.delivery.state)) return;
      const { receipt: _old, ...kept } = a.delivery;
      a.delivery = { ...kept, state, to, reason: item.reason, nextAt: item.nextAt, at: a.delivery.state === state ? a.delivery.at : new Date(this.now()).toISOString(), ...(receipt ? { receipt } : {}) };
    });
  }
  /** Background work after an RPC replied lands on its record; tests await `idle()`. */
  async idle(): Promise<void> { await this.queue?.idle(); }
  /**
   * The developer's Send on a queued message. Replies once the message is on the queue (no Paseo call): what needs
   * fresh state (the agent still idle, its tasks still due) is checked by the sender, and a refusal lands on the batch.
   */
  async sendPending(workspaceId: string, batchId: string): Promise<Workspace> {
    const before = findWorkspace(await this.store.snapshot(), workspaceId).batches.find(b => b.id === batchId);
    if (before && isRecovery(before)) return this.sendRecoveryPending(workspaceId, batchId);
    const current = findWorkspace(await this.store.snapshot(), workspaceId);
    if (!current.enable_tracking || current.archived || this.stopped) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
    if (current.hold) throw new Error(current.hold);
    if (current.batches.some(b => !isRecovery(b) && holdsQueue(b))) throw new Error("Resolve the outstanding batch before sending another");
    const batch = current.batches.find(b => b.id === batchId && b.state === "pending");
    if (!batch) throw new Error("This batch has changed or resolved; refresh the queue");
    if (current.goneAgent?.agentId === current.mainAgentId) throw new Error(GONE_REASON);
    return this.dispatch(workspaceId, batchId, false);
  }
  /** Puts a pending repair batch on the queue (once). The sender sends it when its agent is idle. */
  private async dispatch(workspaceId: string, batchId: string, automatic: boolean): Promise<Workspace> {
    const current = findWorkspace(await this.store.snapshot(), workspaceId);
    const batch = current.batches.find(b => b.id === batchId && b.state === "pending");
    if (batch && isRecovery(batch)) throw new Error("Recovery requires its own explicit action.");
    if (!batch || !current.enable_tracking || current.archived || current.hold || this.stopped || (automatic && (!current.enable_auto_sends || this.autoSendsHeld()))) throw new Error("Workspace or queue is no longer ready to send");
    if (!this.queue) throw new Error("Follow-up's message queue isn't running.");
    const id = repairItemId(workspaceId, batchId);
    const queued = this.queue.get(id);
    // Already queued: a Send (or a due auto-send) tries it now instead of waiting out its retry time.
    if (queued && !["sent", "cancelled"].includes(queued.state)) { if (!automatic || queued.nextAt) await this.queue.retry(id); }
    else this.queue.enqueue({ ...this.repairItem(current, batch, automatic), ...(automatic ? {} : { nextAt: new Date(this.now()).toISOString() }) });
    // Invariant 133: an Auto-send takes a turn until its turn ends; the developer's Send takes none.
    if (batch.refusal || !!batch.automatic !== automatic) await this.store.mutateWorkspace(workspaceId, w => {
      const b = w.batches.find(b => b.id === batchId);
      if (!b) return;
      if (b.refusal) delete b.refusal;
      if (automatic) b.automatic = true; else if (b.automatic) delete b.automatic;
    });
    return findWorkspace(await this.store.snapshot(), workspaceId);
  }
  private repairItem(w: Workspace, b: Batch, automatic: boolean): NewQueueItem {
    return { id: repairItemId(w.id, b.id), kind: isRecovery(b) ? "recovery" : "repair", key: w.id, ref: { workspaceId: w.id, batchId: b.id, ...(automatic ? { automatic: "1" } : {}) },
      messageId: b.messageId, text: isRecovery(b) ? "" : batchPrompt(w, b), priority: isRecovery(b) ? "now" : "idle", state: "queued" };
  }
  /**
   * A repair goes out only to an idle main agent, and only while it is still due: checked here, when it goes, never in
   * the Send's reply. Waiting (busy, unread PRs, another message open) defers it; a refusal cancels it with the reason.
   */
  private async resolveRepair(item: QueueItem): Promise<Resolution> {
    const w = (await this.store.snapshot()).workspaces.find(w => w.id === item.ref.workspaceId);
    const b = w?.batches.find(b => b.id === item.ref.batchId);
    if (!w || !b) return { cancel: "The message is gone." };
    if (!["pending", "sending", "uncertain"].includes(b.state)) return { settled: "cancelled", reason: b.result || "It settled before it went out." };
    if (w.archived) return { cancel: "The workspace was archived." };
    if (!w.enable_tracking || this.stopped) return { cancel: "Follow-up stopped following this workspace." };
    if (item.state !== "queued") return { target: { workspaceId: w.id, recipients: [b.recipientAgentId ?? w.mainAgentId] } };
    if (w.hold) return { cancel: w.hold };
    if (item.ref.automatic && (!w.enable_auto_sends || this.autoSendsHeld())) return { cancel: "Auto-send was turned off." };
    if (w.goneAgent?.agentId === w.mainAgentId) return { cancel: GONE_REASON };
    if (w.batches.some(o => o.id !== b.id && !isRecovery(o) && holdsQueue(o))) return { defer: "waits for the last message to finish" };
    if (needsPrObservations(w, b) && w.prs.some(p => p.error || !p.snapshot?.complete)) return { defer: "waits until GitHub answers, so the message isn't based on stale PRs" };
    const eligible = tasksFor(w, this.now(), this.wording);
    if (b.tasks.some(t => t.kind === "obligation" && !eligible.some(e => e.key === t.key && e.fingerprint === t.fingerprint))) return { cancel: "Task dependencies changed or deployment evidence expired. Review the updated message." };
    let runtime: Runtime;
    try { runtime = await this.gateway.observe(w, true); }
    catch { return { defer: "Paseo unreachable" }; }
    if (runtime.archived) return { cancel: "The workspace was archived." };
    // A repair waits only for the main agent itself (Q96 = A); the Done check waits for the whole workspace to be quiet.
    if (completionCheck(b) && (runtime.busy || runtime.backgroundBusy)) return { defer: QUIET_WAIT };
    const holds = repairWait(runtime);
    if (holds) return { defer: MAIN_WAIT[holds] };
    if (runtime.reason) return { defer: runtime.reason };
    // The runtime read awaited Paseo: what the developer changed meanwhile (Auto off, a hold) still wins.
    const fresh = (await this.store.snapshot()).workspaces.find(x => x.id === w.id);
    const freshBatch = fresh?.batches.find(x => x.id === b.id);
    if (!fresh || !freshBatch || freshBatch.state !== "pending" || fresh.archived || !fresh.enable_tracking) return { cancel: "The workspace changed before it went out." };
    if (fresh.hold) return { cancel: fresh.hold };
    if (item.ref.automatic && (!fresh.enable_auto_sends || this.autoSendsHeld())) return { cancel: "Auto-send was turned off." };
    item.text = batchPrompt(fresh, freshBatch);
    return { target: { workspaceId: w.id, recipients: [w.mainAgentId] } };
  }
  /** A recovery batch's agent is made when it goes out (a Paseo call), never in the reply. */
  private async resolveRecovery(item: QueueItem): Promise<Resolution> {
    const w = (await this.store.snapshot()).workspaces.find(w => w.id === item.ref.workspaceId);
    const b = w?.batches.find(b => b.id === item.ref.batchId);
    if (!w || !b) return { cancel: "The recovery is gone." };
    if (!["pending", "sending", "uncertain"].includes(b.state)) return { settled: "cancelled", reason: b.result || "It settled before it went out." };
    if (!w.enable_tracking || w.archived || this.stopped) return { cancel: "Follow-up stopped following this workspace." };
    if (b.recipientAgentId && b.contextPath) return { target: { workspaceId: w.id, recipients: [b.recipientAgentId] } };
    let recovery: { agentId: string; contextPath: string };
    try { recovery = await this.gateway.prepareRecovery(w, b); }
    catch (error) { return { cancel: `Could not prepare the recovery agent: ${error instanceof Error ? error.message : "Unknown error"}` }; }
    const updated = await this.store.mutateWorkspace(w.id, x => { const r = x.batches.find(r => r.id === b.id)!; r.recipientAgentId = recovery.agentId; r.contextPath = recovery.contextPath; return x; });
    item.text = batchPrompt(updated, updated.batches.find(r => r.id === b.id)!);
    return { target: { workspaceId: w.id, recipients: [recovery.agentId] } };
  }
  /** The batch's mirror of its queue item: pending while queued, then sending, sent or uncertain. */
  private async projectRepair(item: QueueItem): Promise<void> {
    const at = new Date(this.now()).toISOString();
    const snapshot = (await this.store.snapshot()).workspaces.find(w => w.id === item.ref.workspaceId)?.batches.find(b => b.id === item.ref.batchId);
    if (!snapshot || ["sent", "completed", "cancelled"].includes(snapshot.state) && item.state !== "sent") return;
    if (item.state === "queued" && snapshot.state === "pending" && (!item.reason || snapshot.refusal?.reason === item.reason)) return;
    await this.store.mutateWorkspace(item.ref.workspaceId, w => {
      const b = w.batches.find(b => b.id === item.ref.batchId);
      if (!b) return;
      switch (item.state) {
        case "queued":
          if (b.state !== "pending") { b.state = "pending"; b.result = ""; }
          // Why it waits is the batch line's reason ("didn't send: … · tries again shortly"), as a refused send was.
          if (item.reason && b.refusal?.reason !== item.reason) b.refusal = { reason: item.reason, at };
          break;
        case "sending": b.state = "sending"; b.recipientAgentId = b.recipientAgentId ?? w.mainAgentId; delete b.refusal; break;
        case "sent": if (["sending", "uncertain", "pending"].includes(b.state)) { b.state = "sent"; b.sentAt ??= at; b.activityAt = at; b.result = ""; if (item.to) b.recipientAgentId = item.to; if (item.receipt) b.receipt = item.receipt; } break;
        case "uncertain": b.state = "uncertain"; b.result = "Delivery wasn't confirmed. Follow-up reads the agent's chat before sending it again, so it never arrives twice."; break;
        case "failed":
          if (item.gone) { b.state = "pending"; b.result = ""; b.recipientAgentId = null; w.goneAgent = { agentId: item.gone, at, reason: item.reason ?? "" }; w.runtimeReason = GONE_REASON; }
          else { b.state = "uncertain"; b.result = "Follow-up couldn't confirm the agent got it. Check the agent's chat, then retry."; }
          break;
        case "cancelled":
          if (isRecovery(b) && b.state !== "cancelled") { b.state = "blocked"; b.result = item.reason ?? "Recovery couldn't start."; }
          else if (["pending", "sending"].includes(b.state)) { b.state = "pending"; b.refusal = { reason: item.reason ?? "it couldn't go out", at }; delete b.automatic; }
          break;
      }
    });
  }
  /**
   * Ride-along: an answer going to an idle main agent takes the pending repair with it, when the send decision would
   * send it but for its settle window (and the idle-agent wait, since the answer resumes the agent anyway). One message,
   * one turn, instead of two. Never the Done check, never past a hold, Auto off, an open message or unread PRs.
   */
  private async rideAlong(key: string, target: Target): Promise<NewQueueItem[]> {
    const w = (await this.store.snapshot()).workspaces.find(w => w.id === key);
    if (!w || target.recipients[0] !== w.mainAgentId) return [];
    const b = w.batches.find(b => b.state === "pending" && !isRecovery(b));
    if (!b || this.queue?.get(repairItemId(w.id, b.id))) return [];
    if (!sendDecision({ ...w, sendWait: null }, this.now(), { settleMs: 0, batch: b }).send || this.autoSendsHeld()) return [];
    const runtime = await this.gateway.observe(w, true).catch(() => null);
    if (!runtime || repairWait(runtime) || runtime.reason || runtime.archived) return [];
    return [this.repairItem(w, b, true)];
  }
  /**
   * Every start: a batch its record shows as going out (sending, uncertain) with no queue item joins the queue as
   * `uncertain`, so the chat is read before it goes again (the upgrade from 2.0's sender, or a lost queue.json).
   */
  async adoptBatches(): Promise<void> {
    if (!this.queue) return;
    const queue = this.queue;
    const inputs: QueueItemInput[] = [];
    const at = new Date(this.now()).toISOString();
    for (const w of (await this.store.snapshot()).workspaces) for (const b of w.batches) {
      if (!["sending", "uncertain"].includes(b.state) || queue.get(repairItemId(w.id, b.id))) continue;
      inputs.push({ ...this.repairItem(w, b, false), state: "uncertain", nextAt: at, envelope: { messageId: b.messageId, to: b.recipientAgentId, at: b.sentAt ?? b.createdAt }, createdAt: b.createdAt });
    }
    await queue.adopt("batches-v1", inputs);
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
      return { w, b };
    });
    if (!this.queue) throw new Error("Follow-up's message queue isn't running.");
    this.queue.enqueue({ ...this.repairItem(claimed.w, claimed.b, false), nextAt: new Date(this.now()).toISOString() });
    return findWorkspace(await this.store.snapshot(), workspaceId);
  }
  /**
   * Re-derives the workspace's queued message from its PRs as they are now, inside the caller's store write. A merge
   * click marks its PRs MERGED at once (a-merge-outcome-reads-the-same-everywhere); without this the queued repair for
   * a PR it just merged ("Restack #3 after #2 merged") stayed in Tasks and Needs you until the nudged tick.
   */
  settleTasks(w: Workspace): void { if (w.enable_tracking && !w.archived) this.reconcile(w); }
  private reconcile(w: Workspace): void {
    const tasks = tasksFor(w, this.now(), this.wording);
    // Hysteresis: a queued Done check survives the agent's own turns; only a real change (new work, Done) ends it.
    const queuedCheck = w.batches.find(b => b.state === "pending" && completionCheck(b));
    if (queuedCheck && w.runtimeBusy && !tasks.some(t => t.kind === "completion")) tasks.push(...tasksFor({ ...w, runtimeBusy: false }, this.now(), this.wording).filter(t => t.kind === "completion"));
    // One cap (Q49): a send that left a PR condition as it was, acknowledged or not, delivered nothing GitHub shows, so
    // the condition goes out again until it has gone out NO_PROGRESS_CAP times unchanged. An acknowledged one waits
    // for a GitHub read newer than the acknowledgment, so a fix GitHub hasn't shown yet is never sent twice.
    // A stuck batch re-checks what it asked for like a queued one: once nothing still applies, it settles and leaves
    // Needs you (a-batch-item-leaves-once-nothing-applies).
    settleMoot(w, tasks, this.now());
    // A human-only outcome isn't a delivery that awaits GitHub: its still-open conditions are held as "person" at once.
    // An in-progress answer holds its unchanged conditions while the agent's work runs (inProgressHolds), then they go
    // out again like any unacknowledged condition, toward the same cap.
    const delivered = new Set(w.batches.filter(b => ["sending", "sent", "completed", "blocked", "uncertain"].includes(b.state) && !(b.state === "completed" && (b.unacknowledged || b.humanOnly || b.inProgress && !inProgressHolds(w, b, this.now()))))
      .flatMap(b => b.tasks.filter(t => b.state !== "completed" || b.inProgress || !isRepair(t) || !readSince(w, t, b.settledAt)).map(conditionId)));
    const open = tasks.filter(t => !delivered.has(conditionId(t)));
    // One rule for every task in a message (Q49): a task the developer keeps for themselves, or a condition that went
    // out NO_PROGRESS_CAP times unchanged, stays out of it; only that task waits, the rest go out.
    const manual = new Set(w.manualTasks ?? []);
    const held: NonNullable<Workspace["heldTasks"]> = [];
    for (const t of open) {
      if (t.kind === "completion") continue;
      const why = manual.has(t.key) ? "manual" : personHeld(w, t) ? "person" : isCapped(w, t) ? "capped" : null;
      if (why) held.push({ task: t, held: why });
    }
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
      w.mainBusy = repairWait(runtime);
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
      // Done: nobody is working toward the goal any more, so what each agent said it was on goes (shared/now.ts).
      if (!alreadyDone) delete w.milestones;
      if (!alreadyDone) w.completion = { summary: message, declaredAt: new Date(this.now()).toISOString(), ...(gate.unconfirmed.length ? { unconfirmed: gate.unconfirmed } : {}) };
      return { workspace: w, blockers, unconfirmed: gate.unconfirmed, alreadyDone, next: doneGuidance(gate, alreadyDone) };
    });
  }
  /**
   * Records an agent's outcome. `humanOnly` (with blocked): nothing is left for an agent, only a person can move what is
   * still open. The batch settles completed and its still-open conditions wait as the developer's "person" tasks, a PR
   * item, never "The tasks didn't finish" (a-human-only-outcome-is-a-human-item).
   */
  async acknowledge(agentId: string, batchId: string, outcome: "completed" | "blocked" | "in_progress", result: string, workspaceId?: string, humanOnly?: boolean, waitingOn?: string): Promise<Workspace> {
    if (humanOnly && outcome !== "blocked") throw new Error("humanOnly goes with outcome \"blocked\": use it when nothing is left for an agent and only a person can move what is still open.");
    // Resolved on the snapshot, written to that one workspace (a-send-never-clones-the-whole-state), re-checked inside.
    const target = agentWorkspace(await this.store.snapshot(), agentId, "read", workspaceId);
    const w = await this.store.mutateWorkspace(target.id, w => {
      agentWorkspace({ version: 1, workspaces: [w] }, agentId, "read", w.id);
      requireTracking(w, agentId);
      const b = w.batches.find(b => b.id === batchId);
      if (!b || !["sending", "sent", "blocked", "uncertain"].includes(b.state)) throw new Error("Batch is not awaiting acknowledgment.");
      if ((b.recipientAgentId ?? w.mainAgentId) !== agentId) throw new Error(`Only the assigned agent can acknowledge this batch: expected agent ${b.recipientAgentId ?? w.mainAgentId}, received agent ${agentId}.`);
      if (outcome === "completed" && b.tasks.some(t => t.kind === "obligation" && w.obligations.some(o => o.id === t.target && o.communication && o.status !== "waived" && (o.status !== "done" || !replyRecorded(o.communication))))) throw new Error("Record the sent reply on each communication task before completing this batch, or acknowledge blocked with the posting/access reason.");
      if (humanOnly && (isRecovery(b) || completionCheck(b))) throw new Error("humanOnly is for repair batches. Acknowledge this one blocked with the reason.");
      if (outcome === "in_progress" && (isRecovery(b) || completionCheck(b))) throw new Error("in_progress is for repair batches. Acknowledge this one completed or blocked.");
      // in_progress: the agent (or its own subagent) is already on it. Not a failure and not finished: the batch settles
      // completed and its unchanged conditions wait for that work (inProgressHolds), never sent again meanwhile.
      b.state = humanOnly || outcome === "in_progress" ? "completed" : outcome; b.result = result; b.acknowledgmentError = null; b.settledAt = new Date(this.now()).toISOString();
      if (humanOnly) b.humanOnly = true; else delete b.humanOnly;
      // The person part is this answer's: a later answer without one says nothing waits on a person any more.
      // An in_progress answer that names none carries the last one over: "already on it" isn't "nothing waits on a person".
      // A completed or blocked answer without one, or Hand back to agent, clears it.
      const carried = outcome === "in_progress" && !waitingOn?.trim() ? b.tasks.map(t => personPart({ batches: w.batches.filter(x => x !== b) }, t.key)?.text).find(Boolean) : undefined;
      const part = waitingOn?.trim() || carried;
      if (part && !isRecovery(b) && !completionCheck(b)) b.waitingOn = part; else delete b.waitingOn;
      if (outcome === "in_progress") b.inProgress = true; else delete b.inProgress;
      delete b.movedOn;
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

/**
 * An acknowledged repair waits for a GitHub read newer than its acknowledgment (readSince, One cap). Until that read
 * lands, a read that only moves observedAt is a change: it is what lets the condition go out again.
 */
function awaitsRead(w: Workspace): boolean {
  return w.batches.some(b => b.state === "completed" && !b.unacknowledged && !!b.settledAt &&
    b.tasks.some(t => isRepair(t) && !!w.prs.find(p => p.key === t.target)?.snapshot && !readSince(w, t, b.settledAt)));
}
/** The earliest scheduled task due after `now` (Infinity when none): the untouched-pass skip ends there. */
function nextDue(w: Workspace, now: number): number {
  let next = Infinity;
  for (const o of followUpObligations(w)) {
    const due = o.trigger && o.enable_follow_up ? taskSchedule(o, w, now).dueAt : null;
    const at = due ? Date.parse(due) : NaN;
    if (at > now && at < next) next = at;
  }
  return next;
}

export type DoneResult = { workspace: Workspace; blockers: string[]; unconfirmed: string[]; alreadyDone: boolean; next: string };
/** The declare_done reply in words: what's missing, who can move it, and whether calling again could help. */
/**
 * Settles every stuck (blocked or unconfirmed) repair batch that no longer asks for anything (stillApplies over `open`,
 * the tasks the PRs show now), with the reason and the blocker's own time kept for Activity. The same rule reconcile
 * applies to a queued batch ("Conditions resolved before delivery"), so a stuck one never outlives what it was about.
 */
function settleMoot(w: Workspace, open: readonly Task[], now: number): void {
  for (const b of w.batches) if (stuckRepair(b) && !stillApplies(w, b, open)) {
    // The same task with new content (a review's new threads or replies) changed; it isn't over, and the next message
    // carries what's new. "No longer needed" is only for what GitHub really stopped showing.
    const why = changedNotGone(b, open) ? "changed" : "gone";
    const at = new Date(now).toISOString();
    const reason = movedOnReason(w, b, why);
    // The agent's answer is its record: never rewritten as cancelled (invariant a-changed-review-updates-never-cancels).
    if (agentAnswered(b)) { b.movedOn = { at, why, reason }; b.settledAt ??= at; continue; }
    b.state = "cancelled"; b.result = reason; b.settledAt ??= at;
    if (why === "changed") b.movedOn = { at, why, reason };
  }
}

/** What healBatches changed in one workspace, in counts only (logged, never titles or results). */
export type HealCounts = { restored: number; relabelled: number; duplicates: number };
/**
 * Heals records an earlier release left (invariant a-changed-review-updates-never-cancels), idempotently:
 * - a sent batch cancelled "No longer needed" although a later batch carried the same task (it changed, it wasn't
 *   gone) is relabelled `changed`;
 * - an answered batch a Retry rewrote as cancelled gets its blocked outcome back, marked `retried`;
 * - an answered batch whose exact conditions went out again in a later sent batch is marked `duplicate`, so only the
 *   newest answer stands in Needs you and holds the queue.
 */
export function healBatches(w: Workspace): HealCounts {
  const counts: HealCounts = { restored: 0, relabelled: 0, duplicates: 0 };
  const conditions = (b: Batch) => b.tasks.map(conditionId).sort().join("|");
  const engineWords = (r: string) => !r || r.startsWith("Delivery wasn't confirmed") || r.startsWith("Follow-up couldn't confirm") || r.startsWith("No longer needed") || r === "Conditions resolved before delivery";
  w.batches.forEach((b, i) => {
    if (b.movedOn || isRecovery(b) || !b.sentAt) return;
    const later = w.batches.slice(i + 1);
    if (b.state === "cancelled" && b.result === "No longer needed: GitHub no longer shows what it asked for." && later.some(x => x.tasks.some(t => b.tasks.some(y => y.key === t.key)))) {
      b.result = movedOnReason(w, b, "changed"); b.movedOn = { at: b.settledAt ?? b.sentAt, why: "changed", reason: b.result }; counts.relabelled++;
      return;
    }
    const retry = later.find(x => x.attempts === b.attempts + 1 && conditions(x) === conditions(b));
    if (b.state === "cancelled" && retry && !engineWords(b.result)) {
      b.state = "blocked"; b.movedOn = { at: retry.createdAt, why: "retried", reason: movedOnReason(w, b, "retried") }; counts.restored++;
      return;
    }
    if (b.state === "blocked" && agentAnswered(b) && later.some(x => !!x.sentAt && conditions(x) === conditions(b))) {
      b.movedOn = { at: later.find(x => !!x.sentAt && conditions(x) === conditions(b))!.sentAt!, why: "duplicate", reason: movedOnReason(w, b, "duplicate") }; counts.duplicates++;
    }
  });
  return counts;
}
/** Done answers every open Done check: a queued one is cancelled, a sent one counts as acknowledged. */
function settleDoneChecks(w: Workspace, now: number): void {
  for (const b of w.batches.filter(b => completionCheck(b) && ["pending", "sending", "sent", "blocked", "uncertain"].includes(b.state))) {
    const sent = b.state !== "pending";
    b.state = sent ? "completed" : "cancelled"; b.result = "The main agent declared Done."; if (sent) b.settledAt = new Date(now).toISOString();
  }
}
/** Records a stored declaration as Done; the Done check it answers is no longer needed. */
function acceptDeclaration(w: Workspace, gate: CompletionGate, now: number): void {
  delete w.milestones;
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

/** A Q answer's queue item: one per answer (its messageId), so a Resend is the same item. */
export const answerItemId = (workspaceId: string, q: Pick<Question, "id" | "answer">) => `answer:${workspaceId}:${q.id}:${q.answer?.delivery.messageId ?? ""}`;
/** A batch's queue item: one per batch (a Retry makes a new batch, so a new item). */
/** A repair's hold that only the agent's runtime can clear, so a tick that sees the agent free retries it. */
/** The main agent's own waits: a repair held by one goes on the tick that sees the main agent free. */
const MAIN_WAITS = new Set<string>(Object.values(MAIN_WAIT));
export const heldAgentSide = (reason: string) => reason !== PASEO_UNREACHABLE && !reason.startsWith("waits for the last message") && !reason.startsWith("waits until GitHub answers");
export const repairItemId = (workspaceId: string, batchId: string) => `repair:${workspaceId}:${batchId}`;
