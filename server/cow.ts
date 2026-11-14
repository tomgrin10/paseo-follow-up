/**
 * Copy on access: the one way a store hands a mutation its draft (invariant a-mutation-copies-only-what-it-changes).
 * A write that changes nothing isn't a write: 2026-11-13, every engine tick's applyDiscovery set each workspace's
 * title, dormant flag, contributors and inventory to the values they had, copying, stringifying and validating every
 * workspace per tick (tests/discovery-noop.test.ts).
 *
 * A store keeps its saved value deep-frozen. A mutation gets a draft that looks like a plain mutable copy, but nothing is
 * copied until the mutation reads it: a top-level field is copied when first read. An item of a named collection
 * (inbox entries, state workspaces, linked workspaces) is copied only when the mutation could change it: on a write, or
 * on reading one of its nested objects or arrays. Reading its plain values (`w.id` in a `find`) copies nothing, so a
 * search through every workspace doesn't clone them all (2026-11-13, branch profile: 51 MB of 418 MB allocated per 5 min
 * was `workspaces.find` cloning each workspace it passed). `finish()` then builds the next
 * value from the saved one: every field or item the mutation didn't touch, or touched without changing, is the saved
 * (frozen) object itself, and it says exactly what changed, so the store validates and freezes only that and writes
 * nothing when nothing changed.
 *
 * 2026-11-13: InboxStore structuredCloned, validated and stringified the whole inbox (86 entries, 133 KB) 4–5 times per
 * mutation, several mutations per agent turn. Under live's turn rate that was 28% of the worker's 4.3 MB/s, and RSS
 * stepped 315 → 405 MB with a harness-sized JS heap (the second store with the bug after #139's Store.mutate).
 */
type Obj = Record<string, unknown>;
/**
 * How a top-level field is drafted. `record` and `array` hand out a lazy view per item. `frozen` is a field that is only
 * ever read whole and replaced whole (InboxState.briefOrigins, a 500-item log): the draft hands out the saved, frozen
 * value itself (an in-place write throws), and a replacement keeps the saved items it carries over as they are.
 */
export type Collection = { kind: "record" } | { kind: "array"; id: (item: never) => string } | { kind: "frozen" };
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

/** A collection's draft: its target, the items written or copied, and the ids deleted (finish reads only these). */
type Tracked = { target: Obj | unknown[]; copied: Set<string>; deleted: Set<string> };
/** One collection item behind its views: the saved (frozen) item until a real write, then a private copy of it. */
type Item = { saved: object; clone: object | null; map: Map<object, object> | null; onCopy: () => void; views: WeakMap<object, object> };
/** Every view of a saved node (the item itself or anything inside it): which item, and which saved node. */
const views = new WeakMap<object, { item: Item; node: object }>();

/** Pairs each saved node with its copy, so a view handed out before the copy keeps pointing at the same object. */
function pair(a: unknown, b: unknown, map: Map<object, object>): void {
  if (!isObject(a) || !isObject(b)) return;
  map.set(a, b);
  for (const k of Object.keys(a)) pair((a as Obj)[k], (b as Obj)[k], map);
}
function own(item: Item): void {
  if (item.clone) return;
  item.clone = copy(item.saved); item.map = new Map(); pair(item.saved, item.clone, item.map); item.onCopy();
}
/**
 * What a draft value stands for, to read without views: the saved (frozen) node, or the item's copy once written, or
 * the value itself when it isn't a view. A pure reader that walks a whole draft item (InboxStore's reduce copies the
 * entry it is given) reads this instead, so the walk makes no view per nested object; it must never write to it.
 */
