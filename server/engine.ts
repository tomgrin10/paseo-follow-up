import { randomUUID } from "node:crypto";
import { completionBlockers, type Workspace, type State, type Batch } from "../shared/model";
import { Store } from "./store";
import { Github } from "./github";
import { batchPrompt, tasksFor, isRecovery, needsPrObservations } from "./tasks";
import { applyDiscovery, type DiscoveredWorkspace } from "./discovery";
import { replyRecorded } from "../shared/communication";
import { DeliveryDeferred } from "./delivery";
import { recordSnapshot } from "./deployment-anchor";

export interface Runtime {
  busy: boolean; reason: string | null; archived: boolean; backgroundBusy?: boolean;
  guarded?: boolean; guardedInterruptionId?: string;
}
export const interruptionHold = (kind: "canceled" | "failed") => kind === "canceled" ? "You stopped the main agent. Resume follow-up when ready." : "The main agent's turn failed. Check it before resuming follow-up.";
export interface Gateway {
  discover?(state: State, workspaceId?: string): Promise<DiscoveredWorkspace[]>;
  observe(w: Workspace, fresh?: boolean): Promise<Runtime>;
  send(w: Workspace, batch: Batch, text: string): Promise<void>;
  prepareRecovery(w: Workspace, batch: Batch): Promise<{ agentId: string; contextPath: string }>;
  recoveryRuntime?(w: Workspace, batch: Batch): Promise<{ busy: boolean; reason: string | null }>;
  label(w: Workspace, assigned: boolean): Promise<void>;
}

