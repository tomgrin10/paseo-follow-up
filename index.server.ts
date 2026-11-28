import { pathToFileURL } from "node:url";
import { plainError } from "./shared/errors";
import { TranscriptTitleLookup, TranscriptTitleStore, trackedTitleTranscripts } from "./server/transcript-titles";
import { fillLinkedTitles, fillWorkspaceTitles, localTitles, workspaceNeedsTitles, type TitleIndex } from "./shared/local-titles";
import { stopWorker } from "./server/teardown";
import { WriteHealth } from "./server/write-behind";
import { actorBy, actorOf, type Actor } from "./shared/actor";
import { TICK_MS } from "./shared/poll";
import { PluginMove } from "./server/plugin-move";
import { moveData, dataDirs, writeLegacyHeartbeat, type DataMove } from "./server/data-move";
import { isRecovery, withRuntimePrelude, invokeSelf, PLUGIN_ID } from "./shared/legacy";
import { displayPreferences } from "./shared/display";
import { DEFAULT_QUESTION_MODE, QUESTION_DEDUPE_MIGRATION, awaitingSend, collapseDuplicateQuestions, questionPreferences, signedOffAnswers, type QuestionMode } from "./shared/questions";
import { answerRecipients, askQuestion, coverNote, needsYouQuestions, recordAnswer, syncTaskQuestions, withdrawQuestion } from "./server/questions";
import { dismissItem, dismissedNeeds, undoDismissItem } from "./server/dismiss";
import { developerSetSpec } from "./server/spec";
import { Cards, CardsStore } from "./server/cards";
import { cardContents, cardSummary, freshness, type AgentNow } from "./shared/cards";
import type { PluginServerContext, PluginHandlerContext, PluginHookContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { PluginRpcContract, PluginSubscriptionContract } from "@getpaseo/plugin";
import { ValueFeed, WorkspacesFeed } from "./server/feeds";
import { ContextRequests, contextRecipient, questionRecipient } from "./server/context-requests";
import { agentQuestionPrompt, questionHistory, questionsByWorkspace, questionTask } from "./shared/your-questions";
import { agentContextPrompt, contextFor, deckCards, type ContextVia } from "./shared/catch-up";
import { buildHome } from "./shared/home";
import { workspaceNow } from "./shared/now";
import { needsYou } from "./shared/attention";
import type { SortMode } from "./shared/sort";
import type { ZodType, output as zOutput } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { DISMISSED_ASK_NOTE, isTimeZone, sameAsk } from "./shared/inbox";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { activityPage, agentView, boundHistory } from "./shared/history";
import * as rpc from "./shared/contracts";
import { LogRing } from "./server/report-issue/diagnostics";
import { followUpReporter } from "./server/report-issue-adapter";
import { githubApi } from "./server/github-api";
import { githubSetup } from "./server/github-setup";
import { GithubOffError, githubOffText } from "./shared/github-setup";
import { browserRepositories, browserWorkspaces, prClaims, prOwner } from "./server/pr-owner";
import { type Workspace } from "./shared/model";
import { createdItems } from "./server/created-items";
import { isWorkspaceRoot } from "./server/workspace-agent";
import { BackgroundAgents, backgroundAgentsFile } from "./server/background-agents";
import { mayEnroll, recordedRecoveryAgent } from "./server/tasks";
import { Store } from "./server/store";
import { PriorityStore } from "./server/priorities";
import { freshPriorities } from "./shared/priorities";
import { UsageReader } from "./server/usage";
import { Engine, agentWorkspace, findWorkspace } from "./server/engine";
import { turnStarted, turnEnded, agentTrackedWorkspace } from "./server/turn-events";
import { TurnTimeline } from "./server/turn-timeline";
import { nextMessageInfo } from "./shared/task-rows";
import { sendingOf } from "./shared/sending";
import { Github } from "./server/github";
import { PrStats } from "./server/pr-stats";
import { ReviewerConfigStore, ReviewerSuggestions } from "./server/reviewer-config";
import { repoKey } from "./shared/reviewers";
import { Graphite } from "./server/graphite";
import { BrowserBridge } from "./server/browser-bridge";
import { PrActions } from "./server/pr-actions";
import { AgentActions, AGENT_TOOLS, controlWorkspace, type AgentTool } from "./server/agent-actions";
import { PaseoGateway, paseoHome, clientEntry, daemonOptions, closeConnections, sessionGuardOwnsInterruption, compactionJustDelivered } from "./server/daemon";
import { mcpSource } from "./server/mcp-source";
import * as agentText from "./shared/agent-text.mjs";
import { excludeStack } from "./server/exclusions";
import { applyDiscovery, mainWorkDue, markMainWork } from "./server/discovery";
import { lifecycleOnly, recoveryBatch } from "./shared/follow-up";
import { Deployments } from "./server/deployments";
import { AgentHooks } from "./server/agent-hooks";
import { withSessionMcp } from "./server/session-mcp";
import { nativeTools, nativeToolsAvailable, type Invoke, type Live } from "./server/native-tools";
import { compact } from "./server/mcp.mjs";
import { Wait, waitStatus, type WaitPaseoConfig } from "./server/wait";
import { removeGlobalRegistrations } from "./server/mcp-registrations";
import { TrustBypass } from "./server/trust-bypass";
import { scopes } from "./server/scopes";
import { TurnEnd } from "./server/turn-end";
import { updateObligation } from "./server/obligations";
import { Inbox, INBOX_WRITE_MS, type GuardPause } from "./server/inbox";
import { BriefTimeline } from "./server/brief-timeline";
import { daemonDirectory, guardPath } from "./server/inbox-directory";
import { fileSources } from "./server/inbox-classifier";
import { onBeforeSend, onDaemonReconnect } from "./server/daemon";
import { MessageQueue, undeliveredEntry } from "./server/message-queue";
import { queueView } from "./shared/queue";
import { copyFile, readFile, rename, stat } from "node:fs/promises";
import { HistoryCache } from "./server/history-cache";
import { Governor } from "./server/governor";
import { ListCache } from "./server/list-cache";
import { scopeWriter, workflowSummary } from "./server/scopes";
import { maintainTasks, type NudgeReceipt } from "./shared/task-due";
import { PrWorkflowStore } from "./server/pr-workflow";
import { commandName, handsMergeBack, noReviewRepoList, noReviewRepos } from "./shared/pr-workflow";
import { projectRepo } from "./server/daemon";
import { batchArchive, pruneUnsent } from "./server/batch-archive";
import { statusCheck } from "./server/status-check";
import { NO_USAGE, usageKey } from "./shared/usage";
import { isLoaded, activeWindowMs, DEFAULT_ACTIVE_WINDOW_DAYS } from "./server/agent-load";
import { DEFAULT_MAX_AUTO_SENDS } from "./shared/send-decision";
import { ACTIVE_SCOPE_MIGRATION, PRUNE_MIGRATION, autoSendsByDefault, FOLLOW_EVERY_MIGRATION, followsByDefault, followsEvery, migrateFollowEvery, optedOut } from "./shared/settings";
import { Overseer, OVERSEER_TOOLS, type OverseerPaseo, type OverseerTool, providerModel } from "./server/overseer";
import { OVERSEER_LABEL, isOverseerAgent } from "./shared/overseer";
import { withDaemon } from "./server/daemon";
import { RenameService, RenameStore, renameDaemon } from "./server/rename";
import { DispatchService, DispatchStore, type ActionChange, type DispatchPaseo, type DispatchProject } from "./server/dispatch";
import { LinearIssues } from "./server/linear-issues";
import { LinearQueue, LinearQueueStore } from "./server/linear-queue";
import { teamOf } from "./shared/linked";
import { holderOf, issueWorkspaces } from "./shared/issue-workspace";
import { currentSummary } from "./shared/about";
import { RpcTiming } from "./server/rpc-timing";
import { hostAtLeast, hostFeature, ROW_BADGES_SINCE, type ServerInfo } from "./server/host-features";
import { CHANGED_INSTRUCTIONS_HEADER, CODEX_PROMPT_MIN, atLeast, changedInstructions, codexVersion, promptRecordPath, withSystemPrompt, type BridgeTexts, type PromptDeps, type PromptRecord } from "./server/session-prompt";
import { isAcp } from "./shared/provider-support";
import { newWorkspaceTarget, sendReport, type ReportSendDeps } from "./server/report-send";
type ServerInfoClient = { getLastServerInfoMessage?: () => ServerInfo };
import { inboxAnswer } from "./server/etag";
import { CheckWatches } from "./server/check-watches";
import { ScheduledTasks } from "./server/scheduled-tasks";
import { githubOffChecksAnswer, waitForChecksAnswer } from "./server/wait-for-checks";
import { jobAgentRunner, type JobPaseo } from "./server/job-agent";
import { AiJobs } from "./server/ai-jobs";
import { liveRankSources, Ranker, RANKER_ROLE_DEFAULT } from "./server/ranker";
import { MorningBrief, MorningBriefStore, mcpproxyChat } from "./server/morning-brief";
import { matchPlan } from "./shared/morning-brief";
import { askSource } from "./server/ask";
import { BriefSources } from "./server/brief-sources";
import { Compass, CompassStore } from "./server/compass";
import { heardWords, nobodyNeeds } from "./shared/nobody";
import { COMPASS } from "./shared/compass";
import { sourceDirectory } from "./server/source-tools";
import { AboutService, AboutStore, liveSources, rootHistory, type AboutContext } from "./server/about";
import { LinkedService, LinkedStore, liveLinkedSources, type LinkResult } from "./server/linked";
import { workspaceRefs } from "./shared/linked-extract";
import { readTranscript, transcriptTurn } from "./server/transcript";
import { AgentSettingsStore, ProviderCatalog, type CatalogSource } from "./server/agent-settings";
import { labelsFor, providerName, resolveRole, roleSummary, type AgentSettingsView } from "./shared/agent-settings";
import type { LoadSignals } from "./shared/agent-load";
import { OnboardingStore, ReadinessChecks, nativeAgentCount } from "./server/onboarding";
import { updatesConsent, type GhResult } from "./shared/onboarding";
import { execFile, spawn } from "node:child_process";
import { compactHeap, watchMemory, writeHeartbeat } from "./server/memory";
import { UpdatesStore } from "./server/updates";
import { Updater } from "./server/updater";
import { RegistryChecker, registryUrl, type RegistrySnapshot } from "./server/update-registry";
import { checkProvenance, tarballChangelog } from "./server/update-provenance";
import { watchdogSource } from "./server/update-watchdog-source";
import { busyAgents, type Busy } from "./shared/update-policy";
import { VersionsStore, demoOverride, describeSelf, readPackage, type SelfInstall } from "./server/release-notes";
import { updatesViewSchema, type UpdatesView } from "./shared/updates";
import { PLUGIN_NAME, releaseNotesViewSchema, type ReleaseNote, type ReleaseNotesView } from "./shared/changelog";
import { BRIEF_KIND, BRIEF_VERSION, prState, prStates, validateNeedsYou, type NeedsYouRecord } from "./shared/brief";
import { foldedAsk } from "./shared/needs-block";
import { ARCHIVED_NEEDS_YOU_NOTE, paseoShowsLive } from "./shared/reopen";
import { ImageStore } from "./server/image-store";
import type { ImageRef, ImageUpload } from "./shared/images";
import { imageSupport, trustHarnessImageProviders } from "./server/image-support";

/** Agent calls that only the main agent makes: one of these from a successor means the handover is in use. */
const MAIN_WORK = new Set(["follow.sync", "follow.register-pr", "follow.obligation", "follow.done", "follow.acknowledge", "follow.exclude-stack", "follow.ask-question", "follow.record-answer", "follow.withdraw-question", "follow.needs-you"]);

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
  // RPCs only (0.16 overloads `server.handle` for subscriptions too): a subscription goes straight to `server.handle`
  // through `serveFeed`, never into `handlers`, so the in-process path can't call one with an RPC context.
  const handle = <I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, handler: (input: zOutput<I>, context: PluginHandlerContext) => unknown) => {
    // Main-agent work by a successor makes its handover stick (see handBackMainAgent): noted after the call succeeds.
    const run = MAIN_WORK.has(contract.name) ? (async (input: { agentId?: string }, context: PluginHandlerContext) => { const out = await (handler as (i: unknown, c: PluginHandlerContext) => unknown)(input, context); if (input?.agentId) await noteMainWork(input.agentId).catch(() => undefined); return out; }) as typeof handler : handler;
    // A schema error inside a handler (an internal cap, a stored record that no longer fits) reaches the caller as one
    // plain sentence, its issues logged; never as the validator's JSON (invariant pr-scale-lists-batch-not-throw).
    const plain = async (input: unknown, context: PluginHandlerContext) => { try { return await (run as (i: unknown, c: PluginHandlerContext) => unknown)(input, context); } catch (error) { throw plainError(error); } };
    handlers.set(contract.name, { input: contract.input, run: plain as never }); server.handle(contract, rpcTiming.timed(contract.name, plain) as never);
  };
  // What each subscription feed is made of may have changed (wired to the feeds below, server/feeds.ts). Cheap: a feed
  // with no subscriber does nothing, and an unchanged value pushes nothing.
  const feeds = { workspaces: () => {}, inbox: () => {}, home: () => {}, readsNow: () => {} };
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
  /** Every repository a workspace touches: its open PRs' and its checkout's (the agent text's No review is all-or-nothing). */
  const touchedRepos = (w: Workspace): string[] => [...new Set([...w.prs.filter(p => p.snapshot?.state !== "MERGED" && p.snapshot?.state !== "CLOSED").map(p => repoKey(p.repo)), ...(workspaceRepo(w) ? [repoKey(workspaceRepo(w)!)] : [])])];
  const knownRepos = (state: { workspaces: Workspace[] }) => new Set([...state.workspaces.filter(w => w.enable_tracking && !w.archived).flatMap(w => w.prs.map(p => repoKey(p.repo))), ...[...workspaceRepos.values()].map(repoKey)]);
  const writeScopes = scopeWriter(directory, { agent: w => prWorkflow.agentWorkflow(workspaceRepo(w), touchedRepos(w)), summary: state => workflowSummary([...knownRepos(state)].map(r => prWorkflow.cachedWorkflow(r))) });
  // Every write: scopes for the hooks, then any open brief whose questions are now all settled resolves (every answer
  // path writes here, so one check covers them all; tests/stale-brief.test.ts).
  // Not awaited: onChanged runs inside the store's write queue, and resolving a brief can write the store again
  // (settled), which would wait on this very queue forever (harness 2026-11-11: follow.answer-question timed out).
  store.onChanged = async state => { await writeScopes(state); void inbox.questionsChanged(state.workspaces).catch(() => undefined); feeds.workspaces(); };
  const agentHooks = new AgentHooks(directory, clientEntry());
  const historyCache = HistoryCache.at(directory);
  const gateway = new PaseoGateway(undefined, undefined, undefined, historyCache);
  /** The daemon as the inbox sees it; its turnItems is the one timeline read per turn end (engine and inbox). */
  const turnTimeline = new TurnTimeline();
  gateway.turnTimeline = turnTimeline;
  const inboxDirectory = daemonDirectory(gateway.directory, undefined, turnTimeline);
  // Settings → Agents: which agent each special role uses, in agents.json (defaults when absent).
  const agentSettings = new AgentSettingsStore(directory);
  gateway.recoveryRole = () => agentSettings.role("recovery");
  // The main agent's own background job holds its repairs only while Wait for background jobs is on (Q96 = A).
  gateway.waitForJobs = () => agentSettings.waitEnabled();
  const graphite = new Graphite();
  const github = new Github(undefined, graphite, new Deployments(undefined, undefined, undefined, undefined, repo => prWorkflow.current().repos[repoKey(repo)]?.deploy));
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
  const contextRequests = new ContextRequests(directory);
  contextRequests.onChange = () => feeds.home();
  // an-ack-never-waits-on-the-disk (server/write-behind.ts): these files save behind the reply; one still failing after
  // SURFACE_AFTER attempts shows as the worker's error line until it lands.
  const writeHealth = new WriteHealth();
  const reviewerSuggestions = new ReviewerSuggestions();
  const actions = new PrActions(store, github, graphite, browser);
  actions.savedMethod = repo => prWorkflow.current().repos[repoKey(repo)]?.mergeMethod ?? null;
  const engine = new Engine(store, github, gateway);
  // Wait for checks (docs/wait-for-checks.md): judged after each engine pass from the reads it made; a verdict is one
  // queued message. The agent is read from the directory's list (no load), live only when the list lacks it.
  const checkWatches = new CheckWatches(directory, {
    snapshot: () => store.snapshot(),
    quietSince: key => github.quietSince(key),
    agent: async id => {
      const a = gateway.directory.cached(id) ?? (await gateway.directory.read({ fresh: "agents" })).agents.find(r => r.agent.id === id)?.agent;
      return a ? { status: a.status, archived: !!a.archivedAt, workspaceId: a.workspaceId ?? null } : null;
    },
  });
  engine.checkWatches = checkWatches;
  // Scheduled tasks (a-scheduled-task-arrives-once-at-its-time): a task's time trigger goes out once, at its time,
  // Auto-send or not; the agent is read the same way as for a checks verdict (no load).
  const scheduledTasks = new ScheduledTasks({
    snapshot: () => store.snapshot(),
    mutateWorkspace: (id, work) => store.mutateWorkspace(id, work),
    agent: async id => {
      const a = gateway.directory.cached(id) ?? (await gateway.directory.read({ fresh: "agents" })).agents.find(r => r.agent.id === id)?.agent;
      return a ? { status: a.status, archived: !!a.archivedAt, workspaceId: a.workspaceId ?? null } : null;
    },
  });
  engine.scheduledTasks = scheduledTasks;
  engine.wording = { reviewFix: repo => commandName(prWorkflow.reviewFix(repo)) };
  actions.settleTasks = w => engine.settleTasks(w);
  const governor = new Governor();
  const linkedStore = new LinkedStore(directory);
  const cards = new Cards(new CardsStore(directory), directory);
  const linked = new LinkedService({ store: linkedStore, sources: liveLinkedSources(), roomForBackground: async () => governor.allowsBackground(),
    workspaces: async () => (await store.snapshot()).workspaces,
    titlesChanged: async (titles: TitleIndex) => {
      for (const w of (await store.snapshot()).workspaces) {
        if (!w.enable_tracking) continue;
        if (workspaceNeedsTitles(w, titles)) await store.mutateWorkspace(w.id, current => { fillWorkspaceTitles(current, titles); });
      }
    },
  });
  const transcriptTitles = new TranscriptTitleLookup({ store: new TranscriptTitleStore(directory), paths: (workspaces, priority) => trackedTitleTranscripts(paseoHome, workspaces, undefined, priority) });
  // Extraction rides discovery's own timeline batch (loaded agents only): no extra reads (shared/linked-extract.ts).
  gateway.linkRefs = batch => void linked.note(batch).catch(() => undefined);
  const listCache = new ListCache();
  engine.paused = () => !governor.allowsBackground();
  // PR statistics (docs/pr-stats.md): every request through the stats gate, which reads and feeds the PR poller's budget.
  const prStats = new PrStats({ directory, api: githubApi(), githubOff: () => github.off(), clientTimeZone: () => clientTimeZone, graphite: repo => prWorkflow.cachedWorkflow(repo) === "graphite",
    gate: { budget: owner => github.budget(owner), noteRateLimit: (owner, rate) => github.noteRateLimit(owner, rate), noteLimited: (owner, at) => github.noteLimited(owner, at), allowsBackground: () => governor.allowsBackground() } });
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
  const briefTimeline = new BriefTimeline({
    loaded: id => isLoaded(gateway.directory.cached(id))
      ? withDaemon(async client => (await client.fetchAgent(id))?.agent ?? null)
      : Promise.resolve(null),
    current: id => inbox.brief(id),
    append: async (agentId, brief) => {
      if (!api) throw new Error("The plugin session isn't ready");
      await api.agents.ref(agentId).timeline.append({ type: "plugin", id: brief.id, kind: BRIEF_KIND, version: BRIEF_VERSION, data: brief });
    },
  });
  // Discovery already reads agent metadata. Its updates are the retry signal, including idle agents reloaded
  // without a turn. No per-agent observer, poll or timeline read is added.
  gateway.directory.onAgentsChanged = () => { void briefTimeline.changed(); };
  let catalogKicked = false;
  const seen = (paseo: PaseoApi) => {
    api = paseo;
    // The first Paseo handle: read the provider catalog once in the background, so a helper left on its default runs
    // on a provider Paseo has from its first job (runnableRole), without any RPC waiting on it.
    if (!catalogKicked) { catalogKicked = true; queueMicrotask(() => void providerCatalog.read().catch(() => undefined)); }
    void briefTimeline.changed();
  };
  const needsYouPath = (agentId: string) => join(directory, "hook-state", `needs-you-${agentId}.json`);
  const trackedMain = async (agentId: string) => (await store.snapshot()).workspaces.find(w => w.enable_tracking && !w.archived && w.mainAgentId === agentId) ?? null;
  let overseer: Overseer | null = null;
  let ranker: Ranker | null = null;
  let linearQueue: LinearQueue | null = null;
  let morningBrief: MorningBrief | null = null;
  let briefSources: BriefSources | null = null;
  let compass: Compass | null = null;
  // Whether an app client is open (set once the home feed exists), and when a 0.15 client last polled priorities.
  let appOpen: () => boolean = () => false;
  let polledAt = 0;
  // Who sent a message (server/inbox-classifier.ts): the inbox and the Overseer's new-workspace gate read one ledger.
  const senderSources = fileSources(paseoHome, async () => (await inbox.store.snapshot()).ledger);
  const inbox: Inbox = new Inbox(directory, {
    writeMs: INBOX_WRITE_MS,
    enabled: inboxSettings,
    overseer: async () => (await overseer?.state())?.agentId ?? null,
    briefs: {
      sink: (agentId, brief) => briefTimeline.sink(agentId, brief),
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
    directory: inboxDirectory,
    sources: senderSources,
    guard: async () => {
      try { const state = JSON.parse(await readFile(guardPath(paseoHome), "utf8")); return state?.version === 1 && Array.isArray(state.pauses) ? state.pauses as GuardPause[] : null; }
      catch { return null; }
    },
  });
  onBeforeSend((agentId, messageId, by) => inbox.noteDelivery(agentId, messageId, by === "developer" || by?.startsWith("agent:") ? by as "developer" | `agent:${string}` : undefined));
  // a-message-is-saved-before-sent-and-arrives-once: every message to an agent goes through one queue (queue.json).
  // Pasted images (every-agent-field-takes-images): files under images/, refs on the queue item and the dispatch record.
  const imageStore = new ImageStore(directory);
  trustHarnessImageProviders(directory);
  const queue = new MessageQueue(directory, { deliverTo: (target, text, messageId, by, images) => gateway.deliverTo(target, text, messageId, by, images), arrived: (agentId, messageId, since, marker) => gateway.arrivedMessage(agentId, messageId, since, marker), probe: () => gateway.probe() }, { health: writeHealth, images: imageStore });
  engine.attachQueue(queue);
  checkWatches.attachQueue(queue);
  scheduledTasks.attachQueue(queue);
  inbox.attachQueue(queue);
  // Overseer forwards and reports handed to an agent: no record of their own, so the queue item is their status
  // (follow_queue_list). Archived agents cancel, with the reason on the item.
  queue.register("message", {
    async resolve(item) {
      const rows = await gateway.directory.read().catch(() => null);
      if (!rows) return { defer: "Paseo unreachable" };
      const agent = rows.agents.find(r => r.agent.id === item.ref.agentId)?.agent;
      if (!agent || agent.archivedAt) return { cancel: "The agent was archived, so the message wasn't sent." };
      return { target: { workspaceId: null, recipients: [item.ref.agentId!] } };
    },
    // No card of its own: one that didn't go out (Failed, or Queued past MESSAGE_STUCK_MS) shows in its workspace's
    // Needs you with Retry and Cancel, and leaves it once sent or cancelled.
    async project(item) {
      // A More context ask rides the queue under its request id: the send's settle is its delivery, a send that can't
      // happen fails it (context-never-blocks-the-deck: the card comes back either way).
      if (item.messageId?.startsWith("ctx-")) {
        if (item.state === "sent") await contextRequests.delivered(item.messageId, item.settledAt ?? new Date().toISOString());
        else if (item.state === "cancelled" || item.state === "failed" && item.gone) await contextRequests.fail(item.messageId, item.reason ?? "The ask couldn't reach the agent.");
      }
      const w = (await store.snapshot()).workspaces.find(w => w.id === item.key && w.enable_tracking && !w.archived);
      if (!w) return;
      const has = w.undelivered?.find(m => m.id === item.id);
      const entry = undeliveredEntry(item, Date.now(), gateway.directory.cached(item.ref.agentId!)?.title ?? null, has?.since ?? null, queue.scale);
      if (!entry && !has || entry && has && JSON.stringify(entry) === JSON.stringify(has)) return;
      await store.mutateWorkspace(w.id, x => {
        const rest = (x.undelivered ?? []).filter(m => m.id !== item.id);
        x.undelivered = entry ? [...rest, entry].slice(-20) : rest;
      });
    },
  });
  const enqueueMessage = (agentId: string, text: string, messageId: string, by?: string, images: ImageRef[] = []) => {
    const key = gateway.directory.cached(agentId)?.workspaceId ?? `agent:${agentId}`;
    queue.enqueue({ id: `message:${agentId}:${messageId}`, kind: "message", key, ref: { agentId }, messageId, text, ...(by ? { by } : {}), ...(images.length ? { images } : {}), priority: "now", state: "queued" });
  };
  onDaemonReconnect(() => queue.reconnected());
  // Turn-end checks for a provider without Follow-up's hook (server/turn-end.ts): the hook's checks, as one queued message.
  const turnEnd = new TurnEnd({
    input: async (agentId, _provider, _items, _startedAt) => {
      const w = agentTrackedWorkspace(await store.snapshot(), agentId);
      if (!w) return null;
      // Only this workspace's scopes (a-nudge-costs-its-workspace), never the whole state's.
      const entry = scopes({ workspaces: [w] } as unknown as Parameters<typeof scopes>[0])[agentId] ?? null;
      const json = (name: string) => readFile(join(directory, "hook-state", name), "utf8").then(t => JSON.parse(t) as Record<string, unknown>, () => null);
      const synced = await json(`sync-${agentId}.json`);
      const called = await json(`needs-you-${agentId}.json`) as NeedsYouRecord | null;
      const receipt = /^[\w-]+$/.test(w.id) ? await json(`task-nudges-${w.id}.json`) : null;
      const settings = await inboxSettings();
      return {
        entry, receipt: (receipt ?? {}) as never,
        syncedAt: synced && synced.workspaceId === w.id && typeof synced.at === "number" ? synced.at : null,
        needsYouAt: typeof called?.at === "number" ? called.at : null,
        nudge: settings.enable_inbox === true && settings.enable_brief_nudge === true && !inbox.pendingPermissions().includes(agentId),
      };
    },
    saveReceipt: async (workspaceId, receipt) => { if (/^[\w-]+$/.test(workspaceId)) await writeFile(join(directory, "hook-state", `task-nudges-${workspaceId}.json`), JSON.stringify(receipt), { mode: 0o600 }); },
    send: async (agentId, workspaceId, text, turnId) => {
      const messageId = randomUUID();
      queue.enqueue({ id: `turn-end:${agentId}:${turnId ?? messageId}`, kind: "message", key: workspaceId, ref: { agentId }, messageId, text, priority: "now", state: "queued" });
    },
  });
  /**
   * Stores a field's pasted images, runs the action with their refs, and removes any the action didn't queue (a
   * repeated answer, an ask already open, a refusal): only a queue item keeps an image file.
   */
  const withImages = async <T>(uploads: ImageUpload[] | undefined, run: (refs: ImageRef[]) => Promise<T>): Promise<T> => {
    const refs = await imageStore.save(uploads);
    const unqueued = () => { const live = new Set(queue.imageIds()); return refs.filter(r => !live.has(r.id)); };
    try { const out = await run(refs); if (refs.length) await imageStore.remove(unqueued()); return out; }
    catch (error) { await imageStore.remove(unqueued()); throw error; }
  };
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
    // The Overseer's digest backstop (it is built when its turn starts: agent.turn_started below) and its recreation if it was archived. Never blocks the inbox.
    if (overseer) { await overseer.backstopDigest().catch(() => undefined); if (api) await overseer.ensure(api as unknown as OverseerPaseo, { periodic: true }).catch(() => undefined); }
    // The ranker's scheduled run (window, cadence, cap and the governor are its own checks). Never awaited: it can take minutes.
    if (ranker) void ranker.tick().catch(() => undefined);
    // The Morning brief's sweep, once a workday at its time (the-brief-has-one-timer: this loop, no timer of its own).
    if (linearQueue) void linearQueue.tick().catch(() => undefined);
    // The brief's sources: mcpproxy is asked again once a workday after the sweep time (same loop, same rule).
    if (briefSources) void briefSources.tick().catch(() => undefined);
    // Compass's morning read: once a workday after the sweep time (same loop, same rule). It brings this week's plan too.
    if (compass) void compass.tick().catch(() => undefined);
    // Wake-ups, the Overseer's status and the directory's titles move with this tick; the feeds diff, so a quiet tick
    // pushes nothing.
    feeds.inbox(); feeds.home();
    if (!stopped) inboxTimer = setTimeout(() => void inboxLoop(), 15_000);
  };
  // Hooks run in the background; an inbox failure never blocks the rest of Follow-up.
  const inboxHook = (work: () => Promise<void>) => void (async () => { await ready; if (!stopped && !loadError) { await work(); feeds.inbox(); } })().catch(error => { inboxError = error instanceof Error ? error.message : String(error); });
  // A workspace the engine reopened (Paseo shows it live again) shows its main agent's Needs-you row again (invariant 111).
  engine.reopened = agentIds => { for (const id of agentIds) inboxHook(async () => { await inbox.reopen(id); }); };
  let unlock: (() => Promise<void>) | null = null;
  let stopped = false;
  /** Each agent's latest started turn, so a turn end can tell it was already replaced (holdOnTurnEnd). */
  const startedTurns = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hookTimer: ReturnType<typeof setInterval> | null = null;
  let dueTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * due-by-fact, every 10 minutes: the agent hook's nudge receipts become each task's `nudged` (stale needs two), tasks
   * from before due-by-fact get their re-check date and finished time, and finished tasks over 30 days old leave
   * storage (`maintainTasks`). A workspace with nothing to change is only read, never copied.
   */
  const maintainDue = async () => {
    const now = Date.now();
    const due = new Map<string, NudgeReceipt | null>();
    for (const w of (await store.snapshot()).workspaces) {
      if (!w.enable_tracking || w.archived || !w.obligations.length) continue;
      const raw = /^[\w-]+$/.test(w.id) ? await readFile(join(directory, "hook-state", `task-nudges-${w.id}.json`), "utf8").then(t => JSON.parse(t) as unknown, () => null) : null;
      const receipt = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as NudgeReceipt : null;
      if (maintainTasks(w, now, receipt, false)) due.set(w.id, receipt);
    }
    if (!due.size) return;
    // One mutation for the whole pass: the first pass after an upgrade stamps every workspace's tasks, and one
    // mutateWorkspace each (a copy, a write and a re-derive per workspace) left the scale check's idle worker
    // ~100 MB higher (#283 CI). The draft copies only the workspaces it changes (`find` by id copies nothing).
    await store.mutate(state => { for (const [id, receipt] of due) { const d = state.workspaces.find(w => w.id === id); if (d) maintainTasks(d, now, receipt, true); } }).catch(() => undefined);
  };
  let hooksStarted = false;
  let loadError: string | null = null;
  /**
   * a-new-worker-starts-once-the-old-one-exits: set while the previous worker still holds the lock (Store.lock waits
   * for it). Not an error: RPCs answer with it at once instead of waiting, and the worker starts when the lock frees.
   */
  let waiting: string | null = null;
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
    unlock = await store.lock({ onWait: pid => { waiting = `Waiting for the previous Follow-up worker to exit${pid ? ` (pid ${pid})` : ""}.`; } });
    waiting = null;
    // Before anything ticks: which repositories are No review (agentMerges), so the first tick after a restart is already quiet.
    await prWorkflow.read();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(bridge, withRuntimePrelude(mcpSource), { mode: 0o600 });
    // 1.4.0-beta.2: tools are per agent now; drop the old user-scope registrations that spawned mcp.mjs in every session.
    void removeGlobalRegistrations().then(results => { const removed = results.filter(r => r.status === "removed").map(r => r.path); if (removed.length) console.warn(`[follow-up] removed the global follow-up MCP registration from ${removed.length} file(s); backups end in .follow-up-unregister.bak`); });
    governor.start();
    await linked.backfill();
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
    await maintainDue().catch(() => undefined);
    dueTimer = setInterval(() => void maintainDue().catch(() => undefined), 10 * 60_000);
    await writeBriefState().catch(() => undefined);
    // The message queue: answers recorded before a reload (or before the upgrade from 2.0's per-answer senders) join it,
    // a send a reload cut off is read back from the agent's chat before it goes again, and everything due goes now.
    await queue.load();
    await engine.adoptAnswers().catch(error => console.warn(`[follow-up] couldn't move answers onto the queue: ${error instanceof Error ? error.message : String(error)}`));
    await engine.adoptBatches().catch(error => console.warn(`[follow-up] couldn't move batches onto the queue: ${error instanceof Error ? error.message : String(error)}`));
    await inbox.adoptOutbox().catch(error => console.warn(`[follow-up] couldn't move the answer outbox onto the queue: ${error instanceof Error ? error.message : String(error)}`));
    queue.start();
    // An ask still open from before a restart is re-derived from the queue's record and the cached agent list: nothing
    // is woken, and nothing waits on it (context-never-blocks-the-deck).
    void (async () => {
      const rows = await gateway.directory.read().catch(() => null);
      const status = new Map((rows?.agents ?? []).map(({ agent }) => [agent.id, agent.status]));
      await contextRequests.reconcile(r => {
        const item = queue.get(`message:${r.askedOf}:${r.id}`);
        return { sent: item?.state === "sent" ? item.settledAt ?? null : null, failed: item?.state === "cancelled" || item?.state === "failed" && item.gone ? item.reason ?? "The ask couldn't reach the agent." : null,
          idle: rows ? status.get(r.askedOf!) !== "running" : false };
      });
    })().catch(error => console.warn(`[follow-up] couldn't re-check open context asks: ${error instanceof Error ? error.message : String(error)}`));
  })().catch(() => { loadError = "Follow-up could not start. Check its saved state and worker lock."; });
  for (const file of [store, contextRequests.persist, reviewerStore.persist, agentSettings.persist, prWorkflow.persist, inbox.store.persist]) file.health = writeHealth;
  const requireReady = async () => { if (waiting) throw new Error(waiting); await ready; if (loadError || stopped) throw new Error(loadError ?? "Follow-up is stopping"); };
  // 1.4.0-beta.2: Follow-up's tools per agent: natively through Paseo's MCP when the host serves plugin tools,
  // otherwise the stdio bridge for this launch only. FOLLOW_UP_TOOLS tells the hooks which names the agent has.
  let configCache: { mtimeMs: number; value: unknown } | null = null;
  const paseoConfig = async () => {
    try { const path = join(paseoHome, "config.json"); const { mtimeMs } = await stat(path); if (configCache?.mtimeMs !== mtimeMs) configCache = { mtimeMs, value: JSON.parse(await readFile(path, "utf8")) }; return configCache.value as Parameters<typeof nativeToolsAvailable>[1]; } catch { return null; }
  };
  // Wait for background jobs (folded in from paseo-wait): native tools for interactive Claude sessions.
  // Paseo 0.16 runs background jobs itself (features.agentBackgroundWork): Wait retires there (docs/wait.md).
  const hostBackgroundWork = hostFeature("agentBackgroundWork", () => withDaemon(async client => (client as ServerInfoClient).getLastServerInfoMessage?.()));
  // Paseo 0.16 background agents (features.backgroundAgents): the recovery agent is created background (plan #8).
  // Paseo's features.workspaceMultiplicity: more than one workspace on one folder, which a report's new (directory) workspace needs.
  const hostMultiplicity = hostFeature("workspaceMultiplicity", () => withDaemon(async client => (client as ServerInfoClient).getLastServerInfoMessage?.()));
  gateway.backgroundAgents = hostFeature("backgroundAgents", () => withDaemon(async client => (client as ServerInfoClient).getLastServerInfoMessage?.()));
  // Paseo 0.17.1+: the client draws Done as a sidebar row badge, so the engine writes no Done label (docs/workspaces.md).
  gateway.rowBadges = hostAtLeast(ROW_BADGES_SINCE, () => withDaemon(async client => (client as ServerInfoClient).getLastServerInfoMessage?.()));
  const wait = new Wait(join(directory, "wait"), { enabled: () => agentSettings.waitEnabled(), config: async () => await paseoConfig() as WaitPaseoConfig | null, hostBackgroundWork, legacyDirectory: existsSync(dataDirs(paseoHome).legacy) ? join(dataDirs(paseoHome).legacy, "wait") : null });
  const currentWait = async () => waitStatus(await agentSettings.waitEnabled(), await paseoConfig() as WaitPaseoConfig | null, await hostBackgroundWork());
  const live = async (agentId: string): Promise<Live> => ({ role: scopes(await store.snapshot())[agentId]?.role ?? null, inbox: (await inboxSettings()).enable_inbox });
  const invoke: Invoke = async (method, input, context) => {
    const handler = handlers.get(method); if (!handler) throw new Error(`Unknown Follow-up method ${method}.`);
    return handler.run(await handler.input.parseAsync(input), { paseo: context.paseo });
  };
  // Set once promptDeps exists (below); tools call it only after the worker started.
  let changedLead: ((agentId: string) => Promise<string | null>) | undefined;
  const withTools = async <R extends Parameters<typeof withSessionMcp>[0]>(request: R, recovery: boolean, brief: string | null, root: boolean, overseer = false): Promise<R> => {
    // FOLLOW_UP_TOOL_PROVIDERS / FOLLOW_UP_FORCE_STDIO exist for the isolated harness (scripts/check-native-tools.mjs).
    // Every provider gets the tools (an-agent-on-any-provider-gets-follow-up): Paseo serves them through its agent MCP to
    // any provider that takes MCP servers. FOLLOW_UP_TOOL_PROVIDERS narrows it for the isolated harness only.
    const providers = process.env.FOLLOW_UP_TOOL_PROVIDERS ? process.env.FOLLOW_UP_TOOL_PROVIDERS.split(",") : null;
    if (request.purpose !== "interactive" || (providers && !providers.includes(request.provider)) || request.labels["plugin-tools/enabled"] === "false") return request;
    if (process.env.FOLLOW_UP_FORCE_STDIO !== "1" && nativeToolsAvailable(request, await paseoConfig())) {
      toolTransport = "native (Paseo's agent MCP)";
      const flags = { recovery, brief: !!brief && !recovery, root: root && !recovery, overseer: overseer && !recovery };
      const env = { ...request.env, FOLLOW_UP_TOOLS: "native", FOLLOW_UP_PROVIDER: request.provider, ...(flags.root ? { FOLLOW_UP_ROOT: "1" } : {}), ...(flags.overseer ? { FOLLOW_UP_OVERSEER: "1" } : {}) };
      if (/^[\w-]+$/.test(request.agentId)) await writeFile(join(directory, "hook-state", `native-${request.agentId}.json`), JSON.stringify({ instance: toolsInstance }), { mode: 0o600 }).catch(() => undefined);
      return { ...request, env, tools: [...request.tools, ...nativeTools(flags, live, invoke, workflowSummary([...knownRepos(await store.snapshot())].map(r => prWorkflow.cachedWorkflow(r))), agentId => changedLead?.(agentId) ?? Promise.resolve(null))] };
    }
    return withSessionMcp({ ...request, env: { ...request.env, FOLLOW_UP_TOOLS: "stdio", FOLLOW_UP_PROVIDER: request.provider } }, directory, clientEntry(), paseoHome, recovery, process.env, brief, root, overseer, providers) as R;
  };
  let compacted = false; let memoryWatch: { stop(): void } | null = null;
  const loop = async () => {
    await ready;
    if (stopped || loadError) return;
    await engine.tick({ background: true });
    feeds.workspaces();
    // Due PR-stats syncs ride this loop (no timer of their own) and are never awaited here.
    prStats.tick();
    // Startup is done once the first tick is: release what it grew, then return what each later burst grows
    // (memory-returns-after-a-burst, server/memory.ts) and report the worker's memory in heartbeat.json.
    if (!compacted) { compacted = true; compactHeap(); if (!stopped) memoryWatch = watchMemory({ heartbeatFile: join(directory, "heartbeat.json") }); }
    if (!stopped) timer = setTimeout(() => void loop(), TICK_MS);
  };
  void loop();
  // works-without-github: learn whether GitHub is on once the worker is up, so GitHub actions answer from a known state.
  void (async () => { await ready; if (!stopped && !loadError) void githubSetup().current().catch(() => undefined); })();
  void (async () => { await ready; if (stopped || loadError) return; void inbox.refreshDirectory().catch(() => undefined); if (governor.allowsExtras()) void usage.refresh(); await inbox.start().catch(error => { inboxError = error instanceof Error ? error.message : String(error); }); void inboxLoop(); })();
  const changed = (w: Workspace) => { w.completion = null; w.declaration = null; w.updatedAt = new Date().toISOString(); };

  /**
   * Archived is Paseo's state, never a latch (invariant 111, shared/reopen.ts): a main agent calling a tool from a
   * workspace Follow-up reads as archived reopens it when Paseo shows it live (the agent itself unarchived: a prompt
   * did it). True when the workspace is (now) followed; false when Paseo still has it archived.
   */
  const reopenForCaller = async (agent: { id: string; workspaceId?: string | null; archivedAt?: string | null }): Promise<boolean> => {
    const record = (await store.snapshot()).workspaces.find(w => w.id === agent.workspaceId);
    if (!record?.archived || !record.enable_tracking || record.mainAgentId !== agent.id) return !record?.archived;
    const rows = await gateway.directory.read().catch(() => null);
    if (!paseoShowsLive(record.id, rows?.workspaces.find(row => row.id === record.id), agent)) return false;
    await store.mutateWorkspace(record.id, w => { if (w.archived) { w.archived = false; w.updatedAt = new Date().toISOString(); } });
    await inbox.reopen(agent.id).catch(() => false);
    feeds.inbox();
    void engine.nudge(record.id);
    return true;
  };
  const callerWorkspaceId = async (agentId: string, paseo: PluginHandlerContext["paseo"], allowHandoff = true) => {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId) throw new Error(`Cannot locate the caller's workspace: expected agent in a recorded workspace, received agent ${agentId}.`);
    await reopenForCaller(agent);
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
    void engine.nudge();
    return { projects: await gateway.projects(await store.snapshot()) };
  });
  const followSettings = async () => {
    const state = await store.snapshot();
    return { enable_follow_every: followsEvery(state), enable_auto_sends_default: autoSendsByDefault(state), activeWindowDays: state.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS, maxAutoSends: state.maxAutoSends ?? DEFAULT_MAX_AUTO_SENDS,
      workspaces: state.workspaces.filter(w => !w.archived).map(w => ({ id: w.id, title: w.title, enable_tracking: w.enable_tracking, enable_auto_sends: w.enable_auto_sends, optedOut: optedOut(state, w.id), dormant: !!w.dormant, parked: !!state.autoSendsParked?.includes(w.id) }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) };
  };
  handle(rpc.followSettingsRpc, async () => { await requireReady(); return followSettings(); });
  handle(rpc.setFollowSettingsRpc, async ({ enable_follow_every, enable_auto_sends_default, activeWindowDays, maxAutoSends, workspace }) => {
    await requireReady();
    await store.mutate(state => {
      if (activeWindowDays !== undefined) state.activeWindowDays = activeWindowDays;
      if (maxAutoSends !== undefined) state.maxAutoSends = maxAutoSends;
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
    void engine.nudge(workspace?.workspaceId);
    return followSettings();
  });
  // The peek of an agent that isn't loaded (shared/turn.ts): its transcript on disk, never the daemon (invariant 1).
  handle(rpc.agentTurnRpc, async ({ agentId }) => { const read = await transcriptTurn(paseoHome, agentId); return { turn: read?.turn ?? null, at: read?.at ?? null }; });
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
      // A read that fails says nothing about the agent: leave that claim out rather than call its agent closed.
      const read = await paseo.agents.ref(workspace.mainAgentId).refresh().then(r => ({ agent: r?.agent }), () => null);
      if (!read) return null;
      const agent = read.agent;
      return { workspace, agent: agent && !agent.archivedAt && agent.workspaceId === workspace.id ? agent : null };
    }));
    const view = browserWorkspaces(entries.filter(e => e !== null));
    return { tracked: true, ...view, workspaces: view.workspaces.map(w => ({ ...w, title: w.title.slice(0, 200), agentStatus: w.agentStatus.slice(0, 40), state: w.state.slice(0, 200) })) };
  });
  handle(rpc.listRpc, async ({ since }) => { if (waiting) return { workspaces: [], full: false, removed: [], error: waiting }; await ready; const { stampsOnly: _s, ...answer } = listCache.answer(await store.snapshot(), since); return { ...answer, error: loadError ?? hookError ?? writeHealth.message() ?? engine.error }; });
  // Settled history is bounded (shared/history.ts boundHistory); the Activity card pages the rest with follow.activity.
  handle(rpc.getRpc, async ({ workspaceId }) => { if (waiting) return { workspace: null, error: waiting }; await ready; const w = (await store.snapshot()).workspaces.find(w => w.id === workspaceId && w.enable_tracking); return { workspace: w ? boundHistory(w) : null, error: loadError ?? hookError ?? writeHealth.message() ?? engine.error }; });
  handle(rpc.activityRpc, async ({ workspaceId, tab, query, offset, limit }) => {
    const empty = { timeline: [], questions: [], offset: 0, total: 0, counts: { timeline: 0, questions: 0 }, all: 0 };
    if (waiting) return { ...empty, error: waiting };
    await ready;
    const w = (await store.snapshot()).workspaces.find(w => w.id === workspaceId && w.enable_tracking);
    if (!w) return { ...empty, error: "This workspace isn't followed." };
    return { ...activityPage(w, { tab, query, offset, limit }), error: null };
  });
  handle(rpc.syncWorkspaceRpc, async ({ agentId, summary, milestone }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo, false);
    const w = agentWorkspace(await store.snapshot(), agentId, "write", workspaceId, "pr");
    if (w.archived) throw new Error(`Only an active workspace root agent can confirm sidebar sync: expected ${w.mainAgentId}, received ${agentId}.`);
    // What the agent is working on (shared/now.ts): stored per agent on the record, so every surface reads it with
    // the rest of the workspace. Omitted keeps the last one; null clears it; the same one again writes nothing.
    if (milestone !== undefined) await store.mutateWorkspace(w.id, current => {
      const before = current.milestones?.[agentId];
      if (milestone === null) { if (before) delete current.milestones![agentId]; return; }
      const next = { now: milestone.now, done: milestone.done ?? [], next: milestone.next ?? [] };
      if (before && JSON.stringify([before.now, before.done, before.next]) === JSON.stringify([next.now, next.done, next.next])) return;
      current.milestones = { ...current.milestones, [agentId]: { ...next, at: new Date().toISOString() } };
    });
    await agentHooks.confirm(w.id, agentId, summary);
    return { workspaceId: w.id, synced: true as const };
  });
  handle(rpc.workspaceNowRpc, async ({ agentId }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const w = agentWorkspace(await store.snapshot(), agentId, "read", workspaceId, "pr");
    // The inbox rows the worker already holds (no daemon read, nothing woken): the same rows every client draws from.
    // Before Paseo's agent list first loads there are none: each state then reads unknown, never a made-up idle.
    const rows = await inbox.list().then(list => list.rows, () => []);
    return { workspaceId: w.id, agents: workspaceNow(w, rows, Date.now()) };
  });
  // Finished items are a count plus the newest few, paged by history/offset/limit (shared/history.ts agentView), summary and full alike.
  handle(rpc.agentStatusRpc, async ({ agentId, detail, history, live, offset, limit }, { paseo }) => { await requireReady(); const workspaceId = await callerWorkspaceId(agentId, paseo); const w = agentWorkspace(await store.snapshot(), agentId, "read", workspaceId, "pr"); return agentView(w, { kind: history, live, offset, limit }, { dismissed: dismissedNeeds(w, Date.now()), dismissedAsk: await inbox.dismissedAsk(agentId), prWorkflow: prWorkflow.agentWorkflow(workspaceRepo(w), touchedRepos(w)), nextMessageInfo: nextMessageInfo(w, Date.now()), sending: sendingOf(w, Date.now(), { held: !governor.allowsBackground() }), cards: (await cards.list(w.id)).cards.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, by: c.by })) }, detail === "full" ? undefined : view => compact("workspace_status", {}, view)); });
  handle(rpc.activateRpc, async ({ workspaceId }) => { await requireReady(); return engine.activate(workspaceId); });
  handle(rpc.sendRpc, async ({ workspaceId, batchId }) => { await requireReady(); return engine.sendPending(workspaceId, batchId); });
  handle(rpc.recoverRpc, async ({ workspaceId }) => { await requireReady(); return engine.startRecovery(workspaceId); });
  handle(rpc.enrollRpc, async ({ agentId, workspaceId, goal }, { paseo }) => {
    await requireReady();
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId || !await mayEnroll(await store.snapshot(), agent, async id => (await paseo.agents.ref(id).refresh())?.agent)) throw new Error("Choose an available main agent in this workspace.");
    if (workspaceId && workspaceId !== agent.workspaceId) throw new Error("The chosen agent belongs to another workspace.");
    await callerWorkspaceId(agentId, paseo);
    const workspace = await paseo.workspaces.ref(agent.workspaceId).refresh();
    if (!workspace) throw new Error("Workspace is unavailable.");
    return store.mutate(state => {
      // enroll_workspace states a new goal: it follows the workspace again even while Paseo has it archived.
      const w = agentWorkspace(state, agentId, "write", agent.workspaceId!, "owner", true);
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
      const altered = !existing || existing.stack !== stack || existing.parent !== parent || disposition !== undefined && existing.disposition !== disposition || agentMerges !== undefined && existing.agentMerges !== agentMerges;
      if (existing) { existing.registeredAgentId = agentId; existing.discoveredFromSubmission = false; existing.stack = stack; existing.parent = parent; if (disposition !== undefined) existing.disposition = disposition; if (agentMerges !== undefined) existing.agentMerges = agentMerges; }
      else w.prs.push({ registeredAgentId: agentId, key, repo, number, stack, parent, disposition: disposition ?? null, snapshot: null, error: null, ...(agentMerges !== undefined ? { agentMerges } : {}) });
      if (altered) changed(w); return w;
    });
    void engine.nudge(result.id); return result;
  });
  handle(rpc.excludeStackRpc, async ({ agentId, stack, reason, obligationIds }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const result = await store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      excludeStack(w, stack, reason, obligationIds, new Date().toISOString());
      return w;
    });
    void engine.nudge(result.id); return result;
  });
  handle(rpc.obligationRpc, async ({ agentId, workingAgentId, ...input }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    // A named worker must be an agent Paseo knows (directory metadata; nothing is loaded).
    if (workingAgentId && workingAgentId !== agentId && !(gateway.directory.cached(workingAgentId) ?? (await gateway.directory.read({ fresh: "agents" })).agents.find(r => r.agent.id === workingAgentId)?.agent)) throw new Error("workingAgentId isn't an agent Paseo knows. Pass the id of the agent doing the task, or leave it out to record yourself.");
    const result = await store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      const obligation = updateObligation(w, { ...input, caller: agentId, workingAgentId });
      syncTaskQuestions(w, Date.now());
      // one-decision-one-card: say so when the blocked task is already asked (or answered) as a question.
      const note = coverNote(w, obligation.id);
      changed(w); return { ...w, updatedObligationId: obligation.id, ...(note ? { note } : {}) };
    });
    void engine.nudge(result.id); return result;
  });
  handle(rpc.askQuestionRpc, async ({ agentId, ...input }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const mode = await questionMode();
    // A link to a card must name one this workspace shows (show it first).
    const shown = new Set((await cards.list(workspaceId)).cards.map(c => c.id));
    for (const l of input.links ?? []) if (l.card && !shown.has(l.card)) throw new Error(`No card ${l.card} in this workspace. Show it with show_card first, then link it: links:[{card:"${l.card}"}].`);
    return store.mutate(state => {
      const w = agentWorkspace(state, agentId, "write", workspaceId);
      const { supersedes, ...ask } = input;
      const { question, instruction, outcome, of } = askQuestion(w, agentId, ask, mode, Date.now(), { via: "ask", ...(supersedes ? { supersedes } : {}) });
      // A card a blocked task made for this decision closes now (one-decision-one-card), not on the next tick.
      if (outcome !== "duplicate") { syncTaskQuestions(w, Date.now()); changed(w); }
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
  // Cards (server/cards.ts): what an agent shows the developer in the workspace view. Main agents and contributors.
  handle(rpc.showRpc, async ({ agentId, ...input }, { paseo }) => {
    await requireReady();
    const workspaceId = await callerWorkspaceId(agentId, paseo);
    const w = agentWorkspace(await store.snapshot(), agentId, "write", workspaceId, "pr");
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.cwd) throw new Error("show_card: can't find your workspace's folder.");
    const out = await cards.show(w.id, { agentId, title: agent.title ?? null, root: agent.cwd }, input);
    feeds.workspaces();
    return { workspaceId: w.id, ...out };
  });
  /** The agent the card's freshness follows: running since its latest prompt, or idle. Null when Paseo doesn't list it. */
  const agentNow = (id: string): AgentNow => {
    const a = gateway.directory.cached(id) as { status?: string; lastUserMessageAt?: string | null; updatedAt?: string } | undefined;
    if (!a) return null;
    const running = ["running", "initializing"].includes(a.status ?? "");
    const since = Date.parse((running ? a.lastUserMessageAt : a.updatedAt) ?? "");
    return { running, since: Number.isFinite(since) ? since : null };
  };
  handle(rpc.cardsRpc, async ({ workspaceId }) => {
    await requireReady();
    const w = findWorkspace(await store.snapshot(), workspaceId);
    const list = await cards.list(w.id);
    const now = Date.now();
    // The open question pointing at a card ("Q12 · Ship the dark slides?"), from its links' card field.
    const asked = new Map<string, string>();
    for (const q of w.questions) if (!q.answer && !q.closed) for (const l of q.links ?? []) if (l.card && !asked.has(l.card)) asked.set(l.card, q.id);
    return {
      cards: list.cards.map(c => ({ ...c, freshness: freshness(c, agentNow(c.by), now), summary: cardSummary(c), contents: cardContents(c), question: asked.get(c.id) ?? null })),
      removed: list.removed.map(r => ({ id: r.id, title: r.title, removedAt: r.removedAt })),
    };
  });
  handle(rpc.cardMediaRpc, async ({ workspaceId, hash }) => { await requireReady(); return cards.media(findWorkspace(await store.snapshot(), workspaceId).id, hash); });
  handle(rpc.cardActRpc, async ({ workspaceId, id, action }) => {
    await requireReady();
    const w = findWorkspace(await store.snapshot(), workspaceId);
    let result: { ok: boolean; message: string };
    if (action === "remove") { const ok = await cards.remove(w.id, id); result = { ok, message: ok ? "Removed." : "That card is already gone." }; }
    else if (action === "undo") result = await cards.undo(w.id, id);
    else { const ok = await cards.keep(w.id, id, action === "keep"); result = { ok, message: ok ? (action === "keep" ? "Kept." : "No longer kept.") : "That card is gone." }; }
    feeds.workspaces();
    if (action === "remove") void cards.sweep().catch(() => undefined);
    return result;
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
    const links = await linkedStore.read();
    return store.mutate(state => {
      const w = findWorkspace(state, input.workspaceId);
      if (!w.enable_tracking || w.archived) throw new Error("Follow-up isn't following this workspace. Turn it back on in Follow-up settings, under Workspace exceptions.");
      developerSetSpec(w, input, Date.now(), actorOf(context));
      fillWorkspaceTitles(w, localTitles(state.workspaces, links));
      return w;
    });
  });
  handle(rpc.dismissQuestionRpc, async ({ workspaceId, questionId, undo }, context) => { await requireReady(); return engine.dismiss(workspaceId, questionId, !!undo, actorOf(context)); });
  // dismissing-anything-in-needs-you-sends-the-agent-nothing: one path for every kind; only records change.
  handle(rpc.dismissRpc, async ({ workspaceId, key, agentId, issue, compass: note, undo }, context) => {
    await requireReady();
    const actor = actorOf(context);
    if (agentId) return inbox.dismiss(agentId, !!undo, actor);
    if (note) return compass!.removeSuggestion(note, !!undo);
    // "Nobody's on it" is one row per issue: its Remove takes the queue's raise and every Compass ask on it.
    if (issue) {
      const asks = await compass?.removeIssue(issue, !!undo).catch(() => 0) ?? 0;
      try { return await linearQueue!.dismissRaise(issue, !!undo); }
      catch (error) { if (asks) return { name: issue.toUpperCase() }; throw error; }
    }
    return store.mutateWorkspace(workspaceId!, w => {
      const r = undo ? undoDismissItem(w, key!, actor) : dismissItem(w, key!, actor, Date.now());
      w.updatedAt = new Date().toISOString();
      return r;
    });
  });
  handle(rpc.answerQuestionRpc, async ({ workspaceId, questionId, choice, words, action, images }, context) => {
    await requireReady();
    // Images go only with a send (Copy and Put in chat send nothing).
    return withImages(action === "send" || action === "resend" ? images : undefined, refs => engine.answer(workspaceId, questionId, choice, words, action, actorOf(context), refs));
  });
  handle(rpc.declareDoneRpc, async ({ agentId, summary }, { paseo }) => { await requireReady(); return engine.declareDone(agentId, summary, await callerWorkspaceId(agentId, paseo, false)); });
  handle(rpc.acknowledgeRpc, async ({ agentId, batchId, outcome, result, humanOnly, waitingOn }, { paseo }) => {
    await requireReady();
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    try { return await engine.acknowledge(agentId, batchId, outcome, result, await callerWorkspaceId(agentId, paseo), humanOnly, waitingOn); }
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
  handle(rpc.refreshRpc, async ({ workspaceId }) => {
    await requireReady();
    // While GitHub is off, Refresh checks it again first (one gh check, on the click), so turning it on shows at once.
    const recheck = githubSetup().off() ? githubSetup().check().then(() => undefined, () => undefined) : Promise.resolve();
    // Its read stamps go out when the tick lands, not a feed window later: the open view reads no workspace again for them.
    void recheck.then(() => engine.tick({ workspaceId })).then(() => feeds.readsNow(), () => undefined);
    return { ok: true };
  });
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
    void engine.nudge(result.id); return result;
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
    void engine.nudge(result.id); return result;
  });
  handle(rpc.browserStatusRpc, async () => { await requireReady(); return browser.status(); });
  handle(rpc.browserExchangeRpc, async ({ clientId, ready: browserReady, acceptJobs, results, repositories }) => { await requireReady(); return { ...browser.exchange(clientId, browserReady, results, acceptJobs, repositories), repositories: browserRepositories(await store.snapshot()) }; });
  handle(rpc.prControlStatusRpc, async ({ workspaceId, prKey }) => { await requireReady(); return actions.status(workspaceId, prKey); });
  // GitHub off (works-without-github): GitHub's own actions answer in one line at once, without waiting on the worker.
  // works-without-github: a GitHub action answers from the last known state and never waits on a gh check before it
  // replies (an-ack-never-waits-on-the-disk); an unknown state goes on, and the action's own gate decides later.
  const githubOffNow = () => github.offNow();
  const githubFirst = async (what: string) => { const off = githubOffNow(); if (off) throw new GithubOffError(off, what); };
  handle(rpc.preparePrActionRpc, async ({ workspaceId, prKey, kind }) => { await githubFirst(kind === "merge" ? "Merging" : "Merge when ready"); await requireReady(); return actions.prepare(workspaceId, prKey, kind); });
  handle(rpc.confirmPrActionRpc, async ({ planId, scope }) => { await githubFirst("Merging"); await requireReady(); const result = await actions.confirm(planId, scope); void engine.nudge(); return result; });
  handle(rpc.checkPrActionRpc, async ({ workspaceId, actionId }) => { await requireReady(); return actions.check(workspaceId, actionId); });
  handle(rpc.requestReviewersRpc, async ({ workspaceId, prKey, reviewers, remember }) => {
    // Remember still saves while GitHub is off: the developer's choice, for when it's on.
    if (githubOffNow()) { if (reviewers && remember) await reviewerStore.save(prKey.split("#")[0], reviewers); await githubFirst("Adding reviewers"); }
    await requireReady();
    // "Remember for <repo>" saves first: it's the developer's choice whatever GitHub answers.
    if (reviewers && remember) await reviewerStore.save(prKey.split("#")[0], reviewers);
    const result = await actions.requestReviewers(workspaceId, prKey, reviewers?.map(r => r.login)); void engine.nudge(workspaceId); return result;
  });
  const reviewerSettings = async () => {
    const config = await reviewerStore.read();
    const seen = new Set(Object.keys(config.repos));
    for (const w of (await store.snapshot()).workspaces) for (const p of w.prs) seen.add(repoKey(p.repo));
    return { config, repos: [...seen].sort(), noReview: noReviewRepos(prWorkflow.current()) };
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
  handle(rpc.setPrWorkflowRpc, async ({ repo, setting, default: fallback, mergeMethod, reviewFix, review, deploy }) => {
    await requireReady();
    if ((setting !== undefined || mergeMethod !== undefined || review !== undefined || deploy !== undefined || (reviewFix !== undefined && repo)) && !repo) throw new Error("Name the repository (owner/name) to change.");
    await prWorkflow.mutate(config => {
      if (fallback !== undefined) config.default = fallback;
      if (!repo) { if (reviewFix) config.reviewFix = reviewFix; return; }
      const own = config.repos[repoKey(repo)] ??= {};
      if (setting !== undefined) { if (setting === null) delete own.workflow; else own.workflow = setting; }
      if (mergeMethod !== undefined) { if (mergeMethod === null) delete own.mergeMethod; else own.mergeMethod = mergeMethod; }
      if (reviewFix !== undefined) { if (reviewFix === null) delete own.reviewFix; else own.reviewFix = reviewFix; }
      if (review !== undefined) { if (review === null || review === "team") delete own.review; else own.review = review; }
      if (deploy !== undefined) { if (deploy === null) delete own.deploy; else own.deploy = deploy; }
    });
    // A changed workflow changes readiness and merge: check the PRs again now rather than on the next poll.
    void engine.nudge();
    return prWorkflowView();
  });
  // PR statistics: reads load a repository's records for that read only; writes save stats.json behind the reply.
  handle(rpc.prStatsRpc, async input => { await requireReady(); return prStats.read(input); });
  // The repositories Follow-up knows from what it already holds (tracked PRs, workspaces, Shipping PRs), never a Paseo read:
  // Settings answers while Paseo or GitHub hang (an-ack-never-waits-on-the-disk's sibling, tests/rpc-ack.test.ts).
  const statsRepos = async () => new Set([...knownRepos(await store.snapshot()), ...Object.keys(prWorkflow.current().repos)]);
  handle(rpc.prStatsSettingsRpc, async ({ repo, estimate }) => { await requireReady(); return prStats.view(await statsRepos(), { repo, estimate }); });
  handle(rpc.setPrStatsRpc, async input => {
    await requireReady();
    const before = input.repo ? (await prStats.settings()).repos[input.repo] : undefined;
    await prStats.set(input);
    if (input.repo && input.enable === true && !before?.enable_stats) {
      // The first sync starts on this tick's hook; the estimate (1 point) is kept for the page's "≈ N of M PRs".
      const repo = input.repo;
      void prStats.estimate(repo).then(e => prStats.noteEstimate(repo, e)).catch(() => undefined).finally(() => prStats.tick());
    }
    return prStats.view(await statsRepos());
  });
  handle(rpc.reviewerSettingsRpc, async () => { await requireReady(); return reviewerSettings(); });
  handle(rpc.saveReviewersRpc, async ({ repo, reviewers }) => { await requireReady(); await reviewerStore.save(repo, reviewers); return reviewerSettings(); });
  handle(rpc.reviewerSuggestionsRpc, async ({ repo }) => { const off = githubOffNow(); if (off) return { suggestions: [], error: `${githubOffText(off, "Suggesting reviewers")} Until then, type a login or org/team.` }; await requireReady(); return reviewerSuggestions.suggest(repo); });

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
  overseer = new Overseer({ directory, store, inbox, enqueue: enqueueMessage, sources: senderSources, priorities: priorityStore, workspaces: paseoWorkspaces, enabled: overseerOn, paseoHome, tight: async () => !governor.allowsBackground(),
    windowMs: async () => activeWindowMs(await store.snapshot()), agent: () => agentSettings.role("overseer"),
    // Compass's digest block (compass-without-the-overseer): built only with the digest, only when a note is live.
    compass: async () => {
      const notes = await compass?.digest() ?? [];
      if (!notes.length) return [];
      const read = (await morningBrief?.planView().catch(() => null))?.read ?? null;
      const plan = read ? `This week's plan: ${read.title ?? "untitled"}, ${read.items} items${read.withoutIssue ? `, ${read.withoutIssue} without an issue` : ""}` : null;
      return plan ? [plan, ...notes] : notes;
    },
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
  // The Overseer's ask goes straight to it (Overseer.ask, not the queue): its images are sent from memory, never stored.
  handle(rpc.overseerAskRpc, async ({ text, images }, { paseo }) => { await requireReady(); seen(paseo); await overseer!.ask(paseo as unknown as OverseerPaseo, text, images?.map(i => ({ data: i.data, mimeType: i.mimeType }))); return overseerStatus(); });
  handle(rpc.imageSupportRpc, async ({ target }) => {
    await requireReady();
    const agentOf = (id: string | null | undefined) => id ? gateway.directory.cached(id) ?? null : null;
    if (target.kind === "provider") return imageSupport({ provider: target.provider });
    if (target.kind === "agent") return imageSupport(agentOf(target.agentId));
    if (target.kind === "workspace") {
      const w = (await store.snapshot()).workspaces.find(x => x.id === target.workspaceId);
      const main = agentOf(w?.mainAgentId) ?? ((await gateway.directory.read().catch(() => null))?.agents ?? []).map(r => r.agent).find(a => a.workspaceId === target.workspaceId && !a.archivedAt) ?? null;
      return imageSupport(main);
    }
    const s = await overseer!.state();
    const running = agentOf(s.agentId);
    if (running) return imageSupport(running);
    return imageSupport({ provider: (await overseer!.agentInfo()).configured.provider });
  });
  // Your questions and Catch up's More context: the question is recorded and answered at once, and goes through the
  // message queue (invariant 36) to an agent that has context_reply (an-ask-goes-only-to-an-agent-that-can-answer-it):
  // about a card, the card's workspace's main agent; a free question, the agent named (/ask's chat) or the main agent.
  // Asking may wake it: the developer asked, the one exception to never-wake (invariant 1).
  const askAgent = async (input: { workspaceId?: string | null; agentId?: string | null; cardKey?: string | null; card?: string; target?: "agent" | "overseer"; ask: string; via?: ContextVia; parentId?: string | null }, by: string, caller: string | null, images: ImageUpload[] | undefined) => {
    // The worker's own snapshot, never a daemon read (an-ack-never-waits).
    const state = await store.snapshot();
    let to: { agentId: string; workspaceId: string | null };
    if (input.cardKey) {
      const w = input.workspaceId ? state.workspaces.find(x => x.id === input.workspaceId) : undefined;
      const r = contextRecipient(w, caller);
      if ("error" in r) throw new Error(r.error);
      to = { agentId: r.agentId, workspaceId: input.workspaceId ?? null };
    } else {
      const r = questionRecipient(state.workspaces, input, caller);
      if ("error" in r) throw new Error(r.error);
      to = r;
    }
    const parent = input.parentId ? await contextRequests.get(input.parentId) : null;
    return withImages(images, async refs => {
      const out = await contextRequests.ask({ workspaceId: to.workspaceId, agentId: input.agentId ?? to.agentId, cardKey: input.cardKey ?? null, card: input.card ?? "", target: "agent", ask: input.ask,
        via: caller ? "tool" : input.via ?? (input.cardKey ? "more" : "field"), parentId: input.parentId ?? null }, by, to.agentId);
      if (out.fresh) enqueueMessage(to.agentId, out.request.cardKey ? agentContextPrompt(out.request) : agentQuestionPrompt(out.request, parent), out.request.id, by, refs);
      return out;
    });
  };
  handle(rpc.contextAskRpc, async (input, context) => {
    await requireReady();
    const actor = actorOf(context);
    const { images, ...ask } = input;
    const out = await askAgent(ask, actorBy(actor), actor.kind === "agent" ? actor.agentId : null, images);
    return input.target === "overseer" ? { ...out, note: "More context always asks the card's own main agent, which can answer on the card; the Overseer can't, so target is ignored." } : out;
  });
  // What happens to a question after it is asked (Your questions): every act is the developer's click or an agent's
  // confirmed question_action, by the same path; an agent's never reads the answer for the developer.
  handle(rpc.questionActionRpc, async ({ id, action, text, images }, context) => {
    await requireReady();
    const actor = actorOf(context);
    const by = actorBy(actor);
    const r = await contextRequests.get(id);
    if (!r) throw new Error(`No question ${id}. It may have expired (questions are kept 30 days).`);
    // Agents act on others, not themselves (invariant 4): the asked agent answers with context_reply, nothing more.
    if (actor.kind === "agent" && actor.agentId === r.askedOf) throw new Error("This question was asked of you: answer it with context_reply; what happens to it next is the developer's call.");
    if (action === "done") return { request: await contextRequests.done(id, by) };
    if (action === "withdraw") {
      const request = await contextRequests.withdraw(id, by);
      // A message still queued is dropped; one already out stays (its answer, if any, is in the chat).
      if (r.askedOf) await queue.cancel(`message:${r.askedOf}:${id}`, "The question was withdrawn.").catch(() => undefined);
      return { request };
    }
    if (action === "reply") {
      if (!text) throw new Error("Reply needs text: the follow-up question.");
      if (r.state === "asking") throw new Error("This question is still asking; wait for its answer, or withdraw it.");
      const out = await askAgent({ workspaceId: r.workspaceId, agentId: r.askedOf, ask: text, via: r.via === "slash" ? "slash" : "field", parentId: r.id }, by, actor.kind === "agent" ? actor.agentId : null, images);
      const request = by === "developer" ? (await contextRequests.read(id)) ?? r : r;
      return { request, reply: out.request };
    }
    // Make a task: update_obligation's server path, owned by the agent that answered, the Q&A as its note.
    if (r.task) return { request: r, taskId: r.task.id };
    if (r.state === "asking" || r.state === "withdrawn") throw new Error("Make a task needs an answer first.");
    if (!r.workspaceId || !r.askedOf) throw new Error("This question has no workspace to hold a task.");
    const { title, note } = questionTask(r);
    const result = await store.mutate(state => {
      const w = state.workspaces.find(x => x.id === r.workspaceId && x.enable_tracking);
      if (!w) throw new Error("Follow-up no longer tracks this question's workspace, so it can't hold a task.");
      const obligation = updateObligation(w, { title, status: "pending", note, caller: r.askedOf!, new: true });
      syncTaskQuestions(w, Date.now());
      changed(w); return { workspaceId: w.id, taskId: obligation.id };
    });
    void engine.nudge(result.workspaceId);
    return { request: await contextRequests.tasked(id, result.taskId, by), taskId: result.taskId };
  });
  // Built when read (a-derived-view-is-built-when-read), from state the worker holds: no daemon request but the
  // directory's cached workspace list.
  handle(rpc.catchUpDeckRpc, async () => {
    await requireReady();
    const [state, list, paseoList, priorities, settings, context] = await Promise.all([store.snapshot(), inbox.list(), paseoWorkspaces(), priorityStore.read(), inboxSettings(), contextRequests.list()]);
    const tracked = state.workspaces.filter(w => w.enable_tracking);
    const byId = new Map(tracked.map(w => [w.id, w]));
    const model = buildHome({ rows: list.rows, tracked, paseo: paseoList, now: Date.now(), sort: (settings as { home_sort?: SortMode }).home_sort, priorities, questions: context });
    const unread = questionsByWorkspace(context);
    const cards = deckCards({ model, rows: list.rows, items: id => { const w = byId.get(id); return w ? needsYou(w) : []; }, answers: id => unread.get(id)?.unread ?? [] });
    return { cards: cards.map(c => {
      const r = contextFor(context, { workspaceId: c.s.workspaceId, cardKey: c.key });
      return { key: c.key, kind: c.kind, workspaceId: c.s.workspaceId, agentId: c.s.agentId, title: c.s.title, line: c.s.line, questionId: c.questionId ?? null,
        item: c.item && "title" in c.item ? String((c.item as { title?: unknown }).title ?? "") || null : null, context: r ? { id: r.id, state: r.state, target: r.target } : null };
    }) };
  });
  handle(rpc.contextListRpc, async ({ workspaceId, state, query }) => {
    const all = await contextRequests.list(workspaceId ? { workspaceId } : {});
    return { requests: state || query ? questionHistory(all, { filter: state, query }).reverse() : all };
  });
  // Paseo 0.17's own PR watch (subscribe_change_request): named only for PRs Follow-up can't see. No feature flag says
  // it's there; server_info's version does, read from the connection's last hello (no request).
  const hostVersion = async () => { try { return String(((await withDaemon(async client => (client as ServerInfoClient).getLastServerInfoMessage?.())) as { version?: unknown } | null)?.version ?? ""); } catch { return ""; } };
  handle(rpc.waitForChecksRpc, async (input, { paseo }) => {
    if (!input.cancel) { const off = githubOffNow(); if (off) return githubOffChecksAnswer(off, input.prs); }
    await requireReady();
    return waitForChecksAnswer(input, {
      state: () => store.snapshot(), watches: checkWatches, nudge: id => engine.nudge(id), hostVersion, githubOff: () => github.off(),
      register: (repo, number) => handlers.get(rpc.registerPrRpc.name)!.run({ agentId: input.agentId, repo, number, stack: `${repo}#${number}` }, { paseo } as PluginHandlerContext) as Promise<unknown>,
    });
  });
  handle(rpc.contextReplyRpc, async ({ agentId, requestId, text }) => {
    await requireReady();
    await contextRequests.reply(requestId, agentId, text);
    return { ok: true };
  });
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
  // A helper left on its default runs on a provider Paseo has (shared/job-rows.ts runnableRole): the last catalog read.
  // Reading a role never waits on Paseo (an-ack-never-waits-on-the-disk's rule for RPCs: overseer-status, Compass): with
  // no catalog yet it starts one read in the background (cached ten minutes) and keeps the default meanwhile. Never polled.
  agentSettings.catalog = async () => { const last = providerCatalog.peek(); if (!last && api) void providerCatalog.read().catch(() => undefined); return last; };
  const agentSettingsView = async (catalog: boolean, fresh = false): Promise<AgentSettingsView> => {
    // The catalog first, so the roles show what runs (a default on a provider Paseo lacks moves: runnableRole).
    const cat = catalog ? await providerCatalog.read(fresh) : null;
    const [{ invalid }, roles] = await Promise.all([agentSettings.load(), agentSettings.all()]);
    // Which providers are ACP comes from Paseo's config (a generic ACP agent has the developer's own id): Settings' line.
    const config = cat ? await paseoConfig() as Parameters<typeof isAcp>[1] : null;
    const shown = cat ? { ...cat, providers: cat.providers.map(p => ({ ...p, acp: isAcp(p.id, config) })) } : null;
    return { roles: Object.values(roles).map(r => ({ ...r, summary: roleSummary(r, labelsFor(r, cat)) })), invalid, catalog: shown, wait: await currentWait() };
  };
  // What's new and Settings → General. Follow-up's own install comes from Paseo's plugin list, read once per worker.
  const versions = new VersionsStore(directory);
  const updatesStore = new UpdatesStore(directory);
  let self: Promise<SelfInstall & { name: string | null; notes: ReleaseNote[]; releases: string | null }> | null = null;
  const selfInstall = () => self ??= withDaemon(async c => describeSelf(await c.listPlugins?.() ?? [])).then(async row => {
    const pkg = row.path ? await readPackage(row.path) : { version: null, name: null, notes: [], releases: null };
    const version = pkg.version ?? row.version;
    if (!version) throw new Error("Paseo's plugin list doesn't show Follow-up's version yet.");
    // Fresh or existing comes from setup's own record, decided once before anything else wrote state.
    const existing = await onboarding.init().then(f => f.install === "existing", () => true);
    await versions.started(version, existing).catch(() => undefined);
    return { ...row, version, name: pkg.name, notes: pkg.notes, releases: pkg.releases };
  }).catch(error => { self = null; throw error; });
  // Record the version at start (in the background), so "Updated to X 2h ago" counts from the reload, not first view.
  void ready.then(() => selfInstall()).catch(() => undefined);
  const releaseNotesView = async (): Promise<ReleaseNotesView> => {
    const [me, file, updates] = await Promise.all([selfInstall(), versions.read(), updatesStore.read()]);
    return demoOverride(directory, "release-notes", releaseNotesViewSchema, { version: me.version, name: me.name ?? PLUGIN_NAME, installKind: me.installKind, previous: file.previous ?? null, updatedAt: file.startedAt ?? null, hostSeen: file.hostSeen ?? null, enable_whats_new: updates.enable_whats_new !== false, notes: me.notes, releases: me.releases });
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
    const fields = { version: me.version, at: Date.now(), error: loadError ? String(loadError).slice(0, 300) : null };
    const beat = JSON.stringify(fields);
    await writeHeartbeat(join(directory, "heartbeat.json"), fields);
    // A 1.x installer on probation reads the old directory's heartbeat; can go in the release after 2.0.0.
    try { writeLegacyHeartbeat(paseoHome, beat); } catch { /* no 1.x directory, or not writable: nothing watches it */ }
    if (!stopped) await updater.start();
    await evaluateMove();
  }).catch(() => undefined);
  handle(rpc.updatesRpc, async ({ check }) => {
    if (check) await updater.check(check).catch(() => undefined);
    return updatesView();
  });
  handle(rpc.setUpdatesRpc, async ({ mode, channel, enable_whats_new }) => { await updater.setSettings({ mode, channel, enable_whats_new }); return updatesView(); });
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
  // New (server/dispatch.ts, docs/dispatch.md): start work from a Linear issue, a GitHub issue or PR, a link or the
  // developer's words. Linear is read through mcpproxy only when New asks (new-reads-nothing-while-closed).
  const linearIssues = new LinearIssues(undefined, Date.now);
  const baseCache = new Map<string, { at: number; value: Promise<string | null> }>();
  const dispatchProjects = async (): Promise<DispatchProject[]> => {
    const rows = await gateway.directory.projects(60_000);
    return rows.map(p => ({ id: p.projectId, name: p.projectCustomName || p.projectDisplayName, repo: p.projectKind === "git" ? projectRepo(p.projectKey) : null, worktree: p.projectKind === "git", path: p.projectRootPath }));
  };
  const linkedOf = async () => Object.entries((await linkedStore.read()).workspaces);
  // a-taken-issue-is-not-a-suggestion: the one "which live workspace has this issue" map (shared/issue-workspace.ts):
  // a link or a tracked PR whose branch or title names the key. Built per read from state already in hand.
  const issueHolders = async () => {
    const [state, linked] = await Promise.all([store.snapshot(), linkedOf()]);
    const latest = (w: (typeof state.workspaces)[number]) => [w.mainWorkAt ?? "", ...w.batches.map(b => b.activityAt ?? b.sentAt ?? b.createdAt)].reduce((a, b) => b > a ? b : a, "");
    return issueWorkspaces({
      workspaces: state.workspaces.map(w => ({ id: w.id, title: w.title, archived: w.archived, enable_tracking: w.enable_tracking, activityAt: latest(w), prs: w.prs })),
      links: linked.map(([id, l]) => [id, l.items.flatMap(i => i.kind === "linear" && i.key ? [i.key] : [])] as const),
    });
  };
  // New's view of it: each holder with the project it's in (Paseo's directory, cached), for resolveWhere.
  const takenIssues = async () => {
    const [holders, rows] = await Promise.all([issueHolders(), gateway.directory.read().catch(() => null)]);
    const projectOf = new Map((rows?.workspaces ?? []).map(w => [w.id, (w as { projectId?: string | null }).projectId ?? null]));
    return new Map([...holders].map(([key, h]) => [key, { ...h, projectId: projectOf.get(h.workspaceId) ?? null }]));
  };
  const dispatcher = new DispatchService({
    store: new DispatchStore(directory),
    // Compass's suggestions for New's My issues and `{why}` (compass is set before New is ever opened).
    compass: async () => compass ? compass.suggestions() : [],
    images: imageStore,
    linear: linearIssues,
    github: async (kind, repo, number) => {
      const j = await githubApi().rest(repo, `repos/${repo}/${kind === "pr" ? "pulls" : "issues"}/${number}`) as { title?: unknown; body?: unknown; state?: unknown; merged_at?: unknown } | null;
      if (!j || typeof j.title !== "string") return null;
      return { title: j.title, body: typeof j.body === "string" ? j.body : null, state: j.merged_at ? "merged" : typeof j.state === "string" ? j.state : null };
    },
    projects: dispatchProjects,
    // Team → project → workspaces with an issue of that team linked: where the developer already starts that team's work.
    learned: async () => {
      const rows = await gateway.directory.read().catch(() => null);
      const projectOf = new Map((rows?.workspaces ?? []).map(w => [w.id, (w as { projectId?: string | null }).projectId ?? null]));
      const out: Record<string, Record<string, number>> = {};
      for (const [workspaceId, links] of await linkedOf()) {
        const projectId = projectOf.get(workspaceId);
        if (!projectId) continue;
        for (const team of new Set(links.items.filter(i => i.kind === "linear").map(i => teamOf(i.key)))) {
          const t = out[team] ??= {};
          t[projectId] = (t[projectId] ?? 0) + 1;
        }
      }
      return out;
    },
    existing: async source => {
      const state = await store.snapshot();
      const live = (id: string) => state.workspaces.find(w => w.id === id && !w.archived) ?? null;
      // The project it's in (Paseo's directory, cached): a source already being worked on goes there (resolveWhere).
      const projectOf = async (id: string) => (await gateway.directory.read().catch(() => null))?.workspaces.find(w => w.id === id)?.projectId ?? null;
      if (source.kind === "pr" && source.repo && source.number) {
        const owner = prOwner(state, source.repo, source.number);
        const w = owner ? live(owner.workspaceId) : null;
        return w ? { workspaceId: w.id, title: w.title, state: "tracked", projectId: await projectOf(w.id) } : null;
      }
      if (source.kind !== "linear" || !source.key) return null;
      return holderOf(await takenIssues(), source.key);
    },
    taken: takenIssues,
    // The repository's default branch (origin/HEAD), read from the checkout once an hour.
    defaultBase: async projectId => {
      const hit = baseCache.get(projectId);
      if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
      const value = (async () => {
        const project = (await dispatchProjects()).find(p => p.id === projectId);
        if (!project?.worktree) return null;
        const out = await new Promise<string>((resolve, reject) => execFile("git", ["-C", project.path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));
        return out.trim().replace(/^origin\//, "") || null;
      })().catch(() => null);
      baseCache.set(projectId, { at: Date.now(), value });
      return value;
    },
    // The action's own agent, else New's default: Settings → Agents → New work, which is the Overseer's agent until
    // someone picks one ("Same as the Overseer").
    agent: async action => {
      const own = await agentSettings.role("dispatch").catch(() => null);
      const role = !own || own.same ? await agentSettings.role("overseer").catch(() => null) : own;
      const provider = action.agent?.provider ?? role?.provider?.split("/")[0] ?? "claude";
      const model = action.agent?.model ?? (action.agent?.provider ? null : role?.model ?? null);
      const mode = action.agent?.mode ?? (action.agent?.provider ? null : role?.mode ?? null) ?? (provider === "claude" ? "bypassPermissions" : null);
      const thinking = action.agent?.thinking ?? (action.agent?.provider ? null : role?.thinking ?? null);
      const selection = model ? `${provider}/${model}` : api ? await providerModel(api as unknown as OverseerPaseo, provider) : provider;
      return {
        config: { provider: selection, ...(mode ? { modeId: mode } : {}), ...(thinking ? { thinkingOptionId: thinking } : {}) },
        label: model ? `${provider} ${model}` : provider.charAt(0).toUpperCase() + provider.slice(1),
        picked: { provider, ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(thinking ? { thinking } : {}) }, isDefault: !action.agent,
      };
    },
    multiplicity: () => hostMultiplicity(),
    paseo: async () => api ? {
      workspaces: {
        create: o => (api!.workspaces as unknown as DispatchPaseo["workspaces"]).create(o),
        archive: id => (api!.workspaces as unknown as { ref(id: string): { archive(): Promise<unknown> } }).ref(id).archive(),
      },
    } : null,
    // The Overseer's own dispatch needs the developer's ask or approval, as start_workspace always did.
    gate: async (actor, key) => {
      if (actor.kind !== "agent" || !overseer) return null;
      const s = await overseer.state().catch(() => null);
      if (!s?.agentId || s.agentId !== actor.agentId || !api) return null;
      return overseer.newWorkspaceGate(api as unknown as OverseerPaseo, key);
    },
    afterCreate: async (record, source) => {
      if (!record.workspaceId) return;
      const ref = source.kind === "linear" ? source.key : source.url;
      if (ref) await linked.link(record.workspaceId, ref, { origin: "manual", by: record.by, title: source.title || null }).catch(() => undefined);
    },
    onChange: () => feeds.home(),
    log: line => console.warn(`[follow-up] ${line}`),
  });
  void ready.then(async () => {
    if (stopped || loadError) return;
    await dispatcher.start();
    // Pasted images no queue item or waiting dispatch references (a crash between saving and queueing) are removed.
    const removed = await imageStore.sweep([...queue.imageIds(), ...await dispatcher.imageIds()]);
    if (removed) console.warn(`[follow-up] removed ${removed} pasted image${removed === 1 ? "" : "s"} nothing referenced`);
    // Cards: an agent's spec link (set_spec, retired) becomes its `spec` card once; cards of workspaces gone from state go
    // with them, and copied media nothing references is removed.
    const state = await store.snapshot();
    const moved = await cards.migrateSpecs(state.workspaces.filter(w => w.spec?.source === "agent" && w.spec.url).map(w => ({ workspaceId: w.id, url: w.spec!.url!, title: w.spec!.title ?? null, by: w.spec!.by ?? null, at: w.spec!.at })));
    if (moved) console.warn(`[follow-up] moved ${moved} agent spec link${moved === 1 ? "" : "s"} into spec cards`);
    await cards.forget(new Set(state.workspaces.map(w => w.id)));
    await cards.sweep();
  }).catch(() => undefined);
  // Settings → Morning brief (server/morning-brief.ts): the queue's settings, the brief's clock and this week's plan
  // link. The plan reader is the ranker's (built below); the skill registry is imported once.
  // One store for the brief's settings and its sources (morning-brief.json).
  const morningBriefStore = new MorningBriefStore(directory);
  // The chat search follows the brief's Chat switch: a chat source turned off isn't searched.
  const chatAllowed = async () => {
    const g = await briefSources!.gate("chat");
    if (!g.on) throw new Error("Chat is off in Settings → Morning brief.");
    return g.allowed;
  };
  morningBrief = new MorningBrief({
    store: morningBriefStore, chat: mcpproxyChat(undefined, { allowed: chatAllowed }), env: () => process.env.FOLLOW_UP_PLAN_URL, deviceZone: () => clientTimeZone,
    readPlan: url => ranker!.readPlan(url),
    // The plan's items matched to issues and workspaces (the one predicate New reads): "14 items, 3 without an issue".
    lastRead: async () => {
      const p = (await ranker!.state()).planning;
      if (!p) return null;
      const holders = await issueHolders();
      const m = matchPlan(p.value.items, key => holders.get(key)?.workspaceId ?? null);
      return { url: p.url, at: p.at, title: p.value.title, items: p.value.items.length, withoutIssue: m.withoutIssue };
    },
    readPlans: async () => { await compass?.read("manual", { plans: true }); },
    onChange: () => feeds.home(), log: line => console.warn(line),
  });
  // The Morning brief's Linear queue (server/linear-queue.ts, docs/morning-brief.md): the whole queue swept each workday
  // morning through the same Linear reader, diffed against the last complete sweep. Its clock is the setting's zone,
  // else the developer's device's, else the host's; never a fixed one.
  const briefClock = () => morningBrief!.clock();
  linearQueue = new LinearQueue({
    store: new LinearQueueStore(directory),
    linear: linearIssues,
    settings: () => morningBrief!.settings(),
    clock: briefClock,
    // "Has a workspace" in the queue: the one predicate New and dispatch read (a-taken-issue-is-not-a-suggestion).
    workspaces: issueHolders,
    tight: () => !governor.allowsBackground(),
    onChange: () => feeds.home(),
    log: line => console.warn(line),
  });
  // The brief's one Since block (design §8): the queue's changes and what Compass heard, against the same stored point.
  handle(rpc.linearQueueRpc, async ({ filter, since, limit, open }) => {
    await requireReady();
    const view = open ? await linearQueue!.open() : await linearQueue!.view({ filter, since, limit });
    return { ...view, compass: compass ? await compass.since(view.since).catch(() => null) : null };
  });
  handle(rpc.sweepQueueRpc, async ({ wait }, context) => { await requireReady(); return linearQueue!.sweepNow(actorOf(context).kind === "agent" ? "agent" : "manual", wait === false ? 0 : undefined); });
  handle(rpc.briefSettingsRpc, async () => { await requireReady(); return morningBrief!.view(); });
  handle(rpc.setBriefSettingsRpc, async input => { await requireReady(); return morningBrief!.setQueue(input); });
  handle(rpc.briefPlanRpc, async ({ link }) => { await requireReady(); return link ? { ...await morningBrief!.planView(), preview: await morningBrief!.preview(link) } : morningBrief!.planView(); });
  handle(rpc.setBriefPlanRpc, async input => {
    await requireReady();
    const before = await morningBrief!.planUrl();
    const view = await morningBrief!.setPlan(input);
    // A new link: read it now in the background, so Settings shows its title and the next ranking has it.
    if (view.url && view.url !== before) void ranker!.readPlan(view.url).then(() => feeds.home(), () => undefined);
    return view;
  });
  // An alias of compass_find for one minor release (the plan's pickers moved into Compass's source editor).
  handle(rpc.briefChatSearchRpc, async ({ kind, query }) => { await requireReady(); return compass!.find(kind, query); });
  handle(rpc.dispatchSourcesRpc, async ({ fresh, query }) => { await requireReady(); return dispatcher.sources({ fresh, query }); });
  handle(rpc.dispatchPreviewRpc, async (input, context) => { await requireReady(); seen(context.paseo); return dispatcher.preview(input, actorOf(context)); });
  handle(rpc.dispatchRpc, async (input, context) => { await requireReady(); seen(context.paseo); return dispatcher.dispatch(input, actorOf(context)); });
  handle(rpc.dispatchRecordsRpc, async () => { await requireReady(); return { records: await dispatcher.records() }; });
  handle(rpc.dispatchUndoRpc, async ({ dispatchId }, context) => { await requireReady(); seen(context.paseo); return dispatcher.undo(dispatchId); });
  handle(rpc.dispatchActionsRpc, async () => { await requireReady(); return dispatcher.actions(); });
  handle(rpc.setDispatchActionsRpc, async ({ change }, context) => { await requireReady(); return dispatcher.setActions(change as ActionChange, actorOf(context)); });
  handle(rpc.dispatchSettingsRpc, async () => { await requireReady(); return dispatcher.settings(); });
  handle(rpc.setDispatchSettingsRpc, async input => { await requireReady(); return dispatcher.setSettings(input); });
  overseer!.dispatcher = {
    preview: (input, actor) => dispatcher.preview(input as never, actor),
    dispatch: (input, actor) => dispatcher.dispatch(input as never, actor),
    projects: dispatchProjects,
  };
  // Summary: small model jobs through the shared runner, cached per workspace in about.json.
  const aiJobs = new AiJobs({ concurrency: 1, logPath: join(directory, "ai-jobs.jsonl"), generic: jobAgentRunner({ paseo: () => api as unknown as JobPaseo | null, directory }) });
  // The ranker behind Home's Priority sort (1.4.0-beta.0). Its provider, model and limits come from the ranker role
  // in Settings → Agents. Inputs are read-only: Follow-up's state, mcpproxy, gh, the plan.
  const rankerOn = async () => (await inboxSettings()).enable_ranker !== false;
  const rankerRole = async () => {
    const r = await agentSettings.role("ranker");
    return { provider: r.provider, model: r.model, thinking: r.thinking, dailyCap: r.dailyCap ?? RANKER_ROLE_DEFAULT.dailyCap, maxPromptChars: r.maxPromptChars ?? RANKER_ROLE_DEFAULT.maxPromptChars, cadenceMinutes: r.cadenceMinutes ?? RANKER_ROLE_DEFAULT.cadenceMinutes };
  };
  // Every outside source is gated by Settings → Morning brief's switches (shared/brief-sources.ts).
  const rankSources = liveRankSources(aiJobs, { queue: linearQueue, gate: id => briefSources!.gate(id), model: async () => { const r = await rankerRole(); return r.provider === "claude" ? r.model : null; } });
  ranker = new Ranker({ directory, jobs: aiJobs, priorities: priorityStore, role: rankerRole, enabled: rankerOn, tight: async () => !governor.allowsBackground(),
    workstreams: () => overseer!.workstreams(), planningUrl: () => morningBrief!.planUrl(), clock: briefClock,
    windows: async () => { const q = await morningBrief!.settings(); return { chatHours: q.chatHours, calendarDays: q.calendarDays }; },
    sources: { ...rankSources, asks: () => briefSources!.askedItems(), compass: () => compass ? compass.forRanker() : Promise.resolve([]) } });
  // The brief's sources (server/brief-sources.ts): what mcpproxy has, the switches, each source's health, Retry.
  briefSources = new BriefSources({
    store: morningBriefStore, tools: sourceDirectory(), deviceZone: () => clientTimeZone,
    ranker: async () => { const s = await ranker!.state(); return { lastRunAt: s.lastRunAt, health: s.health, errors: s.errors }; },
    sweep: () => linearQueue!.lastSweep(),
    githubAccounts: () => githubApi().accounts(),
    probe: async id => {
      if (id === "linear") { const r = await linearQueue!.sweepNow("manual"); if ("ok" in r && !r.ok) throw new Error(r.error ?? "The sweep failed."); return; }
      if (id === "github") { await rankSources.github(); return; }
      if (id === "chat") { await rankSources.slack(Date.now() - 3_600_000); return; }
      if (id === "mail") { const now = Date.now(); await rankSources.mail!(now - 86_400_000, now); return; }
      if (id === "doc") { const r = await compass?.read("manual"); if (r && !r.ok) throw new Error(r.error ?? "The last read failed."); return; }
      const now = Date.now();
      await rankSources.calendar!({ start: new Date(now).toISOString(), end: new Date(now + 86_400_000).toISOString(), timeZone: (await briefClock()).timeZone });
    },
    // Ask (server/ask.ts): the Summary's role, a fast model; the reads go through the same directory (tool-read only).
    ask: (server, opts) => askSource({ tools: sourceDirectory(), jobs: aiJobs, role: () => agentSettings.role("about") }, server, { ...opts, now: Date.now() }),
    tight: () => !governor.allowsBackground(),
    // Today's Ask items reach today's rank: the ranker's next tick (this loop) runs once, inside its cadence or not.
    onAsked: () => ranker?.markDue(),
    onChange: () => feeds.home(), log: line => console.warn(line),
  });
  // Compass (server/compass.ts, docs/compass.md): its settings beside the brief's, its notes in compass.json. Extraction
  // runs on the Summaries role, only on a provider Follow-up can guard (Claude, Codex).
  compass = new Compass({
    settings: morningBriefStore, store: new CompassStore(directory), tools: sourceDirectory(), jobs: aiJobs,
    role: async () => { const r = await agentSettings.role("about"); return { provider: r.provider, model: r.model, thinking: r.thinking, label: providerName(r.provider) }; },
    clock: briefClock, sweepAt: async () => (await morningBrief!.settings()).sweepAt,
    index: async () => {
      const [rows, holders, aboutFile, linked] = await Promise.all([overseer!.workstreams(), issueHolders(), aboutStore.read(), linkedOf()]);
      const titles = new Map(linked.map(([id, l]) => [id, l.items.flatMap(i => i.title ? [i.title] : [])]));
      return {
        workspaces: rows.map(w => ({ id: w.workspaceId, title: w.title, summary: aboutFile.entries[w.workspaceId]?.gist ?? null, branch: w.branch, linked: titles.get(w.workspaceId) ?? [], prs: [] })),
        issueWorkspace: key => holders.get(key.toUpperCase())?.workspaceId ?? null,
      };
    },
    // Each reader honours its input's switch in Settings → Compass (a chat, docs or calendar server turned off isn't read).
    allowed: async recipeId => {
      if (recipeId === "chat") return chatAllowed();
      const g = await briefSources!.gate(recipeId);
      if (!g.on) throw new Error(`${recipeId === "doc" ? "Your docs are" : "Your calendar is"} off in Settings → Compass.`);
      return g.allowed;
    },
    tight: () => !governor.allowsBackground(), appOpen: () => appOpen(),
    issues: async () => (await linearQueue?.needs())?.issues ?? new Map(),
    // A Linear tracker place reads the sweep's own snapshot; a GitHub one, Follow-up's in-process GitHub reads.
    queue: async () => (await linearQueue?.snapshotIssues()) ?? [],
    github: { rest: (repo, path) => githubApi().rest(repo, path) },
    // Tell the agent (compass-reaches-an-agent-only-by-a-click): one queued message to the workspace's main agent.
    tell: async (workspaceId, text, by) => {
      const w = (await store.snapshot()).workspaces.find(x => x.id === workspaceId && !x.archived);
      if (!w?.mainAgentId) return null;
      enqueueMessage(w.mainAgentId, text, `compass-${randomUUID()}`, by === "developer" ? "developer" : by);
      return { agentId: w.mainAgentId };
    },
    // Plans come from Compass on arrival: this week's plan, its title read at once.
    onPlan: found => morningBrief!.recordPlan(found),
    onChange: () => { ranker?.markDue(); feeds.home(); }, log: line => console.warn(line),
  });
  // Settings → Compass and `compass`: every priority input in one view (one-place-for-priority-inputs): the Compass
  // sources, the built-in and mcpproxy inputs, this week's plan, and the brief's clock.
  const compassAll = async () => {
    const [view, brief, inputs] = await Promise.all([compass!.view(), morningBrief!.view(), briefSources!.view({ check: false })]);
    return { ...view, plan: brief.plan, brief: { queue: brief.queue, clock: brief.clock }, inputs };
  };
  handle(rpc.compassRpc, async ({ workspace }) => {
    await requireReady();
    if (!workspace) return compassAll();
    const view = await compass!.view({ workspace });
    // Why it matters (the panel) and compass {workspace}: where AI priority puts this workspace ("2nd of 14"), and
    // the Overseer to ask about a note (its agent while it runs; none when off).
    const { byWorkspace } = freshPriorities(await priorityStore.read(), Date.now());
    const ranked = [...byWorkspace.values()].sort((a, b) => b.score - a.score);
    const at = ranked.findIndex(p => p.workspaceId === workspace);
    const p = at >= 0 ? ranked[at] : null;
    const o = await overseerStatus().catch(() => null);
    return { ...view, priority: p ? { rank: at + 1, of: ranked.length, reason: p.reason, source: p.sources[0] ? { kind: p.sources[0].kind, label: p.sources[0].label } : null } : null, overseer: o?.enabled && o.agentId ? o.agentId : null };
  });
  handle(rpc.compassFindRpc, async ({ kind, query }) => { await requireReady(); return compass!.find(kind, query); });
  handle(rpc.compassNoteRpc, async (input, context) => {
    await requireReady();
    const ids = new Set((await store.snapshot()).workspaces.filter(w => !w.archived).map(w => w.id));
    return compass!.note(input, actorBy(actorOf(context)), { workspaceExists: id => ids.has(id) });
  });
  handle(rpc.whySuggestedRpc, async input => { await requireReady(); return compass!.why(input); });
  handle(rpc.setCompassRpc, async (input, context) => {
    await requireReady();
    const { plan, inputs, queue, ...own } = input;
    if (Object.values(own).some(v => v !== undefined)) {
      const ids = new Set((await store.snapshot()).workspaces.map(w => w.id));
      await compass!.set(own, actorBy(actorOf(context)), { workspaceExists: id => ids.has(id) });
    }
    if (queue) await morningBrief!.setQueue(queue);
    if (inputs) await briefSources!.set(inputs);
    if (plan) {
      const before = await morningBrief!.planUrl();
      const view = await morningBrief!.setPlan(plan);
      if (view.url && view.url !== before) void ranker!.readPlan(view.url).then(() => feeds.home(), () => undefined);
    }
    return compassAll();
  });
  handle(rpc.readCompassRpc, async (_input, context) => { await requireReady(); const r = await compass!.readWithin(actorOf(context).kind === "agent" ? "agent" : "manual"); return { ...r, view: await compassAll() }; });
  handle(rpc.briefSourcesRpc, async ({ check }) => { await requireReady(); return briefSources!.view({ check }); });
  handle(rpc.setBriefSourcesRpc, async input => { await requireReady(); return briefSources!.set(input); });
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
  // Rename title with AI (server/rename.ts): stored data only, Summaries' model, Paseo's own workspace title.
  const renamer = new RenameService({
    store: new RenameStore(directory), jobs: aiJobs, role: () => agentSettings.role("about"),
    titles: renameDaemon(withDaemon as never, () => gateway.directory.markDirty()),
    room: async () => governor.allowsExtras() ? null : "The VM is short on memory right now. Try again in a few minutes.",
    inputs: async (workspaceId, current) => {
      const w = (await store.snapshot()).workspaces.find(x => x.id === workspaceId) ?? null;
      const rows = await gateway.directory.read().catch(() => null);
      const row = rows?.workspaces.find(x => x.id === workspaceId) as { gitRuntime?: { currentBranch?: string | null } | null } | undefined;
      if (!w && !row) return null;
      const summary = currentSummary((await aboutStore.read()).entries[workspaceId])?.gist ?? null;
      const links = (await linkedStore.read()).workspaces[workspaceId]?.items ?? [];
      // Agent titles from the cached list (no fetch_agent, no timeline): never wakes an agent.
      const agents = (rows?.agents ?? []).map(r => r.agent).filter(a => a.workspaceId === workspaceId && !a.archivedAt && a.title).map(a => a.title!);
      return { current, branch: row?.gitRuntime?.currentBranch ?? null, goal: w?.goal || null, summary, spec: w?.spec?.title ?? null,
        prs: (w?.prs ?? []).map(p => p.snapshot?.title ?? "").filter(Boolean), linked: links.map(l => ({ key: l.key, title: l.title })), agents: [...new Set(agents)] };
    },
  });
  handle(rpc.renameStatusRpc, async ({ workspaceId, suggest }) => { await requireReady(); return renamer.status(workspaceId, !!suggest); });
  handle(rpc.renameWorkspaceRpc, async ({ workspaceId, title, undo }, context) => {
    await requireReady();
    const out = await renamer.rename(workspaceId, { title, undo }, actorBy(actorOf(context)));
    // Home and the panel show the new name now, not after the next discovery pass.
    await store.mutate(state => { const w = state.workspaces.find(x => x.id === workspaceId); if (w) w.title = out.title; }).catch(() => undefined);
    return out;
  });
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
  // Local title recovery is independent of a panel/RPC response: one shared index, at most 4 MB for an unnamed backlog.
  let titleTimer: ReturnType<typeof setTimeout> | null = null;
  const titleLoop = async () => {
    await ready;
    if (stopped || loadError) return;
    if (governor.allowsBackground()) try {
      const state = await store.snapshot(), file = await linkedStore.read();
      await transcriptTitles.tick(state.workspaces, file.workspaces, async titles => {
        await linkedStore.mutate(file => { fillLinkedTitles(file, titles); });
        for (const w of (await store.snapshot()).workspaces) if (w.enable_tracking && workspaceNeedsTitles(w, titles)) await store.mutateWorkspace(w.id, current => { fillWorkspaceTitles(current, titles); });
      });
    } catch { /* a local miss never prevents following work */ }
    if (!stopped) titleTimer = setTimeout(() => void titleLoop(), 30_000);
  };
  titleTimer = setTimeout(() => void titleLoop(), 30_000);
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
  const agentActions = new AgentActions({ timeZone: () => clientTimeZone, autoSendsHeld: () => !governor.allowsBackground(), store, prActions: actions, engine, inbox, priorities: priorityStore, about, agentSettings, wait: { status: currentWait }, prWorkflows: () => prWorkflowView(), rpc: rpcBridge, display: displayBridge, report: { run: (caller, args) => reportKit.reporter.run(caller, args) }, agentTitle: async id => (await api?.agents.ref(id).refresh().catch(() => null))?.agent?.title ?? null,
    pins: {
      async read(workspaceId) {
        const w = await api?.workspaces.ref(workspaceId).refresh().catch(() => null) as { name?: string; title?: string | null; pinnedAt?: string | null } | null | undefined;
        return w && "pinnedAt" in w ? { title: w.title || w.name || workspaceId, pinnedAt: w.pinnedAt ?? null } : null;
      },
      async set(workspaceId, pinned) {
        const ref = api?.workspaces.ref(workspaceId) as { setPinned?: (p: boolean) => Promise<{ pinnedAt: string | null }> } | undefined;
        if (typeof ref?.setPinned !== "function") throw new Error("This Paseo can't pin workspaces.");
        return ref.setPinned(pinned);
      },
    },
    // The directory's agent list (metadata only): a claim never loads or refreshes the main agent.
    agentInfo: async agentId => { const row = gateway.directory.cached(agentId) ?? (await gateway.directory.read()).agents.find(r => r.agent.id === agentId)?.agent; return row ? { status: row.status, activeTurn: row.activeTurn, pendingPermissions: row.pendingPermissions, archivedAt: row.archivedAt } : null; } });
  // 0.15 polls priorities once a minute; the raised issues (Q8) ride the same answer instead of a read of their own.
  handle(rpc.prioritiesRpc, async () => { polledAt = Date.now(); return { items: await priorityStore.read(), queue: await nobodyOnIt(), compass: await compass?.lines().catch(() => undefined) }; });
  // The chat's created cards: the engine's directory snapshot as it stands (never waits on or asks the daemon, wakes
  // nothing) and the store. Before the engine's first read the cards just show no state yet.
  // The engine's snapshot as it stands, plus remembered archived agents; ids it lacks are looked up once, not awaited.
  handle(rpc.createdItemsRpc, async input => { gateway.directory.lookup(input.agentIds); return createdItems(input, gateway.directory.snapshotFor(input.agentIds), (await store.snapshot()).workspaces); });
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
    return { agents: sorted.map(({ last: _l, ...a }) => a), defaultId: sorted[0]?.id ?? null, newAgentWorkspace: here, newWorkspace: newWorkspaceTarget(rows, here?.id, await hostMultiplicity()) };
  });
  handle(rpc.reportSendRpc, async (input, { paseo }) => {
    seen(paseo);
    return sendReport({
      rows: () => gateway.directory.read().catch(() => null), multiplicity: hostMultiplicity, sendTo: async (agentId, prompt, messageId) => enqueueMessage(agentId, prompt, messageId, "developer"),
      agentTitle: async agentId => (await gateway.directory.read().catch(() => null))?.agents.find(r => r.agent.id === agentId)?.agent.title ?? null,
      provider: async () => ({ provider: await providerModel(paseo as unknown as OverseerPaseo, (await agentSettings.role("overseer").catch(() => null))?.provider?.split("/")[0] ?? "claude") }),
      paseo: paseo as unknown as ReportSendDeps["paseo"],
    }, input);
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
    void engine.nudge(agent.workspaceId);
    return result;
  });
  // Home, the sidebar badge and the pills poll this; an unchanged list answers in a few bytes (see inboxAnswer).
  handle(rpc.inboxListRpc, async ({ etag }) => { await requireReady(); const handedBack = noReviewRepoList().length ? (await store.snapshot()).workspaces.flatMap(w => w.prs.filter(handsMergeBack).map(p => p.key)) : [];
    return inboxAnswer({ ...await inbox.list(), error: inboxError, ...(handedBack.length ? { handedBack } : {}) }, etag); });
  handle(rpc.queueListRpc, async ({ workspaceId, agentId }) => {
    await requireReady();
    const { items, recent } = queue.list({ ...(workspaceId ? { key: workspaceId } : {}), ...(agentId ? { agentId } : {}) });
    return { items: items.map(queueView), recent: recent.map(queueView) };
  });
  // Retry or Cancel one item: the card's buttons, Needs you's message row and follow_queue_action run this.
  handle(rpc.queueActionRpc, async ({ itemId, action }) => {
    await requireReady();
    const item = action === "retry" ? await queue.retry(itemId) : await queue.cancel(itemId, "Cancelled; it won't be sent.");
    return { item: queueView(item) };
  });
  handle(rpc.inboxBriefRpc, async ({ agentId }) => { await requireReady(); return { brief: await inbox.brief(agentId) }; });
  handle(rpc.inboxActRpc, async (input, context) => {
    await requireReady();
    const out = await inbox.act(input, actorOf(context));
    // Signing an agent's row off also settles an answer the developer copied or put in its chat and Follow-up never
    // saw arrive (the marker edited away, or answered another way): an-answer-leaves-needs-you-only-when-delivered.
    if (input.action === "sign_off" || input.action === "mute_turn") for (const r of out.results.filter(r => r.ok)) {
      const w = agentTrackedWorkspace(await store.snapshot(), r.agentId);
      if (w?.questions.some(awaitingSend)) await store.mutateWorkspace(w.id, current => { signedOffAnswers(current.questions, q => answerRecipients(current, q), r.agentId, new Date().toISOString()); });
    }
    feeds.inbox();
    return out;
  });

  // Subscriptions (Paseo 0.16): every open client used to poll these reads (about 17 a minute for an idle Home); now
  // the worker pushes from state it already holds, one shared serve per topic (server/feeds.ts, invariant
  // idle-client-makes-at-most-one-rpc-a-minute). A 0.15 host serves no subscriptions, and its clients keep polling.
  const workspacesFeed = new WorkspacesFeed(listCache, () => store.snapshot(), () => waiting ?? loadError ?? hookError ?? writeHealth.message() ?? engine.error);
  const inboxFeed = new ValueFeed({ read: async () => { await requireReady(); return inboxAnswer({ ...await inbox.list(), error: inboxError }, undefined); }, key: v => v.etag ?? JSON.stringify(v) });
  let usageWatch: { close(): void } | null = null;
  // "Nobody's on it" (nobody-s-on-it-is-needs-you): the queue's raises and Compass's urgent asks, one row per issue,
  // from what the worker holds (linear-queue.json, compass.json): one count for every surface, never a read of its own.
  const nobodyOnIt = async () => {
    const q = await linearQueue?.needs().catch(() => undefined);
    const list = compass ? await compass.suggestions(q?.issues).catch(() => []) : [];
    if (!q && !list.length) return undefined;
    const heard = compass ? heardWords(await compass.since(q?.since ?? null, list).catch(() => ({ from: [], lines: [], heard: 0 }))) : null;
    return { needs: nobodyNeeds(q?.raised ?? [], list), timeZone: q?.timeZone ?? (await briefClock()).timeZone, heard,
      revision: `${q?.revision ?? ""}|${list.map(x => `${x.note}${x.urgent ? "!" : ""}`).join(",")}` };
  };
  // New's dispatches for Home's row: the last hour's (the client drops what its clock says is over), at most 5.
  const homeDispatches = async () => (await dispatcher.records().catch(() => [])).filter(r => Date.now() - Date.parse(r.at) < 3_600_000).slice(0, 5);
  const homeFeed = new ValueFeed({
    read: async () => {
      await requireReady();
      const [items, rank, overseerView] = await Promise.all([priorityStore.read(), ranker!.status(), overseerStatus()]);
      // The worker's live resources change every tick: the client reads those once when Home opens (follow.usage).
      const meters = governor.allowsExtras() ? await usage.read() : NO_USAGE;
      return { priorities: items, rank, overseer: overseerView, usage: { available: meters.available, source: meters.source, accounts: meters.accounts }, usageLive: !!usageWatch, context: await contextRequests.list(), prStats: await prStats.anyOn(), dispatches: await homeDispatches(), queue: await nobodyOnIt(), compass: await compass?.lines().catch(() => undefined) };
    },
    key: v => JSON.stringify([v.priorities, v.rank, v.overseer, usageKey(v.usage), v.usageLive, v.context, v.prStats, v.dispatches, v.queue, v.compass]),
    // Smart Session's files are watched only while someone looks at Home (server/usage.ts watch()).
    onFirst: () => { usageWatch = usage.watch(() => void homeFeed.changed()); },
    onLast: () => { usageWatch?.close(); usageWatch = null; },
  });
  const displayFeed = new ValueFeed({ read: () => displaySettings.read() });
  feeds.workspaces = () => void workspacesFeed.changed();
  feeds.readsNow = () => void workspacesFeed.changed({ readsNow: true });
  feeds.inbox = () => void inboxFeed.changed();
  feeds.home = () => void homeFeed.changed();
  // The daytime read runs only while an app client is open (the-brief-has-one-timer): a subscriber on the home feed,
  // or on Paseo 0.15 (no subscriptions) a priorities poll in the last 2 minutes.
  appOpen = () => homeFeed.size > 0 || Date.now() - polledAt < COMPASS.openWindowMs;
  priorityStore.onWrite = feeds.home;
  ranker!.onRunChange = feeds.home;
  let displayOff: (() => void) | null = null;
  try { if (typeof (displaySettings as { subscribe?: unknown }).subscribe === "function") displayOff = displaySettings.subscribe(() => void displayFeed.changed()); } catch { /* 0.15: polled */ }
  // Straight to the host, never into `handlers` (see handle above). The handler returns at once: a returned promise
  // would close the subscription when it settles.
  const serve = <I extends ZodType, E extends ZodType>(contract: PluginSubscriptionContract<I, E>, run: (input: zOutput<I>, push: (event: unknown) => Promise<void>, signal: AbortSignal) => void) => {
    try { server.handle(contract, (input, context) => { run(input, context.push as (event: unknown) => Promise<void>, context.signal); }); } catch { /* A 0.15 host: no subscriptions. */ }
  };
  serve(rpc.workspacesFeed, (input, push, signal) => workspacesFeed.serve(input.since, push, signal));
  serve(rpc.inboxFeed, (_input, push, signal) => inboxFeed.serve(push, signal));
  serve(rpc.homeFeed, (_input, push, signal) => homeFeed.serve(push, signal));
  serve(rpc.displayFeed, (_input, push, signal) => displayFeed.serve(push, signal));
  // The PR stats page (docs/pr-stats.md): one feed per repository on screen. While a subscriber is open the repository
  // syncs every 5 minutes instead of hourly; a run's end or a settings write pushes its status, and the page re-reads.
  const statsFeeds = new Map<string, ValueFeed<Awaited<ReturnType<typeof prStats.feedState>>>>();
  prStats.onChange = repo => {
    if (repo === null) { for (const feed of statsFeeds.values()) void feed.changed(); } else void statsFeeds.get(repo)?.changed();
    feeds.home();
  };
  serve(rpc.prStatsFeed, (input, push, signal) => {
    const repo = input.repo;
    let feed = statsFeeds.get(repo);
    if (!feed) {
      let release: (() => void) | null = null;
      const made = new ValueFeed({ read: async () => { await requireReady(); return prStats.feedState(repo); },
        onFirst: () => { release = prStats.watching(repo); }, onLast: () => { release?.(); release = null; if (statsFeeds.get(repo) === made) statsFeeds.delete(repo); } });
      statsFeeds.set(repo, feed = made);
    }
    feed.serve(push, signal);
  });
  handle(rpc.needsYouRpc, async ({ agentId, ...input }, { paseo }) => {
    await requireReady(); seen(paseo);
    if (!(await inboxSettings()).enable_inbox) throw new Error("The Needs-you inbox is off, so there's no brief to fill. Finish with your normal reply.");
    if (!/^[\w-]+$/.test(agentId)) throw new Error("Unsupported agent identity.");
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId) throw new Error("Cannot locate the caller's workspace.");
    // Invariant 111: the main agent's ask from a workspace Follow-up read as archived reopens it when Paseo shows it
    // live; where Paseo still has it archived, the ask still reaches Needs you and the reply says so.
    const followed = !isRecovery(agent.labels) && await reopenForCaller(agent);
    const saved = await store.snapshot();
    const tracked = saved.workspaces.find(w => w.id === agent.workspaceId && w.enable_tracking && !w.archived);
    const stillArchived = !followed && saved.workspaces.some(w => w.id === agent.workspaceId && w.enable_tracking && w.archived && w.mainAgentId === agentId);
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
    let questionIds: string[] = []; let createdIds: string[] = []; let dismissed: string[] = [];
    if (tracked) {
      const mode = await questionMode();
      const linked = await store.mutate(state => {
        const w = findWorkspace(state, tracked.id);
        const result = needsYouQuestions(w, agentId, call, mode, Date.now(), sameTurn ? previous : null, turn?.at ?? null);
        if (result.createdIds.length) syncTaskQuestions(w, Date.now());
        if (result.questionIds.length || sameTurn) changed(w);
        return { ...result, ask: foldedAsk(call.ask, result.questionIds, w.questions) };
      });
      questionIds = linked.questionIds; createdIds = linked.createdIds; dismissed = linked.dismissed;
      // one-ask-one-title: a brief that folds into its question is named by the question everywhere.
      call = { ...call, ask: linked.ask };
      // The brief maps decisions to questions by position, so the record keeps them aligned (a linked question shows as itself).
      const { questions: _refs, ...rest } = call;
      call = { ...rest, ...(linked.decisions.length ? { decisions: linked.decisions } : {}) };
      if (!linked.decisions.length) delete call.decisions;
    } else if (call.questions?.length) throw new Error(stillArchived ? "questions point at a tracked workspace's open questions, and Paseo has this workspace archived. Leave questions out and state the ask in ask and decisions; ask the developer to unarchive the workspace." : "questions point at a tracked workspace's open questions, and this workspace isn't tracked.");
    // dismissing-anything-in-needs-you-sends-the-agent-nothing: an ask the developer dismissed, stated again with nothing
    // new to decide, isn't flagged again: the turn ends quiet, and the call says why.
    const gone = await inbox.dismissedAsk(agentId);
    const restated = !!gone && !questionIds.length && !call.decisions?.length && sameAsk(gone.ask, call.ask);
    if (restated) call = { ...call, kind: "done" };
    const record: NeedsYouRecord = { at: Date.now(), turnId: turn?.turnId ?? null, call, questionIds, createdIds };
    await mkdir(join(directory, "hook-state"), { recursive: true, mode: 0o700 });
    const temporary = `${needsYouPath(agentId)}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, needsYouPath(agentId));
    // The caller is running, so its Needs-you row is live: an archived (gone) row would hide the brief this turn makes.
    if (!restated && call.kind !== "done") { await inbox.reopen(agentId).catch(() => false); feeds.inbox(); }
    return { ok: true as const, briefId: `brief:${turn?.turnId ?? record.at}`,
      ...(restated ? { note: DISMISSED_ASK_NOTE }
        : stillArchived && call.kind !== "done" ? { note: ARCHIVED_NEEDS_YOU_NOTE }
        : dismissed.length ? { note: `The developer dismissed ${dismissed.join(", ")}: ${dismissed.length === 1 ? "it no longer matters, so it was" : "they no longer matter, so they were"} left off the card. Don't raise ${dismissed.length === 1 ? "it" : "them"} again.` } : {}) };
  });
  // Replies once the answer is recorded; the send runs after (Inbox.briefAction), so a dormant agent's slow resume never
  // times the card out.
  handle(rpc.briefActionRpc, async ({ agentId, briefId, decisionId, choice, words, choices, move, answerId, images }, context) => {
    const { paseo } = context;
    await requireReady(); seen(paseo);
    const brief = await withImages(move ? undefined : images, refs => inbox.briefAction(agentId, { briefId, decisionId, choice, words, choices, move, answerId, images: refs }, actorOf(context)));
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
    // GitHub is optional (works-without-github): the setup's own check, then the signed-in login over the same
    // in-process client every read uses. Check again re-checks, so a gh installed meanwhile is picked up.
    gh: async (): Promise<GhResult> => {
      const state = await githubSetup().check();
      if (!state.on) return { error: state.off, message: "" };
      const user = await githubApi().restAs(null, "user") as { login?: unknown } | null;
      return { login: typeof user?.login === "string" ? user.login : "" };
    },
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
  // Paseo 0.17 (features.checkoutWorktreeList marks 0.17.0+, the first host whose session-open result takes
  // appendSystemPrompt; 0.16's schema is strict and refuses it): the static session text goes in the system prompt
  // and the hook leaves it out (server/session-prompt.ts). Codex takes it from 0.121.
  const hostPrompt = hostFeature("checkoutWorktreeList", () => withDaemon(async client => (client as ServerInfoClient).getLastServerInfoMessage?.()));
  let codexPrompt: Promise<boolean> | null = null;
  const promptDeps: PromptDeps = {
    acp: async provider => isAcp(provider, await paseoConfig() as Parameters<typeof isAcp>[1]),
    hostSupports: hostPrompt,
    providerSupports: async provider => provider === "claude" || provider === "codex" && await (codexPrompt ??= codexVersion().then(v => atLeast(v, CODEX_PROMPT_MIN))),
    bridge: async () => agentText as BridgeTexts,
    // A provider without Follow-up's hook gets the tracked workspace's instructions in its system prompt: the text the
    // hook adds (shared/agent-text.mjs workspaceText), for this agent's role in the store as it is now.
    workspace: async (agentId, native) => {
      const entry = scopes(await store.snapshot(), w => prWorkflow.agentWorkflow(workspaceRepo(w), touchedRepos(w)))[agentId];
      if (!entry || entry.role === "recovery") return null;
      return agentText.workspaceText({ contributor: entry.role === "contributor", workflow: entry.workflow, native, clientEntry: clientEntry(), bridge: join(directory, "mcp.mjs") });
    },
    record: async (agentId, hash) => {
      if (/^[\w-]+$/.test(agentId)) await writeFile(join(directory, promptRecordPath(agentId)), JSON.stringify({ hash, at: Date.now() } satisfies PromptRecord), { mode: 0o600 });
    },
  };
  // A workspace text that changed since the session's system prompt leads the agent's next Follow-up tool result, once.
  changedLead = async agentId => {
    const text = await changedInstructions(agentId, {
      recorded: async id => /^[\w-]+$/.test(id) ? JSON.parse(await readFile(join(directory, promptRecordPath(id)), "utf8")) as PromptRecord : null,
      workspace: promptDeps.workspace!, record: promptDeps.record!,
    });
    return text ? `${CHANGED_INSTRUCTIONS_HEADER}\n\n${text}` : null;
  };
  const withWait = (handler: SessionOpen): SessionOpen => async (input, context) => {
    const background = await isBackground(input.request.agentId, context.paseo);
    const opened = await wait.open((await handler(input, context)) ?? input.request, { background });
    return withSystemPrompt(opened, promptDeps, { background });
  };
  const removers = [
    server.on("agent.permission_requested", async (event, { paseo }) => { trustApi = paseo; await trust.handle(event.agent, event.request as never).catch(() => undefined); }),
    displaySettings.subscribe(() => void writeBriefState().catch(() => undefined)),
    // The shared directory learns from events instead of polling Paseo (see DaemonDirectory). Registered first so the
    // handlers below read the patched rows.
    server.on("agent.turn_started", async event => gateway.directory.turnStarted(event.agent, event.turnId)),
    server.on("agent.turn_started", async event => turnEnd.turnStarted(event.agent.id)),
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
    // a-derived-view-is-built-when-read: the Overseer's digest, built for the turn its prompt hook is about to read.
    server.on("agent.turn_started", async event => { await ready; if (stopped || loadError || !overseer) return; await overseer.turnStarted(event.agent.id).catch(() => undefined); }),
    // A newer main-agent turn supersedes the failed turn's automatic hold (shared/status.ts holdSuperseded).
    // A turn writes only the workspace it is about (server/turn-events.ts, a-send-never-clones-the-whole-state): a
    // superseded hold lifts, the owned workspace's Done ends, the main agent's archived workspace reopens (invariant
    // 111), and a dormant workspace becomes active again.
    server.on("agent.turn_started", async event => {
      if (event.turnId) startedTurns.set(event.agent.id, event.turnId);
      await ready;
      if (stopped || loadError) return;
      const { lifted, owned, woken, reopened } = await turnStarted(store, event.agent, event.turnId ?? null);
      if (owned) gateway.markDirty(event.agent.id);
      for (const id of new Set([...lifted, ...(woken ? [woken] : []), ...(reopened ? [reopened] : [])])) void engine.nudge(id);
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
    // Follow-up's own tools first, then Wait's on top (every interactive Claude session, tracked or not).
    server.before("agent.session_open", withWait(async ({ request }, { paseo }) => {
      await ready;
      if (loadError || stopped || request.purpose !== "interactive") return request;
      // A background agent gets no Follow-up treatment, except Follow-up's own recovery agent: exempt by Follow-up's
      // record (a recovery batch names it as recipient), never by labels, which any plugin can write. Without this, a
      // background recovery agent loses its tools on its second session (resume, reload, plugin update).
      if (await isBackground(request.agentId, paseo) && !recordedRecoveryAgent(await store.snapshot(), request.agentId)) return request;
      // The Overseer: needs_you (no Stop-hook nudge), the action tools and its routing tools. Never tracked.
      if (request.labels[OVERSEER_LABEL] === "1") {
        const env = { ...request.env, FOLLOW_UP_OVERSEER: "1", FOLLOW_UP_BRIEF: request.provider };
        return withTools({ ...request, env }, false, request.provider, true, true);
      }
      const saved = await store.snapshot();
      let w = saved.workspaces.find(w => w.enable_tracking && !w.archived && (w.mainAgentId === request.agentId || w.batches.some(b => b.recipientAgentId === request.agentId && !b.settledAt && b.tasks.every(t => t.kind === "inventory") && ["sending", "sent", "uncertain", "blocked"].includes(b.state))));
      if (!w && request.workspaceId && !saved.workspaces.some(w => w.id === request.workspaceId && (w.archived || w.mainAgentId !== request.agentId))) {
        const project = await gateway.projectForWorkspace(saved, request.workspaceId).catch(() => null);
        if (project?.enable_default_tracking && !optedOut(saved, request.workspaceId)) {
          // an-agent-s-first-session-gets-its-tools: Paseo doesn't list this agent until its first session is open, so
          // discovery counts it from the request. A first session then gets what any later one would.
          const opening = { id: request.agentId, workspaceId: request.workspaceId, provider: request.provider, cwd: request.cwd, title: request.title, labels: request.labels };
          const rows = await gateway.discover(saved, request.workspaceId, undefined, opening).catch(() => []);
          await store.mutate(state => applyDiscovery(state, rows.filter(row => followsByDefault(state, row)), Date.now()));
          w = (await store.snapshot()).workspaces.find(w => w.enable_tracking && w.mainAgentId === request.agentId);
        }
      }
      const root = !!request.workspaceId && !isRecovery(request.labels) && await isWorkspaceRoot({ id: request.agentId, workspaceId: request.workspaceId, labels: request.labels }, async id => (await paseo.agents.ref(id).refresh())?.agent);
      // F2: needs_you and the Stop-hook nudge reach every root agent while the inbox is on, tracked or not.
      const brief = (await inboxSettings()).enable_inbox ? request.provider : null;
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
        if (["canceled", "failed"].includes(event.outcome.kind) && !guarded) await store.mutateWorkspace(assigned.id, w => { const b = w.batches.find(b => b.recipientAgentId === event.agent.id && ["sending", "sent", "uncertain"].includes(b.state)); if (b) { b.state = "blocked"; b.result = b.acknowledgmentError ? `Recovery acknowledgment was refused: ${b.acknowledgmentError.error}` : "Recovery stopped or failed. Check its agent before retrying."; } });
        void engine.nudge(assigned.id); await contextRequests.turnEnded(event.agent.id, null); return;
      }
      if (!agentTrackedWorkspace(await store.snapshot(), event.agent.id)) { await contextRequests.turnEnded(event.agent.id, null); return; }
      // Since Paseo 0.13 the lifecycle payload deliberately contains no history.
      // Read the ended turn through the plugin-owned API, outside the state lock: one read from the agent's cursor,
      // shared with the inbox's handler and with discovery, which the read is kept for (a-turn-s-timeline-is-read-once).
      const items = await inboxDirectory.turnItems!(event.agent.id, event.turnId ?? null).catch(() => null);
      gateway.markDirty(event.agent.id);
      if (signal.aborted || stopped) return;
      const guarded = !!interruption && await sessionGuardOwnsInterruption(event.agent.id, interruption).catch(() => false);
      // Only the developer's Stop holds (shared/status.ts cancelCause): a turn already replaced by a newer one (the
      // developer's or another agent's message), a /compact, or a closed or reloaded session never does.
      const started = startedTurns.get(event.agent.id);
      const newerTurn = !!started && started !== event.turnId;
      // Smart Session's own record of a /compact it just delivered: the canceled turn was that compaction.
      const compaction = event.outcome.kind === "canceled" && await compactionJustDelivered(event.agent.id, Date.parse(interruption!.at)).catch(() => false);
      const nudged = await turnEnded(store, event.agent.id, event.outcome, event.turnId ?? null, items, { interruption, guarded, newerTurn, compaction });
      if (nudged) void engine.nudge(nudged);
      // A provider without the hook: the Stop hook's checks, from this same read (an-agent-on-any-provider-gets-follow-up).
      await turnEnd.turnEnded(event.agent, event.outcome, event.turnId ?? null, items).catch(() => undefined);
      // Your questions' turn-end capture, from this same read (any provider): an ask this turn answered without
      // context_reply takes the agent's last message after it as its answer (null items: "answered in its chat").
      await contextRequests.turnEnded(event.agent.id, items).catch(() => undefined);
    }),
    server.on("workspace.archived", async event => { await ready; if (!loadError && !stopped) await store.mutate(state => { const w = state.workspaces.find(w => w.id === event.workspace.id); if (w) w.archived = true; }); }),
  ];
  // a-new-worker-starts-once-the-old-one-exits, the old side: when Paseo's process goes away without stopping this one
  // (2026-11-16: the daemon worker exited at its own 10 s force-exit, before it stopped any plugin, and its tree kill
  // missed the orphaned plugin processes), the IPC channel closes. Stop within the deadline and exit, so the lock frees
  // and the next worker starts. A normal stop removes the listener first.
  const hostGone = () => { void stop().finally(() => process.exit(0)); };
  if (process.connected) process.once("disconnect", hostGone);
  let stopping: Promise<void> | null = null;
  const stop = () => stopping ??= (async () => {
    process.off("disconnect", hostGone);
    restoreConsole();
    gateway.directory.onAgentsChanged = () => {};
    stopped = true; wait.close(); updater.stop(); pluginMove.stop(); governor.stop(); if (timer) clearTimeout(timer); if (aboutTimer) clearTimeout(aboutTimer); if (linkedTimer) clearTimeout(linkedTimer); if (titleTimer) clearTimeout(titleTimer); aiJobs.stop(); dispatcher.stop(); ranker = null; if (inboxTimer) clearTimeout(inboxTimer); inbox.stop(); queue.stop(); rpcTiming.stop(); if (hookTimer) clearInterval(hookTimer); if (dueTimer) clearInterval(dueTimer); memoryWatch?.stop(); displayOff?.(); usageWatch?.close(); removers.forEach(remove => remove());
    // One deadline for every wait (worker-stop-never-waits-on-a-stuck-pass, server/teardown.ts): start-up and the work
    // in flight may be stuck on a daemon or CLI that never answers. Work that ends inside the deadline is saved; what
    // outlives it can't write, because the store closes before the lock is released.
    await stopWorker({ files: [contextRequests, checkWatches, reviewerStore, agentSettings, prWorkflow, queue, prStats], ready, hooks: hooksStarted ? () => agentHooks.stop() : undefined, actions, closeConnections, engine, store, inbox: inbox.store, unlock });
  })();
  return stop;
}
