import type { PluginClientContext } from "@getpaseo/plugin/client";
import { inboxActRpc, inboxFeed, inboxListRpc } from "../shared/contracts";
import { subscribeFeed } from "./feeds";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { InboxRow } from "../shared/inbox";
import { subscribeDisplay } from "./display";
import { onVisible, whileVisible } from "./visibility";
import { createDoneWindows } from "./done-windows";

type List = RpcOutput<typeof inboxListRpc>;
/**
 * The last sign-off or Later on this client, for the Undo bar and the pill (6 s). A Later keeps each row's earlier
 * snooze so Undo can put it back at once, and `until` for the bar's wording.
 */
export type Recent = { agentIds: string[]; label: string; at: number; batch: boolean } & ({ kind: "sign_off" } | { kind: "later"; until: string; prev: Record<string, InboxRow["snooze"]> }
  /** A workspace's own Later (no agent flag): `restore` puts back the workspace snooze it replaced. */
  | { kind: "later_ws"; until: string; restore: () => Promise<void>; /** The Home row's key, where focus goes after Undo. */ key?: string });
/**
 * The backstop poll. Changes arrive sooner by push: an agent's status or attention changing in Paseo's agent stream
 * calls `nudge` (1.4.0). Nothing polls while the app is hidden; it refreshes once on return.
 */
const POLL_MS = 15_000;

/**
 * One shared poll of the inbox for every surface on this client. Sign-offs apply optimistically;
 * while the host is unreachable they queue with the seq they were made against and replay on
 * reconnect. The daemon drops a replay whose agent moved on, and that agent is reported as
 * "came back while offline" rather than silently cleared.
 */