export class Engine {
  error: string | null = null;
  private recoveryOperations = new Set<Promise<Workspace>>();
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(readonly store: Store, private github: Pick<Github, "observe">, private gateway: Gateway, private now = Date.now, private settleMs = 60_000) {}
  async recover(): Promise<void> {
    await this.store.mutate(state => {
      for (const w of state.workspaces) {
        const eligible = tasksFor(w, this.now());
        for (const b of w.batches.filter(b => b.state === "pending" && !isRecovery(b))) {
          b.tasks = b.tasks.filter(t => t.kind !== "obligation" || eligible.some(e => e.key === t.key && e.fingerprint === t.fingerprint));
          if (!b.tasks.length) { b.state = "cancelled"; b.result = "No triggered task is due. Unscheduled work remains in Tasks."; }
        }
        for (const b of w.batches) if (isRecovery(b) && b.state === "pending" && !b.enable_manual_recovery) { b.state = "cancelled"; b.result = "Recovery is now optional. Run recovery when needed; registered work continues independently."; }
        if (["Recovery stopped or failed. Check the recovery agent before retrying.", "Recovery acknowledgment was refused. Check the identity error on this batch."].includes(w.hold ?? "")) w.hold = null;
      }

      for (const w of state.workspaces) for (const a of w.prActions) if (a.state === "sending") { a.state = "uncertain"; a.result = `Follow-through reloaded before ${a.kind === "request_reviewers" ? "GitHub confirmed the review request" : "Graphite confirmed the action"}. Check state before sending another request.`; }
      for (const w of state.workspaces) for (const b of w.batches) if (b.state === "sending") {
        b.state = "uncertain";
        b.result = "Delivery was interrupted. Check the assigned agent before retrying this batch.";
      }
    });
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().catch(() => { this.error = "Follow-through refresh failed. Saved work is intact; refresh will retry."; }).finally(() => { this.running = null; });
    return this.running;
  }
  private async run(): Promise<void> {
    const saved = await this.store.snapshot();
    if (this.stopped) return;
    if (this.gateway.discover) {
      const discovered = await this.gateway.discover(saved);
      await this.store.mutate(state => applyDiscovery(state, discovered.filter(row => ((row.enable_default_tracking && (!row.projectId || state.projectDefaults?.[row.projectId] !== false)) || saved.workspaces.some(w => w.id === row.id && w.enable_tracking && !w.archived))), this.now()));
    }
    const active = (await this.store.snapshot()).workspaces.filter(w => w.enable_tracking && !w.archived);
    if (!active.length) { this.error = null; return; }
    const observations = await this.github.observe(active.flatMap(w => w.prs));
    for (const original of active) {
      if (this.stopped) return;
      const runtime = await this.gateway.observe(original).catch((): Runtime => ({ busy: false, reason: "Agent state unavailable; refresh will retry", archived: false }));
      await this.store.mutate(state => {
        const w = findWorkspace(state, original.id);
        w.runtimeBusy = runtime.busy; w.runtimeReason = runtime.reason;
        w.backgroundBusy = runtime.backgroundBusy ?? false;
        if (runtime.guardedInterruptionId && w.interruption && w.hold === interruptionHold(w.interruption.kind)) {
          w.hold = null; w.interruption.guardPauseId = runtime.guardedInterruptionId;
        }
        if (runtime.archived) w.archived = true;
        for (const p of w.prs) {
          const observed = observations.get(p.key);
          if (!observed) continue;
          p.error = observed.error;
          if (observed.snapshot) recordSnapshot(p, observed.snapshot, this.now());
        }
        if (w.archived) return;
        this.reconcile(w);
        const unacknowledged = w.batches.find(b => b.state === "sent" && !isRecovery(b));
        if (unacknowledged && (runtime.guarded || runtime.busy || runtime.backgroundBusy || original.runtimeReason?.startsWith("Waiting for Session Guard"))) unacknowledged.activityAt = new Date(this.now()).toISOString();
        if (unacknowledged && !runtime.busy && !runtime.reason && this.now() - Date.parse(unacknowledged.activityAt ?? unacknowledged.sentAt!) > 120_000) {
          unacknowledged.state = "blocked";
          unacknowledged.result = unacknowledged.acknowledgmentError ? `Acknowledgment was refused for agent ${unacknowledged.acknowledgmentError.agentId}: ${unacknowledged.acknowledgmentError.error}` : "No accepted acknowledgment is recorded. Check the assigned agent’s result and any tracker errors before retrying.";
        }
        if (w.completion && completionBlockers(w, this.now()).some(b => !b.startsWith("Wait for active agent"))) w.completion = null;
      });
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
      let current = findWorkspace(await this.store.snapshot(), original.id);
      const pending = current.batches.find(b => b.state === "pending" && !isRecovery(b));
      if (current.enable_auto_sends && !current.archived && !current.hold && pending &&
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
    }
    this.error = null;
  }
  async activate(workspaceId: string): Promise<Workspace> {
    if (this.stopped || !this.gateway.discover) throw new Error("Workspace tracking is unavailable");
    const rows = await this.gateway.discover(await this.store.snapshot(), workspaceId);
    if (!rows.some(row => row.id === workspaceId)) throw new Error("This workspace has no available main agent");
    await this.store.mutate(state => {
      applyDiscovery(state, rows.filter(row => row.id === workspaceId), this.now());
      findWorkspace(state, workspaceId).enable_tracking = true;
    });
    await this.tick();
    return findWorkspace(await this.store.snapshot(), workspaceId);
  }
  async sendPending(workspaceId: string, batchId: string): Promise<Workspace> {
    const before = findWorkspace(await this.store.snapshot(), workspaceId).batches.find(b => b.id === batchId);
    if (before && isRecovery(before)) return this.sendRecoveryPending(workspaceId, batchId);
    const reviewedTasks = JSON.stringify(before?.tasks);
    await this.tick();
    const current = findWorkspace(await this.store.snapshot(), workspaceId);
    if (!current.enable_tracking || current.archived || this.stopped) throw new Error("Tracking is inactive for this workspace");
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
    if (!batch || !current.enable_tracking || current.archived || current.hold || this.stopped || (automatic && !current.enable_auto_sends)) throw new Error("Workspace or queue is no longer ready to send");
    if (needsPrObservations(current, batch) && current.prs.some(p => p.error || !p.snapshot?.complete)) throw new Error("PR status is incomplete; refresh before sending repairs");
    const runtime = await this.gateway.observe(current, true);
    if (runtime.busy || runtime.backgroundBusy || runtime.reason || runtime.archived) throw new Error(runtime.reason ?? "The workspace has active agent work. Send when it is idle.");
    const claimed = await this.store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      const b = w.batches.find(b => b.id === batchId);
      if (this.stopped || !w.enable_tracking || w.archived || w.hold || (automatic && !w.enable_auto_sends) || !b || b.state !== "pending" || w.batches.some(other => other.id !== b.id && !isRecovery(other) && ["sending", "sent", "blocked", "uncertain"].includes(other.state))) throw new Error("Workspace or queue changed; refresh before sending");
      const eligible = tasksFor(w, this.now());
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
      if (!w.enable_tracking || w.archived || this.stopped) throw new Error("Workspace tracking is inactive.");
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
      if (this.stopped) throw new Error("Follow-through stopped before delivery");
      sending = true;
      await this.gateway.send(claimed.w, claimed.b, batchPrompt(claimed.w, claimed.b));
      await this.store.mutate(state => {
        const b = findWorkspace(state, workspaceId).batches.find(b => b.id === batchId)!;
        if (b.state === "sending") { b.state = "sent"; b.sentAt = new Date(this.now()).toISOString(); }
      });
    } catch (error) {
      await this.store.mutate(state => {
        const b = findWorkspace(state, workspaceId).batches.find(b => b.id === batchId)!;
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
    const tasks = tasksFor(w, this.now());
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
    w.completion = null;
  }
  async declareDone(agentId: string, message: string, workspaceId?: string): Promise<{ workspace: Workspace; blockers: string[] }> {
    const current = ownedWorkspace(await this.store.snapshot(), agentId, workspaceId);
    // Delivery may wait for this very turn to finish, so declarations observe independently.
    const [runtime, observations] = await Promise.all([
      this.gateway.observe(current, true),
      this.github.observe(current.prs),
    ]);
    return this.store.mutate(state => {
      const w = ownedWorkspace(state, agentId, workspaceId);
      w.runtimeBusy = runtime.busy; w.runtimeReason = runtime.reason;
      w.backgroundBusy = runtime.backgroundBusy ?? false;
      if (runtime.archived) w.archived = true;
      for (const pr of w.prs) {
        const observation = observations.get(pr.key);
        pr.error = observation?.error ?? (observation?.snapshot ? null : "PR status unavailable during completion verification");
        if (observation?.snapshot) recordSnapshot(pr, observation.snapshot, this.now());
      }
      // The declaration is made inside the owner's turn; that foreground turn is allowed.
      const unsentCompletion = (b: Batch) => b.state === "pending" && b.tasks.every(t => t.kind === "completion");
      const copy = { ...w, runtimeBusy: false, batches: w.batches.filter(b => !unsentCompletion(b)) };
      const blockers = completionBlockers(copy, this.now());
      if (w.archived) blockers.push("Workspace is archived");
      if (!blockers.length) {
        for (const b of w.batches.filter(unsentCompletion)) { b.state = "cancelled"; b.result = "The main agent verified completion directly before this check was sent."; }
        w.completion = { summary: message, declaredAt: new Date(this.now()).toISOString() };
      }
      return { workspace: w, blockers };
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
  async stop(): Promise<void> { this.stopped = true; await this.running; await Promise.allSettled(this.recoveryOperations); }
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
  return new Error(`Cannot ${access} follow-through for workspace ${w?.id ?? workspaceId ?? "unknown"}: expected main agent ${w?.mainAgentId ?? "not recorded"}, received agent ${agentId}. Only the main agent or its assigned recovery agent has access. Recorded recovery recipients: ${w?.batches.filter(b => isRecovery(b)).map(b => b.recipientAgentId).filter(Boolean).join(", ") || "none"}.`);
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
export function agentWorkspace(state: State, agentId: string, access: "read" | "write" = "write", workspaceId?: string): Workspace {
  const w = relatedWorkspace(state, agentId, workspaceId);
  const recovery = w?.batches.some(b => b.recipientAgentId === agentId && isRecovery(b) && (access === "read" || ["sending", "sent", "uncertain"].includes(b.state) || b.state === "blocked" && !b.settledAt));
  if (!w || (w.mainAgentId !== agentId && !recovery)) throw accessError(w, agentId, access, workspaceId);
  if (access === "write") requireTracking(w, agentId);
  return w;
}
