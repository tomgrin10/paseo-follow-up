import { useEffect, useRef, useSyncExternalStore } from "react";
import * as plugin from "@getpaseo/plugin";
import * as sdk from "@getpaseo/plugin/client";
import { z } from "zod";
import { isViewKey, localViewStorage, setDeviceBackend, setViewStatus, subscribeView, viewSnapshot, type KeyValue } from "../shared/settings-nav";

/**
 * The device settings document `follow-up-view` (Paseo 0.16, `scope: "device"`): view state only, keyed by the same
 * names the localStorage cache uses (`view-state-is-per-device-settings-are-per-host`). The 0.16 app stores a device
 * document with AsyncStorage: localStorage on web and desktop (no change there), native storage on the phone, where it
 * survives reopening the app. On 0.15, `defineSettings({ scope: "device" })` throws and nothing here runs: view state
 * stays in localStorage or memory, as before.
 */
export const VIEW_SCHEMA = z.object({ migrated: z.boolean().default(false), entries: z.record(z.string(), z.string()).default({}) });
export type ViewValues = z.output<typeof VIEW_SCHEMA>;

type Define = (definition: { id: string; scope: "device"; version: number; schema: typeof VIEW_SCHEMA }) => unknown;
/** The definition, or null where the host can't keep device settings (0.15 SDK throws, or no defineSettings). */
export function viewDefinition(define: unknown = (plugin as { defineSettings?: unknown }).defineSettings): unknown | null {
  if (typeof define !== "function") return null;
  try { return (define as Define)({ id: "follow-up-view", scope: "device", version: 1, schema: VIEW_SCHEMA }); } catch { return null; }
}

/**
 * The first values a device saves: its document if it already migrated, else the document's entries over every view
 * key in the localStorage cache, marked migrated. Seeding runs once per device and never overwrites a saved document.
 */
export function seedValues(values: ViewValues, cache: { keys(): string[]; get(key: string): string | null }): { values: ViewValues; changed: boolean } {
  if (values.migrated) return { values, changed: false };
  const entries: Record<string, string> = {};
  for (const key of cache.keys()) if (isViewKey(key)) { const v = cache.get(key); if (v != null) entries[key] = v; }
  return { values: { migrated: true, entries: { ...entries, ...values.entries } }, changed: true };
}

type State = { status: string; values?: ViewValues; revision?: string; save?(values: ViewValues, revision: string): Promise<boolean>; reload?(): Promise<void> };

/** A KeyValue over the loaded document: reads its entries, writes save the whole document (coalesced). */
export function documentBackend(initial: ViewValues, persist: (values: ViewValues) => void): KeyValue & { replace(values: ViewValues): void } {
  let values = initial;
  return {
    get: key => values.entries[key] ?? null,
    set(key, value) { if (values.entries[key] === value) return; values = { ...values, entries: { ...values.entries, [key]: value } }; persist(values); },
    replace(next) { values = next; },
  };
}

const localKeys = () => { try { const s = (globalThis as { localStorage?: Storage }).localStorage; return s ? Array.from({ length: s.length }, (_, i) => s.key(i) ?? "").filter(Boolean) : []; } catch { return []; } };

// One owner: the first mounted Follow-up surface syncs the document; the rest only read through deviceStorage. When the
// owner unmounts, the next surface takes over; the backend stays in place meanwhile, so reads never fall back.
let owner: symbol | null = null;
const ownerListeners = new Set<() => void>();
const notifyOwner = () => { for (const l of ownerListeners) l(); };
const subscribeOwner = (l: () => void) => { ownerListeners.add(l); return () => { ownerListeners.delete(l); }; };
const ownerSnapshot = () => owner;
const definition = viewDefinition();
const useSettings = (sdk as { useSettings?: (definition: unknown) => State }).useSettings;
/** True where this app keeps the device document: a reader that needs it (What's new "seen") waits for it to load. */
export const viewDocumentExpected = !!definition && typeof useSettings === "function";
if (viewDocumentExpected) setViewStatus("loading");

function useViewSyncLive() {
  const state = useSettings!(definition);
  const me = useRef<symbol>(Symbol("view-sync")).current;
  const current = useSyncExternalStore(subscribeOwner, ownerSnapshot, ownerSnapshot);
  useEffect(() => {
    if (owner == null) { owner = me; notifyOwner(); }
    return () => { if (owner === me) { owner = null; notifyOwner(); } };
  }, [me, current]);
  const mine = current === me;
  // The latest save and revision, read when a write lands (writes chain, so each saves on the revision before it).
  const live = useRef(state); live.current = state;
  const ready = state.status === "ready" && !!state.values && !!state.save;
  useEffect(() => {
    if (!mine) return;
    if (live.current.status === "error") { setViewStatus("failed"); return; }
    if (!ready) return;
    // Only this app writes its device document, so the backend is built once per owner and keeps its own copy.
    let saving = Promise.resolve();
    const persist = (values: ViewValues) => {
      saving = saving.then(async () => { const s = live.current; if (s.save && !await s.save(values, s.revision!)) await s.reload?.(); await new Promise(r => setTimeout(r, 0)); }).catch(() => undefined);
    };
    const seeded = seedValues(live.current.values!, { keys: localKeys, get: key => localViewStorage.get(key) });
    setDeviceBackend(documentBackend(seeded.values, persist));
    if (seeded.changed) persist(seeded.values);
  }, [mine, ready, state.status]);
}

/** Mount once per Follow-up surface. On 0.15 (no device settings) it does nothing. */
export const useViewSync: () => void = viewDocumentExpected ? useViewSyncLive : () => undefined;

/** useViewSync as a component, for surfaces that mount it beside their body. */
export function ViewSync() { useViewSync(); return null; }

/** Re-render on any view-state change (the document arriving, or a write). */
export const useViewVersion = (): number => useSyncExternalStore(subscribeView, viewSnapshot, viewSnapshot);
