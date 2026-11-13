import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InboxRow } from "../shared/inbox";
import type { State } from "../shared/model";
import type { Priority } from "../shared/priorities";
import type { Brief } from "../shared/brief";
import { flagHeadline } from "../shared/headline";
import { tailSteps, HOME_GROUPS, type PaseoWorkspaceLite, type TailStep } from "../shared/home";
import { isOpen as questionOpen } from "../shared/questions";
import { classify, latestPrompt, ledgerSender, type Sources } from "./inbox-classifier";
import {
  EMPTY_OVERSEER, OVERSEER_LABEL, OVERSEER_TITLE, approvesNewWorkspace, branchFor, digestFile, forwardText, forwardedSender, linearKeys,
  overseerStateSchema, pageRows, routeDecision, scoreCandidates, workspaceTitleFor, workstreams, type OverseerState, type WorkstreamRow,
} from "../shared/overseer";
import { overseerPrompt } from "./overseer-prompt-source";
import { isLoaded, type LoadSignals } from "../shared/agent-load";
import { conversationGone } from "./agent-load";
import { transcriptTail } from "./transcript";
import { modelName } from "../shared/agent-settings";

type AgentSnapshot = LoadSignals & { id: string; workspaceId?: string | null; archivedAt?: string | null; title?: string | null; labels?: Record<string, string> };
/** The slice of the plugin's Paseo API the Overseer uses. Typed loosely so tests can pass a fake. */
export type OverseerPaseo = {
  workspaces: {
    create(options: Record<string, unknown>): Promise<{ id: string; agents: { create(options: Record<string, unknown>): Promise<{ id: string }> } }>;
    ref(id: string): { refresh(): Promise<{ archivedAt?: string | null; archivingAt?: string | null } | null> };
  };
  agents: {
    ref(id: string): {
      refresh(): Promise<{ agent: AgentSnapshot } | null>;
      send(text: string, options?: Record<string, unknown>): Promise<void>;
      timeline: { refetch(options: Record<string, unknown>): Promise<{ entries: { seqStart: number; item: unknown }[] }> };
    };
  };
  projects?: { list(): Promise<unknown> };
  providers?: { listModels(provider: string): Promise<unknown> };
};

export type OverseerDeps = {
  directory: string;
  store: { snapshot(): Promise<State> };
  inbox: { list(): Promise<{ rows: InboxRow[] }>; brief(agentId: string): Promise<Brief | null>; noteDelivery(agentId: string, messageId: string | null, by?: "developer"): Promise<void> };
  priorities: { read(): Promise<Priority[]> };
  /** Who sent a message (the inbox's ledger and other plugins' files): the new-workspace gate reads the same sources as Needs-you. */
  sources?: Sources;
  /** Paseo's workspace descriptors (name, project, branch): metadata only, cached. `fresh` for tool calls. */
  workspaces(fresh?: boolean): Promise<(PaseoWorkspaceLite & { projectId?: string | null })[]>;
  /** Where agent records live, for reading an unloaded agent's transcript from disk. */
  paseoHome?: string;
  /** Background work waits while this is true: the resource governor's verdict (server/governor.ts). */
  tight?: () => Promise<boolean>;
  /** The active window, for workspaces Follow-up doesn't track. */
  windowMs?: () => Promise<number>;
  enabled(): Promise<boolean>;
  /** The "overseer" role from Settings → Agents. Default: Claude, newest Opus, bypass. */
  agent?: () => Promise<OverseerAgentSetting>;
  /** Harness override ("provider/model", from FOLLOW_UP_OVERSEER_PROVIDER): wins over the setting. */
  provider?: string;
  /** Re-rank Home's Priority sort now (the ranker); Tom asked the Overseer for it. */
  rerank?: () => Promise<unknown>;
  now?: () => number;
};

