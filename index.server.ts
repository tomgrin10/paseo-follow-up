import { stopWorker } from "./server/teardown";
import { actorBy, actorOf, type Actor } from "./shared/actor";
import { TICK_MS } from "./shared/poll";
import { PluginMove } from "./server/plugin-move";
import { moveData, dataDirs, writeLegacyHeartbeat, type DataMove } from "./server/data-move";
import { isRecovery, withRuntimePrelude, invokeSelf, PLUGIN_ID } from "./shared/legacy";
import { displayPreferences } from "./shared/display";
import { DEFAULT_QUESTION_MODE, QUESTION_DEDUPE_MIGRATION, collapseDuplicateQuestions, questionPreferences, type QuestionMode } from "./shared/questions";
import { askQuestion, needsYouQuestions, recordAnswer, syncTaskQuestions, withdrawQuestion } from "./server/questions";
import { agentSetSpec, developerSetSpec } from "./server/spec";
import type { PluginServerContext, PluginHandlerContext, PluginHookContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { mkdir, writeFile } from "node:fs/promises";
import { isTimeZone } from "./shared/inbox";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as rpc from "./shared/contracts";
import { LogRing } from "./server/report-issue/diagnostics";
import { followUpReporter, reportPrompt } from "./server/report-issue-adapter";
import { githubApi } from "./server/github-api";
import { browserRepositories, browserWorkspaces, prClaims, prOwner } from "./server/pr-owner";
import { type Workspace } from "./shared/model";
import { isWorkspaceRoot } from "./server/workspace-agent";
import { BackgroundAgents, backgroundAgentsFile } from "./server/background-agents";
import { Store } from "./server/store";
import { PriorityStore } from "./server/priorities";
import { UsageReader } from "./server/usage";
import { Engine, agentWorkspace, findWorkspace } from "./server/engine";
import { holdOnTurnEnd, holdSuperseded, liftHold } from "./shared/status";
import { Github } from "./server/github";
import { ReviewerConfigStore, ReviewerSuggestions } from "./server/reviewer-config";
import { repoKey } from "./shared/reviewers";
import { Graphite } from "./server/graphite";
import { BrowserBridge } from "./server/browser-bridge";
import { PrActions } from "./server/pr-actions";
import { AgentActions, AGENT_TOOLS, controlWorkspace, type AgentTool } from "./server/agent-actions";
import { PaseoGateway, paseoHome, clientEntry, daemonOptions, closeConnections, sessionGuardOwnsInterruption, compactionJustDelivered } from "./server/daemon";
import { mcpSource } from "./server/mcp-source";
import { excludeStack } from "./server/exclusions";
import { applyHistory, applyDiscovery, extractHistory, mainWorkDue, markMainWork } from "./server/discovery";
import { lifecycleOnly, recoveryBatch } from "./shared/follow-up";
import { Deployments } from "./server/deployments";
import { AgentHooks } from "./server/agent-hooks";
import { withSessionMcp } from "./server/session-mcp";
import { nativeTools, nativeToolsAvailable, type Invoke, type Live } from "./server/native-tools";
import { Wait, waitStatus, type WaitPaseoConfig } from "./server/wait";
import { removeGlobalRegistrations } from "./server/mcp-registrations";
import { TrustBypass } from "./server/trust-bypass";
import { scopes } from "./server/scopes";
import { updateObligation } from "./server/obligations";
import { Inbox, type GuardPause } from "./server/inbox";
import { daemonDirectory, guardPath } from "./server/inbox-directory";
import { fileSources, turnPrompt } from "./server/inbox-classifier";
import { onBeforeSend } from "./server/daemon";
import { copyFile, readFile, rename, stat } from "node:fs/promises";
import { HistoryCache } from "./server/history-cache";
import { Governor } from "./server/governor";
import { ListCache } from "./server/list-cache";
import { scopeWriter, workflowSummary } from "./server/scopes";
import { PrWorkflowStore } from "./server/pr-workflow";
import { commandName } from "./shared/pr-workflow";
import { projectRepo } from "./server/daemon";
import { batchArchive, pruneUnsent } from "./server/batch-archive";
import { statusCheck } from "./server/status-check";
import { NO_USAGE } from "./shared/usage";
import { activeWindowMs, conversationGone, DEFAULT_ACTIVE_WINDOW_DAYS } from "./server/agent-load";
import { ACTIVE_SCOPE_MIGRATION, PRUNE_MIGRATION, autoSendsByDefault, FOLLOW_EVERY_MIGRATION, followsByDefault, followsEvery, migrateFollowEvery, optedOut } from "./shared/settings";
import { Overseer, OVERSEER_TOOLS, type OverseerPaseo, type OverseerTool, providerModel } from "./server/overseer";
import { OVERSEER_LABEL, isOverseerAgent } from "./shared/overseer";
import { withDaemon } from "./server/daemon";
import { RpcTiming } from "./server/rpc-timing";
import { hostFeature, type ServerInfo } from "./server/host-features";
type ServerInfoClient = { getLastServerInfoMessage?: () => ServerInfo };
import { inboxAnswer } from "./server/etag";
import { jobAgentRunner, type JobPaseo } from "./server/job-agent";
import { AiJobs } from "./server/ai-jobs";
import { liveRankSources, planningUrl, Ranker, RANKER_ROLE_DEFAULT } from "./server/ranker";
import { AboutService, AboutStore, liveSources, rootHistory, type AboutContext } from "./server/about";
import { LinkedService, LinkedStore, liveLinkedSources, type LinkResult } from "./server/linked";
import { workspaceRefs } from "./shared/linked-extract";
import { readTranscript } from "./server/transcript";
import { AgentSettingsStore, ProviderCatalog, type CatalogSource } from "./server/agent-settings";
import { labelsFor, providerName, resolveRole, roleSummary, type AgentSettingsView } from "./shared/agent-settings";
import type { LoadSignals } from "./shared/agent-load";
import { OnboardingStore, ReadinessChecks, nativeAgentCount } from "./server/onboarding";
import { updatesConsent } from "./shared/onboarding";
import { execFile, spawn } from "node:child_process";
import { compactHeap } from "./server/memory";
import { UpdatesStore } from "./server/updates";
import { Updater } from "./server/updater";
import { RegistryChecker, registryUrl, type RegistrySnapshot } from "./server/update-registry";
import { checkProvenance, tarballChangelog } from "./server/update-provenance";
import { watchdogSource } from "./server/update-watchdog-source";
import { busyAgents, type Busy } from "./shared/update-policy";
import { VersionsStore, demoOverride, describeSelf, readPackage, type SelfInstall } from "./server/release-notes";
import { updatesViewSchema, type UpdatesView } from "./shared/updates";
import { PLUGIN_NAME, releaseNotesViewSchema, type ReleaseNote, type ReleaseNotesView } from "./shared/changelog";
import { BRIEF_KIND, BRIEF_VERSION, prState, prStates, validateNeedsYou, type Brief, type NeedsYouRecord } from "./shared/brief";

/** Agent calls that only the main agent makes: one of these from a successor means the handover is in use. */
const MAIN_WORK = new Set(["follow.sync", "follow.register-pr", "follow.obligation", "follow.done", "follow.acknowledge", "follow.exclude-stack", "follow.ask-question", "follow.record-answer", "follow.withdraw-question", "follow.set-spec", "follow.needs-you"]);

export default function contribute(server: PluginServerContext) {
  // Report an issue's "recent warnings and errors": this worker's own [follow-up] console lines, in memory only.
  const startedAt = Date.now();
  const logRing = new LogRing();
  const restoreConsole = logRing.capture("[follow-up]");
  let toolTransport = "stdio bridge, or no session opened yet";
  const displaySettings = server.registerSettings(displayPreferences);
  const questionSettings = server.registerSettings(questionPreferences);
  // An unreadable setting means the default, which never lets an agent build ahead of the developer.
  const questionMode = async (): Promise<QuestionMode> => { try { const state = await questionSettings.read(); return state.status === "ready" ? state.values.mode : DEFAULT_QUESTION_MODE; } catch { return DEFAULT_QUESTION_MODE; } };
  // 2.0's one-time move from 1.x's data directory; synchronous, before anything below writes to the new one.
  let dataMove: DataMove | null = null;
  try { dataMove = moveData(paseoHome); if (dataMove.status === "moved") console.warn(`[follow-up] moved data from ${dataMove.from} to ${dataMove.to}`); }
  catch (error) { console.error("[follow-up] couldn't move 1.x's data; starting on whatever the new directory holds", error); }
  const directory = dataDirs(paseoHome).directory;
  const timeZonePath = join(directory, "client-time-zone.json");
  let clientTimeZone: string | null = (() => { try { const z = JSON.parse(readFileSync(timeZonePath, "utf8")).timeZone; return isTimeZone(z) ? z : null; } catch { return null; } })();
  const bridge = join(directory, "mcp.mjs");
  /**
   * Native tools live in this process: a reload or update drops them from every open session (Paseo 0.15.2 re-attaches
   * only when a session reopens, which it does before that agent's next prompt). Each worker gets an instance id and each
   * native session records the instance that attached its tools, so the agent hook can tell an agent mid-turn that its
   * follow_ tools are gone and the bridge still works. Written synchronously, before any session can open.
   */
  const toolsInstance = randomUUID();
  try {
    mkdirSync(join(directory, "hook-state"), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, `tools-instance.json.${toolsInstance}`), JSON.stringify({ instance: toolsInstance }), { mode: 0o600 });
    renameSync(join(directory, `tools-instance.json.${toolsInstance}`), join(directory, "tools-instance.json"));
  } catch { /* Without it the hook assumes the tools are attached, as before. */ }
  // Every RPC handler, also callable in-process: native agent tools run the same handlers the stdio bridge reaches.
  const handlers = new Map<string, { input: { parseAsync(value: unknown): Promise<unknown> }; run: (input: any, context: PluginHandlerContext) => unknown }>();
  // Slow RPCs name themselves in the plugin's output, with the event loop's delay (server/rpc-timing.ts).
  const rpcTiming = new RpcTiming(); rpcTiming.start();
  const handle: PluginServerContext["handle"] = (contract, handler) => {
    // Main-agent work by a successor makes its handover stick (see handBackMainAgent): noted after the call succeeds.
    const run = MAIN_WORK.has(contract.name) ? (async (input: { agentId?: string }, context: PluginHandlerContext) => { const out = await (handler as (i: unknown, c: PluginHandlerContext) => unknown)(input, context); if (input?.agentId) await noteMainWork(input.agentId).catch(() => undefined); return out; }) as typeof handler : handler;
    handlers.set(contract.name, { input: contract.input, run: run as never }); server.handle(contract, rpcTiming.timed(contract.name, run as (i: unknown, c: PluginHandlerContext) => unknown) as typeof handler);
  };
  const noteMainWork = async (agentId: string) => {
    // A cheap check on the snapshot first: almost every call has no open handover, so nothing is written.
    if (!(await store.snapshot()).workspaces.some(w => mainWorkDue(w, agentId, Date.now()))) return;
    await store.mutate(state => { markMainWork(state, agentId); });
  };
  const store = new Store(directory, 1_000);
  const onboarding = new OnboardingStore(directory);
  // PR workflow (Graphite or plain GitHub) per repository; scopes.json carries each agent's so its instructions match.
  const prWorkflow = new PrWorkflowStore(directory);
  let workspaceRepos: Map<string, string> = new Map();
  const workspaceRepo = (w: Workspace): string | null => (w.prs.find(p => p.snapshot?.state === "OPEN") ?? w.prs.at(-1))?.repo ?? workspaceRepos.get(w.id) ?? null;
  const knownRepos = (state: { workspaces: Workspace[] }) => new Set([...state.workspaces.filter(w => w.enable_tracking && !w.archived).flatMap(w => w.prs.map(p => repoKey(p.repo))), ...[...workspaceRepos.values()].map(repoKey)]);
  const writeScopes = scopeWriter(directory, { agent: w => prWorkflow.agentWorkflow(workspaceRepo(w)), summary: state => workflowSummary([...knownRepos(state)].map(r => prWorkflow.cachedWorkflow(r))) });
  // Every write: scopes for the hooks, then any open brief whose questions are now all settled resolves (every answer
  // path writes here, so one check covers them all; tests/stale-brief.test.ts).
  // Not awaited: onChanged runs inside the store's write queue, and resolving a brief can write the store again
  // (settled), which would wait on this very queue forever (harness 2026-11-11: follow.answer-question timed out).
  store.onChanged = async state => { await writeScopes(state); void inbox.questionsChanged(state.workspaces).catch(() => undefined); };
  const agentHooks = new AgentHooks(directory, clientEntry());
  const historyCache = HistoryCache.at(directory);
  const gateway = new PaseoGateway(undefined, undefined, undefined, historyCache);
  // Settings → Agents: which agent each special role uses, in agents.json (defaults when absent).
  const agentSettings = new AgentSettingsStore(directory);
  gateway.recoveryRole = () => agentSettings.role("recovery");
  const graphite = new Graphite();
  const github = new Github(undefined, graphite, new Deployments());
  github.workflow = repo => prWorkflow.workflow(repo);
  workspaceRepos = gateway.workspaceRepos;
  prWorkflow.paths = async () => {
    const paths = new Map<string, string[]>();
    const add = (repo: string, path: string) => { const key = repoKey(repo); paths.set(key, [...(paths.get(key) ?? []), path]); };
    const state = await store.snapshot();
    for (const p of await gateway.projects(state)) { const repo = projectRepo(p.key); if (repo && p.path) add(repo, p.path); }
    // Fallback: where tracked workspaces' agents work on that repository's PRs.
    for (const w of state.workspaces) for (const repo of new Set([...w.prs.map(p => p.repo), ...(workspaceRepos.get(w.id) ? [workspaceRepos.get(w.id)!] : [])])) for (const cwd of gateway.workspaceCwds.get(w.id) ?? []) add(repo, cwd);
    return paths;
  };
  prWorkflow.onChanged = () => { void store.snapshot().then(state => store.onChanged(state)).catch(() => undefined); };
  const browser = new BrowserBridge();
  const reviewerStore = new ReviewerConfigStore(directory);
  const reviewerSuggestions = new ReviewerSuggestions();
  const actions = new PrActions(store, github, graphite, browser);
  actions.savedMethod = repo => prWorkflow.current().repos[repoKey(repo)]?.mergeMethod ?? null;
  const engine = new Engine(store, github, gateway);
  engine.wording = { reviewFix: repo => commandName(prWorkflow.reviewFix(repo)) };
  const governor = new Governor();
  const linked = new LinkedService({ store: new LinkedStore(directory), sources: liveLinkedSources(), roomForBackground: async () => governor.allowsBackground() });
  // Extraction rides discovery's own timeline batch (loaded agents only): no extra reads (shared/linked-extract.ts).
  gateway.linkRefs = batch => void linked.note(batch).catch(() => undefined);
  const listCache = new ListCache();
  engine.paused = () => !governor.allowsBackground();
  engine.autoSendsHeld = () => onboarding.holdsAutoSends();
  const archive = batchArchive(directory);
  engine.archive = archive;
  engine.statusCheck = statusCheck(join(directory, "status-diagnostics.jsonl"));
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
  /** A message to one agent: through the plugin session once a handler has seen one, else a daemon connection (worker start). */
  const sendTo = (agentId: string) => async (text: string, messageId: string) => {
    if (api) await api.agents.ref(agentId).send(text, { messageId, activeTurnBehavior: "steer" });
    else await withDaemon(client => client.sendMessage(agentId, text, { messageId, activeTurnBehavior: "steer" }));
  };
  const seen = (paseo: PaseoApi) => {
    api = paseo;
    for (const [key, row] of unsent) { unsent.delete(key); void append(row.agentId, row.brief).catch(() => undefined); }
  };
  const needsYouPath = (agentId: string) => join(directory, "hook-state", `needs-you-${agentId}.json`);
  const trackedMain = async (agentId: string) => (await store.snapshot()).workspaces.find(w => w.enable_tracking && !w.archived && w.mainAgentId === agentId) ?? null;
  let overseer: Overseer | null = null;
  let ranker: Ranker | null = null;
  // Who sent a message (server/inbox-classifier.ts): the inbox and the Overseer's new-workspace gate read one ledger.
  const senderSources = fileSources(paseoHome, async () => (await inbox.store.snapshot()).ledger);
  const inbox: Inbox = new Inbox(directory, {
    enabled: inboxSettings,
    overseer: async () => (await overseer?.state())?.agentId ?? null,
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
      async prs(agentId) {
        return prStates((await store.snapshot()).workspaces.find(w => w.enable_tracking && !w.archived && (w.mainAgentId === agentId || w.prs.some(p => p.registeredAgentId === agentId))));
      },
      async workspaceId(agentId) { return (await trackedMain(agentId))?.id ?? null; },
      // Decisions stored as questions follow the brief: a picked option is the developer's answer; a brief the agent
      // moved past closes its still-open questions so the panel doesn't keep stale ones.
      async settled(agentId, brief) {
        if (brief.state !== "answered" && brief.state !== "superseded") return;
        const latest = await readFile(needsYouPath(agentId), "utf8").then(t => JSON.parse(t) as NeedsYouRecord).catch(() => null);
        await store.mutate(state => {
          const w = state.workspaces.find(w => w.enable_tracking && w.mainAgentId === agentId);
          if (!w) return;
          const at = brief.outcomeAt ?? new Date().toISOString();
          // A question this agent still points at (its newest needs_you), or one it asked with ask_question, outlives
          // an old brief: only the brief's own decisions close with it.
          const current = new Set(latest?.questionIds ?? []);
          for (const d of brief.decisions) {
            const q = w.questions.find(q => q.id === d.id && brief.questionIds.includes(q.id));
            if (!q || q.answer || q.closed) continue;
            if (brief.state === "superseded" && (current.has(q.id) || q.via === "ask")) continue;
            // The card's answer is the developer's only when they clicked it; an agent's brief_action stays the agent's.
            const agentBy = brief.answeredBy?.startsWith("agent:") ? brief.answeredBy.slice("agent:".length) : null;
            if (brief.state === "answered" && d.chosen) q.answer = { choice: d.chosen, ...(d.words ? { words: d.words } : {}), at, ...(agentBy ? { by: "agent" as const, agentId: agentBy } : { by: "developer" as const }), delivery: { state: "sent", to: agentId, messageId: null, at, reason: null } };
            else if (brief.state === "superseded") q.closed = { at, reason: "The agent kept going past this brief.", by: null };
          }
        });
      },
    },
    directory: daemonDirectory(gateway.directory),
    sources: senderSources,
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
    // Critical memory: the inbox's background reads wait too; hooks still record live events.
    if (!governor.allowsExtras()) { if (!stopped) inboxTimer = setTimeout(() => void inboxLoop(), 15_000); return; }
    try { await writeBriefState().catch(() => undefined); await inbox.tick(); await inbox.reconcilePermissions(); await inbox.observeGuard(); await inbox.observeFollowUp(await store.snapshot()); inboxError = null; }
    catch (error) { inboxError = error instanceof Error ? error.message : "The Needs-you inbox couldn't update."; }
    // The Overseer's digest for its next turn, and its recreation if it was archived. Never blocks the inbox.
    if (overseer) { await overseer.writeDigest().catch(() => undefined); if (api) await overseer.ensure(api as unknown as OverseerPaseo, { periodic: true }).catch(() => undefined); }
    // The ranker's scheduled run (window, cadence, cap and the governor are its own checks). Never awaited: it can take minutes.
    if (ranker) void ranker.tick().catch(() => undefined);
    if (!stopped) inboxTimer = setTimeout(() => void inboxLoop(), 15_000);
  };
  // Hooks run in the background; an inbox failure never blocks the rest of Follow-up.
  const inboxHook = (work: () => Promise<void>) => void (async () => { await ready; if (!stopped && !loadError) await work(); })().catch(error => { inboxError = error instanceof Error ? error.message : String(error); });
  let unlock: (() => Promise<void>) | null = null;
  let stopped = false;
  /** Each agent's latest started turn, so a turn end can tell it was already replaced (holdOnTurnEnd). */
  const startedTurns = new Map<string, string>();
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
  /**
   * 1.3.0-beta.4: once, back up state.json and move never-sent cancelled batches beyond the newest few per
   * workspace to the archive (see pruneUnsent). Archived first, so nothing is lost if the write fails.
   */
  const pruneHistory = async () => {
    if ((await store.snapshot()).migrations?.includes(PRUNE_MIGRATION)) return;
    await copyFile(join(directory, "state.json"), join(directory, "state.before-prune.json.bak"), 1).catch(error => { if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
    const preview = await store.read();
    for (const w of preview.workspaces) await archive(w.id, pruneUnsent(w));
    await store.mutate(state => { for (const w of state.workspaces) pruneUnsent(w); state.migrations = [...state.migrations ?? [], PRUNE_MIGRATION]; });
  };
  /**
   * 1.4.0-beta.25: once, collapse open questions that were asked twice or more (see collapseDuplicateQuestions). The
   * oldest stays open; answered ones are never touched. Backed up first, like the other migrations.
   */
  const BRIEF_REOPEN_MIGRATION = "reopen-collapsed-briefs-1";
  const dedupeQuestions = async () => {
    if ((await store.snapshot()).migrations?.includes(QUESTION_DEDUPE_MIGRATION)) return;
    await copyFile(join(directory, "state.json"), join(directory, "state.before-question-dedupe.json.bak"), 1).catch(error => { if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
    await store.mutate(state => {
      const now = Date.now();
      // Not changed(w): closing a duplicate must not reopen a declared completion.
      for (const w of state.workspaces) if (collapseDuplicateQuestions(w.questions, now).length) w.updatedAt = new Date(now).toISOString();
      state.migrations = [...state.migrations ?? [], QUESTION_DEDUPE_MIGRATION];
    });
  };
  /**
   * 1.4.0-beta.25: once, reopen Needs-you cards that another agent's message (or Follow-up, a continuation, a schedule)
   * collapsed while their questions are still open (Inbox.reopenCollapsed). Questions are the source of truth.
   */
  const reopenBriefs = async () => {
    if ((await store.snapshot()).migrations?.includes(BRIEF_REOPEN_MIGRATION)) return;
    const snapshot = await store.snapshot();
    await inbox.reopenCollapsed(async (agentId, ids) => {
      const w = snapshot.workspaces.find(w => w.mainAgentId === agentId);
      return new Set((w?.questions ?? []).filter(q => ids.includes(q.id) && !q.answer && !q.closed).map(q => q.id));
    }).catch(error => console.warn("[follow-up] reopening collapsed cards failed:", error));
    await store.mutate(state => { state.migrations = [...state.migrations ?? [], BRIEF_REOPEN_MIGRATION]; });
  };
  /** 1.3.0-beta.3: back up once before the active-scope migration (applied by the engine after its first discovery). */
  const backupActiveScope = async () => {
    if ((await store.snapshot()).migrations?.includes(ACTIVE_SCOPE_MIGRATION)) return;
    await copyFile(join(directory, "state.json"), join(directory, "state.before-active-scope.json.bak"), 1).catch(error => { if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
  };
  const ready = (async () => {
    // Getting started: fresh or existing is decided from what's on disk before anything below writes state.
    await onboarding.init().catch(() => undefined);
    unlock = await store.lock();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(bridge, withRuntimePrelude(mcpSource), { mode: 0o600 });
    // 1.4.0-beta.2: tools are per agent now; drop the old user-scope registrations that spawned mcp.mjs in every session.
    void removeGlobalRegistrations().then(results => { const removed = results.filter(r => r.status === "removed").map(r => r.path); if (removed.length) console.warn(`[follow-up] removed the global follow-up MCP registration from ${removed.length} file(s); backups end in .follow-up-unregister.bak`); });
    governor.start();
    await engine.recover();
    await migrateTracking();
    await dedupeQuestions();
    await reopenBriefs();
    await backupActiveScope();
    // Reviewers: the one-time seed from earlier requests, before history is pruned. An unreadable reviewers.json only affects Add reviewers.
    await reviewerStore.migrate(await store.snapshot()).catch(() => undefined);
    // PR workflow: the one-time /fix-pr seed, then resolve every known repository (filesystem checks only, never gt).
    await prWorkflow.migrate().catch(() => undefined);
    await prWorkflow.warm(knownRepos(await store.snapshot())).catch(() => undefined);
    await pruneHistory();
    await store.onChanged(await store.snapshot()).catch(() => undefined);
    hooksStarted = true;
    await agentHooks.start().catch(() => { hookError = "Automatic sidebar instructions could not be registered for every provider. Check Claude/Codex hook settings; following still works."; });
    hookTimer = setInterval(() => void agentHooks.heartbeat().catch(() => {}), 30_000);
    await writeBriefState().catch(() => undefined);
    // Brief answers recorded before a reload that Paseo never confirmed go out again, under the same messageId.
    await inbox.resumeAnswers(sendTo).catch(() => undefined);
  })().catch(() => { loadError = "Follow-up could not start. Check its saved state and worker lock."; });
  const requireReady = async () => { await ready; if (loadError || stopped) throw new Error(loadError ?? "Follow-up is stopping"); };
  // 1.4.0-beta.2: Follow-up's tools per agent: natively through Paseo's MCP when the host serves plugin tools,
  // otherwise the stdio bridge for this launch only. FOLLOW_UP_TOOLS tells the hooks which names the agent has.
  let configCache: { mtimeMs: number; value: unknown } | null = null;
  const paseoConfig = async () => {
    try { const path = join(paseoHome, "config.json"); const { mtimeMs } = await stat(path); if (configCache?.mtimeMs !== mtimeMs) configCache = { mtimeMs, value: JSON.parse(await readFile(path, "utf8")) }; return configCache.value as Parameters<typeof nativeToolsAvailable>[1]; } catch { return null; }
  };
  // Wait for background jobs (folded in from paseo-wait): native tools for interactive Claude sessions.
  // Paseo 0.16 runs background jobs itself (features.agentBackgroundWork): Wait retires there (docs/wait.md).
  const hostBackgroundWork = hostFeature("agentBackgroundWork", () => withDaemon(async client => (client as ServerInfoClient).getLastServerInfoMessage?.()));
  const wait = new Wait(join(directory, "wait"), { enabled: () => agentSettings.waitEnabled(), config: async () => await paseoConfig() as WaitPaseoConfig | null, hostBackgroundWork, legacyDirectory: existsSync(dataDirs(paseoHome).legacy) ? join(dataDirs(paseoHome).legacy, "wait") : null });
  const currentWait = async () => waitStatus(await agentSettings.waitEnabled(), await paseoConfig() as WaitPaseoConfig | null, await hostBackgroundWork());
  const live = async (agentId: string): Promise<Live> => ({ role: scopes(await store.snapshot())[agentId]?.role ?? null, inbox: (await inboxSettings()).enable_inbox });
  const invoke: Invoke = async (method, input, context) => {
    const handler = handlers.get(method); if (!handler) throw new Error(`Unknown Follow-up method ${method}.`);
    return handler.run(await handler.input.parseAsync(input), { paseo: context.paseo });
  };
  const withTools = async <R extends Parameters<typeof withSessionMcp>[0]>(request: R, recovery: boolean, brief: string | null, root: boolean, overseer = false): Promise<R> => {
    // FOLLOW_UP_TOOL_PROVIDERS / FOLLOW_UP_FORCE_STDIO exist for the isolated harness (scripts/check-native-tools.mjs).
    const providers = (process.env.FOLLOW_UP_TOOL_PROVIDERS ?? "claude,codex").split(",");
    if (request.purpose !== "interactive" || !providers.includes(request.provider) || request.labels["plugin-tools/enabled"] === "false") return request;
    if (process.env.FOLLOW_UP_FORCE_STDIO !== "1" && nativeToolsAvailable(request, await paseoConfig())) {
      toolTransport = "native (Paseo's agent MCP)";
      const flags = { recovery, brief: !!brief && !recovery, root: root && !recovery, overseer: overseer && !recovery };
      const env = { ...request.env, FOLLOW_UP_TOOLS: "native", FOLLOW_UP_PROVIDER: request.provider, ...(flags.root ? { FOLLOW_UP_ROOT: "1" } : {}), ...(flags.overseer ? { FOLLOW_UP_OVERSEER: "1" } : {}) };
      if (/^[\w-]+$/.test(request.agentId)) await writeFile(join(directory, "hook-state", `native-${request.agentId}.json`), JSON.stringify({ instance: toolsInstance }), { mode: 0o600 }).catch(() => undefined);
      return { ...request, env, tools: [...request.tools, ...nativeTools(flags, live, invoke, workflowSummary([...knownRepos(await store.snapshot())].map(r => prWorkflow.cachedWorkflow(r))))] };
    }
    return withSessionMcp({ ...request, env: { ...request.env, FOLLOW_UP_TOOLS: "stdio", FOLLOW_UP_PROVIDER: request.provider } }, directory, clientEntry(), paseoHome, recovery, process.env, brief, root, overseer, providers) as R;
  };
  let compacted = false;
  const loop = async () => {
    await ready;
    if (stopped || loadError) return;
    await engine.tick({ background: true });
    // Startup is done once the first tick is: release what it grew (see server/memory.ts).
    if (!compacted) { compacted = true; compactHeap(); }
    if (!stopped) timer = setTimeout(() => void loop(), TICK_MS);
  };
  void loop();
  void (async () => { await ready; if (stopped || loadError) return; await inbox.start().catch(error => { inboxError = error instanceof Error ? error.message : String(error); }); void inboxLoop(); })();
  const changed = (w: Workspace) => { w.completion = null; w.declaration = null; w.updatedAt = new Date().toISOString(); };

  const callerWorkspaceId = async (agentId: string, paseo: PluginHandlerContext["paseo"], allowHandoff = true) => {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId) throw new Error(`Cannot locate the caller's workspace: expected agent in a recorded workspace, received agent ${agentId}.`);
    const record = (await store.snapshot()).workspaces.find(w => w.id === agent.workspaceId);
    if (record?.contributorAgentIds?.includes(agentId) && !record.batches.some(b => b.recipientAgentId === agentId && !b.settledAt && b.tasks.every(t => t.kind === "inventory")) && (!await isWorkspaceRoot(agent, async id => (await paseo.agents.ref(id).refresh())?.agent) || isRecovery(agent.labels))) throw new Error("PR registration requires an available root agent in this tracked workspace.");
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

  handle(rpc.projectSettingsRpc, async () => { await requireReady(); return { projects: await gateway.projects(await store.snapshot()) }; });
  handle(rpc.setProjectTrackingRpc, async ({ projectId, enable_default_tracking }) => {
    await requireReady();
    const projects = await gateway.projects(await store.snapshot());
    if (!projects.some(p => p.id === projectId)) throw new Error("This project is no longer available. Refresh settings.");
    await store.mutate(state => { state.projectDefaults ??= {}; state.projectDefaults[projectId] = enable_default_tracking; });
    void engine.tick();
    return { projects: await gateway.projects(await store.snapshot()) };
  });
  const followSettings = async () => {
    const state = await store.snapshot();
    return { enable_follow_every: followsEvery(state), enable_auto_sends_default: autoSendsByDefault(state), activeWindowDays: state.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS,
      workspaces: state.workspaces.filter(w => !w.archived).map(w => ({ id: w.id, title: w.title, enable_tracking: w.enable_tracking, enable_auto_sends: w.enable_auto_sends, optedOut: optedOut(state, w.id), dormant: !!w.dormant, parked: !!state.autoSendsParked?.includes(w.id) }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) };
  };
  handle(rpc.followSettingsRpc, async () => { await requireReady(); return followSettings(); });
  handle(rpc.setFollowSettingsRpc, async ({ enable_follow_every, enable_auto_sends_default, activeWindowDays, workspace }) => {
    await requireReady();
    await store.mutate(state => {
      if (activeWindowDays !== undefined) state.activeWindowDays = activeWindowDays;
      if (enable_follow_every !== undefined) state.enable_follow_every = enable_follow_every;
      if (enable_auto_sends_default !== undefined) state.enable_auto_sends_default = enable_auto_sends_default;
      if (!workspace) return;
      const w = state.workspaces.find(w => w.id === workspace.workspaceId && !w.archived);
      if (!w) throw new Error("This workspace is no longer available. Refresh settings.");
      if (workspace.enable_auto_sends !== undefined) {
        w.enable_auto_sends = workspace.enable_auto_sends;
        // An explicit choice replaces the migration's parking.
        if (state.autoSendsParked) { state.autoSendsParked = state.autoSendsParked.filter(id => id !== w.id); if (!state.autoSendsParked.length) delete state.autoSendsParked; }
      }
      // Opting out stops following (discovery skips it); following again ends the opt-out below.
      if (workspace.follow === false) { state.workspaceOptOuts = [...new Set([...state.workspaceOptOuts ?? [], w.id])]; w.enable_tracking = false; }
      if (workspace.follow === true) state.workspaceOptOuts = (state.workspaceOptOuts ?? []).filter(id => id !== w.id);
    });
    if (workspace?.follow === true) await engine.activate(workspace.workspaceId).catch(() => store.mutate(state => { const w = state.workspaces.find(w => w.id === workspace.workspaceId); if (w) w.enable_tracking = true; }));
    void engine.tick();
    return followSettings();
  });
  handle(rpc.prOwnerRpc, async ({ repo, number }, { paseo }) => {
    await requireReady();
    const owner = prOwner(await store.snapshot(), repo, number);
    if (!owner) return { owner: null };
    const agent = (await paseo.agents.ref(owner.agentId).refresh())?.agent;
    if (!agent || agent.archivedAt || agent.workspaceId !== owner.workspaceId) return { owner: null };
    return { owner };
  });
  handle(rpc.prWorkspacesRpc, async ({ repo, number }, { paseo }) => {
    await requireReady();
    const state = await store.snapshot();
    if (!browserRepositories(state).includes(repo.toLowerCase())) return { tracked: false, workspaces: [], more: 0 };
    const entries = await Promise.all(prClaims(state, repo, number).map(async workspace => {
      const agent = (await paseo.agents.ref(workspace.mainAgentId).refresh().catch(() => null))?.agent;
      return { workspace, agent: agent && !agent.archivedAt && agent.workspaceId === workspace.id ? agent : null };
    }));
    const view = browserWorkspaces(entries);
    return { tracked: true, ...view, workspaces: view.workspaces.map(w => ({ ...w, title: w.title.slice(0, 200), agentStatus: w.agentStatus.slice(0, 40), state: w.state.slice(0, 200) })) };
  });
  handle(rpc.listRpc, async ({ since }) => { await ready; return { ...listCache.answer(await store.snapshot(), since), error: loadError ?? hookError ?? engine.error }; });
  handle(rpc.getRpc, async ({ workspaceId }) => { await ready; return { workspace: (await store.snapshot()).workspaces.find(w => w.id === workspaceId && w.enable_tracking) ?? null, error: loadError ?? hookError ?? engine.error }; });
  handle(rpc.syncWorkspaceRpc, async ({ agentId, summary }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo, false);
    const w = agentWorkspace(await store.snapshot(), agentId, "write", workspaceId, "pr");
    if (w.archived) throw new Error(`Only an active workspace root agent can confirm sidebar sync: expected ${w.mainAgentId}, received ${agentId}.`);
    await agentHooks.confirm(w.id, agentId, summary);
    return { workspaceId: w.id, synced: true as const };
  });
  handle(rpc.agentStatusRpc, async ({ agentId }, { paseo }) => { await requireReady(); const workspaceId = await callerWorkspaceId(agentId, paseo); const w = agentWorkspace(await store.snapshot(), agentId, "read", workspaceId, "pr"); return { ...w, prWorkflow: prWorkflow.agentWorkflow(workspaceRepo(w)) }; });
  handle(rpc.activateRpc, async ({ workspaceId }) => { await requireReady(); return engine.activate(workspaceId); });
  handle(rpc.sendRpc, async ({ workspaceId, batchId }) => { await requireReady(); return engine.sendPending(workspaceId, batchId); });
  handle(rpc.recoverRpc, async ({ workspaceId }) => { await requireReady(); return engine.startRecovery(workspaceId); });
  handle(rpc.enrollRpc, async ({ agentId, workspaceId, goal }, { paseo }) => {
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
  handle(rpc.registerPrRpc, async ({ agentId, repo, number, stack, parentNumber, disposition, agentMerges }, { paseo }) => {
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
      const altered = !existing || existing.stack !== stack || existing.parent !== parent || disposition !== undefined && existing.disposition !== disposition || agentMerges !== undefined && !!existing.agentMerges !== agentMerges;
      if (existing) { existing.registeredAgentId = agentId; existing.discoveredFromSubmission = false; existing.stack = stack; existing.parent = parent; if (disposition !== undefined) existing.disposition = disposition; if (agentMerges !== undefined) existing.agentMerges = agentMerges; }
      else w.prs.push({ registeredAgentId: agentId, key, repo, number, stack, parent, disposition: disposition ?? null, snapshot: null, error: null, ...(agentMerges ? { agentMerges } : {}) });
      if (altered) changed(w); return w;
    });
    void engine.tick(); return result;
  });
  handle(rpc.excludeStackRpc, async ({ agentId, stack, reason, obligationIds }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const result = await store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      excludeStack(w, stack, reason, obligationIds, new Date().toISOString());
      return w;
    });
    void engine.tick(); return result;
  });
  handle(rpc.obligationRpc, async ({ agentId, ...input }, { paseo }) => {
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
  handle(rpc.askQuestionRpc, async ({ agentId, ...input }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const mode = await questionMode();
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      const { supersedes, ...ask } = input;
      const { question, instruction, outcome, of } = askQuestion(w, agentId, ask, mode, Date.now(), { via: "ask", ...(supersedes ? { supersedes } : {}) });
      if (outcome !== "duplicate") changed(w);
      return { workspaceId: w.id, question, mode, instruction, outcome, of };
    });
  });
  handle(rpc.recordAnswerRpc, async ({ agentId, id, choice, words }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      return { workspaceId: w.id, question: recordAnswer(w, agentId, id, choice, words, Date.now()) };
    });
  });
  handle(rpc.withdrawQuestionRpc, async ({ agentId, id, reason }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      return { workspaceId: w.id, question: withdrawQuestion(w, agentId, id, reason, Date.now()) };
    });
  });
  handle(rpc.setSpecRpc, async ({ agentId, url, title }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      const { applied, message } = agentSetSpec(w, agentId, url, title, Date.now());
      return { workspaceId: w.id, spec: w.spec, applied, message };
    });
  });
  // Linked items: the agent's own workspace (main or a contributor), and the developer's list for any workspace.
  const linkReceipt = (workspaceId: string, r: LinkResult) => r.ok
    ? { workspaceId, ok: true, key: r.key, pending: r.pending, message: r.pending ? r.message : `${r.created ? "Linked" : "Already linked"}: ${r.item.title ? `${r.key} · ${r.item.title}` : r.key}.` }
    : { workspaceId, ok: false, key: null, pending: false, message: r.reason };
  const linkedDerived = (w: Workspace) => ({ spec: w.spec?.url ? { url: w.spec.url, title: w.spec.title ?? null } : null, artifacts: w.artifacts ?? [] });
  handle(rpc.linkItemRpc, async ({ agentId, ref, why, title }, { paseo }) => {
    await requireReady();
    const w = agentWorkspace(await store.snapshot(), agentId, "write", await callerWorkspaceId(agentId, paseo), "pr");
    return linkReceipt(w.id, await linked.link(w.id, ref, { origin: "registered", by: agentId, why, title }));
  });
  handle(rpc.unlinkItemRpc, async ({ agentId, ref, reason }, { paseo }) => {
    await requireReady();
    const w = agentWorkspace(await store.snapshot(), agentId, "write", await callerWorkspaceId(agentId, paseo), "pr");
    const { removed, key } = await linked.unlink(w.id, ref, agentId, reason);
    return { workspaceId: w.id, ok: true, key, pending: false, message: removed ? `Unlinked ${key}. It stays out unless the developer adds it back.` : `${key} wasn't linked; it is now kept out.` };
  });
  handle(rpc.linkedItemsRpc, async ({ workspaceId }) => {
    await requireReady();
    const w = findWorkspace(await store.snapshot(), workspaceId);
    return linked.view(w.id, linkedDerived(w));
  });
  handle(rpc.linkedIndexRpc, async () => {
    await requireReady();
    // Archived workspaces stay searchable on Home, so their links do too.
    return { workspaces: await linked.searchIndex() };
  });
  handle(rpc.setLinkedItemsRpc, async (input, context) => {
    await requireReady();
    const by = actorBy(actorOf(context));
    const w = findWorkspace(await store.snapshot(), input.workspaceId);
    let message: string | null = null;
    if (input.action === "add") {
      const r = await linked.link(w.id, input.ref, { origin: "manual", by, title: input.title });
      if (!r.ok) throw new Error(r.reason);
      if (r.pending) message = r.message;
    } else if (input.action === "remove") {
      // The spec and published artifacts are derived: removing one records the exclusion, and the view leaves it out.
      await linked.unlink(w.id, input.ref, by, null);
    } else if (!await linked.undo(w.id, input.ref)) message = "Nothing to undo.";
    return { ...await linked.view(w.id, linkedDerived(w)), message };
  });
  handle(rpc.workspaceSpecRpc, async (input, context) => {
    await requireReady();
    return store.mutate(state => {
      const w = findWorkspace(state, input.workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      developerSetSpec(w, input, Date.now(), actorOf(context));
      return w;
    });
  });
  handle(rpc.answerQuestionRpc, async ({ workspaceId, questionId, choice, words, action }, context) => { await requireReady(); return engine.answer(workspaceId, questionId, choice, words, action, actorOf(context)); });
  handle(rpc.declareDoneRpc, async ({ agentId, summary }, { paseo }) => { await requireReady(); return engine.declareDone(agentId, summary, await callerWorkspaceId(agentId, paseo, false)); });
  handle(rpc.acknowledgeRpc, async ({ agentId, batchId, outcome, result }, { paseo }) => {
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
  handle(rpc.controlRpc, async input => {
    await requireReady();
    return store.mutate(state => controlWorkspace(state, input, Date.now(), clientTimeZone));
  });
  handle(rpc.refreshRpc, async ({ workspaceId }) => { await requireReady(); void engine.tick({ workspaceId }); return { ok: true }; });
  handle(rpc.refineTasksRpc, async ({ workspaceId, tasks }) => {
    await requireReady();
    const result = await store.mutate(state => {
      const w = findWorkspace(state, workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      for (const edit of tasks) {
        const o = w.obligations.find(o => o.id === edit.id);
        if (!o || ["done", "waived", "working"].includes(o.status)) throw new Error("Task changed or is no longer editable. Refresh before refining it.");
        if (lifecycleOnly(edit) || edit.afterPrs.some(key => !w.prs.some(p => p.key === key))) throw new Error("Record concrete follow-up and owned PR dependencies.");
        if (o.title !== edit.title) o.previousTitles = [...(o.previousTitles ?? []), o.title];
        updateObligation(w, { ...edit, status: o.status, evidence: o.evidence });
      }
      changed(w); return w;
    });
    void engine.tick(); return result;
  });
  handle(rpc.taskTriggerRpc, async ({ workspaceId, obligationId, expectedRevision, trigger, afterPrs }) => {
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
  handle(rpc.browserStatusRpc, async () => { await requireReady(); return browser.status(); });
  handle(rpc.browserExchangeRpc, async ({ clientId, ready: browserReady, acceptJobs, results, repositories }) => { await requireReady(); return { ...browser.exchange(clientId, browserReady, results, acceptJobs, repositories), repositories: browserRepositories(await store.snapshot()) }; });
  handle(rpc.prControlStatusRpc, async ({ workspaceId, prKey }) => { await requireReady(); return actions.status(workspaceId, prKey); });
  handle(rpc.preparePrActionRpc, async ({ workspaceId, prKey, kind }) => { await requireReady(); return actions.prepare(workspaceId, prKey, kind); });
  handle(rpc.confirmPrActionRpc, async ({ planId, scope }) => { await requireReady(); const result = await actions.confirm(planId, scope); void engine.tick(); return result; });
  handle(rpc.checkPrActionRpc, async ({ workspaceId, actionId }) => { await requireReady(); return actions.check(workspaceId, actionId); });
  handle(rpc.requestReviewersRpc, async ({ workspaceId, prKey, reviewers, remember }) => {
    await requireReady();
    // "Remember for <repo>" saves first: it's the developer's choice whatever GitHub answers.
    if (reviewers && remember) await reviewerStore.save(prKey.split("#")[0], reviewers);
    const result = await actions.requestReviewers(workspaceId, prKey, reviewers?.map(r => r.login)); void engine.tick(); return result;
  });
  const reviewerSettings = async () => {
    const config = await reviewerStore.read();
    const seen = new Set(Object.keys(config.repos));
    for (const w of (await store.snapshot()).workspaces) for (const p of w.prs) seen.add(repoKey(p.repo));
    return { config, repos: [...seen].sort() };
  };
  const prWorkflowRepos = async () => {
    const repos = new Set((await reviewerSettings()).repos);
    for (const p of await gateway.projects(await store.snapshot()).catch(() => [])) { const repo = projectRepo(p.key); if (repo) repos.add(repoKey(repo)); }
    for (const repo of Object.keys(prWorkflow.current().repos)) repos.add(repo);
    return repos;
  };
  // Each repository's merge settings as GitHub reported them with its newest observed PR (no extra request).
  const repoMerges = async () => {
    const newest = new Map<string, { at: string; value: NonNullable<NonNullable<Workspace["prs"][number]["snapshot"]>["repoMerge"]> }>();
    for (const w of (await store.snapshot()).workspaces) for (const p of w.prs) {
      const s = p.snapshot; if (!s?.repoMerge) continue;
      const key = repoKey(p.repo); const seen = newest.get(key);
      if (!seen || s.observedAt > seen.at) newest.set(key, { at: s.observedAt, value: s.repoMerge });
    }
    return newest;
  };
  const prWorkflowView = async (fresh = false) => { const merges = await repoMerges(); return prWorkflow.view(await prWorkflowRepos(), fresh, repo => merges.get(repo)?.value ?? null); };
  handle(rpc.prWorkflowRpc, async ({ refresh }) => {
    await requireReady();
    const view = await prWorkflowView(!!refresh);
    if (refresh) prWorkflow.onChanged();
    return view;
  });
  handle(rpc.setPrWorkflowRpc, async ({ repo, setting, default: fallback, mergeMethod, reviewFix }) => {
    await requireReady();
    if ((setting !== undefined || mergeMethod !== undefined || (reviewFix !== undefined && repo)) && !repo) throw new Error("Name the repository (owner/name) to change.");
    await prWorkflow.mutate(config => {
      if (fallback !== undefined) config.default = fallback;
      if (!repo) { if (reviewFix) config.reviewFix = reviewFix; return; }
      const own = config.repos[repoKey(repo)] ??= {};
      if (setting !== undefined) { if (setting === null) delete own.workflow; else own.workflow = setting; }
      if (mergeMethod !== undefined) { if (mergeMethod === null) delete own.mergeMethod; else own.mergeMethod = mergeMethod; }
      if (reviewFix !== undefined) { if (reviewFix === null) delete own.reviewFix; else own.reviewFix = reviewFix; }
    });
    // A changed workflow changes readiness and merge: check the PRs again now rather than on the next poll.
    void engine.tick();
    return prWorkflowView();
  });
  handle(rpc.reviewerSettingsRpc, async () => { await requireReady(); return reviewerSettings(); });
  handle(rpc.saveReviewersRpc, async ({ repo, reviewers }) => { await requireReady(); await reviewerStore.save(repo, reviewers); return reviewerSettings(); });
  handle(rpc.reviewerSuggestionsRpc, async ({ repo }) => { await requireReady(); return reviewerSuggestions.suggest(repo); });

  const priorityStore = new PriorityStore(directory);
  // Paseo's workspace descriptors for the Overseer (name, project, branch), from the shared directory.
  let lastFreshDescriptors = 0;
  type Descriptor = { id: string; name?: string | null; title?: string | null; projectId?: string | null; projectDisplayName?: string | null; projectCustomName?: string | null; activityAt?: string | null; archivingAt?: string | null; gitRuntime?: { currentBranch?: string | null } | null; githubRuntime?: { pullRequest?: { number?: number; title?: string } | null } | null };
  const paseoWorkspaces = async (fresh = false) => {
    // The shared directory: the Overseer's own tool calls may ask for a fresh read, at most every 10 s.
    if (fresh && Date.now() - lastFreshDescriptors > 10_000) { lastFreshDescriptors = Date.now(); gateway.directory.markDirty(); }
    const rows = (await gateway.directory.read()).workspaces as Descriptor[];
    return rows.filter(w => !w.archivingAt).map(w => ({ id: w.id, name: w.title || w.name || "Workspace", project: w.projectCustomName || w.projectDisplayName || null, projectId: w.projectId ?? null, activityAt: w.activityAt ?? null,
      branch: w.gitRuntime?.currentBranch ?? null, pr: w.githubRuntime?.pullRequest?.title ? { number: w.githubRuntime.pullRequest.number ?? null, title: w.githubRuntime.pullRequest.title } : null }));
  };
  const overseerOn = async () => (await inboxSettings()).enable_overseer !== false;
  overseer = new Overseer({ directory, store, inbox, sources: senderSources, priorities: priorityStore, workspaces: paseoWorkspaces, enabled: overseerOn, paseoHome, tight: async () => !governor.allowsBackground(),
    windowMs: async () => activeWindowMs(await store.snapshot()), agent: () => agentSettings.role("overseer"),
    // Harness override only (isolated test daemons): "provider/model" wins over Settings → Agents.
    provider: process.env.FOLLOW_UP_OVERSEER_PROVIDER || undefined,
    // Starts the run and answers at once (a tool call shares the plugin RPC timeout); the current ranking comes along.
    rerank: async () => {
      if (!ranker) throw new Error("The ranker isn't ready yet.");
      const { started } = ranker.start({ trigger: "overseer" });
      const titles = new Map((await overseer!.workstreams()).map(w => [w.workspaceId, w.title]));
      const current = (await priorityStore.read()).filter(p => p.by === "ranker").slice(0, 5).map(p => ({ title: titles.get(p.workspaceId) ?? p.workspaceId, score: p.score, reason: p.reason }));
      return { started, current, next: `${started ? "Re-ranking started" : "A ranking is already running"}; it takes about a minute and Home updates by itself. Tell the developer that in one line, with the current top two or three if they asked what to work on.` };
    } });
  const overseerStatus = async () => {
    const [s, info] = await Promise.all([overseer!.state(), overseer!.agentInfo()]);
    // Labels from the last catalog Settings read (never fetched here: this is polled), so both surfaces say the same.
    const catalog = providerCatalog.peek();
    const runningModel = info.running?.model.replace(/^[^/]+\//, "") ?? "";
    const running = info.running ? { ...resolveRole(null, "overseer"), provider: info.running.provider, model: runningModel || null } : null;
    const model = running ? (runningModel ? roleSummary(running, labelsFor(running, catalog)) : `${providerName(running.provider, labelsFor(running, catalog).provider)} · Opus`) : null;
    const role = await agentSettings.role("overseer");
    const configured = roleSummary(role, labelsFor(role, catalog));
    return { enabled: await overseerOn(), agentId: s.agentId, workspaceId: s.workspaceId, startedAt: s.startedAt, generation: s.generation, error: s.error,
      model, restartWith: info.restart ? configured : null, configured };
  };
  handle(rpc.overseerStatusRpc, async () => { await requireReady(); return overseerStatus(); });
  handle(rpc.overseerStartRpc, async (_input, { paseo }) => { await requireReady(); seen(paseo); await overseer!.start(paseo as unknown as OverseerPaseo); return overseerStatus(); });
  handle(rpc.overseerAskRpc, async ({ text }, { paseo }) => { await requireReady(); seen(paseo); await overseer!.ask(paseo as unknown as OverseerPaseo, text); return overseerStatus(); });
  handle(rpc.overseerRestartRpc, async (_input, { paseo }) => { await requireReady(); seen(paseo); await overseer!.restart(paseo as unknown as OverseerPaseo); return overseerStatus(); });
  // The provider catalog for Settings → Agents: read only when that screen asks, cached ten minutes.
  const providerCatalog = new ProviderCatalog(async () => {
    const paseo = api;
    if (!paseo) throw new Error("Paseo isn't connected yet");
    // Paseo discovers providers lazily: on the first read they're still loading, so wait a little for them.
    const snapshot = await paseo.providers.snapshot() as unknown as { entries?: { status?: string }[] };
    if (!snapshot.entries?.some(e => e.status === "loading")) return snapshot as Awaited<ReturnType<CatalogSource>>;
    return await paseo.providers.waitForReady({ timeoutMs: 8000 }).catch(() => snapshot) as unknown as Awaited<ReturnType<CatalogSource>>;
  });
  const agentSettingsView = async (catalog: boolean, fresh = false): Promise<AgentSettingsView> => {
    const [{ invalid }, roles] = await Promise.all([agentSettings.load(), agentSettings.all()]);
    const cat = catalog ? await providerCatalog.read(fresh) : null;
    return { roles: Object.values(roles).map(r => ({ ...r, summary: roleSummary(r, labelsFor(r, cat)) })), invalid, catalog: cat, wait: await currentWait() };
  };
  // What's new and Settings → General. Follow-up's own install comes from Paseo's plugin list, read once per worker.
  const versions = new VersionsStore(directory);
  const updatesStore = new UpdatesStore(directory);
  let self: Promise<SelfInstall & { name: string | null; notes: ReleaseNote[] }> | null = null;
  const selfInstall = () => self ??= withDaemon(async c => describeSelf(await c.listPlugins?.() ?? [])).then(async row => {
    const pkg = row.path ? await readPackage(row.path) : { version: null, name: null, notes: [] };
    const version = pkg.version ?? row.version;
    if (!version) throw new Error("Paseo's plugin list doesn't show Follow-up's version yet.");
    // Fresh or existing comes from setup's own record, decided once before anything else wrote state.
    const existing = await onboarding.init().then(f => f.install === "existing", () => true);
    await versions.started(version, existing).catch(() => undefined);
    return { ...row, version, name: pkg.name, notes: pkg.notes };
  }).catch(error => { self = null; throw error; });
  // Record the version at start (in the background), so "Updated to X 2h ago" counts from the reload, not first view.
  void ready.then(() => selfInstall()).catch(() => undefined);
  const releaseNotesView = async (): Promise<ReleaseNotesView> => {
    const me = await selfInstall(); const file = await versions.read();
    return demoOverride(directory, "release-notes", releaseNotesViewSchema, { version: me.version, name: me.name ?? PLUGIN_NAME, installKind: me.installKind, previous: file.previous ?? null, updatedAt: file.startedAt ?? null, hostSeen: file.hostSeen ?? null, notes: me.notes });
  };
  handle(rpc.releaseNotesRpc, async () => releaseNotesView());
  handle(rpc.whatsNewSeenRpc, async ({ version }) => { await versions.seen(version); return releaseNotesView(); });
  // Settings → General: see server/updater.ts. The registry snapshot lives in registry.json; installs run detached.
  const registry = new RegistryChecker({ packageName: "paseo-follow-up", fetch: (url, init) => fetch(url, init),
    load: () => readFile(join(directory, "registry.json"), "utf8").then(t => JSON.parse(t) as RegistrySnapshot, () => null),
    save: async snap => { const tmp = join(directory, `registry.json.${process.pid}.tmp`); await writeFile(tmp, JSON.stringify(snap), { mode: 0o600 }); await rename(tmp, join(directory, "registry.json")); } });
  const watchdogLock = join(directory, "update-watchdog.lock");
  // Only the isolated update harness sets this: short quiet window and probation, so a rollback shows in minutes.
  const fastUpdates = process.env.FOLLOW_UP_UPDATES_FAST === "1";
  const lockAlive = async (path: string) => {
    const lock = await readFile(path, "utf8").then(t => JSON.parse(t) as { pid?: number }, () => null);
    if (!lock?.pid) return false;
    try { process.kill(lock.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  };
  const installerAlive = () => lockAlive(watchdogLock);
  const busyNow = async (fresh: boolean) => {
    const busy: Busy[] = [];
    const rows = await gateway.directory.read(fresh ? { fresh: "agents" } : {});
    const agents = busyAgents(rows.agents.map(({ agent }) => ({ status: agent.status, archivedAt: agent.archivedAt, hasFollowTools: true })));
    if (agents) busy.push({ kind: "agent", count: agents });
    if (ranker?.isRunning()) busy.push({ kind: "ranker" });
    else if (aiJobs.active > 0) busy.push({ kind: "about" });
    const state = await store.snapshot();
    const prActions = state.workspaces.reduce((n, w) => n + w.prActions.filter(a => a.state === "sending").length, 0);
    const repairs = state.workspaces.reduce((n, w) => n + w.batches.filter(b => b.state === "sending").length, 0);
    if (prActions) busy.push({ kind: "pr-action", count: prActions });
    if (repairs) busy.push({ kind: "repair", count: repairs });
    return busy;
  };
  const watchdogTiming = fastUpdates ? { timing: { probationMs: 60_000, loadTimeoutMs: 45_000, watchEveryMs: 5_000 } } : {};
  /** Writes the installer and starts it detached, with its job in the environment (it carries the daemon password). */
  const startWatchdog = async (job: Record<string, unknown>, to: string) => {
    const script = join(directory, "update-watchdog.mjs");
    await writeFile(script, watchdogSource, { mode: 0o600 });
    const env = { ...process.env, FOLLOW_UP_UPDATE_JOB: JSON.stringify({ ...job, directory, clientEntry: clientEntry(), daemon: await daemonOptions(), ...watchdogTiming }) };
    const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore", env });
    child.unref();
    await writeFile(watchdogLock, JSON.stringify({ pid: child.pid, to }), { mode: 0o600 });
  };
  const updater = new Updater({
    directory, read: () => updatesStore.read(), defaultMode: () => onboarding.init().then(f => f.install === "fresh" ? "auto" as const : "notify" as const, () => "notify" as const), write: next => updatesStore.write(next), self: () => selfInstall(), registry,
    changelog: (tarball, integrity) => tarballChangelog({ fetch: (url, init) => fetch(url, init), tarball, integrity }),
    provenance: version => checkProvenance({ fetch: (url, init) => fetch(url, init), registry: registryUrl(), name: "paseo-follow-up", version }),
    busy: busyNow,
    installerAlive,
    spawn: async job => {
      if (await installerAlive()) return false;
      await startWatchdog({ ...job, pluginId: (await selfInstall()).id ?? PLUGIN_ID }, job.to);
      return true;
    },
    log: message => console.warn(message),
    timing: fastUpdates ? { quietMs: 90_000, probationMs: 60_000 } : undefined,
  });
  // 2.0's one-time move from 1.x's plugin id (server/plugin-move.ts; the move itself runs in update-watchdog.mjs).
  const pluginMove = new PluginMove({
    directory, self: () => selfInstall(), busy: busyNow,
    // A 1.x installer (#61) on probation for this version holds the old directory's lock; moving now would look to it
    // like Follow-up vanished, and it would roll back.
    installerAlive: async () => await installerAlive() || await lockAlive(join(dataDirs(paseoHome).legacy, "update-watchdog.lock")),
    spawn: async job => {
      if (await installerAlive()) return false;
      await startWatchdog({ kind: "move", ...job, packageName: "paseo-follow-up", settingsRoot: join(paseoHome, "plugin-settings") }, job.version);
      return true;
    },
    quietMs: fastUpdates ? 90_000 : undefined,
  });
  // A worker that couldn't start never moves: under probation it is rolled back, and a later good start moves.
  const evaluateMove = () => stopped || loadError ? Promise.resolve() : pluginMove.evaluate().catch(() => undefined);
  const updatesView = async (): Promise<UpdatesView> => demoOverride(directory, "updates", updatesViewSchema, { ...await updater.view(), move: await pluginMove.view().catch(() => null) });
  // The new worker reports in for the installer's probation once it is ready, with the reason if it couldn't start.
  void ready.then(async () => {
    const me = await selfInstall();
    const beat = JSON.stringify({ version: me.version, at: Date.now(), error: loadError ? String(loadError).slice(0, 300) : null });
    await writeFile(join(directory, "heartbeat.json"), beat, { mode: 0o600 });
    // A 1.x installer on probation reads the old directory's heartbeat; can go in the release after 2.0.0.
    try { writeLegacyHeartbeat(paseoHome, beat); } catch { /* no 1.x directory, or not writable: nothing watches it */ }
    if (!stopped) await updater.start();
    await evaluateMove();
  }).catch(() => undefined);
  handle(rpc.updatesRpc, async ({ check }) => {
    if (check) await updater.check(check).catch(() => undefined);
    return updatesView();
  });
  handle(rpc.setUpdatesRpc, async ({ mode, channel }) => { await updater.setSettings({ mode, channel }); return updatesView(); });
  handle(rpc.installUpdateRpc, async ({ version, anyway }) => { await updater.install(version, !!anyway); return updatesView(); });
  handle(rpc.retryMoveRpc, async () => { await pluginMove.retry(); return updatesView(); });
  handle(rpc.dismissUpdateNoticeRpc, async ({ id }) => { await updater.dismiss(id); return updatesView(); });
  handle(rpc.agentSettingsRpc, async ({ catalog, fresh }, { paseo }) => { await requireReady(); seen(paseo); return agentSettingsView(!!catalog, !!fresh); });
  handle(rpc.setAgentSettingRpc, async ({ role, entry }, { paseo }) => { await requireReady(); seen(paseo); await agentSettings.save(role, entry); return agentSettingsView(true); });
  // The developer's timezone, reported by their Follow-up client: an agent's "tonight"/"tomorrow" snooze resolves in it,
  // not on this host's clock (often UTC). Kept across restarts; the last client to report wins.
  handle(rpc.clientTimeZoneRpc, async ({ timeZone }) => {
    if (!isTimeZone(timeZone)) return { ok: false };
    if (timeZone !== clientTimeZone) { clientTimeZone = timeZone; await writeFile(timeZonePath, JSON.stringify({ timeZone }), { mode: 0o600 }).catch(() => undefined); }
    return { ok: true };
  });
  handle(rpc.setWaitRpc, async ({ enable_wait }, { paseo }) => { await requireReady(); seen(paseo); await agentSettings.setWait(enable_wait); return agentSettingsView(true); });
  handle(rpc.overseerActRpc, async ({ agentId, tool, args }, { paseo }) => {
    await requireReady(); seen(paseo);
    if (!(OVERSEER_TOOLS as readonly string[]).includes(tool)) throw new Error(`Unknown Overseer tool ${tool}.`);
    return overseer!.act(paseo as unknown as OverseerPaseo, agentId, tool as OverseerTool, args);
  });
  // Summary: small model jobs through the shared runner, cached per workspace in about.json.
  const aiJobs = new AiJobs({ concurrency: 1, logPath: join(directory, "ai-jobs.jsonl"), generic: jobAgentRunner({ paseo: () => api as unknown as JobPaseo | null, directory }) });
  // The ranker behind Home's Priority sort (1.4.0-beta.0). Its provider, model and limits come from the ranker role
  // in Settings → Agents. Inputs are read-only: Follow-up's state, mcpproxy, gh, the plan.
  const rankerOn = async () => (await inboxSettings()).enable_ranker !== false;
  const rankerRole = async () => {
    const r = await agentSettings.role("ranker");
    return { provider: r.provider, model: r.model, thinking: r.thinking, dailyCap: r.dailyCap ?? RANKER_ROLE_DEFAULT.dailyCap, maxPromptChars: r.maxPromptChars ?? RANKER_ROLE_DEFAULT.maxPromptChars, cadenceMinutes: r.cadenceMinutes ?? RANKER_ROLE_DEFAULT.cadenceMinutes };
  };
  ranker = new Ranker({ directory, jobs: aiJobs, priorities: priorityStore, role: rankerRole, enabled: rankerOn, tight: async () => !governor.allowsBackground(),
    workstreams: () => overseer!.workstreams(), planningUrl: () => planningUrl(process.env.FOLLOW_UP_PLAN_URL),
    sources: liveRankSources(aiJobs, { model: async () => { const r = await rankerRole(); return r.provider === "claude" ? r.model : null; } }) });
  handle(rpc.rankStatusRpc, async () => { await requireReady(); return ranker!.status(); });
  // Returns at once: the run can take minutes on a slow model; Home polls rank-status and shows "Ranking…".
  handle(rpc.rankNowRpc, async ({ force }) => { await requireReady(); return { ...ranker!.start({ trigger: "manual", force: !!force }), running: true }; });
  // Agent metadata only (agents.list never loads an agent), cached for a minute and shared by every overview.
  type AgentMeta = { id: string; title: string | null; parent: string | null; snapshot: LoadSignals };
  let agentMeta: { at: number; rows: Map<string, AgentMeta> } | null = null;
  const agentsMeta = async (paseo: PaseoApi) => {
    if (agentMeta && Date.now() - agentMeta.at < 60_000) return agentMeta.rows;
    const rows = new Map<string, AgentMeta>();
    let cursor: string | null | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const e of page.entries as unknown as { agent: LoadSignals & { id: string; title?: string | null; labels?: Record<string, string> } }[])
        rows.set(e.agent.id, { id: e.agent.id, title: e.agent.title ?? null, parent: e.agent.labels?.["paseo.parent-agent-id"] ?? null, snapshot: e.agent });
      if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) break;
      cursor = page.pageInfo.nextCursor;
    }
    agentMeta = { at: Date.now(), rows };
    return rows;
  };
  const aboutContext = (): AboutContext | null => {
    const paseo = api;
    if (!paseo) return null;
    return {
      async history(agentId, limit) {
        const meta = (await agentsMeta(paseo)).get(agentId);
        return rootHistory(meta?.snapshot, async () => {
          const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit, projection: "canonical" });
          return [...(page as unknown as { entries: { seqStart: number; item: unknown }[] }).entries].sort((a, b) => a.seqStart - b.seqStart).map(e => e.item);
        }, async () => { const disk = await readTranscript(paseoHome, agentId, limit); return disk ? { first: disk.first.map(i => i.text ?? ""), items: disk.tail } : null; });
      },
      async subagents(agentId) {
        return [...(await agentsMeta(paseo)).values()].filter(r => r.parent === agentId && r.title).map(r => r.title!);
      },
    };
  };
  const aboutStore = new AboutStore(directory);
  const about = new AboutService({
    role: () => agentSettings.role("about"),
    store: aboutStore, jobs: aiJobs, sources: liveSources(),
    workspace: async id => (await store.snapshot()).workspaces.find(w => w.id === id && w.enable_tracking && !w.archived) ?? null,
    context: aboutContext, usage: () => usage.read(),
    firstMessage: async agentId => { await historyCache.load(); return historyCache.get(agentId)?.history.goal ?? null; }, roomForBackground: async () => governor.allowsBackground(), roomOnDemand: async () => governor.allowsExtras(),
  });
  handle(rpc.workspaceAboutRpc, async ({ workspaceId, open, refresh }, { paseo }) => { await requireReady(); seen(paseo); return about.view(workspaceId, { open, refresh }); });
  // Pre-write overviews for what's in Needs you, so opening one there is instant. Every 10 minutes, capped per day.
  let aboutTimer: ReturnType<typeof setTimeout> | null = null;
  const aboutLoop = async () => {
    await ready;
    if (stopped || loadError) return;
    try {
      const rows = (await inbox.list()).rows.filter(r => r.needs && !r.snooze);
      const state = await store.snapshot();
      // Needs you only, and never dormant workspaces.
      const ids = [...new Set(rows.map(r => state.workspaces.find(w => w.enable_tracking && !w.archived && !w.dormant && w.mainAgentId === r.agentId)?.id).filter((x): x is string => !!x))];
      await about.background(ids);
    } catch { /* background only; the section writes on open */ }
    if (!stopped) aboutTimer = setTimeout(() => void aboutLoop(), 10 * 60_000);
  };
  aboutTimer = setTimeout(() => void aboutLoop(), 60_000);
  // Linked items (shared/linked.ts): carry over verified About links once, then note the workspace record's own
  // references and drain the Linear check queue on the same 10-minute cadence. An empty queue (the steady state)
  // costs one small file read and no MCP call.
  let linkedTimer: ReturnType<typeof setTimeout> | null = null;
  const linkedLoop = async () => {
    await ready;
    if (stopped || loadError) return;
    await linked.migrate(async () => (await aboutStore.read()).entries).catch(() => undefined);
    const state = await store.snapshot().catch(() => null);
    if (state) await linked.note(new Map(state.workspaces.filter(w => w.enable_tracking && !w.archived && !w.dormant).map(w => [w.id, workspaceRefs(w)]))).catch(() => undefined);
    await linked.drain().catch(() => undefined);
    if (!stopped) linkedTimer = setTimeout(() => void linkedLoop(), 10 * 60_000);
  };
  linkedTimer = setTimeout(() => void linkedLoop(), 90_000);
  // Developer RPCs as agent tools (server/agent-parity.ts): the same handler the button's RPC runs.
  const rpcBridge = {
    async validate(method: string, input: unknown) { const h = handlers.get(method); if (!h) throw new Error(`Unknown Follow-up method ${method}.`); return h.input.parseAsync(input); },
    // Agent tools reach handlers only here, so the acting agent rides along (shared/actor.ts): without it a call is the app's.
    async call(method: string, input: unknown, actor?: Actor) { const h = handlers.get(method); if (!h) throw new Error(`Unknown Follow-up method ${method}.`); return h.run(await h.input.parseAsync(input), { paseo: api, ...(actor ? { actor } : {}) } as PluginHandlerContext); },
  };
  // Settings → Display is host-scoped: read it here, write it through the host's settings RPC, as the screen does.
  const displayBridge = {
    async read() { const state = await displaySettings.read(); if (state.status !== "ready") throw new Error(`Display preferences can't be read: ${state.error}`); return { revision: state.revision, values: state.values as Record<string, unknown> }; },
    async write(revision: string, values: Record<string, unknown>) {
      const result = await withDaemon(client => invokeSelf(id => client.invokePluginRpc(id, `settings.${displayPreferences.id}.write`, { revision, values }))) as { status?: string; error?: string } | null;
      // "saved", or "conflict" (someone changed them since the read) / "invalid".
      if (result?.status !== "saved") throw new Error(result?.status === "conflict" ? "Display preferences changed since the dry run. Run set_display again." : result?.error ?? "Display preferences weren't saved. Try again.");
      return result;
    },
  };
  // Report an issue (server/report-issue/, adapter server/report-issue-adapter.ts): reads only while a report is prepared.
  const reportKit = followUpReporter({
    github: githubApi(), updates: () => updatesView(), call: (method, input) => rpcBridge.call(method, input ?? {}), snapshot: () => store.snapshot(),
    resources: () => governor.current(), serverInfo: () => withDaemon(async client => (client as ServerInfoClient).getLastServerInfoMessage?.() as never), logs: logRing,
    toolTransport: () => toolTransport, startedAt,
  });
  const agentActions = new AgentActions({ timeZone: () => clientTimeZone, store, prActions: actions, engine, inbox, priorities: priorityStore, about, agentSettings, wait: { status: currentWait }, prWorkflows: () => prWorkflowView(), rpc: rpcBridge, display: displayBridge, report: { run: (caller, args) => reportKit.reporter.run(caller, args) }, agentTitle: async id => (await api?.agents.ref(id).refresh().catch(() => null))?.agent?.title ?? null,
    // The directory's agent list (metadata only): a claim never loads or refreshes the main agent.
    agentInfo: async agentId => { const row = gateway.directory.cached(agentId) ?? (await gateway.directory.read()).agents.find(r => r.agent.id === agentId)?.agent; return row ? { status: row.status, activeTurn: row.activeTurn, pendingPermissions: row.pendingPermissions, archivedAt: row.archivedAt } : null; } });
  handle(rpc.prioritiesRpc, async () => ({ items: await priorityStore.read() }));
  // The Report sheet: who it can send to (directory metadata only; nothing is loaded), Send to agent, Open on GitHub.
  handle(rpc.reportTargetsRpc, async ({ workspaceId, agentId }, { paseo }) => {
    seen(paseo);
    const rows = await gateway.directory.read().catch(() => null);
    const state = await store.snapshot();
    const mains = new Map(state.workspaces.filter(w => w.mainAgentId).map(w => [w.mainAgentId, w]));
    const titles = new Map((rows?.workspaces ?? []).map(w => [w.id, w.name]));
    const agents = (rows?.agents ?? []).map(r => r.agent).filter(a => !a.archivedAt && !a.background && !isOverseerAgent(a.labels))
      .map(a => ({ id: a.id, title: a.title ?? "Untitled agent", provider: a.provider, status: a.status, workspaceId: a.workspaceId ?? null, workspaceTitle: a.workspaceId ? titles.get(a.workspaceId) ?? null : null, main: mains.has(a.id), last: Date.parse(a.lastUserMessageAt ?? a.createdAt) || 0 }));
    const rank = (a: typeof agents[number]) => (a.id === agentId ? 4 : 0) + (workspaceId && a.workspaceId === workspaceId ? 2 : 0) + (a.main ? 1 : 0);
    const sorted = agents.filter(a => a.id === agentId || a.workspaceId === workspaceId || a.main).sort((x, y) => rank(y) - rank(x) || y.last - x.last).slice(0, 6);
    const here = workspaceId && titles.has(workspaceId) ? { id: workspaceId, title: titles.get(workspaceId)! } : sorted[0]?.workspaceId ? { id: sorted[0].workspaceId, title: sorted[0].workspaceTitle ?? "Workspace" } : (rows?.workspaces ?? []).filter(w => !w.archivingAt)[0] ? { id: rows!.workspaces[0].id, title: rows!.workspaces[0].name } : null;
    return { agents: sorted.map(({ last: _l, ...a }) => a), defaultId: sorted[0]?.id ?? null, newAgentWorkspace: here };
  });
  handle(rpc.reportSendRpc, async ({ kind, text, error, agentId, newAgentWorkspaceId }, { paseo }) => {
    seen(paseo);
    const prompt = reportPrompt(kind, text, error);
    if (agentId) {
      await sendTo(agentId)(prompt, randomUUID());
      const row = (await gateway.directory.read().catch(() => null))?.agents.find(r => r.agent.id === agentId)?.agent;
      return { agentId, title: row?.title ?? "the agent", started: false };
    }
    if (!newAgentWorkspaceId) throw new Error("Pick an agent, or a workspace to start a new one in.");
    const title = kind === "bug" ? "Report a Follow-up bug" : kind === "feature" ? "Follow-up feature request" : "Follow-up feedback";
    const providerId = (await agentSettings.role("overseer").catch(() => null))?.provider?.split("/")[0] ?? "claude";
    const agent = await paseo.workspaces.ref(newAgentWorkspaceId).agents.create({ config: { provider: await providerModel(paseo as unknown as OverseerPaseo, providerId) }, title, prompt });
    return { agentId: agent.id, title, started: true };
  });
  handle(rpc.reportLinkRpc, async ({ kind, text }) => ({ url: (await reportKit.manualLink(kind, text)).url }));
  // Provider limits are non-essential: at critical memory only the VM meter is served.
  handle(rpc.usageRpc, async () => ({ ...(governor.allowsExtras() ? await usage.read() : NO_USAGE), resources: governor.current() }));
  handle(rpc.agentActRpc, async ({ agentId, tool, args }, { paseo }) => {
    await requireReady(); seen(paseo);
    if (!(AGENT_TOOLS as readonly string[]).includes(tool)) throw new Error(`Unknown Follow-up tool ${tool}.`);
    if (!/^[\w-]+$/.test(agentId)) throw new Error("Unsupported agent identity.");
    // Root agents only, the same rule as needs_you: never recovery, contributors or subagents.
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId || agent.archivedAt) throw new Error("Cannot locate the caller's workspace.");
    if (isRecovery(agent.labels)) throw new Error("Recovery sessions can't act for the developer. Acknowledge your batch instead.");
    // Contributors (the workspace's other root agents) get one tool: make_main_agent, with its claim rules.
    if (tool !== "make_main_agent" && (await store.snapshot()).workspaces.some(w => w.enable_tracking && !w.archived && w.contributorAgentIds?.includes(agentId))) throw new Error("Contributor sessions can't act for the developer. Report to the main agent.");
    if (!await isWorkspaceRoot(agent, async id => (await paseo.agents.ref(id).refresh())?.agent)) throw new Error("Follow-up's action tools are for root agents. Ask your parent agent.");
    const result = await agentActions.run(agentId, tool as AgentTool, args);
    void engine.tick();
    return result;
  });
  // Home, the sidebar badge and the pills poll this; an unchanged list answers in a few bytes (see inboxAnswer).
  handle(rpc.inboxListRpc, async ({ etag }) => { await requireReady(); return inboxAnswer({ ...await inbox.list(), error: inboxError }, etag); });
  handle(rpc.inboxBriefRpc, async ({ agentId }) => { await requireReady(); return { brief: await inbox.brief(agentId) }; });
  handle(rpc.inboxActRpc, async (input, context) => { await requireReady(); return inbox.act(input, actorOf(context)); });
  handle(rpc.needsYouRpc, async ({ agentId, ...input }, { paseo }) => {
    await requireReady(); seen(paseo);
    if (!(await inboxSettings()).enable_inbox) throw new Error("The Needs-you inbox is off, so there's no brief to fill. Finish with your normal reply.");
    if (!/^[\w-]+$/.test(agentId)) throw new Error("Unsupported agent identity.");
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId) throw new Error("Cannot locate the caller's workspace.");
    const saved = await store.snapshot();
    const tracked = saved.workspaces.find(w => w.id === agent.workspaceId && w.enable_tracking && !w.archived);
    // F2: root agents only. Contributors and recovery sessions report to the main agent; subagents to their parent.
    if (isRecovery(agent.labels) || tracked && tracked.mainAgentId !== agentId) throw new Error("needs_you is for the workspace's main agent. Report to the main agent instead.");
    if (!await isWorkspaceRoot(agent, async id => (await paseo.agents.ref(id).refresh())?.agent)) throw new Error("needs_you is for root agents. Report to your parent agent instead.");
    let call = validateNeedsYou(input, ref => {
      const key = ref.trim().replace(/^#/, "");
      const match = tracked?.prs.find(p => p.key.toLowerCase() === key.toLowerCase()) ?? (tracked?.prs.filter(p => String(p.number) === key).length === 1 ? tracked.prs.find(p => String(p.number) === key) : undefined);
      if (!match) throw new Error(`No registered PR matches ${ref}. Register it with register_pr first, or give the link as url.`);
      return match.key;
    });
    const turn = inbox.currentTurn(agentId);
    const previous = await readFile(needsYouPath(agentId), "utf8").then(t => JSON.parse(t) as NeedsYouRecord).catch(() => null);
    const sameTurn = !!previous && (turn?.turnId ? previous.turnId === turn.turnId : !!turn && previous.at >= turn.at);
    let questionIds: string[] = []; let createdIds: string[] = [];
    if (tracked) {
      const mode = await questionMode();
      const linked = await store.mutate(state => {
        const w = findWorkspace(state, tracked.id);
        const result = needsYouQuestions(w, agentId, call, mode, Date.now(), sameTurn ? previous : null);
        if (result.questionIds.length || sameTurn) changed(w);
        return result;
      });
      questionIds = linked.questionIds; createdIds = linked.createdIds;
      // The brief maps decisions to questions by position, so the record keeps them aligned (a linked question shows as itself).
      const { questions: _refs, ...rest } = call;
      call = { ...rest, ...(linked.decisions.length ? { decisions: linked.decisions } : {}) };
      if (!linked.decisions.length) delete call.decisions;
    } else if (call.questions?.length) throw new Error("questions point at a tracked workspace's open questions, and this workspace isn't tracked.");
    const record: NeedsYouRecord = { at: Date.now(), turnId: turn?.turnId ?? null, call, questionIds, createdIds };
    await mkdir(join(directory, "hook-state"), { recursive: true, mode: 0o700 });
    const temporary = `${needsYouPath(agentId)}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, needsYouPath(agentId));
    return { ok: true as const, briefId: `brief:${turn?.turnId ?? record.at}` };
  });
  // Replies once the answer is recorded; the send runs after (Inbox.briefAction), so a dormant agent's slow resume never
  // times the card out.
  handle(rpc.briefActionRpc, async ({ agentId, briefId, decisionId, choice, words, choices, move, answerId }, context) => {
    const { paseo } = context;
    await requireReady(); seen(paseo);
    const brief = await inbox.briefAction(agentId, { briefId, decisionId, choice, words, choices, move, answerId }, sendTo(agentId), actorOf(context));
    return { brief };
  });

  // Trust bypass agents: answer the plain tool prompts a full-trust agent still raises (server/trust-bypass.ts). The
  // mode is re-read at request time; the inbox holds a permission row back for its grace period, and the resolve
  // this approval causes cancels it, so an approved prompt never flags Needs you.
  let trustApi: PaseoApi | null = null;
  const trust = new TrustBypass(directory, {
    enabled: async () => (await inboxSettings()).enable_trust_bypass,
    // The mode the provider reports now; never the one the agent was created with.
    // Before any handler context exists (the load sweep below), the same reads go through a daemon connection.
    mode: async agentId => {
      const agent = trustApi ? (await trustApi.agents.ref(agentId).refresh())?.agent : (await withDaemon(client => client.fetchAgent(agentId)))?.agent;
      return agent?.currentModeId ?? agent?.runtimeInfo?.modeId ?? null;
    },
    approve: (agentId, requestId) => trustApi
      ? trustApi.agents.ref(agentId).respondToPermission({ requestId, response: { behavior: "allow" } })
      : withDaemon(client => client.respondToPermission(agentId, requestId, { behavior: "allow" })),
  });
  // Prompts already pending when Follow-up loaded or updated raise no new event: sweep them once, from the startup
  // agent list (metadata only; only loaded agents can have a pending prompt, so no agent is loaded or refreshed).
  void ready.then(async () => {
    if (loadError || stopped) return;
    const decisions = await trust.sweep((await gateway.directory.read()).agents.map(row => row.agent));
    const approved = decisions.filter(d => d.approved).length;
    if (approved) console.warn(`[follow-up] trust bypass approved ${approved} prompt(s) already pending at load`);
  }).catch(() => undefined);
  handle(rpc.trustBypassRpc, async () => trust.recent(20));
  handle(rpc.onboardingRpc, async () => { await requireReady(); return onboarding.view(); });
  handle(rpc.setOnboardingRpc, async ({ action, step }) => {
    await requireReady();
    const before = await onboarding.init();
    const view = await onboarding.act(action, step ?? null);
    // A fresh install passing the Updates step, or skipping setup, takes Install automatically (see updatesConsent).
    if (updatesConsent({ install: before.install, settled: !!before.settledAt, action, from: before.step, to: step ?? null }) && !(await updatesStore.read()).mode)
      await updater.setSettings({ mode: "auto" }).catch(() => undefined);
    return view;
  });
  // Readiness checks for the setup flow: gh, the helper providers and whether tools attach. On demand only, cached.
  const readiness = new ReadinessChecks({
    gh: () => new Promise((resolve, reject) => execFile("gh", ["api", "user", "--jq", ".login"], { timeout: 10_000 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout))),
    catalog: () => providerCatalog.read(),
    use: async () => {
      const on = await inboxSettings();
      const roles = await agentSettings.all();
      const use: Record<string, string[]> = {};
      const add = (provider: string, name: string) => { (use[provider] ??= []).push(name); };
      if (on.enable_overseer !== false) add(roles.overseer.provider, "the Overseer");
      add(roles.about.provider, "Summaries");
      if (on.enable_ranker !== false) add(roles.ranker.provider, "AI priority");
      return use;
    },
    tools: async () => ({ config: await paseoConfig(), nativeAgents: await nativeAgentCount(directory), hookError }),
  });
  handle(rpc.onboardingChecksRpc, async ({ fresh }, { paseo }) => { await requireReady(); seen(paseo); return readiness.run(!!fresh); });

  type SessionOpen = (input: { request: PluginSessionOpenRequest }, context: PluginHookContext) => Promise<PluginSessionOpenRequest | void>;
  // Paseo 0.16 background agents (another plugin's helpers) get no root treatment: no tools, no Wait, no needs_you or
  // Stop-hook nudge. The flag is only in the agent snapshot, so session open reads it once per agent.
  let saveBackground: () => Promise<void> = async () => {};
  const background = new BackgroundAgents(() => saveBackground());
  saveBackground = backgroundAgentsFile(directory, () => background.ids);
  try { background.seed(JSON.parse(readFileSync(join(directory, "background-agents.json"), "utf8"))?.agents); } catch { /* none yet */ }
  const isBackground = (agentId: string, paseo: PluginHandlerContext["paseo"]) => background.check(agentId, async id => (await paseo.agents.ref(id).refresh())?.agent as { background?: unknown } | undefined);
  const withWait = (handler: SessionOpen): SessionOpen => async (input, context) => wait.open((await handler(input, context)) ?? input.request, { background: await isBackground(input.request.agentId, context.paseo) });
  const removers = [
    server.on("agent.permission_requested", async (event, { paseo }) => { trustApi = paseo; await trust.handle(event.agent, event.request as never).catch(() => undefined); }),
    displaySettings.subscribe(() => void writeBriefState().catch(() => undefined)),
    // The shared directory learns from events instead of polling Paseo (see DaemonDirectory). Registered first so the
    // handlers below read the patched rows.
    server.on("agent.turn_started", async event => gateway.directory.turnStarted(event.agent, event.turnId)),
    server.on("agent.turn_ended", async event => gateway.directory.turnEnded(event.agent, event.outcome)),
    server.on("agent.permission_requested", async event => gateway.directory.permissionRequested(event.agent.id, event.request as { id?: string })),
    server.on("agent.permission_resolved", async event => gateway.directory.permissionResolved(event.agent.id, event.requestId)),
    server.on("agent.archived", async event => gateway.directory.agentArchived(event.agent.id, event.archivedAt)),
    server.on("agent.closed", async event => gateway.directory.agentClosed(event.agent.id)),
    // 0.16: the background flag first shows up here (it isn't in session_open yet), so the hook learns it now.
    server.on("agent.created", async (event, { paseo }) => { await ready; await isBackground(event.agent.id, paseo); await gateway.directory.agentCreated(event.agent); }),
    server.on("workspace.created", async event => gateway.directory.workspaceCreated(event.workspace)),
    server.on("workspace.archived", async event => gateway.directory.workspaceArchived(event.workspace.id)),
    server.on("agent.turn_started", async () => updater.activity()),
    server.on("agent.turn_ended", async () => { updater.activity(); void evaluateMove(); }),
    server.on("agent.turn_started", async (event, { paseo }) => { seen(paseo); inboxHook(() => inbox.turnStarted(event.agent, event.turnId)); }),
    // A newer main-agent turn supersedes the failed turn's automatic hold (shared/status.ts holdSuperseded).
    server.on("agent.turn_started", async event => {
      if (event.turnId) startedTurns.set(event.agent.id, event.turnId);
      await ready;
      if (stopped || loadError) return;
      const turn = { agentId: event.agent.id, turnId: event.turnId ?? null };
      if (!(await store.snapshot()).workspaces.some(w => w.enable_tracking && holdSuperseded(w, turn))) return;
      await store.mutate(state => { for (const w of state.workspaces) if (w.enable_tracking && holdSuperseded(w, turn)) liftHold(w); });
      void engine.tick();
    }),
    server.on("agent.turn_ended", async (event, { paseo }) => { seen(paseo); inboxHook(() => inbox.turnEnded(event.agent, event.outcome, event.turnId)); }),
    server.on("agent.permission_requested", async (event, { paseo }) => { seen(paseo); inboxHook(async () => { await inbox.permissionRequested(event.agent, event.request); await writeBriefState(); }); }),
    server.on("agent.permission_resolved", async (event, { paseo }) => { seen(paseo); inboxHook(async () => { await inbox.permissionResolved(event.agent, event.requestId); await writeBriefState(); }); }),
    server.on("agent.closed", async event => inboxHook(() => inbox.closed(event.agent))),
    server.on("agent.archived", async event => inboxHook(() => inbox.archived([event.agent.id]))),
    // An archived Overseer comes back with a handoff summary (the next inbox tick also checks).
    server.on("agent.archived", async (event, { paseo }) => { seen(paseo); inboxHook(async () => { if (event.agent.id === (await overseer!.state()).agentId) await overseer!.ensure(paseo as unknown as OverseerPaseo); }); }),
    server.on("workspace.archived", async (event, { paseo }) => { seen(paseo); inboxHook(async () => { if (event.workspace.id === (await overseer!.state()).workspaceId) await overseer!.ensure(paseo as unknown as OverseerPaseo); }); }),
    server.on("workspace.archived", async event => inboxHook(() => inbox.workspaceArchived(event.workspace.id))),
    server.on("agent.turn_started", async event => {
      await ready;
      if (stopped || loadError) return;
      // A turn in a dormant workspace makes it active again; discovery reads the now-loaded agent on the next poll.
      const saved = await store.snapshot();
      const owned = saved.workspaces.find(w => w.enable_tracking && (w.mainAgentId === event.agent.id || w.contributorAgentIds?.includes(event.agent.id)));
      const waking = saved.workspaces.find(w => w.dormant && w.id === event.agent.workspaceId);
      if (!owned && !waking) return;
      if (owned) gateway.markDirty(event.agent.id);
      await store.mutate(state => {
        const w = owned && state.workspaces.find(w => w.id === owned.id); if (w) { w.completion = null; w.declaration = null; }
        const d = waking && state.workspaces.find(w => w.id === waking.id); if (d) delete d.dormant;
      });
      if (waking) void engine.tick();
    }),
    // Follow-up's own tools first, then Wait's on top (every interactive Claude session, tracked or not).
    server.before("agent.session_open", withWait(async ({ request }, { paseo }) => {
      await ready;
      if (loadError || stopped || request.purpose !== "interactive") return request;
      if (await isBackground(request.agentId, paseo)) return request;
      // The Overseer: needs_you (no Stop-hook nudge), the action tools and its routing tools. Never tracked.
      if (request.labels[OVERSEER_LABEL] === "1" && ["claude", "codex"].includes(request.provider)) {
        const env = { ...request.env, FOLLOW_UP_OVERSEER: "1", FOLLOW_UP_BRIEF: request.provider };
        return withTools({ ...request, env }, false, request.provider, true, true);
      }
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
            return { ...request, env: { ...request.env, FOLLOW_UP_CLI: bridge, FOLLOW_UP_CLIENT_ENTRY: clientEntry() } };
        }
      }
      const root = !!request.workspaceId && !isRecovery(request.labels) && await isWorkspaceRoot({ id: request.agentId, workspaceId: request.workspaceId, labels: request.labels }, async id => (await paseo.agents.ref(id).refresh())?.agent);
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
        return withTools({ ...request, env: { ...request.env, ...(brief ? { FOLLOW_UP_BRIEF: brief } : {}) } }, false, brief, true);
      }
      const recovery = w.mainAgentId !== request.agentId && !w.contributorAgentIds?.includes(request.agentId);
      const main = !recovery && w.mainAgentId === request.agentId ? brief : null;
      return withTools({ ...request, env: { ...request.env, FOLLOW_UP_CLI: bridge, FOLLOW_UP_CLIENT_ENTRY: clientEntry(), ...(recovery ? { FOLLOW_UP_RECOVERY: "1" } : {}), ...(main ? { FOLLOW_UP_BRIEF: main } : {}) } }, recovery, main, root && !recovery);
    })),
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
      // Only the developer's Stop holds (shared/status.ts cancelCause): a turn already replaced by a newer one (the
      // developer's or another agent's message), a /compact, or a closed or reloaded session never does.
      const started = startedTurns.get(event.agent.id);
      const newerTurn = !!started && started !== event.turnId;
      const prompt = history ? turnPrompt(history.entries.map(entry => entry.item)).message?.text ?? null : null;
      // Smart Session's own record of a /compact it just delivered: the canceled turn was that compaction.
      const compaction = event.outcome.kind === "canceled" && await compactionJustDelivered(event.agent.id, Date.parse(interruption!.at)).catch(() => false);
      if (["canceled", "failed"].includes(event.outcome.kind) && !guarded) await store.mutate(state => {
        const w = state.workspaces.find(w => w.enable_tracking && (w.mainAgentId === event.agent.id || w.contributorAgentIds?.includes(event.agent.id)));
        if (!w || w.mainAgentId !== event.agent.id || !interruption) return;
        // The provider lost the conversation: every later send fails the same way, so stop sending instead of holding.
        if (event.outcome.kind === "failed" && conversationGone(event.outcome.error.message)) { w.goneAgent = { agentId: event.agent.id, at: interruption.at, reason: event.outcome.error.message }; w.completion = null; w.declaration = null; return; }
        holdOnTurnEnd(w, { agentId: event.agent.id, turnId: interruption.turnId, at: interruption.at, outcome: event.outcome, prompt, newerTurn, compaction });
      });
      void engine.tick();
    }),
    server.on("workspace.archived", async event => { await ready; if (!loadError && !stopped) await store.mutate(state => { const w = state.workspaces.find(w => w.id === event.workspace.id); if (w) w.archived = true; }); }),
  ];
  return async () => {
    restoreConsole();
    stopped = true; wait.close(); updater.stop(); pluginMove.stop(); governor.stop(); if (timer) clearTimeout(timer); if (aboutTimer) clearTimeout(aboutTimer); if (linkedTimer) clearTimeout(linkedTimer); aiJobs.stop(); ranker = null; if (inboxTimer) clearTimeout(inboxTimer); inbox.stop(); rpcTiming.stop(); if (hookTimer) clearInterval(hookTimer); removers.forEach(remove => remove());
    // One deadline for every wait (worker-stop-never-waits-on-a-stuck-pass, server/teardown.ts): start-up and the work
    // in flight may be stuck on a daemon or CLI that never answers. Work that ends inside the deadline is saved; what
    // outlives it can't write, because the store closes before the lock is released.
    await stopWorker({ ready, hooks: hooksStarted ? () => agentHooks.stop() : undefined, actions, closeConnections, engine, store, inbox: inbox.store, unlock });
  };
}