export function peek<T>(v: T): T { return resolve(v) as T; }
/** The plain value a view stands for: its item's copy of the node once copied, else the saved node itself. */
const resolve = (v: unknown): unknown => {
  const view = isObject(v) ? views.get(v) : undefined;
  if (!view) return v;
  return view.item.map?.get(view.node) ?? view.node;
};
/** A value about to be stored in a copied item: views inside it become plain objects the item owns. */
function plain(v: unknown, into?: Item): unknown {
  // Saved values are deep-frozen and never hold a view: nothing to do (and no walk through an untouched workspace).
  if (!isObject(v) || Object.isFrozen(v)) return v;
  const view = isObject(v) ? views.get(v) : undefined;
  if (view) {
    // The item's own copy of that node when it's being stored back into the same (copied) item; else a fresh copy,
    // since a saved node is frozen and another item's copy is that item's.
    const n = view.item === into ? into.map?.get(view.node) : undefined;
    return n ?? copy(view.item.map?.get(view.node) ?? view.node);
  }
  // A copy only from the first part that holds a view (a-mutation-costs-what-it-changes): 2026-11-14, every new entry
  // a turn stored was shadow-copied whole and the copy thrown away, 37 MB per 5 min under live's turn rate.
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < v.length; i++) { const x = v[i], p = plain(x, into); if (p !== x) (out ??= v.slice())[i] = p; }
    return out ?? v;
  }
  if (Object.getPrototypeOf(v) === Object.prototype) {
    let out: Obj | null = null;
    for (const k of Object.keys(v)) { const x = (v as Obj)[k], p = plain(x, into); if (p !== x) (out ??= { ...(v as Obj) })[k] = p; }
    return out ?? v;
  }
  return v;
}

/**
 * A lazy view of `node`, a saved part of `item`. Reads come from the saved node, and an object inside it is handed
 * out as another view, so reading copies nothing. A write that changes nothing (the same JSON value, or deleting a
 * field that isn't there) isn't a write. Any other write copies the whole item once, and from then on every view
 * reads and writes the copy.
 */
function view(item: Item, node: object): object {
  const known = item.views.get(node);
  if (known) return known;
  const live = () => (item.map?.get(node) ?? node) as Obj;
  const proxy = new Proxy(Array.isArray(node) ? [] : {}, {
    get(_, k) {
      const n = live(); const v = Reflect.get(n, k);
      if (item.clone || !isObject(v) || typeof k !== "string" || !Object.hasOwn(n, k)) return v;
      return view(item, v);
    },
    set(_, k, v) {
      if (!item.clone && typeof k === "string" && Object.hasOwn(node, k) && sameJson(resolve(v), (node as Obj)[k])) return true;
      own(item); return Reflect.set(live(), k, plain(v, item));
    },
    deleteProperty(_, k) {
      if (!item.clone && !Object.hasOwn(node, k)) return true;
      own(item); return Reflect.deleteProperty(live(), k);
    },
    defineProperty(_, k, d) { own(item); return Reflect.defineProperty(live(), k, { ...d, value: plain(d.value, item) }); },
    has(_, k) { return Reflect.has(live(), k); },
    ownKeys() { return Reflect.ownKeys(live()); },
    getOwnPropertyDescriptor(_, k) {
      const d = Reflect.getOwnPropertyDescriptor(live(), k);
      if (!d) return d;
      // An array view's own `length` mirrors the target's: non-configurable, as the proxy invariants require.
      if (Array.isArray(node) && k === "length") return { value: d.value, writable: true, enumerable: false, configurable: false };
      return { value: d.value, writable: true, enumerable: d.enumerable, configurable: true };
    },
  });
  item.views.set(node, proxy);
  views.set(proxy, { item, node });
  return proxy;
}
/** A collection item as stored: a view resolves to its item's saved object or copy; a new value is made plain. */
const item = (v: unknown): unknown => {
  const known = isObject(v) ? views.get(v) : undefined;
  if (!known) return plain(v);
  const out = resolve(v);
  // Code may have pushed a view into the item's copy directly (copies hand out plain arrays): make those plain too.
  if (known.item.clone) scrub(out, known.item);
  return out;
};
/** Replaces, in place, every view inside a private copy with a plain value (frozen parts can't hold one). */
function scrub(v: unknown, into: Item): void {
  if (!isObject(v) || Object.isFrozen(v)) return;
  for (const k of Object.keys(v)) {
    const x = (v as Obj)[k];
    if (isObject(x) && views.has(x)) (v as Obj)[k] = plain(x, into); else scrub(x, into);
  }
}
const lazyItem = (saved: Obj, onCopy: () => void): object => view({ saved, clone: null, map: null, onCopy, views: new WeakMap() }, saved);
const lazies = { has: (v: object) => views.has(v) };

