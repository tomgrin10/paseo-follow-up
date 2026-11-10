import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runnerSource } from "./wait-runner-source";

/**
 * Wait's job store (folded in from the standalone paseo-wait plugin). A job is a directory under
 * `plugin-data/follow-through/wait/jobs/<agentId>/<jobId>/`:
 *
 * - `job.json`: who prepared it (agent id and cwd, from the daemon, never from model input) and what it is.
 * - `started/`: created once by the runner, so a prepared command runs at most once.
 * - `result.json`: the runner's atomic exit receipt. It is the only proof of completion.
 *
 * The agent runs the command itself through its native Bash tool (run_in_background); this worker only prepares
 * records and reads them. Idle jobs cost nothing: no watcher, no timer. A wait holds two bounded timers (a 250 ms
 * receipt check and the ceiling) and releases them when it returns. Records live on disk, so they survive reloads.
 *
 * - `output.log` / `output.prev.log`: the runner's copy of the command's output, rotated at 512 KiB (~1 MiB at most),
 *   read only by the chat's Wait row (`outputTail`). Jobs untouched for 7 days are pruned when a job is prepared.
 */
export const DEFAULT_WAIT_SECONDS = 60;
export const HARD_MAX_WAIT_SECONDS = 180;
/** A job directory nothing has touched for this long is removed (at most one sweep an hour, when a job is prepared). */
export const JOB_RETENTION_MS = 7 * 24 * 3600_000;
export const OUTPUT_TAIL_BYTES = 8192;
export const waitInput = z.object({
  jobId: z.string().uuid(),
  max_wait_seconds: z.number().int().min(1).max(HARD_MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS),
}).strict();
const metadataSchema = z.object({ version: z.literal(1), id: z.string().uuid(), agentId: z.string(), cwd: z.string(), description: z.string(), createdAt: z.string() }).strict();
const resultSchema = z.object({ exitCode: z.number().int().min(0).max(255) }).strict();

export interface Owner { id: string; cwd: string }
export interface OutputTail { text: string; bytes: number; truncated: boolean }
/** `checkedAt` is when the status was read (server clock), so the chat can say how long the job had run. */
export interface JobStatus { jobId: string; status: "prepared" | "running" | "completed" | "failed"; description: string; createdAt: string; checkedAt: string; exitCode?: number }
export type WaitResult = JobStatus & { outcome: "completed" | "failed" | "still_pending" | "new_message"; waitedSeconds: number; instruction: string };

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** A record the runner or this store wrote: a small regular file, never a symlink. */
async function jsonFile(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("Invalid wait job record");
  return JSON.parse(await readFile(file, "utf8"));
}

export class WaitJobs {
  private active = new Set<AbortController>();
  private closed = false;
  private swept = 0;
  constructor(readonly directory: string) {}

  private path(owner: Owner, jobId: string) {
    if (!/^[a-z0-9_-]{1,128}$/i.test(owner.id)) throw new Error("Invalid agent identity");
    return join(this.directory, "jobs", owner.id, z.string().uuid().parse(jobId));
  }

