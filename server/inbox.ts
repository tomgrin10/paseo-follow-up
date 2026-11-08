import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { emptyInbox, expired, inboxStateSchema, newEntry, reduce, StaleSignOff, type Entry, type InboxEvent, type InboxRow, type InboxState } from "../shared/inbox";
import type { State as FollowState } from "../shared/model";
import { classify, newestUserMessage, type Sources } from "./inbox-classifier";

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

export type AgentInfo = {
  id: string; workspaceId: string | null; parentAgentId: string | null; title: string | null; status: string;
  archivedAt: string | null; updatedAt: string | null; lastUserMessageAt: string | null;
  requiresAttention: boolean; attentionReason: string | null;
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
export type InboxOptions = {
  enabled: () => Promise<{ enable_inbox: boolean; enable_inbox_pr_closed: boolean }>;
  directory: Directory;
  sources: Sources;
  guard: () => Promise<GuardPause[] | null>;
  now?: () => number;
  graceMs?: number;
};
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
  private iso() { return new Date(this.now()).toISOString(); }
  private async on() { try { return (await this.o.enabled()).enable_inbox; } catch { return true; } }

  /** Apply events to entries in one write. Unknown agents get an entry on first flag. */
  async apply(events: { agentId: string; event: InboxEvent }[]): Promise<void> {
    if (!events.length) return;
    const at = this.iso();
    await this.store.mutate(state => {
      for (const { agentId, event } of events) state.entries[agentId] = reduce(state.entries[agentId] ?? newEntry(agentId), event, at);
    });
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

  async turnStarted(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }): Promise<void> {
    this.live.add(agent.id);
    if (!await this.on()) return;
    const root = await this.root(agent);
    if (root.subagent) return;
    const at = this.now();
    const items = await this.o.directory.tail(agent.id, 20).catch(() => []);
    const sender = await classify(newestUserMessage(items), agent.id, at, this.o.sources);
    await this.apply([{ agentId: root.rootId, event: { type: "message", from: sender === "tom" ? "tom" : "automation" } }]);
  }

  async turnEnded(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }, outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string }, turnId: string | null): Promise<void> {
    this.live.delete(agent.id);
    if (!await this.on()) return;
    const root = await this.root(agent);
    if (root.subagent) {
      // Subagent finishes are covered by the parent's own turn end; failures surface on the parent.
      if (outcome.kind === "failed") await this.apply([{ agentId: root.rootId, event: { type: "turn_end", outcome: "failed", detail: one(`Subagent ${root.subagent.title ?? ""}: ${outcome.error.message}`) } }]);
      return;
    }
    if (outcome.kind === "completed") {
      const items = await this.o.directory.tail(agent.id, 20).catch(() => []);
      const reply = [...items].reverse().find(i => (i as { type?: string })?.type === "assistant_message") as { text?: string } | undefined;
      await this.apply([{ agentId: root.rootId, event: { type: "turn_end", outcome: "completed", detail: reply?.text ? lastLine(reply.text) : "", delegated: root.delegated } }]);
    } else if (outcome.kind === "failed") {
      await this.apply([{ agentId: root.rootId, event: { type: "turn_end", outcome: "failed", detail: one(outcome.error.message || "Turn failed") } }]);
    } else {
      const pauses = await this.o.guard().catch(() => null);
      const pause = turnId ? pauses?.find(p => p.agentId === agent.id && p.turnId === turnId && !p.dismissed) : undefined;
      const guard = !pause ? null : pause.phase === "attention" ? "attention" as const : "waiting" as const;
      await this.apply([{ agentId: root.rootId, event: { type: "turn_end", outcome: "canceled", guard, detail: one(pause?.note ?? "Usage limit · pick an account to resume") } }]);
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
          await this.apply([{ agentId: root.rootId, event: { type: "permission", requestId: request.id, detail: root.subagent ? `Subagent asks · ${question}` : question } }]);
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
    await this.apply([{ agentId: root.rootId, event: { type: "permission_resolved", requestId } }]);
  }

  /** Stop pending grace timers when the worker stops. */
  stop(): void { for (const { timer, done } of this.grace.values()) { clearTimeout(timer); done(); } this.grace.clear(); }

  async closed(agent: { id: string; workspaceId: string | null; parentAgentId?: string | null }): Promise<void> {
    const wasLive = this.live.delete(agent.id);
    if (!wasLive || !await this.on()) return;
    const root = await this.root(agent);
    await this.apply([{ agentId: root.rootId, event: { type: "crash", detail: root.subagent ? "Subagent closed during a turn" : "Closed during a turn" } }]);
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
  async noteDelivery(agentId: string, messageId: string | null): Promise<void> {
    const at = this.iso();
    await this.store.mutate(state => { state.ledger = [...state.ledger.filter(l => this.now() - Date.parse(l.at) < 3_600_000), { agentId, messageId, at }].slice(-200); });
  }

  /** #7: Session Guard pauses that need a decision flag; waiting ones show on the Running row. */
  async observeGuard(): Promise<void> {
    const pauses = await this.o.guard().catch(() => null);
    this.waiting = new Map((pauses ?? []).filter(p => p.phase === "waiting" && p.anchorResetsAt).map(p => [p.agentId, p.anchorResetsAt!]));
    if (!pauses || !await this.on()) return;
    const events: { agentId: string; event: InboxEvent }[] = [];
    for (const p of pauses.filter(p => p.phase === "attention" && !p.dismissed)) {
      const root = await this.root((await this.o.directory.agent(p.agentId).catch(() => null)) ?? { id: p.agentId, workspaceId: null });
      events.push({ agentId: root.rootId, event: { type: "paused", pauseId: p.id, detail: one(p.note ?? "Paused at the usage limit") } });
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
    await this.apply(events);
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
    for (const agent of agents.filter(a => !a.archivedAt)) {
      const root = await this.root(agent);
      if (!root.subagent && root.rootId === agent.id) roots.push({ agent, root });
    }
    const at = this.iso(); const now = this.now();
    await this.store.mutate(state => {
      if (!state.importedAt) {
        const unsorted: string[] = [];
        for (const { agent, root } of roots) {
          const idle = !["running", "initializing"].includes(agent.status);
          const reason = agent.requiresAttention ? agent.attentionReason : null;
          const e = state.entries[agent.id] ?? newEntry(agent.id);
          if (reason === "permission") state.entries[agent.id] = reduce(e, { type: "permission", requestId: "import", detail: "Waiting for your answer" }, at);
          else if (reason === "error") state.entries[agent.id] = reduce(e, { type: "crash", detail: "Errored before Follow-up started" }, at);
          else if (agent.requiresAttention) state.entries[agent.id] = reduce(e, { type: "reconcile", detail: "Unread in Paseo" }, at);
          else if (idle && !root.delegated && recent(agent, now) && unanswered(agent)) state.entries[agent.id] = reduce(e, { type: "reconcile", detail: "You haven't replied" }, at);
          else if (idle && !root.delegated) unsorted.push(agent.id);
        }
        state.importedAt = at;
        state.unsorted = unsorted.length ? unsorted : null;
      } else if (state.lastSeen) {
        for (const { agent, root } of roots) {
          const e = state.entries[agent.id];
          const finishedAfter = agent.updatedAt && agent.updatedAt > state.lastSeen! && agent.updatedAt > (e?.lastEventAt ?? "");
          if (finishedAfter && agent.status === "idle" && !root.delegated && !e?.goneAt) state.entries[agent.id] = reduce(e ?? newEntry(agent.id), { type: "reconcile", detail: "Finished while Follow-up was offline" }, at);
        }
      }
      state.lastSeen = at;
    });
  }

  async act(input: InboxAction): Promise<{ results: { agentId: string; ok: boolean; cameBack: boolean }[] }> {
    const at = this.iso(); const now = this.now();
    const results: { agentId: string; ok: boolean; cameBack: boolean }[] = [];
    const cleared: string[] = [];
    await this.store.mutate(state => {
      const each = (event: (id: string) => InboxEvent) => {
        for (const agentId of input.agentIds ?? []) {
          const prev = state.entries[agentId] ?? newEntry(agentId);
          try { state.entries[agentId] = reduce(prev, event(agentId), at); results.push({ agentId, ok: true, cameBack: false }); }
          catch (error) { if (!(error instanceof StaleSignOff)) throw error; results.push({ agentId, ok: false, cameBack: true }); }
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
            if (e && !e.needs) state.entries[b.agentId] = { ...e, needs: b.prev, snooze: b.prevSnooze, undo: null, signedOffAt: null, seq: e.seq + 1 };
            results.push({ agentId: b.agentId, ok: true, cameBack: false });
          }
          if (batch.unsorted) state.unsorted = batch.unsorted;
          state.batchUndo = null;
          break;
        }
      }
    });
    // D8, one way: signing off also clears Paseo's own unread dot.
    if (cleared.length) await this.o.directory.clearAttention(cleared).catch(() => undefined);
    return { results };
  }

  /** Rows for every root agent that is flagged, snoozed, running or signed off today, plus Unsorted. */
  async list(): Promise<{ enabled: boolean; rows: InboxRow[]; unsorted: InboxRow[] | null; firstRun: boolean; batchUndo: { at: string; count: number } | null; signOffs: number }> {
    const enabled = await this.on();
    const state = await this.store.snapshot();
    if (!enabled) return { enabled, rows: [], unsorted: null, firstRun: false, batchUndo: null, signOffs: state.signOffs };
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
    });
    const rows: InboxRow[] = [];
    for (const { agent, delegatedFrom } of roots.values()) {
      const e = state.entries[agent.id];
      if (e?.goneAt) continue;
      const running = ["running", "initializing"].includes(agent.status) || this.waiting.has(agent.id);
      if (e?.needs || e?.signedOffAt && now - Date.parse(e.signedOffAt) < DAY || running || e && !e.enable_finish_flags) rows.push(row(agent, delegatedFrom, e));
    }
    const unsorted = state.unsorted?.flatMap(id => { const r = roots.get(id); return r && !state.entries[id]?.needs ? [row(r.agent, r.delegatedFrom, state.entries[id])] : []; }) ?? null;
    const batch = state.batchUndo && Date.parse(state.batchUndo.expires) > now ? { at: state.batchUndo.at, count: state.batchUndo.entries.length || (state.batchUndo.unsorted?.length ?? 0) } : null;
    return { enabled, rows, unsorted: unsorted?.length ? unsorted : null, firstRun: state.signOffs < 10, batchUndo: batch, signOffs: state.signOffs };
  }
}