export const OVERSEER_TOOLS = ["workstreams", "agent_digest", "route_candidates", "send_to_agent", "start_workspace", "rerank"] as const;
export type OverseerTool = typeof OVERSEER_TOOLS[number];
const id = z.string().trim().min(1).max(200);
export const OVERSEER_INPUT: Record<OverseerTool, z.ZodType> = {
  workstreams: z.strictObject({ page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(100).optional(), group: z.enum(HOME_GROUPS).optional(), query: z.string().trim().max(200).optional() }),
  agent_digest: z.strictObject({ agentId: id, steps: z.number().int().min(1).max(30).optional() }),
  route_candidates: z.strictObject({ ask: z.string().trim().min(1).max(4000) }),
  send_to_agent: z.strictObject({ agentId: id, text: z.string().trim().min(1).max(20_000), reply_to_ask: z.boolean().optional() }),
  rerank: z.strictObject({}),
  start_workspace: z.strictObject({ task: z.string().trim().min(1).max(20_000).optional(), title: z.string().trim().min(1).max(80).optional(), project: id.optional(), linear_key: z.string().trim().max(30).optional(), base: z.string().trim().max(200).optional(), planId: id.optional(), confirm: z.boolean().optional() }),
};

const ENSURE_EVERY_MS = 10 * 60_000;
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * The Overseer's lifecycle and tools. One long-lived Claude agent in a Follow-up-managed workspace, created on the
 * developer's first click, recreated with a handoff summary if it is archived. State lives in overseer.json.
 */
export class Overseer {
  private plans = new Map<string, { expiresAt: number; run: () => Promise<unknown> }>();
  private starting: Promise<OverseerState> | null = null;
  private written: string | null = null;
  private checkedAt = 0;
  constructor(private d: OverseerDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private get path() { return join(this.d.directory, "overseer.json"); }
  get digestPath() { return join(this.d.directory, "overseer-digest.json"); }

  async state(): Promise<OverseerState> {
    try { return overseerStateSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); } catch { return { ...EMPTY_OVERSEER }; }
  }
  private async save(state: OverseerState) { await atomic(this.path, state); }

