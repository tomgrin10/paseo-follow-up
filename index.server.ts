import { displayPreferences } from "./shared/display";
import { DEFAULT_QUESTION_MODE, questionPreferences, type QuestionMode } from "./shared/questions";
import { askQuestion, recordAnswer, syncTaskQuestions, withdrawQuestion } from "./server/questions";
import { agentSetSpec, developerSetSpec } from "./server/spec";
import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as rpc from "./shared/contracts";
import { browserRepositories, prOwner } from "./server/pr-owner";
import { type Workspace } from "./shared/model";
import { isWorkspaceRoot } from "./server/workspace-agent";
import { Store } from "./server/store";
import { PriorityStore } from "./server/priorities";
import { UsageReader } from "./server/usage";
import { Engine, agentWorkspace, findWorkspace, interruptionHold } from "./server/engine";
import { Github } from "./server/github";
import { Graphite } from "./server/graphite";
import { BrowserBridge } from "./server/browser-bridge";
import { PrActions } from "./server/pr-actions";
import { AgentActions, AGENT_TOOLS, controlWorkspace, type AgentTool } from "./server/agent-actions";
import { PaseoGateway, paseoHome, clientEntry, closeConnections, sessionGuardOwnsInterruption } from "./server/daemon";
import { mcpSource } from "./server/mcp-source";
import { excludeStack } from "./server/exclusions";
import { applyHistory, applyDiscovery, extractHistory } from "./server/discovery";
import { lifecycleOnly, recoveryBatch } from "./shared/follow-up";
import { Deployments } from "./server/deployments";
import { AgentHooks } from "./server/agent-hooks";
import { withSessionMcp } from "./server/session-mcp";
import { updateObligation } from "./server/obligations";
import { Inbox, type GuardPause } from "./server/inbox";
import { daemonDirectory, guardPath } from "./server/inbox-directory";
import { fileSources } from "./server/inbox-classifier";
import { onBeforeSend } from "./server/daemon";
import { copyFile, readFile, rename } from "node:fs/promises";
import { autoSendsByDefault, FOLLOW_EVERY_MIGRATION, followsByDefault, followsEvery, migrateFollowEvery, optedOut } from "./shared/settings";
import { BRIEF_KIND, BRIEF_VERSION, prState, validateNeedsYou, type Brief, type NeedsYouRecord } from "./shared/brief";

