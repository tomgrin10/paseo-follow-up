import { STOP_WAIT_MS, settleWithin, type Deadline } from "./teardown";
import { DEVELOPER, type Actor } from "../shared/actor";
import { randomUUID } from "node:crypto";
import { completionBlockers, completionCheck, completionGate, revokesDone, type CompletionGate, type Workspace, type State, type Batch } from "../shared/model";
import { Store } from "./store";
import { Github } from "./github";
import { batchPrompt, tasksFor, isRecovery, needsPrObservations, type TaskWording } from "./tasks";
import { answerRecipients, developerAnswer, syncTaskQuestions } from "./questions";
import { answerMessage, isOpen as isOpenQuestion, type Question } from "../shared/questions";
import { reconcileSubmittedStacks } from "./submissions";
import { applyDiscovery, interruptionHold, startsWithAutoSend, type DiscoveredWorkspace } from "./discovery";
import { followsByDefault, migrateActiveScope } from "../shared/settings";
import { replyRecorded } from "../shared/communication";
import { DeliveryDeferred, ConversationGone, realTimers, withDeadline, type Timers } from "./delivery";
import { recordSnapshot } from "./deployment-anchor";
import { pruneUnsent } from "./batch-archive";
import { holdSuperseded, liftHold } from "../shared/status";

