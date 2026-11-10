import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BackgroundAgents } from "./background-agents";
import { emptyInbox, expired, inboxStateSchema, newEntry, reduce, StaleSignOff, type Entry, type InboxEvent, type InboxRow, type InboxState, type Reason } from "../shared/inbox";
import type { State as FollowState, Workspace as FollowWorkspace } from "../shared/model";
import { prActionBlocks } from "../shared/pr-actions";
import { configuredReviewers, noReviewers, reviewerLabel, withoutAuthor } from "../shared/reviewers";
import { classify, turnPrompt, type Sources } from "./inbox-classifier";
import { briefOrigin, briefStep, pickBrief, shouldReopen, type Brief, type BriefEvent, type BriefSources, type NeedsYouRecord, type PrState } from "../shared/brief";

/** The flag store: plugin-data/follow-through/inbox.json. A new file, so existing state never changes shape. */
export class InboxStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private get path() { return join(this.directory, "inbox.json"); }
  async read(): Promise<InboxState> {
    try { return inboxStateSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyInbox();
      throw new Error("The Needs-you inbox could not be read. Restore inbox.json or remove it to start fresh.");
    }
  }
  async mutate<T>(work: (state: InboxState) => T | Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const state = await this.read();
      const value = await work(state);
      await this.write(state);
      return structuredClone(value);
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  async snapshot(): Promise<InboxState> { await this.tail; return this.read(); }
  private async write(state: InboxState): Promise<void> {
    inboxStateSchema.parse(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `inbox.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state, null, 2)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}

/**
 * F7: whether a completed turn adds nothing. needs_you kind=done is "nothing for the developer"; and while Paseo
 * still shows the agent running (background work after the reply), a plain finish waits for the real one.
 * A turn without needs_you on an idle agent still flags as finished, since nothing says otherwise.
 */
export function finishIsQuiet(kind: string | null, status: string | null): boolean {
  if (kind === "done") return true;
  return (status === "running" || status === "initializing") && (kind === null);
}

export type AgentInfo = {
  id: string; workspaceId: string | null; parentAgentId: string | null; title: string | null; status: string;
  archivedAt: string | null; updatedAt: string | null; lastUserMessageAt: string | null;
  requiresAttention: boolean; attentionReason: string | null;
  /** When Paseo marked the agent as needing attention (a turn finished unread). Optional for older hosts and stubs. */
  attentionTimestamp?: string | null; createdAt?: string | null;
  /** Paseo 0.16 background agent (a plugin's helper): its turns never raise rows. Absent on 0.15. */
  background?: boolean;
  /** Ids of the permission prompts Paseo shows for this agent right now. Absent or null: unknown, so nothing is cleared. */
  pendingPermissionIds?: string[] | null;
};
export interface Directory {
  agents(): Promise<AgentInfo[]>;
  workspaces(): Promise<{ id: string; name: string }[]>;
  agent(id: string): Promise<AgentInfo | null>;
  /** Recent timeline items, oldest first. */
  tail(id: string, limit: number): Promise<unknown[]>;
  clearAttention(ids: string[]): Promise<void>;
}
export type GuardPause = { id: string; agentId: string; phase: string; turnId?: string | null; anchorResetsAt?: string; dismissed?: boolean; note?: string };
/** What the brief needs from the rest of Follow-up. Absent in older tests: then no briefs are made. */
export type BriefHost = {
  /** Append or replace the timeline row. Failures are swallowed by the caller; the stored brief stays. */
  sink(agentId: string, brief: Brief): Promise<void>;
  /** The newest valid needs_you call this agent made, if any. */
  call(agentId: string): Promise<NeedsYouRecord | null>;
  /** The agent's newest open PR in a tracked workspace, with facts. */
  pr(agentId: string, event?: string | null): Promise<PrState | null>;
  /** The tracked workspace the agent is main in, for PR moves and questions. */
  workspaceId?(agentId: string): Promise<string | null>;
  /** A brief collapsed; its decisions stored as questions may need settling. */
  settled?(agentId: string, brief: Brief): Promise<void>;
};
export type InboxOptions = {
  enabled: () => Promise<{ enable_inbox: boolean; enable_inbox_pr_closed: boolean }>;
  briefs?: BriefHost;
  directory: Directory;
  sources: Sources;
  guard: () => Promise<GuardPause[] | null>;
  now?: () => number;
  graceMs?: number;
  /** How long a permission row stays before reconcilePermissions checks Paseo still shows its prompt. */
  permissionSettleMs?: number;
  /** How long a turn end waits for Paseo to stop reporting "running" (F7). Tests shorten it. */
  settleMs?: number; settleStepMs?: number;
  /** The Overseer's agent id: it never counts in Needs you; list() returns its row apart (1.4.0-beta.0). */
  overseer?: () => Promise<string | null>;
};
/** Decides the brief step for one event from the entry before and after it. */
export type BriefDecider = (prev: Entry, next: Entry, at: string) => BriefEvent | null;
/** Brief steps every inbox event implies: sign-off collapses, undo reopens, an answered prompt retires its slim brief. */
export function autoBrief(event: InboxEvent): BriefEvent | null {
  if (event.type === "sign_off") return { type: "sign_off" };
  if (event.type === "undo") return { type: "undo" };
  if (event.type === "permission_resolved") return { type: "permission_resolved" };
  return null;
}
/** Session Guard's note and reset time, read defensively: anything unexpected shows as no detail. */
export function pauseSource(p: GuardPause): { note: string | null; resetsAt: string | null } {
  const note = typeof p.note === "string" && p.note.trim() ? p.note : null;
  const at = typeof p.anchorResetsAt === "string" && Number.isFinite(Date.parse(p.anchorResetsAt)) ? new Date(p.anchorResetsAt) : null;
  return { note, resetsAt: at ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : null };
}
/** The developer's option click, in the existing answer format so Follow-up's answer card renders it. */
export function briefAnswer(id: string, question: string, letter: string, label: string): string {
  const title = question.replace(/[()\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `Follow-up answer ${id} (${title}): ${letter} — ${label}\nContinue with this choice.`;
}
/**
 * Several decisions answered together (1.4.0): one message, a summary line the developer reads at a glance, then one
 * line per decision the agent can act on. Skipped decisions are named, so the agent knows they're still open.
 */
export function briefAnswers(ask: string, decisions: { id: string; question: string; options: { letter: string; label: string }[] }[], picks: Record<string, string>): string {
  const clean = (t: string) => t.replace(/[()\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const asked = decisions.filter(d => d.options.length);
  const picked = (d: typeof asked[number]) => d.options.find(o => o.letter === picks[d.id]);
  const summary = asked.map((d, i) => { const o = picked(d); return `${i + 1}. ${o ? `${o.letter} — ${o.label}` : "skipped"}`; }).join(" · ");
  const lines = [`${ANSWERS_PREFIX} ${asked.map(d => d.id).join(", ")} (${clean(ask)}): ${summary}`];
  for (const d of asked) { const o = picked(d); lines.push(o ? `${d.id} (${clean(d.question)}): ${o.letter} — ${o.label}` : `${d.id} (${clean(d.question)}): skipped — not answered yet; ask again if it still matters.`); }
  const skipped = asked.filter(d => !picked(d));
  lines.push(skipped.length ? `Continue with the answered ones; ${skipped.map(d => d.id).join(" and ")} ${skipped.length === 1 ? "is" : "are"} still open. The answers are already recorded.` : "Continue with these choices. The answers are already recorded.");
  return lines.join("\n");
}
const ANSWERS_PREFIX = "Follow-up answer";
const ORIGINS = 500;
export type Root = { rootId: string; subagent: AgentInfo | null; delegated: boolean };
const DAY = 24 * 3_600_000;
const stub = (a: { id: string; workspaceId: string | null; parentAgentId?: string | null }): AgentInfo => ({ id: a.id, workspaceId: a.workspaceId, parentAgentId: a.parentAgentId ?? null, title: null, status: "", archivedAt: null, updatedAt: null, lastUserMessageAt: null, requiresAttention: false, attentionReason: null });
const one = (text: string, max = 140) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
const lastLine = (text: string) => one(text.split(/\n+/).map(l => l.trim()).filter(Boolean).at(-1) ?? "");

/** Applies Paseo and Follow-up events to the store. The worker owns one instance. */
export class Inbox {
  readonly store: InboxStore;
  private live = new Set<string>();
  private grace = new Map<string, { timer: ReturnType<typeof setTimeout>; done: () => void }>();
  private resolved = new Set<string>();
  private waiting = new Map<string, string>();
  private cache: { at: number; agents: AgentInfo[]; workspaces: { id: string; name: string }[] } | null = null;
  constructor(directory: string, private o: InboxOptions) { this.store = new InboxStore(directory); }
  private now() { return this.o.now?.() ?? Date.now(); }
  /**
   * Paseo still reports "running" for a moment after a turn completes, so a status read at turn end would make
   * every plain finish look like background work (F7) and flag nothing. Re-read until the agent leaves "running"
   * or the window ends; only an agent still running after it counts as running.
   */
  private async settledStatus(agentId: string): Promise<string | null> {
    const read = () => this.o.directory.agent(agentId).then(a => a?.status ?? null, () => null);
    const step = this.o.settleStepMs ?? 500, steps = Math.max(1, Math.ceil((this.o.settleMs ?? 6_000) / step));
    let status = await read();
    for (let i = 0; i < steps && (status === "running" || status === "initializing"); i++) {
      await new Promise(r => setTimeout(r, step));
      status = await read();
    }
    return status;
  }
  private iso() { return new Date(this.now()).toISOString(); }
  private async on() { try { return (await this.o.enabled()).enable_inbox; } catch { return true; } }

  /**
   * Apply events to entries in one write. Unknown agents get an entry on first flag.
   * `brief` decides the brief step from the entry before and after the event (null: none beyond the automatic ones).
   */
  async apply(events: { agentId: string; event: InboxEvent; brief?: BriefDecider }[]): Promise<void> {
    if (!events.length) return;
    const at = this.iso();
    const appends: { agentId: string; brief: Brief }[] = [];
    await this.store.mutate(state => {
      for (const { agentId, event, brief } of events) {
        const prev = state.entries[agentId] ?? newEntry(agentId);
        const next = reduce(prev, event, at);
        state.entries[agentId] = next;
        const steps = [autoBrief(event), brief?.(prev, next, at) ?? null].filter((s): s is BriefEvent => !!s);
        for (const step of steps) this.step(state, agentId, step, at, appends);
      }
    });
    await this.flush(appends);
  }

  /** One brief step on a stored entry, recording what to append and, for a new flagged brief, where it came from. */
  private step(state: InboxState, agentId: string, event: BriefEvent, at: string, appends: { agentId: string; brief: Brief }[]): void {
    const e = state.entries[agentId];
    if (!e || !this.o.briefs) return;
    if (event.type === "create" && e.goneAt) return;
    const result = briefStep(e.brief, event, at);
    if (result.brief === e.brief) return;
    e.brief = result.brief;
    for (const b of result.appends) appends.push({ agentId, brief: b });
    if (event.type === "create" && event.flagged) state.briefOrigins = [...state.briefOrigins, { at, origin: briefOrigin(event.content.source) }].slice(-ORIGINS);
  }

  private async flush(appends: { agentId: string; brief: Brief }[]): Promise<void> {
    for (const { agentId, brief } of appends) {
      await this.o.briefs?.sink(agentId, brief).catch(() => undefined);
      if (brief.state !== "open" && brief.questionIds.length) await this.o.briefs?.settled?.(agentId, brief).catch(() => undefined);
    }
  }

  /** The current turn per agent, from turn starts, so a needs_you call is matched to the turn it was made in. */
  private turns = new Map<string, { turnId: string | null; at: number }>();
  private async previousBriefAt(agentId: string): Promise<number | null> {
    const at = (await this.store.snapshot()).entries[agentId]?.brief?.at;
    const ms = at ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? ms + 1 : null;
  }
  currentTurn(agentId: string): { turnId: string | null; at: number } | null { return this.turns.get(agentId) ?? null; }

  /** The sources every brief has: the agent's needs_you for this turn and its PR state. */
  private async sources(agentId: string, since: number | null, turnId: string | null): Promise<Pick<BriefSources, "agent" | "pr">> {
    const b = this.o.briefs;
    if (!b) return {};
    const [record, pr] = await Promise.all([b.call(agentId).catch(() => null), b.pr(agentId).catch(() => null)]);
    const current = record && (turnId && record.turnId === turnId || since !== null && record.at >= since) ? record.call : null;
    return { agent: current, pr };
  }

  /** A decider that creates a brief, flagged when the event's reason is newly on the entry. */
  private async creator(agentId: string, turnId: string | null, suffix: string, reason: Reason | null, content: BriefSources, keepUnflagged = false, quiet = false): Promise<BriefDecider> {
    const picked = pickBrief(content);
    const workspaceId = await this.o.briefs?.workspaceId?.(agentId).catch(() => null) ?? null;
    const questionIds = picked.source === "agent" ? (await this.o.briefs?.call(agentId).catch(() => null))?.questionIds ?? [] : [];
    return (_prev, next, at) => {
      const flagged = !!reason && !!next.needs?.reasons.some(r => r.reason === reason && r.at === at) && !next.goneAt;
      if (!flagged && !(keepUnflagged && picked.source === "agent")) return null;
      // F7: a quiet finish never replaces an older ask that still needs the developer; its card stays.
      if (quiet && next.needs && next.brief?.state === "open" && next.brief.flagged) return null;
      return { type: "create", id: `brief:${turnId ?? at}${suffix}`, turnId, content: picked, flagged, seq: next.seq, questionIds, workspaceId };
    };
  }

  /** Same-workspace children roll up to their parent; a launch into another workspace is a delegated root. */
  async root(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }): Promise<Root> {
    let current: { id: string; workspaceId: string | null; parentAgentId?: string | null } = agent;
    let subagent: AgentInfo | null = null;
    for (let depth = 0; depth < 8 && current.parentAgentId; depth++) {
      const parent = await this.o.directory.agent(current.parentAgentId).catch(() => null);
      // Unknown parents can't be rolled up to, so the agent stands on its own.
      if (!parent) return { rootId: current.id, subagent, delegated: false };
      if (parent.workspaceId && parent.workspaceId !== current.workspaceId) return { rootId: current.id, subagent, delegated: true };
      if (!subagent) subagent = await this.o.directory.agent(agent.id).catch(() => null) ?? stub(agent);
      current = parent;
    }
    return { rootId: current.id, subagent, delegated: false };
  }

  /** Paseo 0.16 background agents are another plugin's helpers: their turns never raise rows (background-agents.ts). */
  private backgroundAgents = new BackgroundAgents();
  private background(id: string) { return this.backgroundAgents.check(id, agentId => this.o.directory.agent(agentId)); }

  async turnStarted(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }, turnId?: string | null): Promise<void> {
    if (!await this.on()) { this.live.add(agent.id); return; }
    if (await this.background(agent.id)) return;
    this.live.add(agent.id);
    const root = await this.root(agent);
    if (root.subagent) return;
    const at = this.now();
    this.turns.set(agent.id, { turnId: turnId ?? null, at });
    const items = await this.o.directory.tail(agent.id, 20).catch(() => []);
    const prompt = turnPrompt(items);
    const sender = prompt.from ?? await classify(prompt.message, agent.id, at, this.o.sources);
    // Only the developer's own message answers the open brief. Another agent's message, Follow-up's prompts, a
    // continuation after compaction or a schedule start a turn but leave the card open: its questions still are.
    const brief: BriefEvent = sender === "tom" ? { type: "message", text: prompt.message?.text ?? null } : { type: "turn_start" };
    await this.apply([{ agentId: root.rootId, event: { type: "message", from: sender === "tom" ? "tom" : "automation" }, brief: () => brief }]);
  }

  async turnEnded(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }, outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string }, turnId: string | null): Promise<void> {
    this.live.delete(agent.id);
    if (!await this.on()) return;
    if (await this.background(agent.id)) return;
    const root = await this.root(agent);
    if (root.subagent) {
      // Subagent finishes are covered by the parent's own turn end; failures surface on the parent's brief.
      if (outcome.kind === "failed") {
        const message = `Subagent ${root.subagent.title ?? ""}: ${outcome.error.message}`.replace("Subagent : ", "A subagent: ");
        await this.apply([{ agentId: root.rootId, event: { type: "turn_end", outcome: "failed", detail: one(message) }, brief: await this.creator(root.rootId, turnId, `:sub:${agent.id}`, "error", { error: { message } }) }]);
      }
      return;
    }
    // After a plugin reload mid-turn the turn start is lost; anything stated since the previous brief belongs to this turn.
    const since = this.turns.get(agent.id)?.at ?? await this.previousBriefAt(root.rootId);
    this.turns.delete(agent.id);
    const stated = await this.sources(agent.id, since, turnId);
    if (outcome.kind === "completed") {
      const items = await this.o.directory.tail(agent.id, 20).catch(() => []);
      const reply = [...items].reverse().find(i => (i as { type?: string })?.type === "assistant_message") as { text?: string } | undefined;
      // F7: needs_you kind=done means nothing for the developer, and while Paseo still shows the agent running
      // (background work) its own running state is enough. Neither flags; a decision, action or review still does.
      const status = await this.settledStatus(agent.id);
      const quiet = finishIsQuiet(stated.agent?.kind ?? null, status);
      // The ask replaces the reply's last line as the reason's detail (§4); the fallback keeps the old detail.
      const brief = await this.creator(root.rootId, turnId, "", "finished", stated, !quiet || stated.agent?.kind === "done", quiet);
      await this.apply([{ agentId: root.rootId, event: { type: "turn_end", outcome: "completed", detail: reply?.text ? lastLine(reply.text) : "", delegated: root.delegated, quiet }, brief }]);
    } else if (outcome.kind === "failed") {
      const message = outcome.error.message || "Turn failed";
      await this.apply([{ agentId: root.rootId, event: { type: "turn_end", outcome: "failed", detail: one(message) }, brief: await this.creator(root.rootId, turnId, "", "error", { ...stated, error: { message } }) }]);
    } else {
      const pauses = await this.o.guard().catch(() => null);
      const pause = turnId ? pauses?.find(p => p.agentId === agent.id && p.turnId === turnId && !p.dismissed) : undefined;
      const guard = !pause ? null : pause.phase === "attention" ? "attention" as const : "waiting" as const;
      const brief = guard === "attention" ? await this.creator(root.rootId, turnId, ":paused", "paused", { ...stated, paused: pauseSource(pause!) }) : undefined;
      await this.apply([{ agentId: root.rootId, event: { type: "turn_end", outcome: "canceled", guard, detail: one(pause?.note ?? "Usage limit · pick an account to resume") }, brief }]);
    }
  }

  /** #4 with a grace period, so a plugin that answers automatically never flashes a row. */
  permissionRequested(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }, request: { id: string; title?: string; name?: string; description?: string }): Promise<void> {
    const key = `${agent.id}:${request.id}`;
    this.resolved.delete(key);
    return new Promise(resolve => {
      this.grace.set(key, { done: resolve, timer: setTimeout(() => {
        this.grace.delete(key);
        void (async () => {
          if (this.resolved.has(key) || !await this.on()) return;
          const root = await this.root(agent);
          const question = one(request.title || request.description || request.name || "Permission requested");
          const turn = this.turns.get(root.rootId) ?? this.turns.get(agent.id);
          const stated = await this.sources(root.rootId, turn?.at ?? null, turn?.turnId ?? null);
          const brief = await this.creator(root.rootId, turn?.turnId ?? null, `:permission:${request.id}`, "permission", { ...stated, permission: { title: question, subagent: root.subagent ? { id: agent.id, title: root.subagent.title } : null } });
          // Answered while the brief was being built: its resolve already ran against an unflagged entry, so flagging now would stick.
          if (this.resolved.has(key)) return;
          this.pending.add(root.rootId);
          await this.apply([{ agentId: root.rootId, event: { type: "permission", requestId: request.id, detail: root.subagent ? `Subagent asks · ${question}` : question }, brief }]);
        })().catch(() => undefined).finally(resolve);
      }, this.o.graceMs ?? 3_000) });
    });
  }

  async permissionResolved(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }, requestId: string): Promise<void> {
    const key = `${agent.id}:${requestId}`;
    this.resolved.add(key);
    const pending = this.grace.get(key);
    if (pending) { clearTimeout(pending.timer); this.grace.delete(key); pending.done(); return; }
    const root = await this.root(agent);
    this.pending.delete(root.rootId);
    await this.apply([{ agentId: root.rootId, event: { type: "permission_resolved", requestId } }]);
  }

  /**
   * A permission row whose prompt Paseo no longer shows is cleared, for resolves the hook never delivered (a mode change,
   * a provider that answers on its own, a worker restart). Reads only the daemon's agent list, never a timeline, and only
   * when a permission row has been up past the settle time. An agent whose pending prompts are unknown keeps its row.
   */
  async reconcilePermissions(): Promise<void> {
    const now = this.now();
    const settle = this.o.permissionSettleMs ?? 30_000;
    const state = await this.store.snapshot();
    const open = Object.entries(state.entries).flatMap(([rootId, e]) => (e.needs?.reasons ?? [])
      .filter(r => r.reason === "permission" && now - Date.parse(r.at) >= settle)
      .map(r => ({ rootId, requestId: r.dedupeKey.replace(/^permission:/, "") })));
    if (!open.length) return;
    const agents = await this.o.directory.agents();
    const byId = new Map(agents.map(a => [a.id, a]));
    const rootOf = (a: AgentInfo) => { let at = a; for (let i = 0; i < 8 && at.parentAgentId && byId.has(at.parentAgentId); i++) at = byId.get(at.parentAgentId)!; return at.id; };
    const events: { agentId: string; event: InboxEvent }[] = [];
    for (const { rootId, requestId } of open) {
      if (!byId.has(rootId)) continue;
      const family = agents.filter(a => rootOf(a) === rootId);
      if (family.some(a => !Array.isArray(a.pendingPermissionIds))) continue;
      const showing = family.flatMap(a => a.pendingPermissionIds!);
      // "import" stands for whatever prompt was up when the worker started; it clears once none is.
      if (requestId === "import" ? showing.length : showing.includes(requestId)) continue;
      events.push({ agentId: rootId, event: { type: "permission_resolved", requestId } });
      if (!showing.length) this.pending.delete(rootId);
    }
    await this.apply(events);
  }

  /** Root agents with a permission prompt showing, for the Stop-hook nudge to skip (R2). */
  private pending = new Set<string>();
  pendingPermissions(): string[] { return [...this.pending]; }

  /** Stop pending grace timers when the worker stops. */
  stop(): void { for (const { timer, done } of this.grace.values()) { clearTimeout(timer); done(); } this.grace.clear(); }

  async closed(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }): Promise<void> {
    const wasLive = this.live.delete(agent.id);
    if (!wasLive || !await this.on()) return;
    const root = await this.root(agent);
    const detail = root.subagent ? "Subagent closed during a turn" : "Closed during a turn";
    await this.apply([{ agentId: root.rootId, event: { type: "crash", detail }, brief: await this.creator(root.rootId, null, ":closed", "error", { error: { message: detail } }) }]);
  }

  async archived(agentIds: string[]): Promise<void> {
    const state = await this.store.snapshot();
    agentIds = agentIds.filter(id => state.entries[id]);
    await this.apply(agentIds.map(agentId => ({ agentId, event: { type: "archive" } as const })));
  }

  async workspaceArchived(workspaceId: string): Promise<void> {
    const agents = await this.o.directory.agents().catch(() => []);
    await this.archived(agents.filter(a => a.workspaceId === workspaceId).map(a => a.id));
  }

  /** Written before Follow-up sends, so the classifier recognises its own messages. */
  async noteDelivery(agentId: string, messageId: string | null, by?: "developer"): Promise<void> {
    const at = this.iso();
    await this.store.mutate(state => { state.ledger = [...state.ledger.filter(l => this.now() - Date.parse(l.at) < 3_600_000), { agentId, messageId, at, ...(by ? { by } : {}) }].slice(-200); });
  }

  /** An agent's Follow-up action (agent parity), kept beside the deliveries as `by: "agent:<id>"`. Not a message. */
  async noteAction(by: string, agentId: string, action: string): Promise<void> {
    const at = this.iso();
    await this.store.mutate(state => { state.ledger = [...state.ledger.filter(l => this.now() - Date.parse(l.at) < 3_600_000), { agentId, messageId: null, at, by, action }].slice(-200); });
  }

  /**
   * The developer clicked an option or a move on the brief. Validated against the stored brief (a stale card is refused),
   * logged in the ledger as the developer's (so the classifier clears the flag, #11), then sent, then collapsed.
   */
  async briefAction(agentId: string, input: { briefId: string; decisionId?: string; choice?: string; choices?: { decisionId: string; choice: string }[]; move?: "retry" }, send: (text: string, messageId: string) => Promise<void>): Promise<Brief> {
    const state = await this.store.snapshot();
    const b = state.entries[agentId]?.brief;
    if (!b || b.id !== input.briefId) throw new Error("This brief was replaced by a newer one. Read the newest card.");
    if (b.state !== "open") throw new Error("This brief was already answered or signed off.");
    let text: string; let event: BriefEvent;
    if (input.move === "retry") {
      if (b.kind !== "error") throw new Error("Only a failed turn can be retried from its brief.");
      text = "Retry the turn that failed. Pick up from the last step that finished."; event = { type: "message", text: null };
    } else if (input.choices) {
      // A multi-decision card sends every pick in one message; at least one, each a real option of its decision.
      const picks: Record<string, string> = {};
      for (const p of input.choices) {
        const d = b.decisions.find(d => d.id === p.decisionId);
        if (!d?.options.some(o => o.letter === p.choice)) throw new Error("Pick one of the options on the card.");
        picks[d.id] = p.choice;
      }
      if (!Object.keys(picks).length) throw new Error("Pick at least one option before sending.");
      text = briefAnswers(b.ask, b.decisions, picks);
      event = { type: "options", picks: Object.entries(picks).map(([decisionId, choice]) => ({ decisionId, choice })) };
    } else {
      const d = b.decisions.find(d => d.id === input.decisionId);
      const o = d?.options.find(o => o.letter === input.choice);
      if (!d || !o) throw new Error("Pick one of the options on the card.");
      text = briefAnswer(d.id, d.question, o.letter, o.label);
      event = { type: "option", decisionId: d.id, choice: o.letter };
    }
    const messageId = randomUUID();
    await this.noteDelivery(agentId, messageId, "developer");
    await send(text, messageId);
    const appends: { agentId: string; brief: Brief }[] = [];
    const at = this.iso();
    const result = await this.store.mutate(s => { if (s.entries[agentId]?.brief?.id === b.id) this.step(s, agentId, event, at, appends); return s.entries[agentId]?.brief ?? b; });
    await this.flush(appends);
    return result;
  }

  /** #7: Session Guard pauses that need a decision flag; waiting ones show on the Running row. */
  async observeGuard(): Promise<void> {
    const pauses = await this.o.guard().catch(() => null);
    this.waiting = new Map((pauses ?? []).filter(p => p.phase === "waiting" && p.anchorResetsAt).map(p => [p.agentId, p.anchorResetsAt!]));
    if (!pauses || !await this.on()) return;
    const events: { agentId: string; event: InboxEvent; brief?: BriefDecider }[] = [];
    for (const p of pauses.filter(p => p.phase === "attention" && !p.dismissed)) {
      const root = await this.root((await this.o.directory.agent(p.agentId).catch(() => null)) ?? { id: p.agentId, workspaceId: null });
      events.push({ agentId: root.rootId, event: { type: "paused", pauseId: p.id, detail: one(p.note ?? "Paused at the usage limit") }, brief: await this.creator(root.rootId, p.turnId ?? null, `:paused:${p.id}`, "paused", { paused: pauseSource(p) }) });
    }
    await this.apply(events);
  }

  /** #8–#10 from Follow-up's own PR observations. The first pass only primes dedupe keys. */
  async observeFollowUp(follow: FollowState): Promise<void> {
    const settings = await this.o.enabled().catch(() => ({ enable_inbox: true, enable_inbox_pr_closed: true }));
    if (!settings.enable_inbox) return;
    const events = followUpEvents(follow, settings.enable_inbox_pr_closed);
    const state = await this.store.snapshot();
    if (!state.importedAt) return;
    if (!state.primedAt) {
      // Existing red CI and open threads predate the inbox: remember them without flagging.
      await this.store.mutate(s => {
        for (const { agentId, event } of events) if ("dedupeKey" in event) { const e = s.entries[agentId] ?? newEntry(agentId); s.entries[agentId] = { ...e, seenKeys: [...new Set([...e.seenKeys, event.dedupeKey])].slice(-200) }; }
        s.primedAt = this.iso();
      });
      return;
    }
    await this.apply(await Promise.all(events.map(async ({ agentId, event }) => ({ agentId, event, brief: await this.prBrief(agentId, event) }))));
  }

  /** CI red or review threads on an idle agent (#8–9): refresh the open brief's facts, or make an S5 brief. */
  private async prBrief(agentId: string, event: InboxEvent): Promise<BriefDecider | undefined> {
    if (!this.o.briefs || (event.type !== "ci" && event.type !== "review" && event.type !== "reviewers")) return undefined;
    const reason = event.type;
    // The detail already reads as a sentence ("1 review thread to fix on #1499"); CI's is a list of checks.
    const pr = await this.o.briefs.pr(agentId, reason === "ci" ? `Checks failed on ${event.detail}` : reason === "review" ? event.detail : null).catch(() => null);
    if (!pr && reason !== "reviewers") return undefined;
    const sources: BriefSources = event.type === "reviewers" ? { pr, reviewers: { prKey: event.prKey, repo: event.prKey.split("#")[0], number: Number(event.detail.slice(1)), url: event.url, names: event.names } } : { pr };
    const create = await this.creator(agentId, null, `:${reason}:${event.dedupeKey.replace(/[^\w#:,.-]/g, "")}`, reason, sources);
    return (prev, next, at) => {
      if (!next.needs?.reasons.some(r => r.reason === reason && r.at === at)) return null;
      const open = next.brief?.state === "open" ? next.brief : null;
      // Reviewers replace only a card that asks nothing (a plain finish); an agent's own ask stays on top.
      if (event.type === "reviewers") return !open || open.kind === "unknown" || open.kind === "done" ? create(prev, next, at) : null;
      return open ? (pr ? { type: "facts", facts: pr.facts } : null) : create(prev, next, at);
    };
  }

  /** Snooze expiry, undo expiry and the 7-day keep for archived agents. Records liveness for #20. */
  async tick(): Promise<void> {
    const at = this.iso(); const now = this.now();
    await this.store.mutate(state => {
      for (const [id, e] of Object.entries(state.entries)) {
        if (expired(e, now)) { delete state.entries[id]; continue; }
        if (e.snooze || e.undo) state.entries[id] = reduce(e, { type: "tick" }, at);
      }
      if (state.batchUndo && Date.parse(state.batchUndo.expires) < now) state.batchUndo = null;
      state.lastSeen = at;
    });
  }

  /** D4 on the very first start; afterwards, #20 for turns that ended while the worker was down. */
  async start(): Promise<void> {
    if (!await this.on()) return;
    const agents = await this.o.directory.agents();
    const roots: { agent: AgentInfo; root: Root }[] = [];
    // §2.5: archived agents are gone and closed ones without a flag stay hidden, so neither is imported.
    for (const agent of agents.filter(a => !a.archivedAt && a.status !== "closed")) {
      const root = await this.root(agent);
      if (!root.subagent && root.rootId === agent.id) roots.push({ agent, root });
    }
    const now = this.now();
    const at = this.iso();
    const offline: string[] = [];
    await this.store.mutate(state => {
      if (!state.importedAt) {
        const unsorted: string[] = [];
        for (const { agent, root } of roots) {
          const idle = !["running", "initializing"].includes(agent.status);
          const reason = agent.requiresAttention ? agent.attentionReason : null;
          const last = lastActivity(agent);
          // The flag dates from the agent's last activity, so ages and D9 ordering mean something.
          const since = last && last < at ? last : at;
          const e = state.entries[agent.id] ?? newEntry(agent.id);
          if (reason === "permission") state.entries[agent.id] = reduce(e, { type: "permission", requestId: "import", detail: "Waiting for your answer" }, since);
          else if (reason === "error") state.entries[agent.id] = reduce(e, { type: "crash", detail: "Errored before Follow-up started" }, since);
          else if (agent.requiresAttention) state.entries[agent.id] = reduce(e, { type: "reconcile", detail: IMPORT_UNREAD }, since);
          else if (idle && !root.delegated && recent(last, now) && unanswered(agent, last)) state.entries[agent.id] = reduce(e, { type: "reconcile", detail: IMPORT_UNANSWERED }, since);
          else if (idle && !root.delegated) unsorted.push(agent.id);
        }
        state.importedAt = at;
        state.unsorted = unsorted.length ? unsorted : null;
        state.revision = REVISION;
      } else {
        if (state.revision < REVISION) migrateFirstRun(state, new Map(agents.map(a => [a.id, a])), now);
        if (state.lastSeen) for (const { agent, root } of roots) {
          const e = state.entries[agent.id];
          // A finish missed while the worker was down is one Paseo itself marked unread after lastSeen.
          // Paseo's updatedAt can't tell: the daemon bumps it in bulk (restarts, migrations).
          const last = agent.requiresAttention && agent.attentionReason === "finished" ? agent.attentionTimestamp ?? null : null;
          const finishedAfter = !!last && last > state.lastSeen && last > (e?.lastEventAt ?? "");
          if (last && finishedAfter && agent.status === "idle" && !root.delegated && !e?.goneAt) { state.entries[agent.id] = reduce(e ?? newEntry(agent.id), { type: "reconcile", detail: OFFLINE }, last); offline.push(agent.id); }
        }
      }
      state.lastSeen = at;
    });
    // §5.4: a turn that ended while Follow-up was offline gets its brief now, from what is still known.
    if (this.o.briefs) for (const agentId of offline) {
      const stated = await this.sources(agentId, null, null);
      const content = pickBrief(stated);
      const appends: { agentId: string; brief: Brief }[] = [];
      await this.store.mutate(s => { const e = s.entries[agentId]; if (e?.needs) this.step(s, agentId, { type: "create", id: `brief:offline:${e.lastEventAt ?? at}`, turnId: null, content, flagged: true, seq: e.seq }, at, appends); });
      await this.flush(appends);
    }
  }

  async act(input: InboxAction): Promise<{ results: { agentId: string; ok: boolean; cameBack: boolean }[] }> {
    const at = this.iso(); const now = this.now();
    const results: { agentId: string; ok: boolean; cameBack: boolean }[] = [];
    const cleared: string[] = [];
    const appends: { agentId: string; brief: Brief }[] = [];
    await this.store.mutate(state => {
      const each = (event: (id: string) => InboxEvent) => {
        for (const agentId of input.agentIds ?? []) {
          const prev = state.entries[agentId] ?? newEntry(agentId);
          const ev = event(agentId);
          try { state.entries[agentId] = reduce(prev, ev, at); results.push({ agentId, ok: true, cameBack: false }); }
          catch (error) { if (!(error instanceof StaleSignOff)) throw error; results.push({ agentId, ok: false, cameBack: true }); continue; }
          const step = autoBrief(ev);
          if (step) this.step(state, agentId, step, at, appends);
        }
      };
      switch (input.action) {
        case "sign_off": {
          const before = Object.fromEntries((input.agentIds ?? []).map(id => [id, state.entries[id]]));
          each(id => ({ type: "sign_off", ...(input.seqs?.[id] !== undefined ? { seq: input.seqs[id] } : {}), ...(input.muteTurn ? { muteTurn: true } : {}) }));
          const done = results.filter(r => r.ok).map(r => r.agentId);
          cleared.push(...done); state.signOffs += done.length;
          if (done.length > 1) state.batchUndo = { at, expires: new Date(now + DAY).toISOString(), unsorted: null, entries: done.map(id => ({ agentId: id, seq: state.entries[id].seq, prev: before[id]?.needs ?? null, prevSnooze: before[id]?.snooze ?? null })) };
          break;
        }
        case "undo": each(() => ({ type: "undo" })); break;
        case "snooze": each(() => ({ type: "snooze", until: input.until ?? "next-event" })); break;
        case "mute_turn": each(id => ({ type: "sign_off", ...(input.seqs?.[id] !== undefined ? { seq: input.seqs[id] } : {}), muteTurn: true })); cleared.push(...results.filter(r => r.ok).map(r => r.agentId)); break;
        case "set_finish_flags": each(() => ({ type: "set_finish_flags", value: input.value ?? true })); break;
        case "unsorted_flag": {
          each(() => ({ type: "reconcile", detail: "Moved from Unsorted" }));
          state.unsorted = state.unsorted?.filter(id => !input.agentIds?.includes(id)) ?? null;
          if (!state.unsorted?.length) state.unsorted = null;
          break;
        }
        case "unsorted_sign_off": {
          // One confirmed batch; a single Undo restores the whole list for 24 h.
          const removed = input.agentIds ?? state.unsorted ?? [];
          state.batchUndo = { at, expires: new Date(now + DAY).toISOString(), unsorted: state.unsorted, entries: [] };
          state.unsorted = state.unsorted?.filter(id => !removed.includes(id)) ?? null;
          if (!state.unsorted?.length) state.unsorted = null;
          state.signOffs += removed.length;
          results.push(...removed.map(agentId => ({ agentId, ok: true, cameBack: false })));
          break;
        }
        case "batch_undo": {
          const batch = state.batchUndo;
          if (!batch || Date.parse(batch.expires) < now) break;
          for (const b of batch.entries) {
            const e = state.entries[b.agentId];
            if (e && !e.needs) { state.entries[b.agentId] = { ...e, needs: b.prev, snooze: b.prevSnooze, undo: null, signedOffAt: null, seq: e.seq + 1 }; this.step(state, b.agentId, { type: "undo" }, at, appends); }
            results.push({ agentId: b.agentId, ok: true, cameBack: false });
          }
          if (batch.unsorted) state.unsorted = batch.unsorted;
          state.batchUndo = null;
          break;
        }
      }
    });
    await this.flush(appends);
    // D8, one way: signing off also clears Paseo's own unread dot.
    if (cleared.length) await this.o.directory.clearAttention(cleared).catch(() => undefined);
    return { results };
  }

  /**
   * One-time repair (1.4.0-beta.25): an agent's current card that a non-developer turn collapsed while its questions are
   * still open comes back open, in the inbox and in the chat (the timeline item is re-appended with the same id).
   * Only cards collapsed in the last week; `openQuestions` says which of an agent's linked questions are open.
   */
  async reopenCollapsed(openQuestions: (agentId: string, ids: string[]) => Promise<ReadonlySet<string>>): Promise<string[]> {
    const state = await this.store.snapshot();
    const due: string[] = [];
    for (const [agentId, e] of Object.entries(state.entries)) {
      const b = e?.brief;
      if (!b || b.state === "open" || !b.questionIds.length || !b.outcomeAt || this.now() - Date.parse(b.outcomeAt) > 7 * 86_400_000) continue;
      if (shouldReopen(b, await openQuestions(agentId, b.questionIds).catch(() => new Set<string>()), false)) due.push(agentId);
    }
    const appends: { agentId: string; brief: Brief }[] = [];
    if (due.length) await this.store.mutate(s => {
      for (const agentId of due) {
        const b = s.entries[agentId]?.brief;
        if (!b || b.state === "open") continue;
        const reopened: Brief = { ...b, state: "open", outcome: null, outcomeAt: null };
        s.entries[agentId]!.brief = reopened; appends.push({ agentId, brief: reopened });
      }
    });
    await this.flush(appends);
    return appends.map(a => a.agentId);
  }

  /** The stored brief for one agent, for Home's detail pane. */
  async brief(agentId: string): Promise<Brief | null> {
    if (!await this.on()) return null;
    return (await this.store.snapshot()).entries[agentId]?.brief ?? null;
  }

  /** Rows for every root agent that is flagged, snoozed, running or signed off today, plus Unsorted. */
  async list(): Promise<{ enabled: boolean; rows: InboxRow[]; unsorted: InboxRow[] | null; firstRun: boolean; batchUndo: { at: string; count: number } | null; signOffs: number; briefStats: BriefStats; overseer: InboxRow | null }> {
    const enabled = await this.on();
    const state = await this.store.snapshot();
    const briefStats = briefShare(state, this.now());
    const overseerId = await this.o.overseer?.().catch(() => null) ?? null;
    if (!enabled) return { enabled, rows: [], unsorted: null, firstRun: false, batchUndo: null, signOffs: state.signOffs, briefStats, overseer: null };
    const now = this.now();
    if (!this.cache || now - this.cache.at > 3_000) {
      const [agents, workspaces] = await Promise.all([this.o.directory.agents(), this.o.directory.workspaces()]);
      this.cache = { at: now, agents, workspaces };
    }
    const { agents, workspaces } = this.cache;
    const byId = new Map(agents.map(a => [a.id, a]));
    const names = new Map(workspaces.map(w => [w.id, w.name]));
    const roots = new Map<string, { agent: AgentInfo; delegatedFrom: string | null }>();
    for (const a of agents) {
      if (a.archivedAt) continue;
      const parent = a.parentAgentId ? byId.get(a.parentAgentId) : undefined;
      if (parent && parent.workspaceId === a.workspaceId) continue;
      roots.set(a.id, { agent: a, delegatedFrom: parent ? parent.id : null });
    }
    const rootsPer = new Map<string, number>();
    for (const { agent } of roots.values()) if (agent.workspaceId) rootsPer.set(agent.workspaceId, (rootsPer.get(agent.workspaceId) ?? 0) + 1);
    const row = (agent: AgentInfo, delegatedFrom: string | null, e: Entry | undefined): InboxRow => ({
      agentId: agent.id, workspaceId: agent.workspaceId, title: agent.title || "Agent",
      workspaceTitle: agent.workspaceId ? names.get(agent.workspaceId) ?? null : null,
      multiRoot: (rootsPer.get(agent.workspaceId ?? "") ?? 0) > 1, status: agent.status, delegatedFrom,
      resumesAt: this.waiting.get(agent.id) ?? null, lastActivityAt: agent.updatedAt,
      needs: e?.needs ?? null, snooze: e?.snooze ?? null, signedOffAt: e?.signedOffAt ?? null,
      undoable: !!e?.undo && Date.parse(e.undo.expires) > now, seq: e?.seq ?? 0, muteTurn: e?.muteTurn ?? false, enable_finish_flags: e?.enable_finish_flags ?? true,
      brief: e?.brief ? { kind: e.brief.kind, source: e.brief.source, state: e.brief.state, ask: e.brief.ask, questionIds: e.brief.questionIds } : null,
    });
    const rows: InboxRow[] = [];
    let overseer: InboxRow | null = null;
    for (const { agent, delegatedFrom } of roots.values()) {
      const e = state.entries[agent.id];
      // The Overseer stands apart: its own pinned row, never in Needs you or its counts.
      if (agent.id === overseerId) { overseer = row(agent, delegatedFrom, e); continue; }
      if (e?.goneAt) continue;
      if (agent.status === "closed" && !e?.needs) continue; // §2.5
      const running = ["running", "initializing"].includes(agent.status) || this.waiting.has(agent.id);
      if (e?.needs || e?.signedOffAt && now - Date.parse(e.signedOffAt) < DAY || running || e && !e.enable_finish_flags) rows.push(row(agent, delegatedFrom, e));
    }
    const unsorted = state.unsorted?.flatMap(id => { const r = roots.get(id); return r && id !== overseerId && r.agent.status !== "closed" && !state.entries[id]?.needs ? [row(r.agent, r.delegatedFrom, state.entries[id])] : []; }) ?? null;
    const batch = state.batchUndo && Date.parse(state.batchUndo.expires) > now ? { at: state.batchUndo.at, count: state.batchUndo.entries.length || (state.batchUndo.unsorted?.length ?? 0) } : null;
    return { enabled, rows, unsorted: unsorted?.length ? unsorted : null, firstRun: state.signOffs < 10, batchUndo: batch, signOffs: state.signOffs, briefStats, overseer };
  }
}

export type BriefStats = { days: number; total: number; tool: number; structured: number; extraction: number; fallback: number };
/** The adoption share over the last 7 days: how many flagged turns had a brief the agent stated. */
export function briefShare(state: Pick<InboxState, "briefOrigins">, now: number, days = 7): BriefStats {
  const recent = state.briefOrigins.filter(o => now - Date.parse(o.at) <= days * DAY);
  const count = (origin: string) => recent.filter(o => o.origin === origin).length;
  return { days, total: recent.length, tool: count("tool"), structured: count("structured"), extraction: count("extraction"), fallback: count("fallback") };
}

export type InboxAction = {
  action: "sign_off" | "undo" | "snooze" | "mute_turn" | "set_finish_flags" | "unsorted_flag" | "unsorted_sign_off" | "batch_undo";
  agentIds?: string[]; seqs?: Record<string, number>; until?: string; value?: boolean; muteTurn?: boolean;
};

/**
 * The agent's last activity, from fields Paseo doesn't rewrite in bulk: when a turn finished unread, else the
 * developer's last message (an idle agent finished the turn it started), else creation. `updatedAt` is not
 * used: the daemon bumps it on restarts and migrations, and reading timelines would load every agent.
 */
export const lastActivity = (a: AgentInfo): string | null => {
  const stamps = [a.lastUserMessageAt, a.requiresAttention ? a.attentionTimestamp : null].filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  return stamps.sort().at(-1) ?? a.createdAt ?? null;
};
/** D4's 7-day window, on the agent's real last activity. Unknown activity is not recent. */
const recent = (last: string | null, now: number) => !!last && now - Date.parse(last) <= 7 * DAY;
/** The agent spoke last: idle after the developer's last message, so the turn it started has ended. */
const unanswered = (a: AgentInfo, last: string | null) => !!last && !!a.lastUserMessageAt && last >= a.lastUserMessageAt;

const IMPORT_UNANSWERED = "You haven't replied";
const IMPORT_UNREAD = "Unread in Paseo";
const OFFLINE = "Finished while Follow-up was offline";
/** Store revision: 1 = the first-run import fix below has been applied. */
export const REVISION = 1;
/** An entry untouched since 1.1.0-beta.0 created it on start: one finish reason it wrote, and nothing the developer did. */
const importOnly = (e: Entry) => !!e.needs && e.needs.reasons.length === 1 && e.needs.reasons[0].reason === "finished"
  && [IMPORT_UNANSWERED, IMPORT_UNREAD, OFFLINE].includes(e.needs.reasons[0].detail)
  && !e.signedOffAt && !e.snooze && !e.undo && !e.muteTurn && e.enable_finish_flags && !e.goneAt;

/**
 * One-time repair of a store imported by 1.1.0-beta.0, which read Paseo's `updatedAt` as last activity and
 * imported closed agents. Only entries that are still exactly what that import wrote change:
 * - a closed or archived agent's imported flag is dropped (§2.5: closed without a real flag stays hidden);
 * - an "unanswered" flag whose agent was really idle for more than 7 days moves to Unsorted (D4);
 * - every other imported flag keeps its place but dates from the agent's real last activity.
 * Entries with a newer real event, or that the developer acted on, are left alone.
 */
export function migrateFirstRun(state: InboxState, agents: Map<string, AgentInfo>, now: number): void {
  const unsorted = new Set(state.unsorted ?? []);
  for (const e of Object.values(state.entries)) {
    if (!importOnly(e)) continue;
    const agent = agents.get(e.agentId);
    if (!agent) continue; // Unknown to the daemon right now: leave it for the archive and gone rules.
    const last = lastActivity(agent);
    const detail = e.needs!.reasons[0].detail;
    const drop = agent.archivedAt || agent.status === "closed"
      || detail !== IMPORT_UNREAD && (!recent(last, now) || !unanswered(agent, last));
    if (drop) {
      e.needs = null; e.seq += 1;
      if (!agent.archivedAt && agent.status !== "closed") unsorted.add(e.agentId);
    } else if (last && last < e.needs!.since) {
      e.needs = { since: last, reasons: e.needs!.reasons.map(r => ({ ...r, at: last })) }; e.seq += 1;
    }
  }
  state.unsorted = unsorted.size ? [...unsorted] : null;
  state.revision = REVISION;
}

/**
 * Whether red CI and review threads are the agent's work right now: Follow-up sends the repair batch on its own
 * (auto-send on, no hold, no batch stuck or unconfirmed). Then the inbox doesn't flag them; it flags only when the
 * developer has to act (auto-send off, a hold, or a blocked/unconfirmed repair).
 */
export function repairsGoToAgent(w: Pick<FollowWorkspace, "enable_auto_sends" | "hold" | "batches">): boolean {
  return w.enable_auto_sends && !w.hold && !w.batches.some(b => ["blocked", "uncertain"].includes(b.state));
}

/** CI, review, reviewer and PR-state events from Follow-up's tracked workspaces, keyed so the same state never re-flags. */
export function followUpEvents(follow: FollowState, enablePrClosed: boolean): { agentId: string; event: InboxEvent }[] {
  const events: { agentId: string; event: InboxEvent }[] = [];
  for (const w of follow.workspaces.filter(w => w.enable_tracking && !w.archived)) {
    const automatic = repairsGoToAgent(w);
    for (const pr of w.prs) {
      const s = pr.snapshot;
      if (!s?.complete || pr.error) continue;
      const agentId = pr.registeredAgentId ?? w.mainAgentId;
      // The agent is already repairing: its own turn end will flag when it's done.
      const repairing = w.batches.some(b => (b.recipientAgentId ?? w.mainAgentId) === agentId && ["sending", "sent"].includes(b.state) && !b.settledAt);
      if (s.state === "OPEN") {
        if (s.failedChecks.length) events.push({ agentId, event: { type: "ci", dedupeKey: `${pr.key}:${s.head}:checks`, detail: `#${pr.number} ${s.failedChecks.slice(0, 3).join(", ")}`, suppressed: repairing || automatic } });
        if (s.threads.length) events.push({ agentId, event: { type: "review", dedupeKey: `${pr.key}:threads:${s.threads.map(t => t.id).sort().join(",")}`, detail: `${s.threads.length} review thread${s.threads.length === 1 ? "" : "s"} to fix on #${pr.number}`, suppressed: repairing || automatic } });
        if (s.conflict) events.push({ agentId, event: { type: "review", dedupeKey: `${pr.key}:conflict:${s.head}`, detail: `Merge conflict to fix on #${pr.number}`, suppressed: repairing || automatic } });
        // Reviewers are the developer's job, and don't wait for threads or CI. Skipped only while a reviewer request
        // or merge is already in flight for this PR (so a second request isn't asked for while GitHub catches up).
        if (!s.draft && noReviewers(pr) && !w.prActions.some(a => prActionBlocks(a, [pr.key])))
          events.push({ agentId, event: { type: "reviewers", dedupeKey: `${pr.key}:reviewers`, detail: `#${pr.number}`, prKey: pr.key, url: s.url ?? null,
            names: withoutAuthor(configuredReviewers(pr.repo), s.reviewers?.author).map(reviewerLabel) } });
      } else if (enablePrClosed && (s.state === "MERGED" || s.state === "CLOSED")) {
        events.push({ agentId, event: { type: "pr_closed", dedupeKey: `${pr.key}:${s.state}`, detail: `#${pr.number} ${s.state === "MERGED" ? "merged" : "closed"}`, prKey: pr.key } });
      }
    }
  }
  return events;
}
