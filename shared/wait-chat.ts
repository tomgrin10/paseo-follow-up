import { z } from "zod";
import { readText, type TimelineToolCall } from "./chat";

/**
 * Wait's row in an agent chat: one row per background job, drawn at the job's first wait_for_job call. Later waits on
 * the same job, wait_prepare_job and wait_get_job stay Paseo's own tool calls inside its group (TOOL_PRESENTATION);
 * the transformer still reads them into a WaitLedger, and the row renders the job's live state from it. The ledger is
 * rebuilt from the timeline on every projection, so a reopened chat or a plugin reload draws the same row.
 *
 * Times come from the server's receipts (createdAt at prepare, checkedAt on each status read), so the job's elapsed
 * time survives a reopen. The current call's countdown starts at the previous check, or at the row's own timestamp
 * (Paseo's latest update of the first call: its start while it runs).
 */
export const WAIT_ROW_KIND = "wait-row";
export const waitRowSchema = z.object({ jobId: z.string(), callId: z.string() });
export type WaitRow = z.infer<typeof waitRowSchema>;

export type WaitOutcome = "completed" | "failed" | "still_pending" | "new_message";
export interface WaitCall { callId: string; status: TimelineToolCall["status"]; maxWait: number; outcome?: WaitOutcome; exitCode?: number; checkedAt?: string; error?: string }
export interface WaitJob {
  jobId: string;
  description: string | null;
  command: string | null;
  createdAt: string | null;
  firstCallId: string;
  /** Wait calls in timeline order. */
  calls: WaitCall[];
  /** The newest status read by wait_get_job, when it's newer than the last wait. */
  status: { status: string; exitCode?: number; checkedAt: string } | null;
}

/** What the row says, derived from a job and the clock. */
export type WaitView =
  | { state: "running"; elapsed: number | null; remaining: number | null; cap: number }
  | { state: "passed" | "failed" | "pending" | "released" | "stopped" | "error"; elapsed: number | null; exitCode?: number; error?: string };

const LIMIT = 200;
const WAIT_NAME = /(?:^|__|\.|\/|:)wait_(prepare_job|for_job|get_job)$/;
const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function receipt(detail: unknown): Record<string, unknown> | null {
  if (!rec(detail) || !("output" in detail)) return null;
  if (rec(detail.output) && rec(detail.output.structuredContent)) return detail.output.structuredContent;
  const text = readText(detail.output);
  if (!text) return null;
  try { const value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); return rec(value) ? value : null; } catch { return null; }
}
const input = (detail: unknown) => rec(detail) && rec(detail.input) ? detail.input : {};
const iso = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;

/** Jobs seen in this client's chats, with a version and listeners so a row re-renders when its job changes. */
export class WaitLedger {
  private jobs = new Map<string, WaitJob>();
  private prepared = new Map<string, { description: string | null; command: string | null }>();
  private listeners = new Set<() => void>();
  private pending = false;
  version = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  job(jobId: string) { return this.jobs.get(jobId); }

  /** Transforms run during Paseo's render, so listeners hear about a change on the next microtask. */
  private changed() {
    this.version++;
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; for (const listener of [...this.listeners]) listener(); });
  }
  private entry(jobId: string, callId: string) {
    let job = this.jobs.get(jobId);
    if (!job) {
      if (this.jobs.size >= LIMIT) this.jobs.delete(this.jobs.keys().next().value!);
      const known = this.prepared.get(jobId);
      job = { jobId, description: known?.description ?? null, command: known?.command ?? null, createdAt: null, firstCallId: callId, calls: [], status: null };
      this.jobs.set(jobId, job);
    }
    return job;
  }

  /**
   * Reads one Wait tool call. Returns the row for the job's first wait_for_job, undefined for everything else (which
   * stays Paseo's grouped tool call). Idempotent per call, so re-projecting the timeline changes nothing.
   */
  observe(item: TimelineToolCall): WaitRow | undefined {
    const tool = WAIT_NAME.exec(item.name)?.[1];
    if (!tool) return undefined;
    const args = input(item.detail);
    const result = receipt(item.detail);
    const jobId = typeof args.jobId === "string" ? args.jobId : typeof result?.jobId === "string" ? result.jobId : null;
    if (tool === "prepare_job") {
      if (!jobId) return undefined;
      const known = { description: typeof args.description === "string" ? args.description : null, command: typeof args.command === "string" ? args.command : null };
      const before = this.prepared.get(jobId);
      if (!before || before.description !== known.description) {
        if (this.prepared.size >= LIMIT) this.prepared.delete(this.prepared.keys().next().value!);
        this.prepared.set(jobId, known);
        const job = this.jobs.get(jobId);
        if (job) { job.description = known.description; job.command = known.command; }
        this.changed();
      }
      if (iso(result?.createdAt)) { const job = this.jobs.get(jobId); if (job && !job.createdAt) { job.createdAt = iso(result!.createdAt)!; this.changed(); } }
      return undefined;
    }
    if (!jobId) return undefined;
    if (tool === "get_job") {
      if (item.status !== "completed" || !result || !iso(result.checkedAt)) return undefined;
      const job = this.jobs.get(jobId);
      if (!job || (job.status && job.status.checkedAt >= String(result.checkedAt))) return undefined;
      job.status = { status: String(result.status), ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}), checkedAt: String(result.checkedAt) };
      job.createdAt ??= iso(result.createdAt) ?? null;
      this.changed();
      return undefined;
    }
    const job = this.entry(jobId, item.callId);
    const call: WaitCall = { callId: item.callId, status: item.status, maxWait: typeof args.max_wait_seconds === "number" ? args.max_wait_seconds : 60 };
    if (result && typeof result.outcome === "string") {
      call.outcome = result.outcome as WaitOutcome;
      if (typeof result.exitCode === "number") call.exitCode = result.exitCode;
      call.checkedAt = iso(result.checkedAt);
      job.createdAt ??= iso(result.createdAt) ?? null;
    }
    if (item.status === "failed") call.error = typeof item.error === "string" ? item.error : rec(item.error) && typeof item.error.message === "string" ? item.error.message : "The wait failed";
    const at = job.calls.findIndex(c => c.callId === item.callId);
    const before = at >= 0 ? JSON.stringify(job.calls[at]) : null;
    if (before !== JSON.stringify(call)) { if (at >= 0) job.calls[at] = call; else job.calls.push(call); this.changed(); }
    return job.firstCallId === item.callId ? { jobId, callId: item.callId } : undefined;
  }
}