  /** First start (the developer's one-time click) or a recreation with a handoff summary. Idempotent while alive. */
  start(paseo: OverseerPaseo, handoff: string | null = null, why = "which was archived or stopped"): Promise<OverseerState> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!await this.d.enabled()) throw new Error("The Overseer is off. Turn it on in Follow-up settings.");
      const current = await this.state();
      if (current.agentId && !handoff && await this.alive(paseo, current)) return current;
      const home = join(this.d.directory, "overseer-home");
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(join(home, "README.md"), "Follow-up's Overseer works here. It routes your asks to the agents that own them.\n").catch(() => undefined);
      const workspace = await paseo.workspaces.create({ title: OVERSEER_TITLE, source: { kind: "directory", path: home } });
      const chosen = await this.chosen(paseo);
      const agent = await workspace.agents.create({
        config: { provider: chosen.provider, ...(chosen.mode ? { modeId: chosen.mode } : {}), ...(chosen.thinking ? { thinkingOptionId: chosen.thinking } : {}), systemPrompt: overseerPrompt },
        title: OVERSEER_TITLE, labels: { [OVERSEER_LABEL]: "1" },
        ...(handoff ? { prompt: `Handoff from the previous Overseer, ${why}. Its last steps:\n${handoff}\n\nNothing to do until the developer writes. Reply "Ready." only.` } : {}),
      });
      const next: OverseerState = { version: 1, agentId: agent.id, workspaceId: workspace.id, startedAt: new Date(this.now()).toISOString(), generation: current.generation + 1, error: null,
        agent: { key: chosen.key, provider: chosen.provider.split("/")[0], model: chosen.provider.split("/").slice(1).join("/"), thinking: chosen.thinking, mode: chosen.mode } };
      await this.save(next);
      await this.writeDigest().catch(() => undefined);
      return next;
    })().catch(async error => {
      const s = await this.state();
      if (s.agentId) await this.save({ ...s, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  /**
   * The developer's words from the omnibox: start the Overseer if this is the first use (asking is the click), bring
   * it back if it was archived, then send the text unchanged. Sending may load the Overseer; that's the ask.
   */
  async ask(paseo: OverseerPaseo, text: string): Promise<OverseerState> {
    const ask = text.trim();
    if (!ask) throw new Error("Type what you want the Overseer to do.");
    if (!await this.d.enabled()) throw new Error("The Overseer is off. Turn it on in Follow-up settings.");
    let s = await this.state();
    if (!s.agentId) s = await this.start(paseo);
    else if (!await this.alive(paseo, s)) { await this.ensure(paseo); s = await this.state(); }
    await paseo.agents.ref(s.agentId!).send(ask);
    return s;
  }

  /** The configured agent as Paseo's "provider/model", its mode and effort, and the setting key it came from. */
  private async chosen(paseo: OverseerPaseo): Promise<{ provider: string; mode: string | null; thinking: string | null; key: string }> {
    if (this.d.provider) return { provider: this.d.provider, mode: this.d.provider.startsWith("claude") ? "bypassPermissions" : null, thinking: null, key: `env:${this.d.provider}` };
    const s = await this.setting();
    const provider = s.model ? `${s.provider}/${s.model}` : s.provider === "claude" ? await providerModel(paseo, "claude", /opus/i) : await providerModel(paseo, s.provider);
    return { provider, mode: s.mode, thinking: s.thinking, key: settingKey(s) };
  }
  private async setting(): Promise<OverseerAgentSetting> {
    return (await this.d.agent?.().catch(() => null)) ?? DEFAULT_OVERSEER_AGENT;
  }

  /**
   * What the Overseer runs on now and, when Settings → Agents changed since it was created, what a restart would use.
   * Cheap (no Paseo calls): read on every status poll.
   */
  async agentInfo(): Promise<{ running: { provider: string; model: string } | null; configured: OverseerAgentSetting; restart: boolean }> {
    const [s, configured] = await Promise.all([this.state(), this.setting()]);
    if (!s.agentId) return { running: null, configured, restart: false };
    const running = s.agent ? { provider: s.agent.provider, model: s.agent.model } : { provider: "claude", model: "" };
    const key = this.d.provider ? `env:${this.d.provider}` : settingKey(configured);
    return { running, configured, restart: (s.agent?.key ?? settingKey(DEFAULT_OVERSEER_AGENT)) !== key };
  }

  /**
   * The developer's "Restart the Overseer with …": a new Overseer on the configured agent, handed the old one's last
   * steps the same way a recreation is (never a timeline read of an unloaded agent). The old agent is left as it is.
   */
  async restart(paseo: OverseerPaseo): Promise<OverseerState> {
    const s = await this.state();
    if (!s.agentId) return this.start(paseo);
    const read = await this.steps(paseo, s.agentId, 12).catch(() => null);
    const configured = await this.setting();
    return this.start(paseo, handoffSummary(read?.steps ?? []), `which the developer replaced to run on ${configured.model ? modelName(configured.model) : configured.provider}`);
  }

  private async alive(paseo: OverseerPaseo, s: OverseerState): Promise<boolean> {
    if (!s.agentId) return false;
    const agent = (await paseo.agents.ref(s.agentId).refresh().catch(() => null))?.agent;
    if (!agent || agent.archivedAt) return false;
    if (s.workspaceId) {
      const w = await paseo.workspaces.ref(s.workspaceId).refresh().catch(() => undefined);
      if (w === null || w?.archivedAt || w?.archivingAt) return false;
    }
    return true;
  }

  /** Recreate the Overseer when its agent or workspace was archived. Never on a plain close: Paseo reopens it on send. */
  async ensure(paseo: OverseerPaseo, { periodic = false } = {}): Promise<"absent" | "alive" | "recreated" | "off" | "later"> {
    // The archive events recreate it at once; the periodic check is only a backstop, every 10 minutes.
    if (periodic) { if (this.now() - this.checkedAt < ENSURE_EVERY_MS) return "later"; this.checkedAt = this.now(); }
    const s = await this.state();
    if (!s.agentId) return "absent";
    if (!await this.d.enabled()) return "off";
    if (await this.alive(paseo, s)) return "alive";
    const read = await this.steps(paseo, s.agentId, 12).catch(() => null);
    await this.start(paseo, handoffSummary(read?.steps ?? []));
    return "recreated";
  }

  /**
   * An agent's last steps without ever waking it: its timeline only while it is loaded, otherwise its provider
   * transcript on disk. Null when neither is readable.
   */
  private async steps(paseo: OverseerPaseo, agentId: string, n: number, snapshot?: AgentSnapshot | null): Promise<{ steps: ReturnType<typeof tailSteps>; source: "timeline" | "transcript" } | null> {
    const agent = snapshot !== undefined ? snapshot : (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent ?? null;
    if (agent && !agent.archivedAt && isLoaded(agent)) {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: Math.max(40, n * 4), projection: "canonical" });
      const items = [...page.entries].sort((a, b) => a.seqStart - b.seqStart).map(e => e.item);
      return { steps: tailSteps(items as Parameters<typeof tailSteps>[0], n), source: "timeline" };
    }
    if (!this.d.paseoHome) return null;
    const steps = await transcriptTail(this.d.paseoHome, agentId, n);
    return steps ? { steps, source: "transcript" } : null;
  }

  async workstreams(fresh = false): Promise<WorkstreamRow[]> {
    const [state, inbox, paseo, priorities, me, windowMs] = await Promise.all([this.d.store.snapshot(), this.d.inbox.list(), this.d.workspaces(fresh), this.d.priorities.read(), this.state(), this.d.windowMs?.()]);
    const autoSendsHeld = !!await this.d.tight?.();
    return workstreams({ rows: inbox.rows, tracked: state.workspaces.filter(w => w.enable_tracking), paseo, priorities, now: this.now(), windowMs, autoSendsHeld, exclude: { agentId: me.agentId, workspaceId: me.workspaceId } });
  }

  /**
   * The file the agent hook reads at the start of every Overseer turn, from metadata and Follow-up's state only.
   * Checked on the inbox tick, rewritten only when its content hash moves, and skipped while the resource governor pauses background work.
   */
  async writeDigest(): Promise<"written" | "same" | "skipped"> {
    const s = await this.state();
    if (!s.agentId || !await this.d.enabled()) return "skipped";
    if (await this.d.tight?.()) return "skipped";
    if (this.written === null) this.written = await readFile(this.digestPath, "utf8").then(t => JSON.parse(t)?.hash ?? "", () => "");
    const file = digestFile(s.agentId, await this.workstreams(), this.now());
    if (file.hash === this.written) return "same";
    await atomic(this.digestPath, file);
    this.written = file.hash;
    return "written";
  }

  /** One Overseer tool call. The caller must be the current Overseer agent. */
  async act(paseo: OverseerPaseo, caller: string, tool: OverseerTool, raw: unknown): Promise<unknown> {
    const s = await this.state();
    if (!s.agentId || caller !== s.agentId) throw new Error("These tools are for Follow-up's Overseer only.");
    if (!(OVERSEER_TOOLS as readonly string[]).includes(tool)) throw new Error(`Unknown Overseer tool ${tool}.`);
    const parsed = OVERSEER_INPUT[tool].safeParse(raw ?? {});
    if (!parsed.success) throw new Error(`${tool}: ${parsed.error.issues.map(i => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ")}`);
    const args = parsed.data as Record<string, any>;
    switch (tool) {
      case "workstreams": return pageRows(await this.workstreams(true), args);
      case "agent_digest": return this.agentDigest(paseo, args.agentId, args.steps ?? 10);
      case "route_candidates": {
        const { confident, top } = routeDecision(scoreCandidates(args.ask, await this.workstreams(true), this.now()));
        return { confident, candidates: top, next: confident ? `Send it with send_to_agent to ${top[0].agentId} (${top[0].title}), then tell the developer in one line.` : "Not sure: ask the developer with needs_you kind=decision, these candidates plus \"New workspace\"." };
      }
      case "send_to_agent": return this.send(paseo, s, args as { agentId: string; text: string; reply_to_ask?: boolean });
      case "start_workspace": return args.confirm ? this.confirm(args.planId) : this.planWorkspace(paseo, s, args);
      case "rerank": { if (!this.d.rerank) throw new Error("Re-ranking isn't available on this host."); return this.d.rerank(); }
    }
  }

  private async agentDigest(paseo: OverseerPaseo, agentId: string, n: number) {
    const agent = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent;
    if (!agent) throw new Error(`No agent ${agentId}. Use an agentId from workstreams.`);
    const [read, inbox, state, brief, lites] = await Promise.all([this.steps(paseo, agentId, n, agent).catch(() => null), this.d.inbox.list(), this.d.store.snapshot(), this.d.inbox.brief(agentId).catch(() => null), this.d.workspaces().catch(() => [])]);
    const row = inbox.rows.find(r => r.agentId === agentId);
    const head = row ? flagHeadline(row, this.now()) : null;
    const w = state.workspaces.find(w => w.id === agent.workspaceId && w.enable_tracking);
    const loaded = isLoaded(agent);
    const asks = [
      ...(head ? [`${head.label}${head.line && head.line !== head.label ? `: ${head.line}` : ""}`] : []),
      ...(brief?.state === "open" ? brief.decisions.map(d => `Decision: ${d.question}${d.options.length ? ` (${d.options.map(o => `${o.letter}) ${o.label}`).join(", ")})` : ""}`) : []),
      ...(w && w.mainAgentId === agentId ? w.questions.filter(questionOpen).map(q => `Question ${q.id}: ${q.title}`) : []),
    ];
    return {
      agentId, title: agent.title ?? null, status: agent.status, loaded, workspaceId: agent.workspaceId ?? null,
      workspace: lites.find(l => l.id === agent.workspaceId)?.name ?? w?.title ?? null,
      // Never wakes the agent: unloaded agents are read from their transcript on disk, else Follow-up's cache.
      source: read?.source ?? "cache",
      ...(read ? {} : { goal: w?.goal ?? null, prs: (w?.prs ?? []).map(p => `#${p.number} ${p.snapshot?.title ?? ""}`.trim()) }),
      steps: (read?.steps ?? []).map(x => ({ kind: x.kind, text: clip(x.text.replace(/\s+/g, " ").trim(), 300) })),
      openAsks: [...new Set(asks)],
      ...(loaded ? {} : { note: read?.source === "transcript" ? "Not loaded: steps come from its transcript on disk. Sending to it wakes it." : "Not loaded and no transcript: goal and PRs from Follow-up's cache. Sending to it wakes it." }),
    };
  }

  /** Forward the developer's words. The inbox ledger records who sent it (the forwarded-message rule). */
  private async send(paseo: OverseerPaseo, s: OverseerState, args: { agentId: string; text: string; reply_to_ask?: boolean }) {
    if (args.agentId === s.agentId) throw new Error("That's you. Pick the agent that owns the work.");
    const agent = (await paseo.agents.ref(args.agentId).refresh().catch(() => null))?.agent;
    if (!agent || agent.archivedAt) throw new Error(`Agent ${args.agentId} is gone or archived. Read workstreams again.`);
    const row = (await this.d.inbox.list()).rows.find(r => r.agentId === args.agentId);
    const sender = forwardedSender({ replyToAsk: !!args.reply_to_ask, targetFlagged: !!row?.needs && !row.snooze });
    const messageId = randomUUID();
    await this.d.inbox.noteDelivery(args.agentId, messageId, sender === "developer" ? "developer" : undefined);
    // Sending to an unloaded agent wakes it. That's Tom's explicit ask here, so it's allowed, and the reply says so.
    const woke = !isLoaded(agent);
    try { await paseo.agents.ref(args.agentId).send(forwardText(args.text), { messageId }); }
    catch (error) { if (conversationGone(error)) throw new Error(`${agent.title ?? args.agentId}'s conversation is gone; it can't take messages. Offer the developer a new workspace instead.`); throw error; }
    const lites = await this.d.workspaces().catch(() => []);
    const where = lites.find(l => l.id === agent.workspaceId)?.name ?? agent.title ?? args.agentId;
    const who = agent.title ?? where;
    return { sent: true, agentId: args.agentId, workspace: where, woke, clearsNeedsYou: sender === "developer", next: `Tell the developer in one line: "Sent to ${where}${woke ? ` (woke ${who})` : ""}."` };
  }

  /**
   * The developer's latest message to the Overseer, or null when the newest prompt is anyone else's (another agent,
   * a child's notification, a schedule, Follow-up's own send). A "Follow-up answer" counts only when the delivery
   * ledger shows the developer clicked it; another agent answering the Overseer's card never approves.
   * The Overseer is mid-turn when it calls a tool, so it is loaded; the transcript covers the rare other case.
   */
  private async lastDeveloperMessage(paseo: OverseerPaseo, agentId: string): Promise<string | null> {
    const agent = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent ?? null;
    if (agent && isLoaded(agent)) {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 40, projection: "canonical" }).catch(() => null);
      const prompt = page ? latestPrompt([...page.entries].sort((a, b) => a.seqStart - b.seqStart).map(e => e.item)) : null;
      if (!prompt?.message || typeof prompt.sender === "string") return null;
      const sources = this.d.sources ?? NO_SOURCES;
      if (prompt.sender.kind === "follow-up" && prompt.sender.what === "answer") return await ledgerSender(prompt.message, agentId, this.now(), sources) === "tom" ? prompt.message.text : null;
      if (prompt.sender.kind !== "developer") return null;
      return await classify(prompt.message, agentId, this.now(), sources) === "tom" ? prompt.sender.text : null;
    }
    // Transcript steps say "you" only for the developer's own message (shared/message-sender.ts).
    const read = await this.steps(paseo, agentId, 20, agent).catch(() => null);
    const last = [...(read?.steps ?? [])].reverse().find(x => x.kind === "you" || x.kind === "message");
    return last?.kind === "you" ? last.text : null;
  }

  /** Dry run: the workspace Follow-up would start. Runs only after the developer asked for or approved it. */
  private async planWorkspace(paseo: OverseerPaseo, s: OverseerState, args: { task?: string; title?: string; project?: string; linear_key?: string; base?: string }) {
    if (!args.task) throw new Error("start_workspace: give task (the developer's words for the work).");
    const [lites, projects] = await Promise.all([this.d.workspaces(true), listProjects(paseo)]);
    const wanted = args.project?.toLowerCase();
    // Without a project, the one most of the developer's workspaces live in.
    const counts = new Map<string, number>();
    for (const l of lites) if (l.projectId && l.id !== s.workspaceId) counts.set(l.projectId, (counts.get(l.projectId) ?? 0) + 1);
    const busiest = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const project = wanted ? projects.find(p => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted) : projects.find(p => p.id === busiest);
    const key = args.linear_key?.toUpperCase() ?? linearKeys(args.task)[0] ?? null;
    const title = args.title ?? workspaceTitleFor(args.task, key);
    const branch = branchFor(title);
    const base = args.base ?? "main";
    const blockers: string[] = [];
    if (!project) blockers.push(projects.length ? `Pick a project: ${projects.slice(0, 8).map(p => p.name).join(", ")}.` : "No Paseo project is available.");
    if (!approvesNewWorkspace(await this.lastDeveloperMessage(paseo, s.agentId!))) blockers.push("The developer hasn't asked for or approved a new workspace. Ask them first (needs_you kind=decision with \"New workspace\" as an option).");
    const plan = { title, branch, base, project: project?.name ?? null, firstMessage: forwardText(args.task) };
    const planId = blockers.length ? null : randomUUID();
    if (planId) this.plans.set(planId, { expiresAt: this.now() + 10 * 60_000, run: async () => {
      const w = await paseo.workspaces.create({ title, source: { kind: "worktree", projectId: project!.id, action: "branch-off", baseBranch: base, branchName: branch } });
      // The developer's default model for the provider, in bypass like his other agents.
      const providerId = this.d.provider?.split("/")[0] ?? "claude";
      const agent = await w.agents.create({ config: { provider: await providerModel(paseo, providerId), ...(providerId === "claude" ? { modeId: "bypassPermissions" } : {}) }, title, prompt: plan.firstMessage });
      return { started: true, workspaceId: w.id, agentId: agent.id, title, branch };
    } });
    return { dryRun: true, planId, plan, blockers, next: planId ? `Call start_workspace with confirm=true and planId=${planId}. Then tell the developer in one line.` : "Blocked; resolve the blockers first." };
  }
  private async confirm(planId: string | undefined) {
    if (!planId) throw new Error("start_workspace: confirm needs the planId from the dry run.");
    const plan = this.plans.get(planId);
    if (!plan || plan.expiresAt <= this.now()) throw new Error("This plan expired or was used. Run the dry run again.");
    this.plans.delete(planId);
    return plan.run();
  }
}

