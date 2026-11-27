import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WriteBehind } from "./write-behind";
import type { MessageQueue, Resolution } from "./message-queue";
import type { State, Workspace } from "../shared/model";
import { WATCHES_PER_AGENT, checkWatchFileSchema, coveredByRepair, watchVerdict, type CheckWatch, type Verdict } from "../shared/check-watch";

export const WATCH_FILE = "check-watches.json";
export const checksItemId = (w: Pick<CheckWatch, "agentId" | "id">) => `checks:${w.agentId}:${w.id}`;

/** What the channel needs to know about the agent when the message goes: nothing here loads it. */
export type WatchAgent = { status: string; archived: boolean; workspaceId: string | null } | null;

/**
 * Wait for checks (docs/wait-for-checks.md; shared/check-watch.ts holds the rules). The watches live in memory and
 * save behind the reply (an-ack-never-waits-on-the-disk). `evaluate` runs after each engine pass on the state that pass
 * wrote, so a watch costs no GitHub read of its own (waiting-for-checks-adds-no-github-read): its PR only counts as
 * due at the running-checks cadence (`watched`). A verdict becomes one `checks` message on the queue
 * (a-message-is-saved-before-sent-and-arrives-once), sent even when Paseo unloaded the requesting agent
 * (a-requested-verdict-reopens-an-unloaded-agent), and never beside a repair that carries the same failure
 * (a-waited-for-failure-is-sent-once).
 */