export function copyOnAccess<T extends object>(saved: T, collections: Readonly<Record<string, Collection>> = {}): { draft: T; finish(): Finished<T> } {
  const proxies = new WeakMap<object, Tracked>();
  const collection = (field: string, value: object): object => {
    const target: Obj | unknown[] = Array.isArray(value) ? [...value] : { ...(value as Obj) };
    const copied = new Set<string>(); const deleted = new Set<string>();
    const proxy = new Proxy(target, {
      get(t, k, receiver) {
        if (typeof k !== "string" || !Object.hasOwn(t, k) || copied.has(k) || (Array.isArray(t) && k === "length")) return Reflect.get(t, k, receiver);
        const v = (t as Obj)[k];
        if (isObject(v) && !lazies.has(v)) (t as Obj)[k] = lazyItem(v as Obj, () => copied.add(k));
        return (t as Obj)[k];
      },
      set(t, k, v) { if (typeof k === "string") copied.add(k); return Reflect.set(t, k, item(v)); },
      deleteProperty(t, k) { if (typeof k === "string") { copied.delete(k); deleted.add(k); } return Reflect.deleteProperty(t, k); },
    });
    proxies.set(proxy, { target, copied, deleted });
    void field;
    return proxy;
  };
  const root: Obj = { ...(saved as Obj) };
  const touched = new Set<string>();
  const draft = new Proxy(root, {
    get(t, k, receiver) {
      if (typeof k !== "string" || !Object.hasOwn(t, k) || touched.has(k)) return Reflect.get(t, k, receiver);
      if (collections[k]?.kind === "frozen") return t[k];
      const v = t[k]; touched.add(k);
      if (isObject(v)) t[k] = collections[k] ? collection(k, v) : copy(v);
      return t[k];
    },
    // A collection keeps item views (finish resolves them, keeping untouched items' saved objects); anything else is
    // stored plain, so no view reaches the saved value.
    set(t, k, v) {
      if (typeof k === "string") touched.add(k);
      const kind = typeof k === "string" ? collections[k]?.kind : undefined;
      return Reflect.set(t, k, proxies.has(v as object) ? v : kind && kind !== "frozen" && isObject(v) ? v : plain(v));
    },
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
      const kind = collections[k];
      const tracked = isObject(root[k]) ? proxies.get(root[k] as object) : undefined;
      if (kind?.kind === "record" && tracked && isObject(was) && !Array.isArray(tracked.target)) {
        const { value, items, removed } = mergeTouched(was as Obj, tracked);
        next[k] = value;
        if (value !== was) { changes.fields.add(k); changes.items.set(k, items); changes.removed.set(k, removed); }
        continue;
      }
      const now = kind?.kind === "frozen" ? root[k] : unwrap(root[k]);
      if (kind && kind.kind !== "frozen" && isObject(now) && isObject(was)) {
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
    const t = tracked ? tracked.target : v;
    if (!isObject(t)) return t;
    return Array.isArray(t) ? t.map(item) : Object.fromEntries(Object.entries(t).map(([k, x]) => [k, item(x)]));
  };

  return { draft, finish };
}

/**
 * A record collection's next value from only the ids the draft wrote, copied or deleted: the saved record itself when
 * none of them changed, else one copy of it. 2026-11-14: finish rebuilt the whole 86-entry inbox record twice per
 * mutation (unwrap, then merge), no-ops included.
 */
function mergeTouched(was: Obj, tracked: Tracked) {
  const t = tracked.target as Obj; const items = new Set<string>(); const removed = new Set<string>();
  let value: Obj | null = null;
  for (const id of tracked.copied) {
    if (!Object.hasOwn(t, id)) continue;
    const v = item(t[id]);
    if (Object.hasOwn(was, id) && (v === was[id] || sameJson(v, was[id]))) continue;
    (value ??= { ...was })[id] = v; items.add(id);
  }
  for (const id of tracked.deleted) if (Object.hasOwn(was, id) && !Object.hasOwn(t, id)) { value ??= { ...was }; delete value[id]; removed.add(id); }
  return { value: value ?? was, items, removed };
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
  if (kind.kind !== "array") throw new Error(`merge: ${kind.kind} isn't an item collection`);
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
