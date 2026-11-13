/**
 * Per-card values, keyed by brief id then decision id, shared by every copy of the card on this client (the chat, the
 * panel and Home render the same brief). Module-level and outside React, so a re-render, a refetch from an inbox tick
 * or a remount of the card keeps what the developer picked or typed. In memory only; nothing is sent until Send.
 */
export function cardStore(toggle: boolean) {
  const values = new Map<string, Record<string, string>>(); const listeners = new Set<() => void>();
  const none: Record<string, string> = {};
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    get: (briefId: string) => values.get(briefId) ?? none,
    /** Sets `value`; with `toggle`, the same value again clears that decision (it can then be skipped). Empty clears. */
    set(briefId: string, decisionId: string, value: string) {
      const next = { ...values.get(briefId) };
      if (toggle && next[decisionId] === value || !value) delete next[decisionId]; else next[decisionId] = value;
      values.set(briefId, next); for (const l of listeners) l();
    },
    clear(briefId: string) { if (values.delete(briefId)) for (const l of listeners) l(); },
  };
}
export type CardStore = ReturnType<typeof cardStore>;
