import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { checksLine, named } from "../shared/agent-text.mjs";
import { hasHooks, isAcp } from "../shared/provider-support";

/**
 * Paseo 0.17 (#9781): a plugin's `agent.open.before` result may carry `appendSystemPrompt`, which the provider gets as
 * part of its system prompt (Claude's appended system prompt, Codex's developer instructions). Follow-up's static
 * session text goes there instead of the SessionStart hook's `additionalContext`: the role texts that native tools
 * lack (needs_you, the action tools, the Overseer), Wait's guidance, and the wait_for_checks line. The worker names the
 * parts it put in the prompt in FOLLOW_UP_SYSTEM_PROMPT, and the hook leaves exactly those out (docs/hooks.md).
 *
 * One delivery path (one-place-for-agent-text): on a host and provider that take it, every provider gets all of its
 * session text here, the tracked workspace's instructions included (part `workspace`), and the hook adds none of it.
 * The workspace text follows the role and the PR workflow, which can change mid-session; what the session was given is
 * recorded (`hook-state/prompt-<agent>.json`, a hash), and a change reaches the agent once, through whichever comes
 * first: the next Follow-up tool result (any provider, `changedInstructions`) or the hook's next prompt (Claude Code,
 * Codex). What stays the hook's: the Overseer's digest, the polling nudge, the detached notice and the Stop check.
 */
export const SYSTEM_PROMPT_ENV = "FOLLOW_UP_SYSTEM_PROMPT";
export const PROMPT_PARTS = ["needsYou", "action", "overseer", "wait", "backgroundWork", "checks", "workspace"] as const;
export type PromptPart = typeof PROMPT_PARTS[number];

/** The hash the hook compares too (server/agent-hook.mjs `digest`): sha256, 16 hex characters. */
export const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** Where the workspace text a session was given is recorded, relative to the data directory. */
export const promptRecordPath = (agentId: string) => `hook-state/prompt-${agentId}.json`;
export type PromptRecord = { hash: string; at: number };

/** The role and Wait texts (shared/agent-text.mjs), the ones the hook adds too. */
export type BridgeTexts = { needsYouInstruction?: string; actionInstruction?: string; overseerInstruction?: string; waitInstruction?: string; backgroundWorkInstruction?: string };

export { checksLine, named };

/**
 * Which parts a session gets in its system prompt, from the env Follow-up launched it with. Mirrors the hook's
 * SessionStart (server/hook-source.ts): a recovery agent gets nothing (the hook returns first); the Overseer gets its
 * native role texts and Wait's; any other session gets Wait's; and a native root agent (the hook's gate always passes
 * for one) gets its role texts and the checks line. A background agent never reaches here (invariant 9).
 */
export function promptParts(env: Readonly<Record<string, string | undefined>>): PromptPart[] {
  if (env.FOLLOW_UP_RECOVERY === "1") return [];
  const native = env.FOLLOW_UP_TOOLS === "native";
  const overseer = env.FOLLOW_UP_OVERSEER === "1";
  const root = env.FOLLOW_UP_ROOT === "1";
  const parts: PromptPart[] = [];
  if (native && (overseer || root)) {
    if (env.FOLLOW_UP_BRIEF) parts.push("needsYou");
    if (root) parts.push("action");
    if (overseer) parts.push("overseer");
  }
  if (env.FOLLOW_UP_WAIT === "1") parts.push("wait");
  else if (env.FOLLOW_UP_BACKGROUND_WORK === "1") parts.push("backgroundWork");
  if (native && root && !overseer) parts.push("checks");
  return parts;
}

/** The parts' text, in the hook's order, named for the session's tools. A part with no text is dropped. */
export function promptText(parts: readonly PromptPart[], bridge: BridgeTexts, native: boolean): { parts: PromptPart[]; text: string[] } {
  const raw: Record<PromptPart, string | undefined> = {
    needsYou: bridge.needsYouInstruction, action: bridge.actionInstruction, overseer: bridge.overseerInstruction,
    wait: bridge.waitInstruction, backgroundWork: bridge.backgroundWorkInstruction, checks: checksLine, workspace: undefined,
  };
  const kept = parts.filter(p => !!raw[p]);
  // Role texts and the checks line are named for native tools, as the hook does; Wait's texts never name Follow-up's.
  return { parts: kept, text: kept.map(p => p === "wait" || p === "backgroundWork" ? raw[p]! : named(raw[p]!, native)) };
}

