/**
 * Copy on access: the one way a store hands a mutation its draft (invariant a-mutation-copies-only-what-it-changes).
 *
 * A store keeps its saved value deep-frozen. A mutation gets a draft that looks like a plain mutable copy, but nothing is
 * copied until the mutation reads it: a top-level field is copied when first read, and an item of a named collection
 * (inbox entries, state workspaces, linked workspaces) when that item is first read. `finish()` then builds the next
 * value from the saved one: every field or item the mutation didn't touch, or touched without changing, is the saved
 * (frozen) object itself, and it says exactly what changed, so the store validates and freezes only that and writes
 * nothing when nothing changed.
 *
 * 2026-11-13: InboxStore structuredCloned, validated and stringified the whole inbox (86 entries, 133 KB) 4–5 times per
 * mutation, several mutations per agent turn. Under live's turn rate that was 28% of the worker's 4.3 MB/s, and RSS
 * stepped 315 → 405 MB with a harness-sized JS heap (the second store with the bug after #139's Store.mutate).
 */
type Obj = Record<string, unknown>;
export type Collection = { kind: "record" } | { kind: "array"; id: (item: never) => string };
export type Changes = {
  /** Top-level fields whose value changed (a collection counts when an item was added, removed, replaced or changed). */
  fields: Set<string>;
  /** Per collection field: ids (record keys or the array's id) of items added or changed. */
  items: Map<string, Set<string>>;
  /** Per collection field: ids removed. */
  removed: Map<string, Set<string>>;
};
export type Finished<T> = { next: T; changed: boolean; changes: Changes };

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null;

/**
 * Whether two values would save the same: JSON-equal, ignoring key order and undefined properties (the schema
 * normalizes both). Anything else (a Date, a Map) counts as different, so a real change is never skipped.
 */
export function sameJson(a: unknown, b: unknown, ignore?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i], ignore)) return false;
    return true;
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  let keys = 0;
  for (const key in x) { if (x[key] === undefined || ignore?.has(key)) continue; keys++; if (!Object.hasOwn(y, key) || !sameJson(x[key], y[key], ignore)) return false; }
  for (const key in y) if (y[key] !== undefined && !ignore?.has(key)) keys--;
  return keys === 0;
}

/** Freezes a value and everything in it, so a caller that mutates a shared snapshot throws (strict mode). */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** A plain, mutable copy of a (possibly frozen) JSON value. */
const copy = <T>(v: T): T => structuredClone(v);

type Tracked = { target: Obj | unknown[]; copied: Set<string> };

export function copyOnAccess<T extends object>(saved: T, collections: Readonly<Record<string, Collection>> = {}): { draft: T; finish(): Finished<T> } {
  const proxies = new WeakMap<object, Tracked>();
  const collection = (field: string, value: object): object => {
    const target: Obj | unknown[] = Array.isArray(value) ? [...value] : { ...(value as Obj) };
    const copied = new Set<string>();
    const proxy = new Proxy(target, {
      get(t, k, receiver) {
        if (typeof k !== "string" || !Object.hasOwn(t, k) || copied.has(k) || (Array.isArray(t) && k === "length")) return Reflect.get(t, k, receiver);
        const v = (t as Obj)[k];
        if (isObject(v)) { (t as Obj)[k] = copy(v); copied.add(k); }
        return (t as Obj)[k];
      },
      set(t, k, v) { if (typeof k === "string") copied.add(k); return Reflect.set(t, k, v); },
      deleteProperty(t, k) { if (typeof k === "string") copied.delete(k); return Reflect.deleteProperty(t, k); },
    });
    proxies.set(proxy, { target, copied });
    void field;
    return proxy;
  };
  const root: Obj = { ...(saved as Obj) };
  const touched = new Set<string>();
  const draft = new Proxy(root, {
    get(t, k, receiver) {
      if (typeof k !== "string" || !Object.hasOwn(t, k) || touched.has(k)) return Reflect.get(t, k, receiver);
      const v = t[k]; touched.add(k);
      if (isObject(v)) t[k] = collections[k] ? collection(k, v) : copy(v);
      return t[k];
    },
    set(t, k, v) { if (typeof k === "string") touched.add(k); return Reflect.set(t, k, v); },
    deleteProperty(t, k) { if (typeof k === "string") touched.add(k); return Reflect.deleteProperty(t, k); },
  }) as T;

  const finish = (): Finished<T> => {
    const before = saved as Obj;
    const next: Obj = {};
    const changes: Changes = { fields: new Set(), items: new Map(), removed: new Map() };
    for (const k of new Set([...Object.keys(before), ...Object.keys(root)])) {
      if (!Object.hasOwn(root, k)) { if (before[k] !== undefined) changes.fields.add(k); continue; }
      const was = before[k];
      if (!touched.has(k)) { next[k] = was; continue; }
      const now = unwrap(root[k]);
      const kind = collections[k];
      if (kind && isObject(now) && isObject(was)) {
        const { value, items, removed } = merge(kind, was, now, proxies.get(root[k] as object));
        next[k] = value;
        if (value !== was) { changes.fields.add(k); changes.items.set(k, items); changes.removed.set(k, removed); }
        continue;
      }
      if (sameJson(now, was)) next[k] = was;
      else { next[k] = now; changes.fields.add(k); }
    }
    return { next: next as T, changed: changes.fields.size > 0, changes };
  };

  /** A draft value that is (or holds at its top) one of this draft's collection proxies, as a plain value. */
  const unwrap = (v: unknown): unknown => {
    const tracked = isObject(v) ? proxies.get(v) : undefined;
    if (!tracked) return v;
    return Array.isArray(tracked.target) ? [...tracked.target] : { ...tracked.target };
  };

  return { draft, finish };
}

/** The next collection: saved items where nothing changed (by identity first, then by value), the draft's otherwise. */
function merge(kind: Collection, was: object, now: object, tracked: Tracked | undefined) {
  const items = new Set<string>(); const removed = new Set<string>();
  if (kind.kind === "record") {
    const a = was as Obj, b = now as Obj; const value: Obj = {}; let same = Object.keys(a).length === Object.keys(b).length;
    for (const k of Object.keys(b)) {
      const v = b[k];
      if (Object.hasOwn(a, k) && (v === a[k] || (!tracked || tracked.copied.has(k)) && sameJson(v, a[k]))) value[k] = a[k];
      else { value[k] = v; items.add(k); same = false; }
    }
    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) { removed.add(k); same = false; }
    return { value: same ? was : value, items, removed };
  }
  const id = kind.id as (item: unknown) => string;
  const a = was as unknown[], b = now as unknown[];
  const byId = new Map(a.map(item => [id(item), item]));
  const value = b.map(item => { const old = byId.get(id(item)); if (old !== undefined && (item === old || sameJson(item, old))) return old; items.add(id(item)); return item; });
  const kept = new Set(b.map(item => id(item)));
  for (const k of byId.keys()) if (!kept.has(k)) removed.add(k);
  const same = !items.size && !removed.size && value.length === a.length && value.every((v, i) => v === a[i]);
  return { value: same ? was : value, items, removed };
}

/**
 * A mutation's return value as a plain, private copy. It may hold (or be) a draft proxy, which structuredClone refuses;
 * JSON is what the stores save, so a JSON round trip loses nothing a caller could rely on.
 */
export function detach<T>(value: T): T {
  if (!isObject(value)) return value;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)) as T; }
}