export default function contribute(server: PluginServerContext) {
  const displaySettings = server.registerSettings(displayPreferences);
  const questionSettings = server.registerSettings(questionPreferences);
  // An unreadable setting means the default, which never lets an agent build ahead of the developer.
  const questionMode = async (): Promise<QuestionMode> => { try { const state = await questionSettings.read(); return state.status === "ready" ? state.values.mode : DEFAULT_QUESTION_MODE; } catch { return DEFAULT_QUESTION_MODE; } };
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
  const usage = new UsageReader(paseoHome);
  // Unknown is not off: an unreadable document keeps the inbox on with its defaults.
  const inboxSettings = async () => { try { const state = await displaySettings.read(); if (state.status === "ready") return state.values; } catch {} return displayPreferences.schema.parse({}); };
  // The brief's timeline rows need a plugin session; the handler contexts carry one. Rows wait until one is seen.
  type PaseoApi = PluginHandlerContext["paseo"];
  let api: PaseoApi | null = null;
  const unsent = new Map<string, { agentId: string; brief: Brief }>();
  const append = async (agentId: string, brief: Brief) => {
    if (!api) { unsent.set(`${agentId}|${brief.id}`, { agentId, brief }); return; }
    await api.agents.ref(agentId).timeline.append({ type: "plugin", id: brief.id, kind: BRIEF_KIND, version: BRIEF_VERSION, data: brief });
  };
  const seen = (paseo: PaseoApi) => {
    api = paseo;
    for (const [key, row] of unsent) { unsent.delete(key); void append(row.agentId, row.brief).catch(() => undefined); }
  };
  const needsYouPath = (agentId: string) => join(directory, "hook-state", `needs-you-${agentId}.json`);
  const trackedMain = async (agentId: string) => (await store.snapshot()).workspaces.find(w => w.enable_tracking && !w.archived && w.mainAgentId === agentId) ?? null;
  const inbox: Inbox = new Inbox(directory, {
    enabled: inboxSettings,
    briefs: {
      sink: append,
      async call(agentId) {
        if (!/^[\w-]+$/.test(agentId)) return null;
        try { return JSON.parse(await readFile(needsYouPath(agentId), "utf8")) as NeedsYouRecord; } catch { return null; }
      },
      async pr(agentId, event) {
        const w = (await store.snapshot()).workspaces.find(w => w.enable_tracking && !w.archived && (w.mainAgentId === agentId || w.prs.some(p => p.registeredAgentId === agentId)));
        return prState(w, agentId, event ?? null);
      },
      async workspaceId(agentId) { return (await trackedMain(agentId))?.id ?? null; },
      // Decisions stored as questions follow the brief: a picked option is the developer's answer; a brief the agent
      // moved past closes its still-open questions so the panel doesn't keep stale ones.
      async settled(agentId, brief) {
        if (brief.state !== "answered" && brief.state !== "superseded") return;
        await store.mutate(state => {
          const w = state.workspaces.find(w => w.enable_tracking && w.mainAgentId === agentId);
          if (!w) return;
          const at = brief.outcomeAt ?? new Date().toISOString();
          for (const d of brief.decisions) {
            const q = w.questions.find(q => q.id === d.id && brief.questionIds.includes(q.id));
            if (!q || q.answer || q.closed) continue;
            if (brief.state === "answered" && d.chosen) q.answer = { choice: d.chosen, at, by: "developer", delivery: { state: "sent", to: agentId, messageId: null, at, reason: null } };
            else if (brief.state === "superseded") q.closed = { at, reason: "The agent kept going past this brief.", by: null };
          }
        });
      },
    },
    directory: daemonDirectory(),
    sources: fileSources(paseoHome, async (): Promise<{ agentId: string; messageId: string | null; at: string }[]> => (await inbox.store.snapshot()).ledger),
    guard: async () => {
      try { const state = JSON.parse(await readFile(guardPath(paseoHome), "utf8")); return state?.version === 1 && Array.isArray(state.pauses) ? state.pauses as GuardPause[] : null; }
      catch { return null; }
    },
  });
  onBeforeSend((agentId, messageId) => inbox.noteDelivery(agentId, messageId));
  /** What the bridge and the Stop hook read: is the inbox on, may agents be nudged, who has a prompt showing. */
  const writeBriefState = async () => {
    const values = await inboxSettings();
    const path = join(directory, "brief.json");
    const temporary = `${path}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify({ enable_inbox: values.enable_inbox, enable_brief_nudge: values.enable_brief_nudge, pending: inbox.pendingPermissions(), at: Date.now() }), { mode: 0o600 });
    await rename(temporary, path);
  };
  let inboxError: string | null = null;
  let inboxTimer: ReturnType<typeof setTimeout> | null = null;
  const inboxLoop = async () => {
    await ready;
    if (stopped || loadError) return;
    try { await writeBriefState().catch(() => undefined); await inbox.tick(); await inbox.observeGuard(); await inbox.observeFollowUp(await store.snapshot()); inboxError = null; }
    catch (error) { inboxError = error instanceof Error ? error.message : "The Needs-you inbox couldn't update."; }
    if (!stopped) inboxTimer = setTimeout(() => void inboxLoop(), 15_000);
  };
  // Hooks run in the background; an inbox failure never blocks the rest of Follow-up.
  const inboxHook = (work: () => Promise<void>) => void (async () => { await ready; if (!stopped && !loadError) await work(); })().catch(error => { inboxError = error instanceof Error ? error.message : String(error); });
  let unlock: (() => Promise<void>) | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hookTimer: ReturnType<typeof setInterval> | null = null;
  let hooksStarted = false;
  let loadError: string | null = null;
  let hookError: string | null = null;
  /**
   * 1.3.0-beta.2: tracking is invisible. Once, back up state.json, then follow every known workspace with auto-send on.
   * The backup is never overwritten (COPYFILE_EXCL), so a second start can't replace it with migrated state.
   */
  const migrateTracking = async () => {
    if ((await store.snapshot()).migrations?.includes(FOLLOW_EVERY_MIGRATION)) return;
    await copyFile(join(directory, "state.json"), join(directory, "state.before-follow-every.json.bak"), 1).catch(error => { if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
    await store.mutate(state => { migrateFollowEvery(state); });
  };
  const ready = (async () => {
    unlock = await store.lock();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(bridge, mcpSource, { mode: 0o600 });
    await engine.recover();
    await migrateTracking();
    hooksStarted = true;
    await agentHooks.start().catch(() => { hookError = "Automatic sidebar instructions could not be registered for every provider. Check Claude/Codex hook settings; following still works."; });
    hookTimer = setInterval(() => void agentHooks.heartbeat().catch(() => {}), 30_000);
    await writeBriefState().catch(() => undefined);
  })().catch(() => { loadError = "Follow-through could not start. Check its saved state and worker lock."; });
  const requireReady = async () => { await ready; if (loadError || stopped) throw new Error(loadError ?? "Follow-through is stopping"); };
  const loop = async () => {
    await ready;
    if (stopped || loadError) return;
    await engine.tick();
    if (!stopped) timer = setTimeout(() => void loop(), 15_000);
  };
  void loop();
  void (async () => { await ready; if (stopped || loadError) return; await inbox.start().catch(error => { inboxError = error instanceof Error ? error.message : String(error); }); void inboxLoop(); })();
  const changed = (w: Workspace) => { w.completion = null; w.updatedAt = new Date().toISOString(); };

  const callerWorkspaceId = async (agentId: string, paseo: PluginHandlerContext["paseo"], allowHandoff = true) => {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId) throw new Error(`Cannot locate the caller's workspace: expected agent in a recorded workspace, received agent ${agentId}.`);
    const record = (await store.snapshot()).workspaces.find(w => w.id === agent.workspaceId);
    if (record?.contributorAgentIds?.includes(agentId) && !record.batches.some(b => b.recipientAgentId === agentId && !b.settledAt && b.tasks.every(t => t.kind === "inventory")) && (!await isWorkspaceRoot(agent, async id => (await paseo.agents.ref(id).refresh())?.agent) || agent.labels["follow-through.recovery"])) throw new Error("PR registration requires an available root agent in this tracked workspace.");
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
            record.contributorAgentIds = record.contributorAgentIds?.filter(id => id !== agentId);
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
  const followSettings = async () => {
    const state = await store.snapshot();
    return { enable_follow_every: followsEvery(state), enable_auto_sends_default: autoSendsByDefault(state),
      workspaces: state.workspaces.filter(w => !w.archived).map(w => ({ id: w.id, title: w.title, enable_tracking: w.enable_tracking, enable_auto_sends: w.enable_auto_sends, optedOut: optedOut(state, w.id) }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) };
  };
  server.handle(rpc.followSettingsRpc, async () => { await requireReady(); return followSettings(); });
  server.handle(rpc.setFollowSettingsRpc, async ({ enable_follow_every, enable_auto_sends_default, workspace }) => {
    await requireReady();
    await store.mutate(state => {
      if (enable_follow_every !== undefined) state.enable_follow_every = enable_follow_every;
      if (enable_auto_sends_default !== undefined) state.enable_auto_sends_default = enable_auto_sends_default;
      if (!workspace) return;
      const w = state.workspaces.find(w => w.id === workspace.workspaceId && !w.archived);
      if (!w) throw new Error("This workspace is no longer available. Refresh settings.");
      if (workspace.enable_auto_sends !== undefined) w.enable_auto_sends = workspace.enable_auto_sends;
      // Opting out stops following (discovery skips it); following again ends the opt-out below.
      if (workspace.follow === false) { state.workspaceOptOuts = [...new Set([...state.workspaceOptOuts ?? [], w.id])]; w.enable_tracking = false; }
      if (workspace.follow === true) state.workspaceOptOuts = (state.workspaceOptOuts ?? []).filter(id => id !== w.id);
    });
    if (workspace?.follow === true) await engine.activate(workspace.workspaceId).catch(() => store.mutate(state => { const w = state.workspaces.find(w => w.id === workspace.workspaceId); if (w) w.enable_tracking = true; }));
    void engine.tick();
    return followSettings();
  });
  server.handle(rpc.prOwnerRpc, async ({ repo, number }, { paseo }) => {
    await requireReady();
    const owner = prOwner(await store.snapshot(), repo, number);
    if (!owner) return { owner: null };
    const agent = (await paseo.agents.ref(owner.agentId).refresh())?.agent;
    if (!agent || agent.archivedAt || agent.workspaceId !== owner.workspaceId) return { owner: null };
    return { owner };
  });
  server.handle(rpc.listRpc, async () => { await ready; return { workspaces: (await store.snapshot()).workspaces.filter(w => w.enable_tracking), error: loadError ?? hookError ?? engine.error }; });
  server.handle(rpc.getRpc, async ({ workspaceId }) => { await ready; return { workspace: (await store.snapshot()).workspaces.find(w => w.id === workspaceId && w.enable_tracking) ?? null, error: loadError ?? hookError ?? engine.error }; });
  server.handle(rpc.syncWorkspaceRpc, async ({ agentId, summary }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo, false);
    const w = agentWorkspace(await store.snapshot(), agentId, "write", workspaceId, "pr");
    if (w.archived) throw new Error(`Only an active workspace root agent can confirm sidebar sync: expected ${w.mainAgentId}, received ${agentId}.`);
    await agentHooks.confirm(w.id, agentId, summary);
    return { workspaceId: w.id, synced: true as const };
  });
  server.handle(rpc.agentStatusRpc, async ({ agentId }, { paseo }) => { await requireReady(); const workspaceId = await callerWorkspaceId(agentId, paseo); return agentWorkspace(await store.snapshot(), agentId, "read", workspaceId, "pr"); });
  server.handle(rpc.activateRpc, async ({ workspaceId }) => { await requireReady(); return engine.activate(workspaceId); });
  server.handle(rpc.sendRpc, async ({ workspaceId, batchId }) => { await requireReady(); return engine.sendPending(workspaceId, batchId); });
  server.handle(rpc.recoverRpc, async ({ workspaceId }) => { await requireReady(); return engine.startRecovery(workspaceId); });
  server.handle(rpc.enrollRpc, async ({ agentId, workspaceId, goal }, { paseo }) => {
    await requireReady();
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId || !await isWorkspaceRoot(agent, async id => (await paseo.agents.ref(id).refresh())?.agent)) throw new Error("Choose an available main agent in this workspace.");
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
      const w = agentWorkspace(state, agentId, "write", workspaceId, "pr");
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
      if (existing) { existing.registeredAgentId = agentId; existing.discoveredFromSubmission = false; existing.stack = stack; existing.parent = parent; if (disposition !== undefined) existing.disposition = disposition; }
      else w.prs.push({ registeredAgentId: agentId, key, repo, number, stack, parent, disposition: disposition ?? null, snapshot: null, error: null });
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
      syncTaskQuestions(w, Date.now());
      changed(w); return { ...w, updatedObligationId: obligation.id };
    });
    void engine.tick(); return result;
  });
  server.handle(rpc.askQuestionRpc, async ({ agentId, ...input }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const mode = await questionMode();
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      const { question, instruction } = askQuestion(w, agentId, input, mode, Date.now());
      changed(w);
      return { workspaceId: w.id, question, mode, instruction };
    });
  });
  server.handle(rpc.recordAnswerRpc, async ({ agentId, id, choice, words }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      return { workspaceId: w.id, question: recordAnswer(w, agentId, id, choice, words, Date.now()) };
    });
  });
  server.handle(rpc.withdrawQuestionRpc, async ({ agentId, id, reason }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      return { workspaceId: w.id, question: withdrawQuestion(w, agentId, id, reason, Date.now()) };
    });
  });
  server.handle(rpc.setSpecRpc, async ({ agentId, url, title }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      const { applied, message } = agentSetSpec(w, agentId, url, title, Date.now());
      return { workspaceId: w.id, spec: w.spec, applied, message };
    });
  });
  server.handle(rpc.workspaceSpecRpc, async input => {
    await requireReady();
    return store.mutate(state => {
      const w = findWorkspace(state, input.workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      developerSetSpec(w, input, Date.now());
      return w;
    });
  });
  server.handle(rpc.answerQuestionRpc, async ({ workspaceId, questionId, choice, words, action }) => { await requireReady(); return engine.answer(workspaceId, questionId, choice, words, action); });
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
  server.handle(rpc.controlRpc, async input => {
    await requireReady();
    return store.mutate(state => controlWorkspace(state, input));
  });
  server.handle(rpc.refreshRpc, async () => { await requireReady(); void engine.tick(); return { ok: true }; });
  server.handle(rpc.refineTasksRpc, async ({ workspaceId, tasks }) => {
    await requireReady();
    const result = await store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
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
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      const o = w.obligations.find(o => o.id === obligationId);
      if (!o || o.revision !== expectedRevision || ["done", "waived", "working"].includes(o.status)) throw new Error("Task changed. Refresh it before saving the trigger.");
      if (w.batches.some(b => ["sending", "sent", "uncertain"].includes(b.state) && b.tasks.some(t => t.kind === "obligation" && t.target === o.id))) throw new Error("This task is assigned to the agent. Settle its batch before changing the trigger.");
      updateObligation(w, { id: o.id, title: o.title, status: o.status, evidence: o.evidence, afterPrs, trigger, enable_follow_up: !!trigger });
      changed(w); return w;
    });
    void engine.tick(); return result;
  });
  server.handle(rpc.browserStatusRpc, async () => { await requireReady(); return browser.status(); });
  server.handle(rpc.browserExchangeRpc, async ({ clientId, ready: browserReady, acceptJobs, results, repositories }) => { await requireReady(); return { ...browser.exchange(clientId, browserReady, results, acceptJobs, repositories), repositories: browserRepositories(await store.snapshot()) }; });
  server.handle(rpc.prControlStatusRpc, async ({ workspaceId, prKey }) => { await requireReady(); return actions.status(workspaceId, prKey); });
  server.handle(rpc.preparePrActionRpc, async ({ workspaceId, prKey, kind }) => { await requireReady(); return actions.prepare(workspaceId, prKey, kind); });
  server.handle(rpc.confirmPrActionRpc, async ({ planId, scope }) => { await requireReady(); const result = await actions.confirm(planId, scope); void engine.tick(); return result; });
  server.handle(rpc.checkPrActionRpc, async ({ workspaceId, actionId }) => { await requireReady(); return actions.check(workspaceId, actionId); });
  server.handle(rpc.requestReviewersRpc, async ({ workspaceId, prKey }) => { await requireReady(); const result = await actions.requestReviewers(workspaceId, prKey); void engine.tick(); return result; });

  const priorityStore = new PriorityStore(directory);
  const agentActions = new AgentActions({ store, prActions: actions, engine, inbox, priorities: priorityStore });
  server.handle(rpc.prioritiesRpc, async () => ({ items: await priorityStore.read() }));
  server.handle(rpc.usageRpc, async () => usage.read());
  server.handle(rpc.agentActRpc, async ({ agentId, tool, args }, { paseo }) => {
    await requireReady(); seen(paseo);
    if (!(AGENT_TOOLS as readonly string[]).includes(tool)) throw new Error(`Unknown Follow-up tool ${tool}.`);
    if (!/^[\w-]+$/.test(agentId)) throw new Error("Unsupported agent identity.");
    // Root agents only, the same rule as needs_you: never recovery, contributors or subagents.
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId || agent.archivedAt) throw new Error("Cannot locate the caller's workspace.");
    if (agent.labels["follow-through.recovery"]) throw new Error("Recovery sessions can't act for the developer. Acknowledge your batch instead.");
    if ((await store.snapshot()).workspaces.some(w => w.enable_tracking && !w.archived && w.contributorAgentIds?.includes(agentId))) throw new Error("Contributor sessions can't act for the developer. Report to the main agent.");
    if (!await isWorkspaceRoot(agent, async id => (await paseo.agents.ref(id).refresh())?.agent)) throw new Error("Follow-up's action tools are for root agents. Ask your parent agent.");
    const result = await agentActions.run(agentId, tool as AgentTool, args);
    void engine.tick();
    return result;
  });
  server.handle(rpc.inboxListRpc, async () => { await requireReady(); return { ...await inbox.list(), error: inboxError }; });
  server.handle(rpc.inboxBriefRpc, async ({ agentId }) => { await requireReady(); return { brief: await inbox.brief(agentId) }; });
  server.handle(rpc.inboxActRpc, async input => { await requireReady(); return inbox.act(input); });
  server.handle(rpc.needsYouRpc, async ({ agentId, ...input }, { paseo }) => {
    await requireReady(); seen(paseo);
    if (!(await inboxSettings()).enable_inbox) throw new Error("The Needs-you inbox is off, so there's no brief to fill. Finish with your normal reply.");
    if (!/^[\w-]+$/.test(agentId)) throw new Error("Unsupported agent identity.");
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId) throw new Error("Cannot locate the caller's workspace.");
    const saved = await store.snapshot();
    const tracked = saved.workspaces.find(w => w.id === agent.workspaceId && w.enable_tracking && !w.archived);
    // F2: root agents only. Contributors and recovery sessions report to the main agent; subagents to their parent.
    if (agent.labels["follow-through.recovery"] || tracked && tracked.mainAgentId !== agentId) throw new Error("needs_you is for the workspace's main agent. Report to the main agent instead.");
    if (!await isWorkspaceRoot(agent, async id => (await paseo.agents.ref(id).refresh())?.agent)) throw new Error("needs_you is for root agents. Report to your parent agent instead.");
    const call = validateNeedsYou(input, ref => {
      const key = ref.trim().replace(/^#/, "");
      const match = tracked?.prs.find(p => p.key.toLowerCase() === key.toLowerCase()) ?? (tracked?.prs.filter(p => String(p.number) === key).length === 1 ? tracked.prs.find(p => String(p.number) === key) : undefined);
      if (!match) throw new Error(`No registered PR matches ${ref}. Register it with register_pr first, or give the link as url.`);
      return match.key;
    });
    const turn = inbox.currentTurn(agentId);
    const previous = await readFile(needsYouPath(agentId), "utf8").then(t => JSON.parse(t) as NeedsYouRecord).catch(() => null);
    const sameTurn = !!previous && (turn?.turnId ? previous.turnId === turn.turnId : !!turn && previous.at >= turn.at);
    let questionIds: string[] = [];
    if (tracked) {
      const mode = await questionMode();
      questionIds = await store.mutate(state => {
        const w = findWorkspace(state, tracked.id);
        const now = Date.now();
        // Called twice in one turn: the last call wins, so the first call's questions close.
        if (sameTurn) for (const q of w.questions) if (previous!.questionIds?.includes(q.id) && !q.answer && !q.closed) q.closed = { at: new Date(now).toISOString(), reason: "Replaced by a newer needs_you call.", by: agentId };
        const ids = (call.decisions ?? []).map(d => askQuestion(w, agentId, { title: d.question.slice(0, 120), question: d.question, options: (d.options ?? []).map((o, i) => ({ letter: String.fromCharCode(65 + i), label: o.label, ...(o.consequence ? { consequence: o.consequence } : {}) })), ...(d.options?.length ? { recommend: String.fromCharCode(65 + d.recommend!) } : {}) }, mode, now).question.id);
        if (ids.length) changed(w);
        return ids;
      });
    }
    const record: NeedsYouRecord = { at: Date.now(), turnId: turn?.turnId ?? null, call, questionIds };
    await mkdir(join(directory, "hook-state"), { recursive: true, mode: 0o700 });
    const temporary = `${needsYouPath(agentId)}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, needsYouPath(agentId));
    return { ok: true as const, briefId: `brief:${turn?.turnId ?? record.at}` };
  });
  server.handle(rpc.briefActionRpc, async ({ agentId, briefId, decisionId, choice, move }, { paseo }) => {
    await requireReady(); seen(paseo);
    const brief = await inbox.briefAction(agentId, { briefId, decisionId, choice, move }, async (text, messageId) => {
      await paseo.agents.ref(agentId).send(text, { messageId, activeTurnBehavior: "steer" });
    });
    return { brief };
  });

  const removers = [
    displaySettings.subscribe(() => void writeBriefState().catch(() => undefined)),
    server.on("agent.turn_started", async (event, { paseo }) => { seen(paseo); inboxHook(() => inbox.turnStarted(event.agent, event.turnId)); }),
    server.on("agent.turn_ended", async (event, { paseo }) => { seen(paseo); inboxHook(() => inbox.turnEnded(event.agent, event.outcome, event.turnId)); }),
    server.on("agent.permission_requested", async (event, { paseo }) => { seen(paseo); inboxHook(async () => { await inbox.permissionRequested(event.agent, event.request); await writeBriefState(); }); }),
    server.on("agent.permission_resolved", async (event, { paseo }) => { seen(paseo); inboxHook(async () => { await inbox.permissionResolved(event.agent, event.requestId); await writeBriefState(); }); }),
    server.on("agent.closed", async event => inboxHook(() => inbox.closed(event.agent))),
    server.on("agent.archived", async event => inboxHook(() => inbox.archived([event.agent.id]))),
    server.on("workspace.archived", async event => inboxHook(() => inbox.workspaceArchived(event.workspace.id))),
    server.on("agent.turn_started", async event => {
      await ready;
      if (!stopped && !loadError) await store.mutate(state => { const w = state.workspaces.find(w => w.enable_tracking && (w.mainAgentId === event.agent.id || w.contributorAgentIds?.includes(event.agent.id))); if (w) w.completion = null; });
    }),
    server.before("agent.session_open", async ({ request }, { paseo }) => {
      await ready;
      if (loadError || stopped || request.purpose !== "interactive") return request;
      const saved = await store.snapshot();
      let w = saved.workspaces.find(w => w.enable_tracking && !w.archived && (w.mainAgentId === request.agentId || w.batches.some(b => b.recipientAgentId === request.agentId && !b.settledAt && b.tasks.every(t => t.kind === "inventory") && ["sending", "sent", "uncertain", "blocked"].includes(b.state))));
      if (!w && request.workspaceId && !saved.workspaces.some(w => w.id === request.workspaceId && (w.archived || w.mainAgentId !== request.agentId))) {
        const project = await gateway.projectForWorkspace(saved, request.workspaceId).catch(() => null);
        if (project?.enable_default_tracking && !optedOut(saved, request.workspaceId)) {
          const rows = await gateway.discover(saved, request.workspaceId).catch(() => []);
          await store.mutate(state => applyDiscovery(state, rows.filter(row => followsByDefault(state, row)), Date.now()));
          const current = await store.snapshot();
          w = current.workspaces.find(w => w.enable_tracking && w.mainAgentId === request.agentId);
          if (!current.workspaces.some(w => w.id === request.workspaceId) && current.projectDefaults?.[project.id] !== false)
            return { ...request, env: { ...request.env, FOLLOW_THROUGH_CLI: bridge, FOLLOW_THROUGH_CLIENT_ENTRY: clientEntry() } };
        }
      }
      const root = !!request.workspaceId && !request.labels["follow-through.recovery"] && await isWorkspaceRoot({ id: request.agentId, workspaceId: request.workspaceId, labels: request.labels }, async id => (await paseo.agents.ref(id).refresh())?.agent);
      // F2: needs_you and the Stop-hook nudge reach every root agent while the inbox is on, tracked or not.
      const brief = (await inboxSettings()).enable_inbox && ["claude", "codex"].includes(request.provider) ? request.provider : null;
      if (!w && root) {
        w = await store.mutate(state => {
          const workspace = state.workspaces.find(w => w.id === request.workspaceId && w.enable_tracking && !w.archived);
          if (workspace) workspace.contributorAgentIds = [...new Set([...(workspace.contributorAgentIds ?? []), request.agentId])];
          return workspace;
        });
      }
      if (!w) {
        // Root agents get the action tools (agent parity) and, while the inbox is on, needs_you.
        if (!root) return request;
        return withSessionMcp({ ...request, env: { ...request.env, ...(brief ? { FOLLOW_THROUGH_BRIEF: brief } : {}) } }, directory, clientEntry(), paseoHome, false, process.env, brief, true);
      }
      const recovery = w.mainAgentId !== request.agentId && !w.contributorAgentIds?.includes(request.agentId);
      const main = !recovery && w.mainAgentId === request.agentId ? brief : null;
      return withSessionMcp({ ...request, env: { ...request.env, FOLLOW_THROUGH_CLI: bridge, FOLLOW_THROUGH_CLIENT_ENTRY: clientEntry(), ...(recovery ? { FOLLOW_THROUGH_RECOVERY: "1" } : {}), ...(main ? { FOLLOW_THROUGH_BRIEF: main } : {}) } }, directory, clientEntry(), paseoHome, recovery, process.env, main, root && !recovery);
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
      if (!(await store.snapshot()).workspaces.some(w => w.enable_tracking && (w.mainAgentId === event.agent.id || w.contributorAgentIds?.includes(event.agent.id)))) return;
      gateway.markDirty(event.agent.id);
      // Since Paseo 0.13 the lifecycle payload deliberately contains no history.
      // Read a bounded tail through the plugin-owned API, outside the state lock.
      const history = await paseo.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit: 100, projection: "canonical" }).catch(() => null);
      if (signal.aborted || stopped) return;
      if (history) await store.mutate(state => {
        const w = state.workspaces.find(w => w.enable_tracking && (w.mainAgentId === event.agent.id || w.contributorAgentIds?.includes(event.agent.id)));
        if (w) applyHistory(w, extractHistory(history.entries.map(entry => entry.item), w.inventory?.historyComplete ?? false, w.inventory?.historyError ?? null), null);
      });
      const guarded = interruption && await sessionGuardOwnsInterruption(event.agent.id, interruption).catch(() => false);
      if (["canceled", "failed"].includes(event.outcome.kind) && !guarded) await store.mutate(state => {
        const w = state.workspaces.find(w => w.enable_tracking && (w.mainAgentId === event.agent.id || w.contributorAgentIds?.includes(event.agent.id)));
        if (w && w.mainAgentId === event.agent.id && interruption) { w.hold = interruptionHold(interruption.kind); w.interruption = interruption; w.completion = null; }
      });
      void engine.tick();
    }),
    server.on("workspace.archived", async event => { await ready; if (!loadError && !stopped) await store.mutate(state => { const w = state.workspaces.find(w => w.id === event.workspace.id); if (w) w.archived = true; }); }),
  ];
  return async () => {
    stopped = true; if (timer) clearTimeout(timer); if (inboxTimer) clearTimeout(inboxTimer); inbox.stop(); if (hookTimer) clearInterval(hookTimer); removers.forEach(remove => remove());
    await ready; if (hooksStarted) await agentHooks.stop().catch(() => {});
    await actions.close(); await closeConnections(); await engine.stop(); await ready; await unlock?.();
  };
}