/** The handoff a recreated Overseer starts with: its predecessor's last steps, one line each. */
export type OverseerAgentSetting = { provider: string; model: string | null; thinking: string | null; mode: string | null };
export const DEFAULT_OVERSEER_AGENT: OverseerAgentSetting = { provider: "claude", model: null, thinking: null, mode: "bypassPermissions" };
/** Identifies a setting: the default is plain "claude", so older Overseers (no recorded agent) match it. */
export const settingKey = (s: OverseerAgentSetting) => s.provider === "claude" && !s.model && !s.thinking && s.mode === "bypassPermissions" ? "claude" : [s.provider, s.model ?? "", s.thinking ?? "", s.mode ?? ""].join("|");

const NO_SOURCES: Sources = { ledger: async () => [], defer: async () => false, session: async () => false, schedule: async () => false };

export function handoffSummary(steps: TailStep[]): string {
  return steps.length ? steps.map(x => `- ${x.kind === "you" ? "developer" : x.kind === "message" ? x.from : x.kind}: ${clip(x.text.replace(/\s+/g, " ").trim(), 240)}`).join("\n") : "(no history could be read)";
}

/** Write JSON to a temp file, then rename: readers never see half a file. */
export async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * "provider/model" for a provider: the first model matching `prefer` (the Overseer wants Opus), else the provider's
 * default, else its first. Paseo requires the model in the selection.
 */
