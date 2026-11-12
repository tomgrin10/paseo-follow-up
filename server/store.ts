import { settleWithin, stopDeadline, type Deadline } from "./teardown";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateSchema, type State, type Workspace } from "../shared/model";

/**
 * Follow-up's saved state. 1.3.0-beta.4: the state lives in memory once loaded, and writes to state.json are
 * batched (at most one per `writeMs`) and skipped when nothing changed, instead of re-reading, re-validating and
 * rewriting the whole file on every snapshot and mutation. The worker lock makes this process the only writer;
 * the hook and MCP bridge only read the file, which stays at most `writeMs` behind.
 *
 * Snapshots are shared (frozen once validated): read them, never mutate them. Mutations work on a copy and replace it,
 * so a failed mutation leaves the state untouched.
 */
/** Refused once the worker stopped: nothing is saved, and the next start recovers from what was. */
const stopping = () => new Error("Follow-up is stopping; nothing was saved.");

export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  private state: State | null = null;
  private written: string | null = null;
  private saved: State | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Pending read timestamps only (store-writes-only-real-changes): written by VOLATILE_WRITE_MS, a real change or close. */
  private volatileTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  /**
   * Set by close() (worker-stop-never-waits-on-a-stuck-pass). `closing`: new mutations are refused at once. `sealed`:
   * close stopped waiting on the queue at the deadline, so a mutation still running commits nothing.
   */
  private closing = false;
  private sealed = false;
  /**
   * Called inside each mutation with the new state, before it returns, so files derived from it (scopes.json)
   * are current as soon as the mutation is, independent of the batched state.json write. It runs inside the write
   * queue, so it must never await a write to this store: that write would wait on the queue it holds.
   */
  onChanged: (state: State) => Promise<void> = async () => {};
  /** Writes to state.json, for tests and the resource check. */
  writes = 0;
  /** `writeMs` 0 writes through inside each mutation (tools, tests); the worker batches with 1000. */
  constructor(readonly directory: string, private writeMs = 0, private volatileMs = VOLATILE_WRITE_MS) {}
  private async load(): Promise<State> {
    if (this.state) return this.state;
    let text: string | null = null;
    try { text = await readFile(join(this.directory, "state.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Saved follow-up state could not be read. Restore state.json before continuing."); }
    let state: State;
    try { state = text === null ? { version: 1, workspaces: [] } : stateSchema.parse(JSON.parse(text)); }
    catch { throw new Error("Saved follow-up state could not be read. Restore state.json before continuing."); }
    this.state ??= deepFreeze(state);
    return this.state;
  }
  /** A private, mutable copy of the saved state (the old per-call read). */
  async read(): Promise<State> { return structuredClone(await this.load()); }
  async mutate<T>(work: (state: State) => T | Promise<T>): Promise<T> {
    return this.apply(async current => {
      const draft = structuredClone(current);
      const value = await work(draft);
      return { value, next: sameJson(draft, current) ? null : draft, volatile: sameIgnoringReadTimes(draft, current) };
    });
  }
  /**
   * A mutation of one workspace: only that workspace is copied, and nothing is written, re-validated or derived when
   * it comes back unchanged. The engine observes every active workspace on each tick, and copying the whole state for
   * each (then re-parsing it at the next write) was most of the idle worker's garbage (1.4.0-beta.23 scale check).
   */
  async mutateWorkspace<T>(id: string, work: (workspace: Workspace) => T | Promise<T>): Promise<T> {
    return this.apply(async current => {
      const index = current.workspaces.findIndex(w => w.id === id);
      if (index < 0) throw new Error("Workspace tracking is initializing; try again shortly.");
      const before = current.workspaces[index];
      const draft = structuredClone(before);
      const value = await work(draft);
      return { value, next: sameJson(draft, before) ? null : { ...current, workspaces: current.workspaces.with(index, draft) }, volatile: sameIgnoringReadTimes(draft, before) };
    });
  }
  /** Runs a mutation in order. A null `next` means nothing changed: the state, the pending write and derived files stay as they are. */
  private apply<T>(work: (current: State) => Promise<{ value: T; next: State | null; volatile?: boolean }>): Promise<T> {
    if (this.closing) return Promise.reject(stopping());
    const next = this.tail.then(async () => {
      if (this.sealed) throw stopping();
      const { value, next, volatile } = await work(await this.load());
      // Accepted before the worker stopped: it commits if it finished before the stop's deadline, and is dropped if
      // it finished after (its work awaited a daemon that answered late).
      if (this.sealed) throw stopping();
      if (next) {
        // Write-through keeps the old contract: a failed write leaves the saved state as it was. The draft may hold
        // objects owned by callers (observations), so only the validated copy the write returns is frozen.
        if (this.writeMs <= 0) this.state = await this.write(next);
        else { this.state = next; this.schedule(!!volatile); }
        await this.onChanged(this.state).catch(() => undefined);
      }
      return structuredClone(value);
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  /** The current state, shared and frozen. */
  async snapshot(): Promise<State> { await this.tail; return this.load(); }
  /** Writes pending changes now; call before reading state.json directly or on shutdown. */
  async flush(): Promise<void> {
    await this.tail;
    this.clearTimers();
    while (this.flushing) await this.flushing;
    const current = this.state;
    if (!current) return;
    this.flushing = this.write(current).then(saved => { if (this.state === current) this.state = saved; }).finally(() => { this.flushing = null; });
    await this.flushing;
  }
  /**
   * The worker's last word on its state. Refuses new mutations at once; mutations already accepted commit if they
   * finish by `work`, and anything finishing later is dropped. Then it writes what is pending, by `save` (the end of
   * the stop's deadline). Given ms (or nothing), it splits a deadline that far from now. Never throws.
   */
  async close(within?: number | Deadline, save?: Deadline): Promise<void> {
    let work: Deadline;
    if (within === undefined || typeof within === "number") ({ work, save } = stopDeadline(within));
    else { work = within; save ??= within; }
    this.closing = true;
    await settleWithin(this.tail, work);
    this.sealed = true;
    // Pending read timestamps count too: close writes them (store-writes-only-real-changes).
    const pending = this.timer !== null || this.volatileTimer !== null;
    this.clearTimers();
    if (this.flushing) await settleWithin(this.flushing, save);
    const current = this.state;
    if (pending && current) await settleWithin(this.write(current).then(saved => { if (this.state === current) this.state = saved; }), save);
  }
  /** A real change writes within writeMs; one that only refreshed read timestamps waits up to volatileMs. */
  private schedule(volatile = false): void {
    if (volatile) {
      if (this.timer) return; // a real change is already on its way and carries the timestamps
      this.volatileTimer ??= setTimeout(() => { this.volatileTimer = null; void this.flush().catch(() => undefined); }, this.volatileMs);
      (this.volatileTimer as { unref?: () => void }).unref?.();
      return;
    }
    this.timer ??= setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, this.writeMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
  private clearTimers(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.volatileTimer) { clearTimeout(this.volatileTimer); this.volatileTimer = null; }
  }
  /** Validates (applying schema defaults), writes when changed and returns the saved state, frozen. */
  private async write(state: State): Promise<State> {
    if (state === this.saved) return state;
    const parsed = deepFreeze(stateSchema.parse(state));
    const text = JSON.stringify(parsed);
    if (text === this.written) { this.saved = parsed; return parsed; }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `state.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(text); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.directory, "state.json"));
      this.written = text; this.saved = parsed; this.writes++;
    } finally { await unlink(temporary).catch(() => undefined); }
    return parsed;
  }
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "worker.lock");
    const token = `${process.pid}:${randomUUID()}`;
    const claim = async () => {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(token); } finally { await file.close(); }
    };
    try { await claim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await readFile(path, "utf8");
      const pid = Number(prior.split(":")[0]);
      if (!Number.isInteger(pid) || pid < 1) throw new Error("Worker lock has an invalid owner.");
      try { process.kill(pid, 0); throw new Error("Another follow-up worker is running."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      const recovery = await open(`${path}.recovery`, "wx", 0o600);
      try {
        if (await readFile(path, "utf8") !== prior) throw new Error("Worker ownership changed. Retry loading.");
        await unlink(path); await claim();
      } finally { await recovery.close(); await unlink(`${path}.recovery`); }
    }
    return async () => { if (await readFile(path, "utf8").catch(() => "") === token) await unlink(path); };
  }
}

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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * How long read timestamps alone may wait in memory (store-writes-only-real-changes). 2026-11-12: 17 of 19 live
 * state.json writes (1.3 MB each) only moved PR read times. A crash loses at most this much of them, which costs
 * nothing: the completion gate and the Deployed label need a read under ~2 min, and the first tick after a start
 * reads every PR fresh.
 */
export const VOLATILE_WRITE_MS = 300_000;
/** Read timestamps: when a PR or its deployment was last observed. Nothing else is volatile. */
const READ_TIMES = new Set(["observedAt"]);
/**
 * True when two values differ in read timestamps at most. Structural like sameJson: key order doesn't count (a parsed
 * snapshot's keys come in a different order from the saved, schema-ordered one).
 */
export function sameIgnoringReadTimes(a: unknown, b: unknown): boolean { return sameJson(a, b, READ_TIMES); }
