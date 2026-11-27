/**
 * A mount reads each thing once (one-read-per-key-at-mount, invariant 142). Several client modules start together
 * (the live list, Home's extras, the Display store, the search shortcut, Home itself) and used to read the same
 * document each for itself: 2026-11-27 (the broad perf check, Home's first open) `settings.display.read` went out three
 * times in the same millisecond and `follow.usage` twice within 3 s. A read made through `sharedRead` joins one with
 * the same key that's in flight, or reuses its answer for `freshMs` after it was sent (0: in flight only). Use it for
 * reads only: a write never goes through it, and a read that must see a write just made passes `freshMs` 0.
 */
const held = new Map<string, { at: number; value: Promise<unknown>; done: boolean }>();
export function sharedRead<T>(key: string, read: () => Promise<T>, freshMs = 0): Promise<T> {
  const now = Date.now(); const h = held.get(key);
  if (h && (!h.done || now - h.at < freshMs)) return h.value as Promise<T>;
  const value = read();
  const entry = { at: now, value: value as Promise<unknown>, done: false };
  held.set(key, entry);
  value.then(() => { entry.done = true; if (!freshMs && held.get(key) === entry) held.delete(key); }, () => { if (held.get(key) === entry) held.delete(key); });
  return value;
}
/** The meters' answer is reused this long: the open read and the poll that starts when the home feed says so. */
export const USAGE_SHARED_MS = 10_000;
/** Tests: forget every held read. */
export const resetSharedReads = () => held.clear();