export async function providerModel(paseo: OverseerPaseo, provider: string, prefer?: RegExp): Promise<string> {
  try {
    const result = await paseo.providers?.listModels(provider) as { models?: { id: string; isDefault?: boolean; isSelectable?: boolean }[] } | undefined;
    const models = (result?.models ?? []).filter(m => m.isSelectable !== false && !/\[1m\]/.test(m.id));
    const pick = (prefer && models.find(m => prefer.test(m.id))) || models.find(m => m.isDefault) || models[0];
    if (pick) return `${provider}/${pick.id}`;
  } catch {}
  return provider === "claude" ? "claude/claude-opus-5-5" : `${provider}/default`;
}

async function listProjects(paseo: OverseerPaseo): Promise<{ id: string; name: string }[]> {
  try {
    const r = await paseo.projects?.list() as { entries?: unknown[]; projects?: unknown[] } | undefined;
    const rows = (r?.entries ?? r?.projects ?? []) as { projectId?: string; id?: string; projectName?: string | null; name?: string | null; displayName?: string | null; projectDisplayName?: string | null }[];
    return rows.flatMap(p => { const pid = p.projectId ?? p.id; const name = p.projectName ?? p.displayName ?? p.projectDisplayName ?? p.name ?? pid; return pid ? [{ id: pid, name: name! }] : []; });
  } catch { return []; }
}