const seconds = (from: string | null | undefined, to: number) => from ? Math.max(0, (to - Date.parse(from)) / 1000) : null;

/** The row's state at `now`. `rowTimestamp` is Paseo's timestamp for the row (the first call's latest update). */
export function waitView(job: WaitJob, now: number, rowTimestamp: number): WaitView {
  const last = job.calls.at(-1);
  if (last?.status === "running") {
    const previous = job.calls.at(-2)?.checkedAt;
    const start = previous ? Date.parse(previous) : rowTimestamp;
    const elapsed = seconds(job.createdAt, now) ?? Math.max(0, (now - rowTimestamp) / 1000);
    return { state: "running", elapsed, remaining: Math.max(0, last.maxWait - (now - start) / 1000), cap: last.maxWait };
  }
  // A wait_get_job newer than the last wait can settle the job (the agent checked instead of waiting again).
  const status = job.status && (!last?.checkedAt || job.status.checkedAt > last.checkedAt) ? job.status : null;
  const settledAt = status?.checkedAt ?? last?.checkedAt;
  const elapsed = job.createdAt && settledAt ? Math.max(0, (Date.parse(settledAt) - Date.parse(job.createdAt)) / 1000) : null;
  if (status?.status === "completed" || (!status && last?.outcome === "completed")) return { state: "passed", elapsed, exitCode: status?.exitCode ?? last?.exitCode ?? 0 };
  if (status?.status === "failed" || (!status && last?.outcome === "failed")) return { state: "failed", elapsed, exitCode: status?.exitCode ?? last?.exitCode };
  if (!last) return { state: "pending", elapsed };
  if (last.status === "canceled") return { state: "stopped", elapsed: null };
  if (last.status === "failed") return { state: "error", elapsed: null, error: last.error };
  if (last.outcome === "new_message") return { state: "released", elapsed };
  return { state: "pending", elapsed };
}

/** 0:07, 2:41, 1:02:05. Whole seconds, floored, so the number never runs ahead of the clock. */
export function clock(total: number) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** The row's one line: what, then the state and times. Settled lines are what's left in the chat afterwards. */
export function waitLine(job: WaitJob, view: WaitView, compact = false): { title: string; meta: string } {
  const title = job.description?.trim() || "Background job";
  const at = (n: number | null) => n === null ? "" : ` at ${clock(n)}`;
  switch (view.state) {
    case "running": return { title, meta: view.elapsed === null ? "" : compact || view.remaining === null ? clock(view.elapsed) : `${clock(view.elapsed)} · next check ${clock(Math.ceil(view.remaining))}` };
    case "passed": return { title, meta: view.elapsed === null ? "passed" : `passed · ${clock(view.elapsed)}` };
    case "failed": return { title, meta: `failed${view.exitCode === undefined ? "" : ` · exit ${view.exitCode}`}${view.elapsed === null ? "" : ` · ${clock(view.elapsed)}`}` };
    case "released": return { title, meta: `still running · released by a new message${at(view.elapsed)}` };
    case "stopped": return { title, meta: "still running · wait stopped" };
    case "error": return { title, meta: `couldn't check${view.error ? ` · ${view.error.split("\n")[0].slice(0, 120)}` : ""}` };
    case "pending": return { title, meta: `still running · checked${at(view.elapsed)}` };
  }
}
