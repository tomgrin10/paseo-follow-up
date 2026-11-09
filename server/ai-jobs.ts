import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import type { z } from "zod";

/**
 * Small bounded model jobs: a prompt in, validated JSON out. Shared by "What's this about?" and the Overseer ranker.
 *
 * The default runner is a headless `claude -p` with everything optional stripped: no tools, no MCP servers, no
 * settings, hooks, skills or CLAUDE.md, no saved session, one turn, a fixed system prompt, run from the temp dir.
 * That keeps a call at the prompt's own size (a bare call is ~1 k tokens; the CLI's defaults load ~175 k). It uses
 * the CLI's own login, so the plugin holds no key. A Paseo child agent would cost a whole agent session per call.
 */

export type RunInput = { prompt: string; system: string; model: string; timeoutMs: number; signal: AbortSignal };
export type RunOutput = { text: string; costUsd: number | null; inputTokens: number | null; outputTokens: number | null };
export type Runner = (input: RunInput) => Promise<RunOutput>;

export type JobSpec<T> = {
  /** Shown in the log: "about", "rank". */
  name: string;
  prompt: string;
  schema: z.ZodType<T>;
  system?: string;
  /** "haiku" (default) or "sonnet". */
  model?: string;
  timeoutMs?: number;
  /** The prompt cap in characters (~4 per token). Longer prompts are refused, not truncated: the caller bounds inputs. */
  maxPromptChars?: number;
  /** The reply cap in characters; a longer reply is refused. */
  maxOutputChars?: number;
};
export type JobResult<T> =
  | { ok: true; value: T; costUsd: number | null; durationMs: number }
  | { ok: false; error: string; reason: "timeout" | "too-large" | "invalid-json" | "invalid-shape" | "failed" | "stopped"; costUsd: number | null; durationMs: number };
export type JobLog = { at: string; name: string; model: string; ok: boolean; reason: string | null; durationMs: number; costUsd: number | null; promptChars: number; inputTokens: number | null; outputTokens: number | null };

export const DEFAULT_SYSTEM = "You turn the material you are given into the JSON object the user asks for. Reply with that JSON object only: no prose, no code fence. Use only facts in the material; never guess names, numbers or links.";

export class AiJobs {
  private running = 0;
  private queue: (() => void)[] = [];
  private stopped = false;
  private controllers = new Set<AbortController>();
  constructor(private opts: { runner?: Runner; concurrency?: number; logPath?: string | null; now?: () => number } = {}) {}

  get active(): number { return this.running; }
  get waiting(): number { return this.queue.length; }

  async run<T>(spec: JobSpec<T>): Promise<JobResult<T>> {
    const now = this.opts.now ?? Date.now;
    const model = spec.model ?? "haiku";
    const started = now();
    let entry: JobLog | null = null;
    const done = (r: JobResult<T>, out?: RunOutput | null) => { entry = ({ at: new Date(started).toISOString(), name: spec.name, model, ok: r.ok, reason: r.ok ? null : r.reason, durationMs: r.durationMs, costUsd: r.costUsd, promptChars: spec.prompt.length, inputTokens: out?.inputTokens ?? null, outputTokens: out?.outputTokens ?? null }); return r; };
    try { return await this.attempt(spec, model, started, done); } finally { if (entry) await this.log(entry); }
  }

