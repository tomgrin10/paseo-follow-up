import type { Daemon } from "./daemon";

/**
 * A turn's timeline is read once (a-turn-s-timeline-is-read-once). Run T, 2026-11-13 (a copy of a live install, 20
 * turns a minute of 31 entries of 8 KB): every turn made 3.2 timeline reads and parsed ~125 entries for its 31: the
 * turn start read the newest 20, the turn end paged back 25 at a time to the prompt (2 reads, 50 entries), and
 * discovery re-read the turn from its own cursor. That churn (64 reads a minute) is what grew V8's heap under load.
 *
 * Now one cursor per agent, shared by every reader of a turn: the turn start reads what's new since the last read
 * (the prompt), the turn end reads what's new since the turn start (the turn itself), and discovery takes the turn
 * end's read instead of fetching the same entries again. Without a cursor (first turn after a reload) or when it no
 * longer applies (new epoch, reset, gap), a reader falls back to reading back from the tail to the turn's prompt.
 */
type Cursor = { epoch: string; seq: number };
type Entry = { item: unknown; seqStart: number };
export type TimelineRead = { entries: Entry[]; complete: boolean; end: Cursor | null; incremental: boolean };

/** Backward page size when there's no cursor: a page at a time back to the item that started the turn. */
export const TURN_PAGE = 25;
/** How far back a read without a cursor goes, and how many of a turn's entries its readers get. */
export const TURN_READ_CAP = 100;
/** Forward page size from a cursor: one request for any turn up to this many entries. */
export const AFTER_PAGE = 100;
/** Forward pages one read may take (a very long turn): every entry is still read once. */
const AFTER_PAGES = 20;
/** How long a turn end's read stays for discovery to take, unless a new turn starts first. */
export const TURN_READ_KEEP_MS = 120_000;

export const startsTurn = (item: unknown): boolean => {
  const i = item as { type?: string; name?: string; callId?: string; agentMessage?: unknown } | null;
  return !!i && (i.type === "user_message" || i.type === "tool_call" && (i.name === "agent_message" || !!i.agentMessage || !!i.callId?.startsWith("paseo-agent-message:") || i.name === "heartbeat" && !!i.callId?.startsWith("paseo-system:")));
};
/** The entries from the last item that started a turn, at most TURN_READ_CAP. */
const fromTurnStart = (entries: Entry[]): Entry[] => {
  let i = entries.length - 1;
  while (i > 0 && !startsTurn(entries[i]!.item)) i--;
  return entries.slice(Math.max(i, entries.length - TURN_READ_CAP));
};

type AgentState = { end: Cursor | null; prompt: Entry[]; chain: Promise<unknown> };
type Kept = { from: Cursor; end: Cursor; entries: Entry[]; at: number };

export class TurnTimeline {
  private agents = new Map<string, AgentState>();
  private kept = new Map<string, Kept>();
  /** Timeline requests and entries fetched, for tests and the scale check. */
  requests = 0;
  entries = 0;
  constructor(private now = Date.now) {}

  /** Turn start: what's new since this agent's last read, normally just the prompt. */
  started(client: Daemon, id: string): Promise<unknown[]> {
    return this.serial(id, async state => {
      this.kept.delete(id);
      const read = await this.next(client, id, state);
      state.prompt = fromTurnStart([...state.prompt, ...read]);
      return state.prompt.map(e => e.item);
    });
  }

  /** Turn end: the ended turn, its prompt first. Kept for discovery until the next turn starts. */
  ended(client: Daemon, id: string): Promise<unknown[]> {
    return this.serial(id, async state => {
      const read = await this.next(client, id, state);
      // Nothing since the last turn end (a late second reader of the same turn): that turn, as read then.
      const again = !read.length && !state.prompt.length ? this.fresh(id) : null;
      if (again) return again.entries.map(e => e.item);
      const turn = fromTurnStart([...state.prompt, ...read]);
      state.prompt = [];
      const first = turn[0]; const end = state.end;
      if (first && end) this.kept.set(id, { from: { epoch: end.epoch, seq: first.seqStart - 1 }, end, entries: turn, at: this.now() });
      return turn.map(e => e.item);
    });
  }

  /**
   * Discovery's read since its cursor, from the last turn end's read when that covers it: nothing was added since
   * (no turn started), and the read reaches back to the cursor. Null: discovery reads the daemon itself.
   */
  since(id: string, since: Cursor, overlap: number): TimelineRead | null {
    const kept = this.fresh(id);
    if (!kept) return null;
    if (kept.from.epoch !== since.epoch || kept.end.epoch !== since.epoch || kept.from.seq > since.seq || since.seq > kept.end.seq) return null;
    return { entries: kept.entries.filter(e => e.seqStart > since.seq - overlap), complete: true, end: kept.end, incremental: true };
  }

  /** The last turn end's read, until the next turn starts or TURN_READ_KEEP_MS passes. */
  private fresh(id: string): Kept | null {
    const kept = this.kept.get(id);
    if (kept && this.now() - kept.at > TURN_READ_KEEP_MS) { this.kept.delete(id); return null; }
    return kept ?? null;
  }

  private serial<T>(id: string, work: (state: AgentState) => Promise<T>): Promise<T> {
    const state = this.agents.get(id) ?? { end: null, prompt: [], chain: Promise.resolve() };
    this.agents.set(id, state);
    const run = state.chain.then(() => work(state), () => work(state));
    state.chain = run.catch(() => undefined);
    return run;
  }

  /** Entries after the agent's cursor, or (no usable cursor) back from the tail to the turn's prompt. */
  private async next(client: Daemon, id: string, state: AgentState): Promise<Entry[]> {
    if (state.end) {
      const forward = await this.after(client, id, state.end);
      if (forward) { state.end = forward.end; return forward.entries; }
      state.end = null; state.prompt = [];
    }
    return this.back(client, id, state);
  }

  private async after(client: Daemon, id: string, since: Cursor): Promise<{ entries: Entry[]; end: Cursor } | null> {
    const entries: Entry[] = []; let cursor = since;
    for (let pageIndex = 0; pageIndex < AFTER_PAGES; pageIndex++) {
      const page = await client.fetchAgentTimeline(id, { direction: "after", cursor, limit: AFTER_PAGE, projection: "canonical", timeout: 10_000 });
      this.requests++; this.entries += page.entries.length;
      if (page.error || page.gap || page.staleCursor || page.reset || (page.epoch && page.epoch !== since.epoch)) return null;
      entries.push(...page.entries);
      if (page.endCursor) { if (page.endCursor.epoch !== since.epoch) return null; cursor = page.endCursor; }
      if (!page.hasNewer) return { entries: entries.sort((a, b) => a.seqStart - b.seqStart), end: cursor };
      if (!page.endCursor) return null;
    }
    return null;
  }

  private async back(client: Daemon, id: string, state: AgentState): Promise<Entry[]> {
    const entries: Entry[] = []; let cursor: Cursor | null = null;
    while (entries.length < TURN_READ_CAP) {
      const page = await client.fetchAgentTimeline(id, { direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}), limit: Math.min(TURN_PAGE, TURN_READ_CAP - entries.length), projection: "canonical", timeout: 10_000 });
      this.requests++; this.entries += page.entries.length;
      if (page.error) throw new Error(page.error);
      if (!cursor) state.end = page.endCursor ?? null;
      entries.push(...page.entries);
      if (page.entries.some(e => startsTurn(e.item)) || !page.hasOlder || !page.startCursor) break;
      cursor = page.startCursor;
    }
    return entries.sort((a, b) => a.seqStart - b.seqStart);
  }
}
