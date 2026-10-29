import { displayPreferences } from "./shared/display";
import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as rpc from "./shared/contracts";
import { type Workspace } from "./shared/model";
import { Store } from "./server/store";
import { Engine, agentWorkspace, findWorkspace, interruptionHold } from "./server/engine";
import { Github } from "./server/github";
import { Graphite } from "./server/graphite";
import { BrowserBridge } from "./server/browser-bridge";
import { PrActions } from "./server/pr-actions";
import { PaseoGateway, paseoHome, clientEntry, closeConnections, sessionGuardOwnsInterruption } from "./server/daemon";
import { mcpSource } from "./server/mcp-source";
import { excludeStack } from "./server/exclusions";
import { applyHistory, applyDiscovery, extractHistory } from "./server/discovery";
import { lifecycleOnly, recoveryBatch } from "./shared/follow-up";
import { Deployments } from "./server/deployments";
import { AgentHooks } from "./server/agent-hooks";
import { withSessionMcp } from "./server/session-mcp";
import { updateObligation } from "./server/obligations";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(displayPreferences);
  const directory = join(paseoHome, "plugin-data", "follow-through");
  const bridge = join(directory, "mcp.mjs");
  const store = new Store(directory);
  const agentHooks = new AgentHooks(directory, clientEntry());
  const gateway = new PaseoGateway();
  const graphite = new Graphite();
  const github = new Github(undefined, graphite, new Deployments());
  const browser = new BrowserBridge();
  const actions = new PrActions(store, github, graphite, browser);
  const engine = new Engine(store, github, gateway);
  let unlock: (() => Promise<void>) | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hookTimer: ReturnType<typeof setInterval> | null = null;
  let hooksStarted = false;
  let loadError: string | null = null;
  let hookError: string | null = null;
  const ready = (async () => {
    unlock = await store.lock();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(bridge, mcpSource, { mode: 0o600 });
    await engine.recover();
    hooksStarted = true;
    await agentHooks.start().catch(() => { hookError = "Automatic sidebar instructions could not be registered for every provider. Check Claude/Codex hook settings; tracking is still available."; });
    hookTimer = setInterval(() => void agentHooks.heartbeat().catch(() => {}), 30_000);
  })().catch(() => { loadError = "Follow-through could not start. Check its saved state and worker lock."; });
  const requireReady = async () => { await ready; if (loadError || stopped) throw new Error(loadError ?? "Follow-through is stopping"); };
  const loop = async () => {
    await ready;
    if (stopped || loadError) return;
    await engine.tick();
    if (!stopped) timer = setTimeout(() => void loop(), 15_000);
  };
  void loop();
  const changed = (w: Workspace) => { w.completion = null; w.updatedAt = new Date().toISOString(); };

  const callerWorkspaceId = async (agentId: string, paseo: PluginHandlerContext["paseo"], allowHandoff = true) => {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId) throw new Error(`Cannot locate the caller's workspace: expected agent in a recorded workspace, received agent ${agentId}.`);
    if (allowHandoff) {
      const w = (await store.snapshot()).workspaces.find(w => w.id === agent.workspaceId);
      if (w && w.mainAgentId !== agentId && !w.batches.some(b => b.recipientAgentId === agentId)) {
        const handoff = await gateway.handoff(w, agentId);
        if (handoff) {
          await store.mutate(state => {
            const record = findWorkspace(state, w.id);
            const b = record.batches.find(b => b.id === handoff.batchId)!;
            if (b.recipientAgentId !== handoff.fromAgentId || b.settledAt || !["sending", "sent", "uncertain", "blocked"].includes(b.state)) throw new Error("Recovery assignment changed; read workspace_status again.");
            const at = new Date().toISOString();
            b.recoveryHandoffs.push({ fromAgentId: handoff.fromAgentId, toAgentId: agentId, at });
            b.recipientAgentId = agentId; b.activityAt = at;
            if (b.state === "blocked") { b.state = "sent"; b.result = "Recovery continued in the replacement agent; prior inventory and evidence are preserved."; }
            if (record.hold === "Recovery stopped or failed. Check the recovery agent before retrying." || record.hold === "Recovery acknowledgment was refused. Check the identity error on this batch.") record.hold = null;
          });
          await gateway.markRecovery(agentId, handoff.batchId);
        }
      }
    }
    return agent.workspaceId;
  };

  server.handle(rpc.projectSettingsRpc, async () => { await requireReady(); return { projects: await gateway.projects(await store.snapshot()) }; });
  server.handle(rpc.setProjectTrackingRpc, async ({ projectId, enable_default_tracking }) => {
    await requireReady();
    const projects = await gateway.projects(await store.snapshot());
    if (!projects.some(p => p.id === projectId)) throw new Error("This project is no longer available. Refresh settings.");
    await store.mutate(state => { state.projectDefaults ??= {}; state.projectDefaults[projectId] = enable_default_tracking; });
    void engine.tick();
    return { projects: await gateway.projects(await store.snapshot()) };
  });
  server.handle(rpc.listRpc, async () => { await ready; return { workspaces: (await store.snapshot()).workspaces.filter(w => w.enable_tracking), error: loadError ?? hookError ?? engine.error }; });
  server.handle(rpc.getRpc, async ({ workspaceId }) => { await ready; return { workspace: (await store.snapshot()).workspaces.find(w => w.id === workspaceId && w.enable_tracking) ?? null, error: loadError ?? hookError ?? engine.error }; });
  server.handle(rpc.syncWorkspaceRpc, async ({ agentId, summary }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo, false);
    const w = agentWorkspace(await store.snapshot(), agentId, "write", workspaceId);
    if (w.mainAgentId !== agentId || w.archived) throw new Error(`Only the active workspace main agent can confirm sidebar sync: expected ${w.mainAgentId}, received ${agentId}.`);
    await agentHooks.confirm(w.id, agentId, summary);
    return { workspaceId: w.id, synced: true as const };
  });
  server.handle(rpc.agentStatusRpc, async ({ agentId }, { paseo }) => { await requireReady(); const workspaceId = await callerWorkspaceId(agentId, paseo); return agentWorkspace(await store.snapshot(), agentId, "read", workspaceId); });
  server.handle(rpc.activateRpc, async ({ workspaceId }) => { await requireReady(); return engine.activate(workspaceId); });
  server.handle(rpc.sendRpc, async ({ workspaceId, batchId }) => { await requireReady(); return engine.sendPending(workspaceId, batchId); });
  server.handle(rpc.recoverRpc, async ({ workspaceId }) => { await requireReady(); return engine.startRecovery(workspaceId); });
  server.handle(rpc.enrollRpc, async ({ agentId, workspaceId, goal }, { paseo }) => {
    await requireReady();
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId || agent.archivedAt || agent.labels["paseo.parent-agent-id"]) throw new Error("Choose an available main agent in this workspace.");
    if (workspaceId && workspaceId !== agent.workspaceId) throw new Error("The chosen agent belongs to another workspace.");
    await callerWorkspaceId(agentId, paseo);
    const workspace = await paseo.workspaces.ref(agent.workspaceId).refresh();
    if (!workspace) throw new Error("Workspace is unavailable.");
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", agent.workspaceId!);
      if (w) {
        if (w.goal !== goal) changed(w);
        w.goal = goal; w.title = workspace.name; w.archived = false;
      } else {
        throw new Error("Workspace tracking is initializing. Read workspace_status and retry shortly.");
      }
      return w;
    });
  });
  server.handle(rpc.registerPrRpc, async ({ agentId, repo, number, stack, parentNumber, disposition }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const result = await store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      const key = `${repo}#${number}`;
      const excluded = w.excludedStacks.find(s => s.name === stack || s.prs.some(p => p.key === key));
      if (excluded) throw new Error(`This PR or stack was excluded from workspace scope: ${excluded.reason}. Read workspace_status and preserve the exclusion.`);
      const existing = w.prs.find(p => p.key === key);
      const parent = parentNumber === undefined ? existing?.parent ?? null : parentNumber === null ? null : `${repo}#${parentNumber}`;
      if (parent === key) throw new Error("A PR cannot be its own parent.");
      if (parent && !w.prs.some(p => p.key === parent)) throw new Error("Register the parent PR first.");
      let ancestor = parent;
      const seen = new Set([key]);
      while (ancestor) {
        if (seen.has(ancestor)) throw new Error("PR parent relationships cannot form a cycle.");
        seen.add(ancestor); ancestor = w.prs.find(p => p.key === ancestor)?.parent ?? null;
      }
      const altered = !existing || existing.stack !== stack || existing.parent !== parent || disposition !== undefined && existing.disposition !== disposition;
      if (existing) { existing.stack = stack; existing.parent = parent; if (disposition !== undefined) existing.disposition = disposition; }
      else w.prs.push({ key, repo, number, stack, parent, disposition: disposition ?? null, snapshot: null, error: null });
      if (altered) changed(w); return w;
    });
    void engine.tick(); return result;
  });
  server.handle(rpc.excludeStackRpc, async ({ agentId, stack, reason, obligationIds }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const result = await store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      excludeStack(w, stack, reason, obligationIds, new Date().toISOString());
      return w;
    });
    void engine.tick(); return result;
  });
  server.handle(rpc.obligationRpc, async ({ agentId, ...input }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const result = await store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      const obligation = updateObligation(w, input);
      changed(w); return { ...w, updatedObligationId: obligation.id };
    });
    void engine.tick(); return result;
  });
  server.handle(rpc.declareDoneRpc, async ({ agentId, summary }, { paseo }) => { await requireReady(); return engine.declareDone(agentId, summary, await callerWorkspaceId(agentId, paseo, false)); });
  server.handle(rpc.acknowledgeRpc, async ({ agentId, batchId, outcome, result }, { paseo }) => {
    await requireReady();
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    try { return await engine.acknowledge(agentId, batchId, outcome, result, await callerWorkspaceId(agentId, paseo)); }
    catch (error) {
      if (agent?.workspaceId) await store.mutate(state => {
        const w = state.workspaces.find(w => w.id === agent.workspaceId);
        const b = w?.batches.find(b => b.id === batchId && ["sending", "sent", "blocked", "uncertain"].includes(b.state));
        if (b) { b.acknowledgmentError = { agentId, at: new Date().toISOString(), error: error instanceof Error ? error.message : "Acknowledgment rejected" }; if (b.state === "blocked" && !b.settledAt) b.result = `Acknowledgment was refused for agent ${agentId}: ${b.acknowledgmentError.error}`; }
      });
      throw error;
    }
  });
  server.handle(rpc.controlRpc, async ({ workspaceId, enable_auto_sends, clearHold, retryBatchId }) => {
    await requireReady();
    return store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Activate this workspace before changing follow-up controls.");
      if (enable_auto_sends !== undefined) w.enable_auto_sends = enable_auto_sends;
      if (clearHold) w.hold = null;
      if (retryBatchId) {
        const b = w.batches.find(b => b.id === retryBatchId);
        if (!b || !["blocked", "uncertain"].includes(b.state)) throw new Error("This batch cannot be retried.");
        if (b.attempts >= 3) throw new Error("Three delivery attempts were made. Resolve this batch with the main agent.");
        b.state = "cancelled";
        w.batches.push({ ...b, ...(recoveryBatch(b) ? { enable_manual_recovery: true } : {}), id: randomUUID(), messageId: randomUUID(), state: "pending", attempts: b.attempts + 1, createdAt: new Date().toISOString(), sentAt: null, settledAt: null, result: "", activityAt: null, acknowledgmentError: null });
      }
      if (clearHold || retryBatchId && !recoveryBatch(w.batches.find(b => b.id === retryBatchId)!)) changed(w);
      else w.updatedAt = new Date().toISOString();
      return w;
    });
  });
  server.handle(rpc.refreshRpc, async () => { await requireReady(); void engine.tick(); return { ok: true }; });
  server.handle(rpc.refineTasksRpc, async ({ workspaceId, tasks }) => {
    await requireReady();
    const result = await store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Workspace tracking is inactive.");
      for (const edit of tasks) {
        const o = w.obligations.find(o => o.id === edit.id);
        if (!o || ["done", "waived", "working"].includes(o.status)) throw new Error("Task changed or is no longer editable. Refresh before refining it.");
        if (lifecycleOnly(edit) || edit.afterPrs.some(key => !w.prs.some(p => p.key === key))) throw new Error("Record concrete follow-through and owned PR dependencies.");
        if (o.title !== edit.title) o.previousTitles = [...(o.previousTitles ?? []), o.title];
        updateObligation(w, { ...edit, status: o.status, evidence: o.evidence });
      }
      changed(w); return w;
    });
    void engine.tick(); return result;
  });
  server.handle(rpc.taskTriggerRpc, async ({ workspaceId, obligationId, expectedRevision, trigger, afterPrs }) => {
    await requireReady();
    const result = await store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Workspace tracking is inactive.");
      const o = w.obligations.find(o => o.id === obligationId);
      if (!o || o.revision !== expectedRevision || ["done", "waived", "working"].includes(o.status)) throw new Error("Task changed. Refresh it before saving the trigger.");
      if (w.batches.some(b => ["sending", "sent", "uncertain"].includes(b.state) && b.tasks.some(t => t.kind === "obligation" && t.target === o.id))) throw new Error("This task is assigned to the agent. Settle its batch before changing the trigger.");
      updateObligation(w, { id: o.id, title: o.title, status: o.status, evidence: o.evidence, afterPrs, trigger, enable_follow_up: !!trigger });
      changed(w); return w;
    });
    void engine.tick(); return result;
  });
  server.handle(rpc.browserStatusRpc, async () => { await requireReady(); return browser.status(); });
  server.handle(rpc.browserExchangeRpc, async ({ clientId, ready: browserReady, acceptJobs, results }) => { await requireReady(); return { jobs: browser.exchange(clientId, browserReady, results, acceptJobs), accepted: results.map(r => r.id) }; });
  server.handle(rpc.prControlStatusRpc, async ({ workspaceId, prKey }) => { await requireReady(); return actions.status(workspaceId, prKey); });
  server.handle(rpc.preparePrActionRpc, async ({ workspaceId, prKey, kind }) => { await requireReady(); return actions.prepare(workspaceId, prKey, kind); });
  server.handle(rpc.confirmPrActionRpc, async ({ planId, scope }) => { await requireReady(); const result = await actions.confirm(planId, scope); void engine.tick(); return result; });
  server.handle(rpc.checkPrActionRpc, async ({ workspaceId, actionId }) => { await requireReady(); return actions.check(workspaceId, actionId); });
  server.handle(rpc.requestReviewersRpc, async ({ workspaceId, prKey }) => { await requireReady(); const result = await actions.requestReviewers(workspaceId, prKey); void engine.tick(); return result; });

  const removers = [
    server.on("agent.turn_started", async event => {
      await ready;
      if (!stopped && !loadError) await store.mutate(state => { const w = state.workspaces.find(w => w.enable_tracking && w.mainAgentId === event.agent.id); if (w) w.completion = null; });
    }),
    server.before("agent.session_open", async ({ request }) => {
      await ready;
      if (loadError || stopped || request.purpose !== "interactive") return request;
      const saved = await store.snapshot();
      let w = saved.workspaces.find(w => w.enable_tracking && !w.archived && (w.mainAgentId === request.agentId || w.batches.some(b => b.recipientAgentId === request.agentId && !b.settledAt && b.tasks.every(t => t.kind === "inventory") && ["sending", "sent", "uncertain", "blocked"].includes(b.state))));
      if (!w && request.workspaceId && !saved.workspaces.some(w => w.id === request.workspaceId && (w.archived || w.mainAgentId !== request.agentId))) {
        const project = await gateway.projectForWorkspace(saved, request.workspaceId).catch(() => null);
        if (project?.enable_default_tracking) {
          const rows = await gateway.discover(saved, request.workspaceId).catch(() => []);
          await store.mutate(state => applyDiscovery(state, rows.filter(row => row.enable_default_tracking && (!row.projectId || state.projectDefaults?.[row.projectId] !== false)), Date.now()));
          const current = await store.snapshot();
          w = current.workspaces.find(w => w.enable_tracking && w.mainAgentId === request.agentId);
          if (!current.workspaces.some(w => w.id === request.workspaceId) && current.projectDefaults?.[project.id] !== false)
            return { ...request, env: { ...request.env, FOLLOW_THROUGH_CLI: bridge, FOLLOW_THROUGH_CLIENT_ENTRY: clientEntry() } };
        }
      }
      if (!w) return request;
      const recovery = w.mainAgentId !== request.agentId;
      return withSessionMcp({ ...request, env: { ...request.env, FOLLOW_THROUGH_CLI: bridge, FOLLOW_THROUGH_CLIENT_ENTRY: clientEntry(), ...(recovery ? { FOLLOW_THROUGH_RECOVERY: "1" } : {}) } }, directory, clientEntry(), paseoHome, recovery);
    }),
    server.on("agent.turn_ended", async (event, { paseo, signal }) => {
      await ready;
      if (stopped || loadError) return;
      const interruption = event.outcome.kind === "canceled" || event.outcome.kind === "failed" ? { turnId: event.turnId, at: new Date().toISOString(), kind: event.outcome.kind } : null;
      const assigned = (await store.snapshot()).workspaces.find(w => w.enable_tracking && w.batches.some(b => b.recipientAgentId === event.agent.id && b.tasks.every(t => t.kind === "inventory") && ["sending", "sent", "uncertain"].includes(b.state)));
      if (assigned) {
        const guarded = interruption && await sessionGuardOwnsInterruption(event.agent.id, interruption).catch(() => false);
        if (["canceled", "failed"].includes(event.outcome.kind) && !guarded) await store.mutate(state => { const w = findWorkspace(state, assigned.id); const b = w.batches.find(b => b.recipientAgentId === event.agent.id && ["sending", "sent", "uncertain"].includes(b.state)); if (b) { b.state = "blocked"; b.result = b.acknowledgmentError ? `Recovery acknowledgment was refused: ${b.acknowledgmentError.error}` : "Recovery stopped or failed. Check its agent before retrying."; } });
        void engine.tick(); return;
      }
      if (!(await store.snapshot()).workspaces.some(w => w.enable_tracking && w.mainAgentId === event.agent.id)) return;
      gateway.markDirty(event.agent.id);
      // Since Paseo 0.13 the lifecycle payload deliberately contains no history.
      // Read a bounded tail through the plugin-owned API, outside the state lock.
      const history = await paseo.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit: 100, projection: "canonical" }).catch(() => null);
      if (signal.aborted || stopped) return;
      if (history) await store.mutate(state => {
        const w = state.workspaces.find(w => w.enable_tracking && w.mainAgentId === event.agent.id);
        if (w) applyHistory(w, extractHistory(history.entries.map(entry => entry.item), w.inventory?.historyComplete ?? false, w.inventory?.historyError ?? null), null);
      });
      const guarded = interruption && await sessionGuardOwnsInterruption(event.agent.id, interruption).catch(() => false);
      if (["canceled", "failed"].includes(event.outcome.kind) && !guarded) await store.mutate(state => {
        const w = state.workspaces.find(w => w.enable_tracking && w.mainAgentId === event.agent.id);
        if (w && interruption) { w.hold = interruptionHold(interruption.kind); w.interruption = interruption; w.completion = null; }
      });
      void engine.tick();
    }),
    server.on("workspace.archived", async event => { await ready; if (!loadError && !stopped) await store.mutate(state => { const w = state.workspaces.find(w => w.id === event.workspace.id); if (w) w.archived = true; }); }),
  ];
  return async () => {
    stopped = true; if (timer) clearTimeout(timer); if (hookTimer) clearInterval(hookTimer); removers.forEach(remove => remove());
    await ready; if (hooksStarted) await agentHooks.stop().catch(() => {});
    await actions.close(); await closeConnections(); await engine.stop(); await ready; await unlock?.();
  };
}