export type InboxAction = {
  action: "sign_off" | "undo" | "snooze" | "mute_turn" | "set_finish_flags" | "unsorted_flag" | "unsorted_sign_off" | "batch_undo";
  agentIds?: string[]; seqs?: Record<string, number>; until?: string; value?: boolean; muteTurn?: boolean;
};

const recent = (a: AgentInfo, now: number) => !!a.updatedAt && now - Date.parse(a.updatedAt) <= 7 * DAY;
/** The agent spoke last: its activity is newer than the developer's last message. */
const unanswered = (a: AgentInfo) => !!a.updatedAt && (!a.lastUserMessageAt || a.updatedAt > a.lastUserMessageAt);

/** CI, review and PR-state events from Follow-up's tracked workspaces, keyed so the same state never re-flags. */
export function followUpEvents(follow: FollowState, enablePrClosed: boolean): { agentId: string; event: InboxEvent }[] {
  const events: { agentId: string; event: InboxEvent }[] = [];
  for (const w of follow.workspaces.filter(w => w.enable_tracking && !w.archived)) {
    for (const pr of w.prs) {
      const s = pr.snapshot;
      if (!s?.complete || pr.error) continue;
      const agentId = pr.registeredAgentId ?? w.mainAgentId;
      // The agent is already repairing: its own turn end will flag when it's done.
      const repairing = w.batches.some(b => (b.recipientAgentId ?? w.mainAgentId) === agentId && ["sending", "sent"].includes(b.state) && !b.settledAt);
      if (s.state === "OPEN") {
        if (s.failedChecks.length) events.push({ agentId, event: { type: "ci", dedupeKey: `${pr.key}:${s.head}:checks`, detail: `#${pr.number} ${s.failedChecks.slice(0, 3).join(", ")}`, suppressed: repairing } });
        if (s.threads.length) events.push({ agentId, event: { type: "review", dedupeKey: `${pr.key}:threads:${s.threads.map(t => t.id).sort().join(",")}`, detail: `${s.threads.length} thread${s.threads.length === 1 ? "" : "s"} on #${pr.number}` } });
        if (s.conflict) events.push({ agentId, event: { type: "review", dedupeKey: `${pr.key}:conflict:${s.head}`, detail: `Conflict on #${pr.number}` } });
      } else if (enablePrClosed && (s.state === "MERGED" || s.state === "CLOSED")) {
        events.push({ agentId, event: { type: "pr_closed", dedupeKey: `${pr.key}:${s.state}`, detail: `#${pr.number} ${s.state === "MERGED" ? "merged" : "closed"}`, prKey: pr.key } });
      }
    }
  }
  return events;
}