/**
 * A provider Follow-up has no hook in (anything but Claude Code and Codex): no hook adds anything, so the system prompt
 * carries all of what the hook's SessionStart would have, including the tracked workspace's instructions and the
 * checks line for any root or tracked agent.
 */
export function hooklessParts(env: Readonly<Record<string, string | undefined>>, tracked: boolean): PromptPart[] {
  const parts = promptParts(env);
  if (env.FOLLOW_UP_RECOVERY === "1" || env.FOLLOW_UP_OVERSEER === "1" || parts.includes("checks")) return parts;
  return env.FOLLOW_UP_ROOT === "1" || tracked ? [...parts, "checks"] : parts;
}

type OpenRequest = { agentId?: string; provider: string; purpose: string; env: Record<string, string>; appendSystemPrompt?: string[]; tools?: AgentToolDefinition[] };

/** The tool an ACP agent reads Follow-up's instructions through (Paseo doesn't pass a plugin's system prompt to ACP). */
export const INSTRUCTIONS_TOOL = "follow_session_instructions";
/**
 * Follow-up's instructions as a tool: its description is in the agent's context on every turn (tool lists reach ACP
 * agents through Paseo's MCP), and it tells the agent to read them first. The text is what the system prompt would
 * have carried, fixed at session open like a system prompt.
 */
export function instructionsTool(text: string): AgentToolDefinition {
  return {
    name: INSTRUCTIONS_TOOL,
    description: "Follow-up's instructions for this session. Call this once at the start of the session and again after compaction, before any other follow_ tool, and follow what it returns.",
    input: z.object({}).strict(),
    execute: () => ({ text }),
  };
}
export type PromptDeps = {
  /** The host takes `appendSystemPrompt` from a session-open hook (Paseo 0.17+). */
  hostSupports(): Promise<boolean>;
  /** The provider can take it: Claude always; Codex from 0.121 (older throws on a new thread). */
  providerSupports(provider: string): Promise<boolean>;
  bridge(): Promise<BridgeTexts | null>;
  /**
   * The tracked workspace's instructions for this agent (shared/agent-text.mjs workspaceText, what the hook adds), or
   * null when it isn't a tracked main or contributor agent.
   */
  workspace?(agentId: string, native: boolean): Promise<string | null>;
  /** Records the hash of the workspace text this session was given ("" for none), for a later change (promptRecordPath). */
  record?(agentId: string, hash: string): Promise<void>;
  /** Paseo runs this provider over ACP (shared/provider-support.ts isAcp, from Paseo's config): it drops a plugin's system prompt. */
  acp?(provider: string): Promise<boolean>;
};

/**
 * The session-open result with Follow-up's static text as `appendSystemPrompt`, and FOLLOW_UP_SYSTEM_PROMPT naming
 * what moved. Unchanged when the host or provider can't take it, the bridge can't be read, or nothing applies: the
 * hook then adds all of it, as before.
 */
