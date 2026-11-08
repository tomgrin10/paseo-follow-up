import type { PluginClientContext } from "@getpaseo/plugin/client";
import { inboxActRpc, inboxListRpc } from "../shared/contracts";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { InboxRow } from "../shared/inbox";
import { subscribeDisplay } from "./display";

type List = RpcOutput<typeof inboxListRpc>;
export type Recent = { agentIds: string[]; label: string; at: number; batch: boolean };
const POLL_MS = 4_000;

/**
 * One shared poll of the inbox for every surface on this client. Sign-offs apply optimistically;
 * while the host is unreachable they queue with the seq they were made against and replay on
 * reconnect. The daemon drops a replay whose agent moved on, and that agent is reported as
 * "came back while offline" rather than silently cleared.
 */
export function createInboxStore(client: PluginClientContext) {
  let data: List | null = null;
  let offlineSince: number | null = null;
  let version = 0;
  let enabled = true;
  let headerWhenEmpty = false;
  let pending: { agentId: string; seq: number }[] = [];
  let cameBack: string[] = [];
  let recent: Recent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const listeners = new Set<() => void>();
  const emit = () => { version++; for (const l of listeners) l(); };
  const rpcList = (): Promise<List> => client.rpc(inboxListRpc, {});
  const act = (input: RpcInput<typeof inboxActRpc>) => client.rpc(inboxActRpc, input);

  const poll = async () => {
    try {
      if (pending.length) {
        const queued = pending; pending = [];
        const result = await act({ action: "sign_off", agentIds: queued.map(p => p.agentId), seqs: Object.fromEntries(queued.map(p => [p.agentId, p.seq])) });
        cameBack = [...cameBack, ...result.results.filter(r => r.cameBack).map(r => r.agentId)];
      }
      const next = await rpcList();
      if (stopped) return;
      data = next; offlineSince = null;
      // Rows signed off while offline stay hidden until the replay lands.
      emit();
    } catch {
      if (offlineSince === null) { offlineSince = Date.now(); emit(); }
    } finally { if (!stopped) timer = setTimeout(() => void poll(), POLL_MS); }
  };
  const refresh = () => { if (timer) clearTimeout(timer); void poll(); };
  const unsubscribe = subscribeDisplay(values => {
    const on = values.enable_inbox !== false; const header = values.enable_inbox_header_when_empty === true;
    if (on !== enabled || header !== headerWhenEmpty) { enabled = on; headerWhenEmpty = header; emit(); if (on) refresh(); }
  });
  void poll();

  const patch = (agentIds: string[], change: (row: InboxRow) => InboxRow) => {
    if (!data) return;
    data = { ...data, rows: data.rows.map(r => agentIds.includes(r.agentId) ? change(r) : r) };
    emit();
  };
  const titleOf = (id: string) => { const r = data?.rows.find(x => x.agentId === id) ?? data?.unsorted?.find(x => x.agentId === id); return r ? r.workspaceTitle && r.multiRoot ? `${r.workspaceTitle} › ${r.title}` : r.workspaceTitle ?? r.title : "agent"; };

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    enabled: () => enabled && (data?.enabled ?? true),
    headerWhenEmpty: () => headerWhenEmpty,
    data: () => data,
    rows: () => (enabled && data?.enabled ? data.rows : []),
    offlineSince: () => offlineSince,
    cameBack: () => cameBack,
    clearCameBack() { cameBack = []; emit(); },
    recent: () => recent,
    clearRecent() { recent = null; emit(); },
    refresh,
    stop() { stopped = true; if (timer) clearTimeout(timer); listeners.clear(); unsubscribe(); },

    /** Sign off now; queue for replay when the host can't be reached. */
    async signOff(agentIds: string[], options: { muteTurn?: boolean } = {}) {
      const seqs = Object.fromEntries((data?.rows ?? []).filter(r => agentIds.includes(r.agentId)).map(r => [r.agentId, r.seq]));
      const at = new Date().toISOString();
      patch(agentIds, r => ({ ...r, needs: null, snooze: null, signedOffAt: at, undoable: true, muteTurn: !!options.muteTurn || r.muteTurn }));
      recent = { agentIds, label: agentIds.length === 1 ? titleOf(agentIds[0]) : `${agentIds.length} agents`, at: Date.now(), batch: agentIds.length > 1 };
      emit();
      try {
        const result = await act({ action: options.muteTurn ? "mute_turn" : "sign_off", agentIds, seqs });
        cameBack = [...cameBack, ...result.results.filter(r => r.cameBack).map(r => r.agentId)];
      } catch {
        pending = [...pending.filter(p => !agentIds.includes(p.agentId)), ...agentIds.map(agentId => ({ agentId, seq: seqs[agentId] ?? 0 }))];
        return;
      }
      refresh();
    },
    async undo(agentIds?: string[]) {
      const target = agentIds ?? recent?.agentIds ?? [];
      const batch = !agentIds && recent?.batch;
      recent = null;
      pending = pending.filter(p => !target.includes(p.agentId));
      emit();
      if (batch) await act({ action: "batch_undo" }); else if (target.length) await act({ action: "undo", agentIds: target });
      refresh();
    },
    async snooze(agentIds: string[], until: string) {
      patch(agentIds, r => ({ ...r, snooze: { until, at: new Date().toISOString() } }));
      await act({ action: "snooze", agentIds, until }); refresh();
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
