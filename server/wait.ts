import { z } from "zod";
import type { AgentToolDefinition, AgentToolContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { WaitJobs, waitInput, prepareInput } from "./wait-jobs";
import type { WaitStatus } from "../shared/wait";

/**
 * Wait: bounded foreground waits for finite background jobs, folded in from the standalone paseo-wait plugin
 * (1.4.0-beta.24). The agent prepares a job, runs the returned command with native Bash run_in_background=true,
 * then calls wait_for_job, which holds for at most 60 s (default 30) and returns completed, failed, still_pending
 * or new_message. The agent stays Running instead of ending its turn on "waiting for a notification".
 *
 * Served as native plugin tools on the agent's Paseo MCP (request.tools at session_open), like the follow_ tools.
 * Paseo holds a plugin tool call for up to 10 minutes and forwards a cancelled request as tool.cancel (our
 * context.signal), so a 60 s wait fits and Stop ends it. No listener, no port, no process per agent. Hosts that
 * can't serve plugin tools (Paseo 0.14, daemon.mcp.injectIntoAgents=false, the provider's Paseo tools off) get no
 * Wait; the standalone plugin's loopback MCP was not carried over.
 *
 * Claude only: it sets CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 so Claude Code doesn't move a long MCP call to the
 * background (this also applies to the session's other long MCP calls), and relies on Bash run_in_background.
 */
export const WAIT_TOOLS = ["wait_prepare_job", "wait_for_job", "wait_get_job"] as const;
export const WAIT_LABEL = "follow-up-wait/enabled";
/** The standalone plugin's id. While it is installed and enabled on this daemon, Follow-up's Wait stays off. */
export const STANDALONE_WAIT_ID = "paseo-wait";

export type WaitPaseoConfig = {
  daemon?: { mcp?: { enabled?: boolean; injectIntoAgents?: boolean } };
  agents?: { providers?: Record<string, { paseoTools?: { enabled?: boolean; disabledTools?: string[] } }> };
  plugins?: Record<string, { enabled?: boolean } | undefined>;
};

/** The standalone plugin counts as installed when config.json lists it and it isn't disabled. */
export function standaloneWaitInstalled(config: WaitPaseoConfig | null): boolean {
  const entry = config?.plugins?.[STANDALONE_WAIT_ID];
  return !!entry && entry.enabled !== false;
}

/** Whether this host serves plugin tools to Claude agents at all (request.tools is checked per session). */
function hostServesTools(config: WaitPaseoConfig | null): boolean {
  if (config?.daemon?.mcp?.enabled === false || config?.daemon?.mcp?.injectIntoAgents === false) return false;
  const policy = config?.agents?.providers?.claude?.paseoTools;
  if (policy?.enabled === false) return false;
  return !policy?.disabledTools?.some(name => (WAIT_TOOLS as readonly string[]).includes(name));
}

/** What Settings → Agents shows: the switch, and why Wait is off when it is on. */
export function waitStatus(enabled: boolean, config: WaitPaseoConfig | null, hostBackgroundWork = false): WaitStatus {
  const reason = !enabled ? "off" : standaloneWaitInstalled(config) ? "standalone" : hostBackgroundWork ? "host" : !hostServesTools(config) ? "no-agent-tools" : null;
  return { enable_wait: enabled, active: reason === null, reason, ...(hostBackgroundWork ? { host: true } : {}) };
}

const json = (value: unknown) => ({ text: JSON.stringify(value), structuredContent: value });

export class Wait {
  readonly jobs: WaitJobs;
  readonly tools: AgentToolDefinition[];
  /** `hostBackgroundWork`: the host advertises features.agentBackgroundWork (Paseo 0.16, server/host-features.ts). */
  constructor(directory: string, private deps: { enabled: () => Promise<boolean>; config: () => Promise<WaitPaseoConfig | null>; hostBackgroundWork?: () => Promise<boolean>; legacyDirectory?: string | null }) {
    this.jobs = new WaitJobs(directory, deps.legacyDirectory ?? null);
    const owner = (context: AgentToolContext) => ({ id: context.agent.id, cwd: context.agent.cwd });
    const guard = (context: AgentToolContext) => { if (context.signal.aborted) throw new Error("Wait tool canceled"); };
    this.tools = [
      {
        name: "wait_prepare_job",
        description: "For a finite shell command that may take a while and whose result you need before finishing (tests, builds, installs, deploy checks): prepare it here instead of running it directly. Returns jobId and bashCommand and runs nothing. Run that exact bashCommand with native Bash run_in_background=true, then call wait_for_job instead of ending your turn. The command is stopped after timeoutSeconds (default 3 hours, at most 12); a stopped job reports timedOut.",
        input: prepareInput,
        execute: async (input, context) => { guard(context); return json(await this.jobs.prepare(owner(context), input as z.input<typeof prepareInput>)); },
      },
      {
        name: "wait_get_job",
        description: "Read the status of a job you prepared with wait_prepare_job: prepared, running, completed or failed, with its exit code. Only an exit receipt means it finished; an elapsed wait or missing output does not.",
        input: z.object({ jobId: z.string().uuid() }).strict(),
        execute: async (input, context) => { guard(context); return json(await this.jobs.status(owner(context), (input as { jobId: string }).jobId)); },
      },
      {
        name: "wait_for_job",
        description: "Wait in the foreground for a job you prepared: default 30 s, at most 60 s per call. Returns completed or failed with the exit code, still_pending (inspect the job and its output, then wait again if it is still needed) or new_message (handle it first). Stop and new messages end the wait without killing the job. Don't end your turn just because a wait ran out.",
        input: waitInput,
        execute: async (input, context) => {
          const started = Date.now();
          const handle = context.paseo.agents.ref(context.agent.id);
          let nextCheck = 0;
          // At most one agent refresh a second, and only during an active wait.
          const hasNewMessage = async () => {
            if (Date.now() < nextCheck) return false;
            nextCheck = Date.now() + 1000;
            const refreshed = await handle.refresh();
            return Date.parse(refreshed?.agent.lastUserMessageAt ?? "") > started;
          };
          return json(await this.jobs.wait(owner(context), input as z.input<typeof waitInput>, { signal: context.signal, hasNewMessage }));
        },
      },
    ];
  }

  /**
   * Adds Wait's tools to an interactive Claude session, unless it's off, opted out, or the standalone plugin has it.
   * On a Paseo 0.16 host (agentBackgroundWork) it attaches nothing and leaves Claude Code's MCP auto-background alone;
   * FOLLOW_THROUGH_BACKGROUND_WORK=1 makes the hook say "run it in the background and end your turn" instead.
   */
  async open<R extends PluginSessionOpenRequest>(request: R, options: { background?: boolean } = {}): Promise<R> {
    // A Paseo 0.16 background agent is another plugin's helper: no Wait (server/background-agents.ts).
    if (options.background || request.purpose !== "interactive" || request.provider !== "claude") return request;
    if (request.labels["plugin-tools/enabled"] === "false" || request.labels["paseo-wait/enabled"] === "false" || request.labels[WAIT_LABEL] === "false") return request;
    if (!(await this.deps.enabled())) return request;
    const config = await this.deps.config();
    const status = waitStatus(true, config, await this.deps.hostBackgroundWork?.().catch(() => false));
    // Paseo 0.16: no plugin tools needed for the host's own background work, so this comes before the tool checks.
    if (status.reason === "host") return { ...request, env: { ...request.env, FOLLOW_THROUGH_BACKGROUND_WORK: "1" } };
    if (!Array.isArray(request.tools) || request.tools.some(tool => (WAIT_TOOLS as readonly string[]).includes(tool.name))) return request;
    if (!status.active) return request;
    return { ...request, env: { ...request.env, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0", FOLLOW_THROUGH_WAIT: "1" }, tools: [...request.tools, ...this.tools] };
  }

  close() { this.jobs.close(); }
}