export async function withSystemPrompt<R extends OpenRequest>(request: R, deps: PromptDeps, options: { background?: boolean } = {}): Promise<R & { appendSystemPrompt?: string[] }> {
  // Invariant 9: a background agent (another plugin's helper) gets nothing from Follow-up, its system prompt included.
  if (options.background) return request;
  if (request.purpose !== "interactive") return request;
  const native = request.env.FOLLOW_UP_TOOLS === "native";
  const hooked = hasHooks(request.provider);
  // An ACP agent never receives appendSystemPrompt (Paseo 0.17.4): the same text goes in a tool it is told to read
  // first (instructionsTool), and no env claims a system prompt it never got.
  const acp = !hooked && await (deps.acp?.(request.provider) ?? Promise.resolve(isAcp(request.provider))).catch(() => isAcp(request.provider));
  // The workspace instructions go in the system prompt for every provider (one delivery path).
  const workspace = request.env.FOLLOW_UP_RECOVERY === "1" || !request.agentId || !deps.workspace ? null : await deps.workspace(request.agentId, native).catch(() => null);
  const wanted = hooklessParts(request.env, !!workspace);
  if (!wanted.length && !workspace) return request;
  if (acp) {
    if (!Array.isArray(request.tools) || request.tools.some(t => t.name === INSTRUCTIONS_TOOL)) return request;
    const bridge = await deps.bridge().catch(() => null);
    if (!bridge) return request;
    const { parts, text } = promptText(wanted, bridge, native);
    if (!parts.length && !workspace) return request;
    return { ...request, tools: [...request.tools, instructionsTool([...(workspace ? [workspace] : []), ...text].join("\n\n"))] };
  }
  if (!(await deps.hostSupports().catch(() => false))) return request;
  if (hooked && !(await deps.providerSupports(request.provider).catch(() => false))) return request;
  const bridge = await deps.bridge().catch(() => null);
  if (!bridge) return request;
  const { parts, text } = promptText(wanted, bridge, native);
  if (!parts.length && !workspace) return request;
  // A root or tracked agent's workspace text is this prompt's from now on, even when it has none yet (an untracked root
  // agent enrolled later gets its text once, like a role change). Recorded before the session opens.
  const owns = !!deps.record && request.env.FOLLOW_UP_OVERSEER !== "1" && (request.env.FOLLOW_UP_ROOT === "1" || !!workspace);
  if (owns) await deps.record!(request.agentId!, workspace ? textHash(workspace) : "").catch(() => undefined);
  const claimed = owns || workspace ? [...parts, "workspace"] : parts;
  return { ...request, appendSystemPrompt: [...(request.appendSystemPrompt ?? []), [...(workspace ? [workspace] : []), ...text].join("\n\n")], env: { ...request.env, [SYSTEM_PROMPT_ENV]: claimed.join(",") } };
}

/**
 * The workspace instructions a session hasn't been given yet, once: its role or PR workflow changed since its system
 * prompt (or it was enrolled after it opened). Null when nothing changed, the session's text isn't recorded (an older
 * host or provider: the hook carries it), or the agent has no workspace text now. Records what it returns, so the
 * hook's next prompt and later tool results stay quiet.
 */
export async function changedInstructions(agentId: string, deps: { recorded(agentId: string): Promise<PromptRecord | null>; workspace(agentId: string, native: boolean): Promise<string | null>; record(agentId: string, hash: string): Promise<void> }): Promise<string | null> {
  const record = await deps.recorded(agentId).catch(() => null);
  if (!record) return null;
  const text = await deps.workspace(agentId, true).catch(() => null);
  if (!text || textHash(text) === record.hash) return null;
  await deps.record(agentId, textHash(text));
  return text;
}
/** How a changed text leads a tool result. */
export const CHANGED_INSTRUCTIONS_HEADER = "Follow-up's instructions for this session changed (your role or this workspace's PR workflow did). They replace the earlier workspace instructions:";

/** The installed Codex CLI's version as [major, minor, patch], or null (not installed, unreadable). */
export function codexVersion(command = "codex", timeoutMs = 5000): Promise<[number, number, number] | null> {
  return new Promise(resolve => {
    execFile(command, ["--version"], { timeout: timeoutMs }, (error, stdout) => {
      const m = !error && /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout));
      resolve(m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null);
    });
  });
}
export const atLeast = (v: readonly number[] | null, min: readonly number[]) => !!v && (v[0]! - min[0]! || v[1]! - min[1]! || v[2]! - min[2]!) >= 0;
/** Codex from this version takes developer instructions on a new thread (Paseo throws "Update Codex to 0.121.0" below it). */
export const CODEX_PROMPT_MIN = [0, 121, 0] as const;