export interface Runtime {
  busy: boolean; reason: string | null; archived: boolean; backgroundBusy?: boolean;
  /** Live state of the agents working tasks name (Workspace.taskAgents). Undefined: unknown, so every line says In progress. */
  taskAgents?: Workspace["taskAgents"];
  guarded?: boolean; guardedInterruptionId?: string;
  /** The main agent's runtime is loaded (see isLoaded). Undefined means unknown. */
  mainLoaded?: boolean;
  /** The main agent had a user message within the active window. Undefined means unknown. */
  mainRecent?: boolean;
  /** The main agent's current turn id (shared/status.ts turnIdOf), when it has one. Undefined means unknown. */
  mainTurnId?: string | null;
  /** The main agent's provider conversation no longer exists. */
  gone?: string | null;
}
const GONE_REASON = "The main agent's conversation no longer exists, so Follow-up stopped sending to it. Start a new agent in this workspace to continue.";
/** A batch that asks the agent to verify it's finished and declare Done. These never go out on their own. */
export const completionBatch = (b: Batch): boolean => b.tasks.some(t => t.kind === "completion");
export { interruptionHold };
export interface Gateway {
  discover?(state: State, workspaceId?: string): Promise<DiscoveredWorkspace[]>;
  observe(w: Workspace, fresh?: boolean): Promise<Runtime>;
  send(w: Workspace, batch: Batch, text: string): Promise<void>;
  prepareRecovery(w: Workspace, batch: Batch): Promise<{ agentId: string; contextPath: string }>;
  recoveryRuntime?(w: Workspace, batch: Batch): Promise<{ busy: boolean; reason: string | null }>;
  label(w: Workspace, assigned: boolean): Promise<void>;
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
  statusCheck: (w: Workspace, now: number) => Promise<void> = async () => {};
  /** Background refreshes skipped while paused, for tests and the resource check. */
  skipped = 0;
  constructor(readonly store: Store, private github: Pick<Github, "observe">, private gateway: Gateway, private now = Date.now, private settleMs = 60_000) {}
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
      for (const w of state.workspaces) for (const b of w.batches) if (b.state === "sending") {
        b.state = "uncertain";
        b.result = "Delivery was interrupted. Check the assigned agent before retrying this batch.";
      }
    });
  }
  /** How repair tasks are worded per repository (review-fix command, GitHub restacks). Empty: the original wording. */
  wording: TaskWording = {};
  private runningBackground = false;
  /**
   * One refresh at a time. The timer passes `background`, which lets PR polling back off for settled repositories;
   * every other caller (the developer's refresh, an action, an agent tool) gets a fresh read. A fresh request that
   * arrives during a background tick runs right after it instead of being folded into it. `workspaceId` narrows a
   * fresh read to that workspace's PRs (opening its panel).
   */
  tick(o: { background?: boolean; workspaceId?: string } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.runningBackground && !o.background ? this.running.then(() => this.tick(o)) : this.running;
    this.runningBackground = !!o.background;
    this.running = this.run(o).catch(() => { this.error = "Follow-up refresh failed. Saved work is intact; refresh will retry."; }).finally(() => { this.running = null; });
    return this.running;
  }
  private async run(o: { background?: boolean; workspaceId?: string } = {}): Promise<void> {
    if (this.paused()) { this.skipped++; return; }
    const saved = await this.store.snapshot();
    if (this.stopped) return;
    if (this.gateway.discover) {
      const discovered = await this.gateway.discover(saved);
      await this.store.mutate(state => {
        applyDiscovery(state, discovered.filter(row => followsByDefault(state, row) || saved.workspaces.some(w => w.id === row.id && w.enable_tracking && !w.archived)), this.now());
        migrateActiveScope(state, new Set(discovered.filter(row => row.active !== false).map(row => row.id)));
      });
    }
    // Dormant workspaces stay listed but cost nothing: no PR or agent observation until they're active again.
    const active = (await this.store.snapshot()).workspaces.filter(w => w.enable_tracking && !w.archived && !w.dormant);
    if (!active.length) { this.error = null; return; }
    // Busy workspaces keep every-tick PR reads: their agent may push or answer review at any moment.
    const keys = (ws: Workspace[]) => new Set(ws.flatMap(w => w.prs.map(p => p.key)));
    const hot = keys(active.filter(w => w.runtimeBusy || w.backgroundBusy || !!w.declaration || w.batches.some(b => ["sending", "sent"].includes(b.state)) || w.prActions.some(a => a.state === "sending")));
    const observations = await this.github.observe(active.flatMap(w => w.prs), o.background || o.workspaceId ? { background: true, hot, fresh: keys(active.filter(w => w.id === o.workspaceId)) } : {});
    for (const original of active) {
      if (this.stopped) return;
      const runtime = await this.gateway.observe(original).catch((): Runtime => ({ busy: false, reason: "Agent state unavailable; refresh will retry", archived: false }));
      const pruned: Batch[] = [];
      await this.store.mutateWorkspace(original.id, w => {
        w.runtimeBusy = runtime.busy; w.runtimeReason = runtime.reason; w.taskAgents = runtime.taskAgents;
        w.backgroundBusy = runtime.backgroundBusy ?? false;
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
        if (unacknowledged && !runtime.busy && !runtime.reason && this.now() - Date.parse(unacknowledged.activityAt ?? unacknowledged.sentAt!) > 120_000) {
          unacknowledged.state = "blocked";
          unacknowledged.result = unacknowledged.acknowledgmentError ? `Acknowledgment was refused for agent ${unacknowledged.acknowledgmentError.agentId}: ${unacknowledged.acknowledgmentError.error}` : "No accepted acknowledgment is recorded. Check the assigned agent’s result and any tracker errors before retrying.";
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
        if (status?.busy) await this.store.mutate(state => {
          const current = findWorkspace(state, original.id).batches.find(x => x.id === b.id)!;
          if (current.state === "sent") current.activityAt = new Date(this.now()).toISOString();
        });
        if (!status?.busy && this.now() - Date.parse(b.activityAt ?? b.sentAt!) > 120_000) await this.store.mutate(state => {
          const current = findWorkspace(state, original.id).batches.find(x => x.id === b.id)!;
          if (current.state !== "sent") return;
          current.state = "blocked"; current.result = current.acknowledgmentError ? `Acknowledgment was refused for agent ${current.acknowledgmentError.agentId}: ${current.acknowledgmentError.error}` : status?.reason ?? "Recovery finished without an accepted acknowledgment. Check its result before retrying.";
        });
      }
      for (const q of findWorkspace(await this.store.snapshot(), original.id).questions.filter(q => q.answer?.delivery.state === "queued")) await this.deliverAnswer(original.id, q.id).catch(() => undefined);
      let current = findWorkspace(await this.store.snapshot(), original.id);
      // Persist the holds that live only in this refresh, so every surface can say why repairs wait (shared/status.ts).
      const sendWait = this.autoSendsHeld() ? "setup" : runtime.mainLoaded === false || runtime.mainRecent === false ? "unloaded" : null;
      if ((current.sendWait ?? null) !== sendWait) current = await this.store.mutate(state => { const w = findWorkspace(state, original.id); w.sendWait = sendWait; return w; });
      const pending = current.batches.find(b => b.state === "pending" && !isRecovery(b));
      // Auto-send only reaches an agent that is loaded and recently used: sending to a dormant one would wake it.
      // Completion checks never go out on their own; they wait for Tom or the agent's next live turn.
      if (current.enable_auto_sends && !this.autoSendsHeld() && !current.archived && !current.hold && pending && !current.dormant && !current.goneAgent &&
          !completionBatch(pending) && runtime.mainLoaded !== false && runtime.mainRecent !== false &&
          !runtime.busy && !runtime.backgroundBusy && !runtime.reason &&
          !current.batches.some(b => !isRecovery(b) && ["sending", "sent", "blocked", "uncertain"].includes(b.state)) &&
          this.now() - Date.parse(pending.createdAt) >= this.settleMs &&
          (!needsPrObservations(current, pending) || current.prs.every(p => !p.error && p.snapshot?.complete)))
        await this.dispatch(current.id, pending.id, true).catch(() => undefined);
      current = findWorkspace(await this.store.snapshot(), original.id);
      const done = !current.archived && !!current.completion && completionBlockers(current, this.now()).length === 0;
      if (done || current.managedDoneLabel) {
        if (done && !current.managedDoneLabel) await this.store.mutate(state => { findWorkspace(state, current.id).managedDoneLabel = true; });
        await this.gateway.label(current, done);
        if (!done) await this.store.mutate(state => { findWorkspace(state, current.id).managedDoneLabel = false; });
      }
      await this.statusCheck(findWorkspace(await this.store.snapshot(), original.id), this.now()).catch(() => undefined);
    }
    this.error = null;
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
  async answer(workspaceId: string, questionId: string, choice: string, words: string | undefined, action: "send" | "copy" | "resend", actor: Actor = DEVELOPER): Promise<{ workspace: Workspace; question: Question }> {
    await this.store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      developerAnswer(w, questionId, choice, words, action, this.now(), actor);
      if (!w.questions.some(isOpenQuestion)) w.updatedAt = new Date(this.now()).toISOString();
    });
    // Recorded as "sending": the reply goes back now and the message after it. Reaching a dormant agent can take Paseo
    // longer than the 30 s a plugin RPC gets; the question shows sending → sent (or queued, unconfirmed) as it lands.
    if (action !== "copy") this.later(() => this.deliverAnswer(workspaceId, questionId));
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
    await this.store.mutate(state => {
      const current = findWorkspace(state, workspaceId).questions.find(x => x.id === questionId);
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
    const claimed = await this.store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      const b = w.batches.find(b => b.id === batchId);
      if (this.stopped || !w.enable_tracking || w.archived || w.hold || (automatic && !w.enable_auto_sends) || !b || b.state !== "pending" || w.batches.some(other => other.id !== b.id && !isRecovery(other) && ["sending", "sent", "blocked", "uncertain"].includes(other.state))) throw new Error("Workspace or queue changed; refresh before sending");
      const eligible = tasksFor(w, this.now(), this.wording);
      if (b.tasks.some(t => t.kind === "obligation" && !eligible.some(e => e.key === t.key && e.fingerprint === t.fingerprint))) throw new Error("Task dependencies changed or deployment evidence expired. Refresh before sending.");
      b.state = "sending";
      return { w, b };
    });
    return this.deliver(claimed, workspaceId, batchId);
  }
  async startRecovery(workspaceId: string): Promise<Workspace> {
    const batchId = randomUUID();
    await this.store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      if (!w.enable_tracking || w.archived || this.stopped) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      if (w.batches.some(b => isRecovery(b) && (["pending", "sending", "sent", "uncertain"].includes(b.state) || b.state === "blocked" && !b.settledAt))) throw new Error("Check the existing recovery before starting another.");
      w.batches.push({ id: batchId, enable_manual_recovery: true, messageId: randomUUID(), tasks: [{ key: `inventory:${w.id}`, kind: "inventory", target: w.id, title: "Recover workspace PR stacks and remaining work", fingerprint: String(w.inventory?.revision ?? 1) }], state: "pending", attempts: 1, createdAt: new Date(this.now()).toISOString(), sentAt: null, settledAt: null, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] });
    });
    return this.sendRecoveryPending(workspaceId, batchId);
  }
  private async sendRecoveryPending(workspaceId: string, batchId: string): Promise<Workspace> {
    const claimed = await this.store.mutate(state => {
      const w = findWorkspace(state, workspaceId), b = w.batches.find(b => b.id === batchId);
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
        await this.store.mutate(state => {
          const b = findWorkspace(state, workspaceId).batches.find(b => b.id === batchId)!;
          b.recipientAgentId = recovery.agentId; b.contextPath = recovery.contextPath;
        });
        claimed.b.recipientAgentId = recovery.agentId; claimed.b.contextPath = recovery.contextPath;
      } else {
        claimed.b.recipientAgentId = claimed.w.mainAgentId;
        await this.store.mutate(state => { findWorkspace(state, workspaceId).batches.find(b => b.id === batchId)!.recipientAgentId = claimed.w.mainAgentId; });
      }
      if (this.stopped) throw new Error("Follow-up stopped before delivery");
      sending = true;
      await this.gateway.send(claimed.w, claimed.b, batchPrompt(claimed.w, claimed.b));
      await this.store.mutate(state => {
        const b = findWorkspace(state, workspaceId).batches.find(b => b.id === batchId)!;
        if (b.state === "sending") { b.state = "sent"; b.sentAt = new Date(this.now()).toISOString(); }
      });
    } catch (error) {
      await this.store.mutate(state => {
        const b = findWorkspace(state, workspaceId).batches.find(b => b.id === batchId)!;
        if (b.state === "sending" && error instanceof ConversationGone) {
          // Nothing reached the agent. Keep the batch for a new agent and stop retrying this one.
          const w = findWorkspace(state, workspaceId);
          b.state = "pending"; b.result = ""; b.recipientAgentId = null;
          w.goneAgent = { agentId: error.agentId, at: new Date(this.now()).toISOString(), reason: error.message };
          w.runtimeReason = GONE_REASON;
          return;
        }
        if (b.state === "sending" && error instanceof DeliveryDeferred) {
          b.state = "pending"; b.result = "";
          if (!isRecovery(b)) findWorkspace(state, workspaceId).runtimeReason = error.message;
          return;
        }
        if (b.state === "sending") { b.state = sending ? "uncertain" : "blocked"; b.result = sending ? "Delivery could not be confirmed. Check the assigned agent before retrying." : `Could not prepare the recovery agent: ${error instanceof Error ? error.message : "Unknown error"}`; }
      });
    }
    return findWorkspace(await this.store.snapshot(), workspaceId);
  }
  private reconcile(w: Workspace): void {
    const tasks = tasksFor(w, this.now(), this.wording);
    // Hysteresis: a queued Done check survives the agent's own turns; only a real change (new work, Done) ends it.
    const queuedCheck = w.batches.find(b => b.state === "pending" && completionCheck(b));
    if (queuedCheck && w.runtimeBusy && !tasks.some(t => t.kind === "completion")) tasks.push(...tasksFor({ ...w, runtimeBusy: false }, this.now(), this.wording).filter(t => t.kind === "completion"));
    const delivered = new Set(w.batches.filter(b => ["sending", "sent", "completed", "blocked", "uncertain"].includes(b.state)).flatMap(b => b.tasks.map(t => `${t.key}:${t.fingerprint}`)));
    const fresh = tasks.filter(t => !delivered.has(`${t.key}:${t.fingerprint}`));
    let pending = w.batches.find(b => b.state === "pending" && !isRecovery(b));
    if (!fresh.length) {
      if (pending) { pending.state = "cancelled"; pending.result = "Conditions resolved before delivery"; }
      return;
    }
    if (pending) {
      const changed = JSON.stringify(pending.tasks) !== JSON.stringify(fresh);
      pending.tasks = fresh;
      if (changed) pending.createdAt = new Date(this.now()).toISOString();
    } else {
      pending = { id: randomUUID(), messageId: randomUUID(), tasks: fresh, state: "pending", createdAt: new Date(this.now()).toISOString(), sentAt: null, settledAt: null, attempts: 1, result: "", recipientAgentId: null, contextPath: null, activityAt: null, acknowledgmentError: null, recoveryHandoffs: [] };
      w.batches.push(pending);
    }
    if (fresh.some(t => ["conflict", "review", "checks", "restack"].includes(t.kind) && w.batches.filter(b => b.id !== pending!.id && ["completed", "blocked"].includes(b.state)).filter(b => b.tasks.some(old => old.key === t.key)).length >= 3)) {
      pending.state = "blocked"; pending.result = "This PR still needs repairs after three follow-up batches. Review it before retrying.";
    }
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
    const w = await this.store.mutate(state => {
      const w = agentWorkspace(state, agentId, "read", workspaceId);
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
  async stop(within?: Deadline): Promise<void> { this.stopped = true; await settleWithin(Promise.allSettled([this.running, ...this.recoveryOperations]), within ?? this.stopWaitMs); }
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
