/**
 * Bounded waits for the worker's teardown (invariant worker-stop-never-waits-on-a-stuck-pass). Stopping clears every
 * timer; a wait with no bound on work stuck on a daemon, Paseo or a CLI that never answers then leaves stop pending
 * forever (a plugin reload waits on the old worker; in tests node aborts the file once nothing else is scheduled).
 * Work still in flight when a bound runs out is abandoned: the store is closed by then, so it can't write
 * (Store.close), and the next start recovers from what was saved.
 */
export const STOP_WAIT_MS = 5_000;

/** Waits for `work` to settle, at most `ms`; true when it settled. Never throws. */
export async function settleWithin(work: Promise<unknown>, ms = STOP_WAIT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([work.then(() => true, () => true), capped]); }
  finally { clearTimeout(timer); }
}