export class CheckWatches {
  private value: CheckWatch[] | null = null;
  readonly persist: WriteBehind<{ version: 1; watches: CheckWatch[] }>;
  private queue: MessageQueue | null = null;
  /** Fired verdicts (for tests and the docs' counts). */
  readonly fired: { watch: CheckWatch; verdict: Verdict; sent: boolean; why: string }[] = [];
  constructor(readonly directory: string, private deps: {
    snapshot: () => Promise<State>;
    /** When the PR's content last changed (or Follow-up first saw it), from the reads already made; null: unknown. */
    quietSince?: (prKey: string) => number | null;
    agent: (agentId: string) => Promise<WatchAgent>;
    now?: () => number;
  }) {
    this.persist = new WriteBehind({ path: join(directory, WATCH_FILE), encode: v => JSON.stringify(v) });
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  async flush(): Promise<void> { await this.persist.flush(); }
  private async load(): Promise<CheckWatch[]> {
    if (this.value) return this.value;
    let watches: CheckWatch[];
    try { watches = checkWatchFileSchema.parse(JSON.parse(await readFile(join(this.directory, WATCH_FILE), "utf8"))).watches; }
    catch { watches = []; } // A lost file costs the agent a call again, never a broken worker.
    // A worker that stopped mid-answer left the flag on: the call it belonged to is gone, so the watch messages now.
    this.value ??= watches.map(w => w.answering ? { ...w, answering: false } : w);
    return this.value;
  }
  private save(watches: CheckWatch[]): void {
    this.value = watches;
    this.persist.set({ version: 1, watches });
  }
  async list(agentId?: string): Promise<CheckWatch[]> {
    const all = await this.load();
    return agentId ? all.filter(w => w.agentId === agentId) : all;
  }
  /** PR key → when its oldest watch began: github.ts reads it at the running-checks cadence, and once after that time. */
  watched(): Map<string, number> {
    const out = new Map<string, number>();
    for (const w of this.value ?? []) { const at = Date.parse(w.createdAt); out.set(w.prKey, Math.min(out.get(w.prKey) ?? at, at)); }
    return out;
  }
  /** One watch per agent and PR: asking again restarts its clock and keeps what it learned. */
  async add(input: { agentId: string; workspaceId: string; prKey: string; url: string; ms: number }): Promise<CheckWatch> {
    const watches = await this.load();
    const at = new Date(this.now());
    const existing = watches.find(w => w.agentId === input.agentId && w.prKey === input.prKey);
    if (!existing && watches.filter(w => w.agentId === input.agentId).length >= WATCHES_PER_AGENT) throw new Error(`You already wait on ${WATCHES_PER_AGENT} PRs. End your turn; Follow-up messages you as each finishes.`);
    const watch: CheckWatch = { id: existing?.id ?? randomUUID(), agentId: input.agentId, workspaceId: input.workspaceId, prKey: input.prKey, url: input.url,
      createdAt: at.toISOString(), until: new Date(at.getTime() + input.ms).toISOString(), answering: true, runningHead: existing?.runningHead ?? null };
    this.save([...watches.filter(w => w !== existing), watch]);
    return watch;
  }
  /** Ends the tool call's hold: a verdict it reported itself ends the watch; otherwise the watch messages later. */
  async answered(id: string, ended: boolean): Promise<void> {
    const watches = await this.load();
    const next = ended ? watches.filter(w => w.id !== id) : watches.map(w => w.id === id && w.answering ? { ...w, answering: false } : w);
    if (next.length !== watches.length || next.some((w, i) => w !== watches[i])) this.save(next);
  }
  async cancel(agentId: string, prKey?: string): Promise<number> {
    const watches = await this.load();
    const next = watches.filter(w => !(w.agentId === agentId && (!prKey || w.prKey === prKey)));
    if (next.length !== watches.length) this.save(next);
    return watches.length - next.length;
  }
  /** The verdict for one watch now, from the stored PR (the tool's immediate answer). */
  async check(watch: CheckWatch): Promise<{ fire: Verdict | null; next: CheckWatch }> {
    const state = await this.deps.snapshot();
    const w = state.workspaces.find(x => x.id === watch.workspaceId);
    return watchVerdict(watch, w?.prs.find(p => p.key === watch.prKey), this.now(), this.deps.quietSince?.(watch.prKey) ?? null);
  }
  /**
   * After an engine pass: every watch on those workspaces (all when `ids` is absent) against the state the pass left.
   * Pure reads of the snapshot; a verdict saves one queue item and drops the watch. Watches whose tool call is still
   * answering are left to it.
   */
  async evaluate(ids?: ReadonlySet<string>): Promise<void> {
    const watches = await this.load();
    if (!watches.length) return;
    const state = await this.deps.snapshot();
    const now = this.now();
    let next: CheckWatch[] | null = null;
    for (const watch of watches) {
      if (watch.answering || ids && !ids.has(watch.workspaceId)) continue;
      const w = state.workspaces.find(x => x.id === watch.workspaceId);
      const pr = w && w.enable_tracking && !w.archived ? w.prs.find(p => p.key === watch.prKey) : undefined;
      const { fire, next: updated } = watchVerdict(watch, pr, now, this.deps.quietSince?.(watch.prKey) ?? null);
      if (!fire && updated === watch) continue;
      next ??= [...watches];
      const index = next.indexOf(watch);
      if (!fire) { next[index] = updated; continue; }
      next.splice(index, 1);
      await this.deliver(watch, fire, w);
    }
    if (next) this.save(next);
  }
  private async deliver(watch: CheckWatch, verdict: Verdict, w: Workspace | undefined): Promise<void> {
    if (verdict.kind === "failed" && w && coveredByRepair(w, watch.agentId, watch.prKey)) { this.fired.push({ watch, verdict, sent: false, why: "repair" }); return; }
    if (!w || w.archived) { this.fired.push({ watch, verdict, sent: false, why: "workspace archived" }); return; }
    // Archived: the watch ends with nothing sent. Unknown keeps the message; the channel checks again when it goes.
    const agent = await this.deps.agent(watch.agentId).catch(() => null);
    if (agent?.archived) { this.fired.push({ watch, verdict, sent: false, why: "archived" }); return; }
    if (!this.queue) { this.fired.push({ watch, verdict, sent: false, why: "no queue" }); return; }
    this.queue.enqueue({ id: checksItemId(watch), kind: "checks", key: watch.workspaceId, ref: { agentId: watch.agentId, workspaceId: watch.workspaceId, prKey: watch.prKey },
      messageId: `checks-${watch.id}-${Date.parse(watch.createdAt).toString(36)}`, text: verdict.text, priority: "now", state: "queued" });
    this.fired.push({ watch, verdict, sent: true, why: "queued" });
  }
  /** The queue's `checks` channel: the agent is resolved when the message goes, Paseo reopens unloaded agents; archived targets cancel. */
  attachQueue(queue: MessageQueue): void {
    this.queue = queue;
    queue.register("checks", {
      resolve: async (item): Promise<Resolution> => {
        const w = (await this.deps.snapshot()).workspaces.find(w => w.id === item.ref.workspaceId);
        if (!w || w.archived) return { cancel: "The workspace was archived, so the checks result wasn't sent." };
        let agent: WatchAgent;
        try { agent = await this.deps.agent(item.ref.agentId!); }
        catch { return { defer: "Paseo unreachable" }; }
        if (!agent || agent.archived) return { cancel: "The agent was archived, so the checks result wasn't sent." };
        if (item.state === "queued" && ["running", "initializing"].includes(agent.status)) return { defer: "waits for the agent's turn to end" };
        return { target: { workspaceId: agent.workspaceId, recipients: [item.ref.agentId!] } };
      },
      project: async () => undefined,
    });
  }
}
