/**
 * The worker's teardown (invariant worker-stop-never-waits-on-a-stuck-pass): stop finishes within one deadline, and
 * work that ends inside it is kept. Stopping clears every timer; a wait with no bound on work stuck on a daemon, Paseo
 * or a CLI that never answers then left stop pending forever (a plugin reload waits on the old worker; in tests node
 * aborts the file once nothing else is scheduled). Bounding each wait on its own wasn't enough: run one after another
 * they added up to about 45 s, so the deadline starts with stop and every wait gets what is left of it.
 * Work that outlives the deadline is abandoned and writes nothing (Store.close); the next start recovers from what
 * was saved.
 */
export const STOP_WAIT_MS = 5_000;
/** The end of the deadline kept for saving what finished in time: work waits stop this much earlier. */
const SAVE_SHARE = 0.2;
const SAVE_MAX_MS = 1_000;

/** A point in time that waits share: each gets what is left. */
export interface Deadline { readonly at: number; left(): number; expired(): boolean }
export function deadline(ms = STOP_WAIT_MS, now = Date.now()): Deadline {
  const at = now + ms;
  return { at, left: () => Math.max(0, at - Date.now()), expired: () => Date.now() >= at };
}
/**
 * A stop's deadline, `ms` from now, in two parts: waits on work end at `work`, leaving the rest until `save` for
 * writing what finished in time.
 */
export function stopDeadline(ms = STOP_WAIT_MS): { work: Deadline; save: Deadline } {
  const save = deadline(ms);
  return { work: deadline(0, save.at - Math.min(SAVE_MAX_MS, ms * SAVE_SHARE)), save };
}

/** Waits for `work` to settle, at most until the deadline (or `ms` from now); true when it settled. Never throws. */
export async function settleWithin(work: Promise<unknown>, within: number | Deadline = STOP_WAIT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ms = typeof within === "number" ? within : within.left();
  const capped = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([work.then(() => true, () => true), capped]); }
  finally { clearTimeout(timer); }
}
export interface WorkerParts {
  /** Start-up; it ends by sending to the daemon, so it may be stuck. */
  ready: Promise<unknown>;
  hooks?: () => Promise<unknown>;
  actions: { close(within: Deadline): Promise<void> };
  closeConnections(within: Deadline): Promise<void>;
  engine: { stop(within: Deadline): Promise<void> };
  store: { close(work: Deadline, save: Deadline): Promise<void> };
  unlock?: (() => Promise<unknown>) | null;
}
/**
 * Stops the worker within `ms` from now. Waits on work (start-up, hooks, PR actions, connections, the sync pass, the
 * store's queue) end a little early, so what finished in time is still saved before the deadline; then the lock goes.
 */
export async function stopWorker(parts: WorkerParts, ms = STOP_WAIT_MS): Promise<void> {
  const { work, save } = stopDeadline(ms);
  // Each part bounds its own waits by the deadline it is given; the deadline bounds the call too, so one part that
  // doesn't (or a hook that hangs) can't stretch the stop.
  const step = (run: () => unknown, by = work) => settleWithin(Promise.resolve().then(run), by);
  await settleWithin(parts.ready, work);
  if (parts.hooks) await step(parts.hooks);
  await step(() => parts.actions.close(work));
  await step(() => parts.closeConnections(work));
  await step(() => parts.engine.stop(work));
  await settleWithin(parts.ready, work);
  await step(() => parts.store.close(work, save), save);
  if (parts.unlock) await step(parts.unlock, save);
}