export function createInboxStore(client: PluginClientContext) {
  let data: List | null = null;
  let offlineSince: number | null = null;
  let failures = 0;
  let version = 0;
  let enabled = true;
  /** Agents with a sign-off or snooze on the wire. A second identical click (or a double-mounted popover) is dropped. */
  const inflight = new Set<string>();
  let pending: { agentId: string; seq: number }[] = [];
  let cameBack: string[] = [];
  let recent: Recent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const listeners = new Set<() => void>();
  const emit = () => { version++; for (const l of listeners) l(); };
  const dones = createDoneWindows(emit);
  const rpcList = (): Promise<List> => client.rpc(inboxListRpc, data?.etag ? { etag: data.etag } : {});
  const act = (input: RpcInput<typeof inboxActRpc>) => client.rpc(inboxActRpc, input);

  let feed: (() => void) | null = null;
  /** Sign-offs queued while the worker was unreachable go out before the next read. */
  const flush = async () => {
    if (!pending.length) return;
    const queued = pending; pending = [];
    try {
      const result = await act({ action: "sign_off", agentIds: queued.map(p => p.agentId), seqs: Object.fromEntries(queued.map(p => [p.agentId, p.seq])) });
      cameBack = [...cameBack, ...result.results.filter(r => r.cameBack).map(r => r.agentId)];
    } catch (error) { pending = [...queued, ...pending]; throw error; }
  };
  const apply = (next: List) => {
      // Nothing changed since the answer this store holds: keep it, and only re-render if we were offline.
      if (next.unchanged && data) { if (offlineSince !== null || failures) { offlineSince = null; failures = 0; emit(); } return; }
      data = next; offlineSince = null; failures = 0;
      // Rows signed off while offline stay hidden until the replay lands.
      emit();
  };
  // Paseo 0.15 polls the etag'd list; 0.16 gets it pushed (follow.inbox-feed) and polls nothing.
  const poll = async () => {
    try {
      await flush();
      const next = await rpcList();
      if (stopped || feed) return;
      apply(next);
    } catch {
      failures++;
      if (failures >= 2 && offlineSince === null) { offlineSince = Date.now(); emit(); }
    } finally { if (!stopped && !feed) timer = whileVisible(POLL_MS, () => void poll()); }
  };
  /** After an action: the feed pushes the change by itself (only queued sign-offs go out); polling hosts read at once. */
  const refresh = () => { if (feed) { void flush().catch(() => undefined); return; } if (timer) clearTimeout(timer); void poll(); };
  let nudged: ReturnType<typeof setTimeout> | null = null;
  /** Something changed in Paseo: refresh soon, coalescing a burst of agent updates into one read. */
  const nudge = () => { if (nudged || stopped || feed) return; nudged = setTimeout(() => { nudged = null; refresh(); }, 750); };
  const unsubscribe = subscribeDisplay(values => {
    const on = values.enable_inbox !== false;
    if (on !== enabled) { enabled = on; emit(); if (on) refresh(); }
  });
  feed = subscribeFeed(client, inboxFeed, {}, next => { if (stopped) return; void flush().catch(() => undefined); apply(next); }, () => { feed = null; void poll(); });
  const offVisible = onVisible(refresh);
  if (!feed) void poll();

  const patch = (agentIds: string[], change: (row: InboxRow) => InboxRow) => {
    if (!data) return;
    data = { ...data, rows: data.rows.map(r => agentIds.includes(r.agentId) ? change(r) : r) };
    emit();
  };
  const titleOf = (id: string) => { const r = data?.rows.find(x => x.agentId === id) ?? data?.unsorted?.find(x => x.agentId === id); return r ? r.workspaceTitle && r.multiRoot ? `${r.workspaceTitle} › ${r.title}` : r.workspaceTitle ?? r.title : "agent"; };

  const labelOf = (agentIds: string[]) => agentIds.length === 1 ? titleOf(agentIds[0]) : `${agentIds.length} agents`;

  const signOffNow = async (agentIds: string[], options: { muteTurn?: boolean }) => {
    const seqs = Object.fromEntries((data?.rows ?? []).filter(r => agentIds.includes(r.agentId)).map(r => [r.agentId, r.seq]));
    const at = new Date().toISOString();
    patch(agentIds, r => ({ ...r, needs: null, snooze: null, signedOffAt: at, undoable: true, muteTurn: !!options.muteTurn || r.muteTurn }));
    recent = { kind: "sign_off", agentIds, label: labelOf(agentIds), at: Date.now(), batch: agentIds.length > 1 };
    emit();
    try {
      const result = await act({ action: options.muteTurn ? "mute_turn" : "sign_off", agentIds, seqs });
      cameBack = [...cameBack, ...result.results.filter(r => r.cameBack).map(r => r.agentId)];
    } catch {
      pending = [...pending.filter(p => !agentIds.includes(p.agentId)), ...agentIds.map(agentId => ({ agentId, seq: seqs[agentId] ?? 0 }))];
      return;
    }
    refresh();
  };

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    enabled: () => enabled && (data?.enabled ?? true),
    data: () => data,
    rows: () => (enabled && data?.enabled ? data.rows : []),
    /** The Overseer's own row: never in rows, never counted (1.4.0-beta.0). */
    overseer: () => data?.overseer ?? null,
    offlineSince: () => offlineSince,
    cameBack: () => cameBack,
    clearCameBack() { cameBack = []; emit(); },
    recent: () => recent,
    clearRecent() { recent = null; emit(); },
    refresh,
    nudge,
    stop() { stopped = true; feed?.(); offVisible(); if (timer) clearTimeout(timer); if (nudged) clearTimeout(nudged); listeners.clear(); unsubscribe(); },

    /** Sign off now; queue for replay when the host can't be reached. */
    async signOff(requested: string[], options: { muteTurn?: boolean } = {}) {
      const agentIds = requested.filter(id => !inflight.has(id));
      if (!agentIds.length) return;
      for (const id of agentIds) inflight.add(id);
      try { await signOffNow(agentIds, options); } finally { for (const id of agentIds) inflight.delete(id); }
    },
    async snooze(requested: string[], until: string) {
      const agentIds = requested.filter(id => !inflight.has(id));
      if (!agentIds.length) return;
      for (const id of agentIds) inflight.add(id);
      try {
        // Only flagged rows take a Later (the daemon ignores the rest), so only they get an Undo.
        const flagged = (data?.rows ?? []).filter(r => agentIds.includes(r.agentId) && r.needs);
        const prev = Object.fromEntries(flagged.map(r => [r.agentId, r.snooze]));
        patch(agentIds, r => ({ ...r, snooze: { until, at: new Date().toISOString() } }));
        if (flagged.length) recent = { kind: "later", agentIds: flagged.map(r => r.agentId), label: labelOf(flagged.map(r => r.agentId)), at: Date.now(), batch: false, until, prev };
        emit();
        await act({ action: "snooze", agentIds, until });
      } finally { for (const id of agentIds) inflight.delete(id); }
      refresh();
    },
    /** Bring back now: the rows leave Later for Needs you at once; the daemon confirms on the next read. */
    async unsnooze(requested: string[]) {
      const agentIds = requested.filter(id => !inflight.has(id));
      if (!agentIds.length) return;
      for (const id of agentIds) inflight.add(id);
      try {
        patch(agentIds, r => r.needs ? { ...r, snooze: null } : r);
        await act({ action: "unsnooze", agentIds });
      } finally { for (const id of agentIds) inflight.delete(id); }
      refresh();
    },
    /** A workspace Later, for the same Undo bar. */
    noteLater(label: string, until: string, restore: () => Promise<void>, key?: string) {
      recent = { kind: "later_ws", agentIds: [], label, at: Date.now(), batch: false, until, restore, key };
      emit();
    },
    /** Done's Undo windows (client/done-windows.ts): the pill says Done until that agent's toast ends. */
    noteDone: (agentId: string, cancel: () => void) => dones.note(agentId, cancel),
    endDone: (agentId: string) => dones.end(agentId),
    doneWindow: (agentId: string) => dones.has(agentId),
    async undo(agentIds?: string[]) {
      if (agentIds && dones.undo(agentIds)) return;
      if (!agentIds && recent?.kind === "later_ws") { const { restore } = recent; recent = null; emit(); await restore(); return; }
      const target = agentIds ?? recent?.agentIds ?? [];
      const batch = !agentIds && recent?.batch;
      // A Later's undo shows at once: each row gets its earlier snooze back before the daemon confirms.
      if (recent?.kind === "later") { const prev = recent.prev; patch(target.filter(id => id in prev), r => ({ ...r, snooze: prev[r.agentId] ?? null })); }
      recent = null;
      pending = pending.filter(p => !target.includes(p.agentId));
      emit();
      if (batch) await act({ action: "batch_undo" }); else if (target.length) await act({ action: "undo", agentIds: target });
      refresh();
    },
    async setFinishFlags(agentId: string, value: boolean) {
      patch([agentId], r => ({ ...r, enable_finish_flags: value }));
      await act({ action: "set_finish_flags", agentIds: [agentId], value }); refresh();
    },
    async unsortedSignOff(agentIds?: string[]) {
      if (data) { data = { ...data, unsorted: agentIds ? data.unsorted?.filter(r => !agentIds.includes(r.agentId)) ?? null : null }; emit(); }
      await act({ action: "unsorted_sign_off", ...(agentIds ? { agentIds } : {}) }); refresh();
    },
    async unsortedFlag(agentIds: string[]) { await act({ action: "unsorted_flag", agentIds }); refresh(); },
    async batchUndo() { await act({ action: "batch_undo" }); refresh(); },
  };
}
export type InboxStore = ReturnType<typeof createInboxStore>;
