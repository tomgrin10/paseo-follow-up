import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runner, RunInput } from "./ai-jobs";

/**
 * One-shot jobs on any Paseo provider: the job runs as a short-lived agent in a background workspace, so it never shows
 * in the developer's workspace or agent lists, and is archived as soon as it answers. Claude and Codex keep their
 * headless CLI fast path (ai-jobs.ts); this is for every other provider.
 *
 * Paseo 0.15.2 refuses `internal` agents from clients ("create a background workspace instead"), so a background
 * workspace is the supported way to stay out of sight. Idle cost is zero: nothing runs between jobs.
 */
export const JOBS_TITLE = "Follow-up jobs";
export const JOB_LABEL = "follow-up-job";

type JobAgent = {
  readonly id: string;
  waitForFinish(timeoutMs?: number): Promise<{ status: "idle" | "error" | "permission" | "timeout"; lastMessage: string | null; error: string | null }>;
  archive(): Promise<unknown>;
};
type JobWorkspace = { readonly id: string; agents: { create(options: Record<string, unknown>): Promise<JobAgent> } };
export type JobPaseo = {
  workspaces: {
    create(options: Record<string, unknown>): Promise<JobWorkspace>;
    ref(id: string): { refresh(): Promise<{ workspace?: { archivedAt?: string | null } | null } | unknown>; agents: JobWorkspace["agents"] };
  };
};

export type JobAgentOptions = {
  /** The plugin's Paseo handle, null until the worker has one. */
  paseo: () => JobPaseo | null;
  /** Follow-up's plugin-data directory: the jobs workspace lives in `jobs-home` there. */
  directory: string;
};

/** The provider string Paseo's agent config takes: "opencode/qwen3-coder", or the provider alone for its default model. */
export const providerModel = (provider: string, model: string) => model ? `${provider}/${model}` : provider;

export function jobAgentRunner(opts: JobAgentOptions): Runner {
  const statePath = join(opts.directory, "jobs-workspace.json");
  let cached: string | null = null;
  const workspace = async (paseo: JobPaseo, fresh: boolean): Promise<JobWorkspace> => {
    if (!fresh) {
      if (!cached) cached = await readFile(statePath, "utf8").then(t => (JSON.parse(t) as { workspaceId?: string }).workspaceId ?? null).catch(() => null);
      if (cached) return { id: cached, agents: paseo.workspaces.ref(cached).agents };
    }
    const home = join(opts.directory, "jobs-home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "README.md"), "Follow-up runs its one-shot helper jobs here (summaries, ranking). Nothing here needs you.\n").catch(() => undefined);
    const created = await paseo.workspaces.create({ title: JOBS_TITLE, source: { kind: "directory", path: home }, background: true });
    cached = created.id;
    await writeFile(statePath, JSON.stringify({ workspaceId: created.id }), { mode: 0o600 }).catch(() => undefined);
    return created;
  };
  const create = async (paseo: JobPaseo, input: RunInput) => {
    const options = {
      config: { provider: providerModel(input.provider, input.model), systemPrompt: input.system, ...(input.thinking ? { thinkingOptionId: input.thinking } : {}) },
      title: `${JOBS_TITLE}: one-shot`, labels: { [JOB_LABEL]: "1" }, prompt: input.prompt, autoArchive: true,
    };
    // A saved workspace can be archived or gone (a fresh Paseo home): make a new one once, then give up.
    try { return await (await workspace(paseo, false)).agents.create(options); }
    catch { return (await workspace(paseo, true)).agents.create(options); }
  };
  return async input => {
    const paseo = opts.paseo();
    if (!paseo) throw new Error("Follow-up isn't connected to Paseo yet; the job runs once the app has opened it.");
    if (input.signal.aborted) throw new Error("Stopped.");
    const agent = await create(paseo, input);
    const stop = () => void agent.archive().catch(() => undefined);
    input.signal.addEventListener("abort", stop, { once: true });
    try {
      const r = await agent.waitForFinish(input.timeoutMs);
      if (r.status === "timeout") throw new Error(`No answer within ${Math.round(input.timeoutMs / 1000)} s.`);
      if (r.status === "permission") throw new Error(`${input.provider} asked for a permission; one-shot jobs can't grant one.`);
      if (r.status === "error") throw new Error(r.error ?? `${input.provider} failed.`);
      if (!r.lastMessage?.trim()) throw new Error(`${input.provider} answered with nothing.`);
      return { text: r.lastMessage, costUsd: null, inputTokens: null, outputTokens: null };
    } finally {
      input.signal.removeEventListener("abort", stop);
      stop();
    }
  };
}