  private async attempt<T>(spec: JobSpec<T>, model: string, started: number, done: (r: JobResult<T>, out?: RunOutput | null) => JobResult<T>): Promise<JobResult<T>> {
    const now = this.opts.now ?? Date.now;
    if (spec.prompt.length > (spec.maxPromptChars ?? 60_000)) return done({ ok: false, reason: "too-large", error: `The prompt is ${spec.prompt.length} characters; the cap is ${spec.maxPromptChars ?? 60_000}.`, costUsd: null, durationMs: 0 });
    if (this.stopped) return done({ ok: false, reason: "stopped", error: "Follow-up is stopping.", costUsd: null, durationMs: 0 });
    await this.slot();
    const controller = new AbortController(); this.controllers.add(controller);
    const timeoutMs = spec.timeoutMs ?? 90_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let out: RunOutput | null = null;
    try {
      const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, timeoutMs); });
      const runner = this.opts.runner ?? claudeRunner();
      const result = await Promise.race([runner({ prompt: spec.prompt, system: spec.system ?? DEFAULT_SYSTEM, model, timeoutMs, signal: controller.signal }), timeout]);
      const durationMs = now() - started;
      if (result === "timeout") return done({ ok: false, reason: "timeout", error: `No answer within ${Math.round(timeoutMs / 1000)} s.`, costUsd: null, durationMs });
      out = result;
      if (this.stopped) return done({ ok: false, reason: "stopped", error: "Follow-up is stopping.", costUsd: out.costUsd, durationMs }, out);
      if (out.text.length > (spec.maxOutputChars ?? 6000)) return done({ ok: false, reason: "too-large", error: "The reply was longer than allowed.", costUsd: out.costUsd, durationMs }, out);
      const json = parseJsonReply(out.text);
      if (json === undefined) return done({ ok: false, reason: "invalid-json", error: "The reply wasn't JSON.", costUsd: out.costUsd, durationMs }, out);
      const parsed = spec.schema.safeParse(json);
      if (!parsed.success) return done({ ok: false, reason: "invalid-shape", error: `The reply didn't match: ${parsed.error.issues.slice(0, 2).map(i => `${i.path.join(".") || "reply"} ${i.message}`).join("; ")}`.slice(0, 300), costUsd: out.costUsd, durationMs }, out);
      return done({ ok: true, value: parsed.data, costUsd: out.costUsd, durationMs }, out);
    } catch (error) {
      return done({ ok: false, reason: controller.signal.aborted && this.stopped ? "stopped" : "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 300), costUsd: out?.costUsd ?? null, durationMs: now() - started }, out);
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
      this.release();
    }
  }

  stop(): void { this.stopped = true; for (const c of this.controllers) c.abort(); for (const next of this.queue.splice(0)) next(); }

  private slot(): Promise<void> {
    const limit = Math.max(1, Math.min(2, this.opts.concurrency ?? 1));
    if (this.running < limit) { this.running++; return Promise.resolve(); }
    return new Promise(resolve => this.queue.push(() => { this.running++; resolve(); }));
  }
  private release(): void { this.running--; const next = this.queue.shift(); if (next) next(); }
  private async log(entry: JobLog): Promise<void> {
    if (!this.opts.logPath) return;
    try { await mkdir(dirname(this.opts.logPath), { recursive: true, mode: 0o700 }); await appendFile(this.opts.logPath, JSON.stringify(entry) + "\n", { mode: 0o600 }); } catch { /* the log never fails a job */ }
  }
}

/** The JSON object in a reply: bare, fenced, or the outermost {…} in surrounding prose. Undefined when there is none. */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidates = [fenced ? fenced[1] : trimmed];
  const start = trimmed.indexOf("{"), end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* next */ } }
  return undefined;
}

/** The `claude -p --output-format json` envelope: the reply text, its cost and token counts. */
export function parseClaudeEnvelope(stdout: string): RunOutput {
  const envelope = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { result?: unknown; is_error?: boolean; subtype?: string; total_cost_usd?: number; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } };
  if (envelope.is_error || typeof envelope.result !== "string") throw new Error(`Claude returned no reply${envelope.subtype ? ` (${envelope.subtype})` : ""}.`);
  const u = envelope.usage;
  return { text: envelope.result, costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    inputTokens: u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null, outputTokens: u?.output_tokens ?? null };
}

export function claudeArgs(input: Pick<RunInput, "model" | "system">): string[] {
  return ["-p", "--model", input.model, "--output-format", "json", "--max-turns", "1", "--tools", "", "--no-session-persistence",
    "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--system-prompt", input.system];
}

/** The envelope of a one-turn reply is a few KB; anything near this is runaway output. */
export const MAX_STDOUT = 512 * 1024;

/** Spawns `claude` with an argument array (no shell); the prompt goes on stdin. */
export function claudeRunner(command = "claude"): Runner {
  return input => new Promise((resolve, reject) => {
    // Its own process group, so a timeout kills claude and anything it started.
    const child = spawn(command, claudeArgs(input), { cwd: tmpdir(), detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    let stdout = "", stderr = "", capped = false;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    input.signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", d => { if (capped) return; stdout += d; if (stdout.length > MAX_STDOUT) { capped = true; kill(); } });
    child.stderr.on("data", d => { stderr = (stderr + d).slice(-2000); });
    child.on("error", reject);
    child.on("close", code => {
      input.signal.removeEventListener("abort", kill);
      if (input.signal.aborted) return reject(new Error("Stopped."));
      if (capped) return reject(new Error("claude wrote more than the output cap."));
      try { resolve(parseClaudeEnvelope(stdout)); }
      catch { reject(new Error(`claude exited ${code ?? "early"}: ${(stderr || stdout).trim().split("\n").at(-1)?.slice(0, 200) ?? "no output"}`)); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.prompt);
  });
}