  /** Writes the job record and returns the exact command to run. Runs nothing. */
  async prepare(owner: Owner, input: { description: string; command: string }) {
    if (this.closed) throw new Error("Wait tools are stopping");
    void this.prune().catch(() => {});
    const id = randomUUID();
    const path = this.path(owner, id);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const runner = join(this.directory, "run-job.sh");
    const temporary = `${runner}.${randomUUID()}`;
    await writeFile(temporary, runnerSource, { mode: 0o700 });
    await rename(temporary, runner);
    const record = { version: 1, id, agentId: owner.id, cwd: owner.cwd, description: input.description, createdAt: new Date().toISOString() };
    await writeFile(join(path, "job.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
    return {
      jobId: id,
      createdAt: record.createdAt,
      bashCommand: ["sh", runner, path, owner.cwd, input.command].map(quote).join(" "),
      instruction: "Run bashCommand using native Bash with run_in_background=true. Then call wait_for_job. Preparing this job has not executed the command.",
    };
  }

  async status(owner: Owner, jobId: string): Promise<JobStatus> {
    const path = this.path(owner, jobId);
    let record;
    try { record = metadataSchema.parse(await jsonFile(join(path, "job.json"))); }
    catch (error) { if (missing(error)) throw new Error("Unknown job for this agent"); throw error; }
    if (record.agentId !== owner.id || record.id !== jobId || record.cwd !== owner.cwd) throw new Error("Job ownership does not match this agent and working directory");
    const base = { jobId, description: record.description, createdAt: record.createdAt, checkedAt: new Date().toISOString() };
    try {
      const { exitCode } = resultSchema.parse(await jsonFile(join(path, "result.json")));
      return { ...base, status: exitCode === 0 ? "completed" : "failed", exitCode };
    } catch (error) { if (!missing(error)) throw error; }
    try {
      const started = await lstat(join(path, "started"));
      if (!started.isDirectory() || started.isSymbolicLink()) throw new Error("Invalid job start record");
      return { ...base, status: "running" };
    } catch (error) { if (!missing(error)) throw error; return { ...base, status: "prepared" }; }
  }

  /** The last `limit` bytes of a job's captured output, for the chat's Wait row. Read-only; any agent's own job. */
  async outputTail(agentId: string, jobId: string, limit = OUTPUT_TAIL_BYTES): Promise<OutputTail> {
    const path = this.path({ id: agentId, cwd: "" }, jobId);
    let record;
    try { record = metadataSchema.parse(await jsonFile(join(path, "job.json"))); }
    catch (error) { if (missing(error)) throw new Error("Unknown job for this agent"); throw error; }
    if (record.agentId !== agentId || record.id !== jobId) throw new Error("Job ownership does not match this agent");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (const name of ["output.log", "output.prev.log"]) {
      const stat = await lstat(join(path, name)).catch(error => { if (missing(error)) return null; throw error; });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid wait job output");
      bytes += stat.size;
      const want = limit - chunks.reduce((n, c) => n + c.length, 0);
      if (want <= 0) continue;
      const handle = await open(join(path, name), "r");
      try {
        const length = Math.min(want, stat.size);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, stat.size - length);
        chunks.unshift(buffer);
      } finally { await handle.close(); }
    }
    const tail = Buffer.concat(chunks);
    // Start at a line boundary when the tail was cut, so the first line isn't half a line.
    const cut = bytes > tail.length ? tail.indexOf(10) + 1 : 0;
    return { text: tail.subarray(cut).toString("utf8"), bytes, truncated: bytes > tail.length };
  }

  /** Removes job directories nothing has touched for JOB_RETENTION_MS. Bounded: at most one sweep an hour. */
  async prune(now = Date.now()) {
    if (now - this.swept < 3600_000) return 0;
    this.swept = now;
    let removed = 0;
    const root = join(this.directory, "jobs");
    for (const agent of await readdir(root).catch(() => [] as string[])) {
      for (const job of await readdir(join(root, agent)).catch(() => [] as string[])) {
        const path = join(root, agent, job);
        const times = await Promise.all(["job.json", "started", "output.log", "result.json"].map(name => lstat(join(path, name)).then(s => s.mtimeMs, () => 0)));
        if (Math.max(...times) && now - Math.max(...times) > JOB_RETENTION_MS) { await rm(path, { recursive: true, force: true }); removed++; }
      }
    }
    return removed;
  }

  /**
   * Holds the call until the receipt appears, a new message arrives, or the ceiling passes (still_pending, never
   * success). The caller's signal (Stop, a cancelled MCP request) ends observation only; the job keeps running.
   */
  async wait(owner: Owner, raw: z.input<typeof waitInput>, options: { signal?: AbortSignal; hasNewMessage?: () => Promise<boolean> } = {}): Promise<WaitResult> {
    const input = waitInput.parse(raw);
    if (this.closed) throw new Error("Wait tools are stopping");
    const started = Date.now();
    const controller = new AbortController();
    this.active.add(controller);
    const signal = controller.signal;
    const cancel = () => controller.abort();
    const cancellationError = () => this.closed ? new Error("Follow-up stopped; job records are preserved") : options.signal && "reason" in options.signal ? options.signal.reason : new Error("Wait canceled");
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      if (signal.aborted) throw cancellationError();
      return await new Promise<WaitResult>((resolve, reject) => {
        let settled = false;
        let current: JobStatus | undefined;
        let checking = false;
        let checkingMessage = false;
        let newMessage = false;
        const cleanup = () => { clearTimeout(deadline); clearInterval(poll); signal.removeEventListener("abort", abort); };
        const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
        const finish = (outcome: WaitResult["outcome"]) => {
          if (settled) return;
          if (!current) { fail(new Error("Job status could not be verified within the wait ceiling; inspect the job before waiting again")); return; }
          settled = true; cleanup();
          resolve({
            ...current, checkedAt: new Date().toISOString(), outcome, waitedSeconds: (Date.now() - started) / 1000,
            instruction: outcome === "still_pending" ? "The wait ceiling was reached. Inspect the job and its output now. If it is healthy and still needed, call wait_for_job again. Do not treat this as completion."
              : outcome === "new_message" ? "A new message arrived. Handle it before deciding whether to wait again. The underlying job was not stopped."
              : "The command exited. Inspect its output and exit code before continuing.",
          });
        };
        const abort = () => fail(cancellationError());
        const deadline = setTimeout(() => finish("still_pending"), input.max_wait_seconds * 1000);
        const check = async () => {
          if (settled || checking) return;
          checking = true;
          try {
            current = await this.status(owner, input.jobId);
            if (current.status === "completed" || current.status === "failed") finish(current.status);
            else if (newMessage) finish("new_message");
          } catch (error) { fail(error); }
          finally { checking = false; }
        };
        const message = async () => {
          if (settled || checkingMessage || !options.hasNewMessage) return;
          checkingMessage = true;
          try { if (await options.hasNewMessage()) { newMessage = true; if (current) finish("new_message"); } }
          catch { /* A transport outage cannot extend the hard wait ceiling. */ }
          finally { checkingMessage = false; }
        };
        const poll = setInterval(() => { void check(); void message(); }, 250);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else { void check(); void message(); }
      });
    } finally { options.signal?.removeEventListener("abort", cancel); this.active.delete(controller); }
  }

  /** Plugin teardown: every active wait returns an error; no job is touched. */
  close() { this.closed = true; for (const controller of this.active) controller.abort(); this.active.clear(); }
  get activeWaits() { return this.active.size; }
}
