import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat } from "node:fs/promises";
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
 */
export const DEFAULT_WAIT_SECONDS = 30;
export const HARD_MAX_WAIT_SECONDS = 60;
/** A prepared job's time limit: 3 h unless the agent asks for another, at most 12 h. The runner stops it after that. */
export const DEFAULT_JOB_TIMEOUT_SECONDS = 3 * 3600;
export const MAX_JOB_TIMEOUT_SECONDS = 12 * 3600;
export const prepareInput = z.object({
  description: z.string().min(1).max(240),
  command: z.string().min(1).max(32000),
  timeoutSeconds: z.number().int().min(1).max(MAX_JOB_TIMEOUT_SECONDS).optional(),
}).strict();
export const waitInput = z.object({
  jobId: z.string().uuid(),
  max_wait_seconds: z.number().int().min(1).max(HARD_MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS),
}).strict();
const metadataSchema = z.object({ version: z.literal(1), id: z.string().uuid(), agentId: z.string(), cwd: z.string(), description: z.string(), createdAt: z.string() }).strict();
const resultSchema = z.object({ exitCode: z.number().int().min(0).max(255), timedOut: z.literal(true).optional() }).strict();

export interface Owner { id: string; cwd: string }
/** `timedOut`: the runner stopped the command at its time limit (exit 124). */
export interface JobStatus { jobId: string; status: "prepared" | "running" | "completed" | "failed"; description: string; createdAt: string; exitCode?: number; timedOut?: true }
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
  constructor(readonly directory: string) {}

  private path(owner: Owner, jobId: string) {
    if (!/^[a-z0-9_-]{1,128}$/i.test(owner.id)) throw new Error("Invalid agent identity");
    return join(this.directory, "jobs", owner.id, z.string().uuid().parse(jobId));
  }

  /** Writes the job record and returns the exact command to run. Runs nothing. */
  async prepare(owner: Owner, raw: z.input<typeof prepareInput>) {
    const input = prepareInput.parse(raw);
    if (this.closed) throw new Error("Wait tools are stopping");
    const id = randomUUID();
    const path = this.path(owner, id);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const runner = join(this.directory, "run-job.sh");
    const temporary = `${runner}.${randomUUID()}`;
    await writeFile(temporary, runnerSource, { mode: 0o700 });
    await rename(temporary, runner);
    const record = { version: 1, id, agentId: owner.id, cwd: owner.cwd, description: input.description, createdAt: new Date().toISOString() };
    await writeFile(join(path, "job.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
    const limit = input.timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_SECONDS;
    await writeFile(join(path, "timeout"), String(limit), { mode: 0o600, flag: "wx" });
    return {
      jobId: id,
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
    const base = { jobId, description: record.description, createdAt: record.createdAt };
    try {
      const { exitCode, timedOut } = resultSchema.parse(await jsonFile(join(path, "result.json")));
      return { ...base, status: exitCode === 0 ? "completed" : "failed", exitCode, ...(timedOut ? { timedOut } : {}) };
    } catch (error) { if (!missing(error)) throw error; }
    try {
      const started = await lstat(join(path, "started"));
      if (!started.isDirectory() || started.isSymbolicLink()) throw new Error("Invalid job start record");
      return { ...base, status: "running" };
    } catch (error) { if (!missing(error)) throw error; return { ...base, status: "prepared" }; }
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
            ...current, outcome, waitedSeconds: (Date.now() - started) / 1000,
            instruction: outcome === "still_pending" ? "The wait ceiling was reached. Inspect the job and its output now. If it is healthy and still needed, call wait_for_job again. Do not treat this as completion."
              : outcome === "new_message" ? "A new message arrived. Handle it before deciding whether to wait again. The underlying job was not stopped."
              : current.timedOut ? "The command hit its time limit and was stopped (exit 124); it did not finish. Inspect its output, then decide whether to run it again with a longer timeoutSeconds or change it."
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
