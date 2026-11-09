import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * "Bypass means bypass" (Tom, 2026-11-09). Claude Code still sends some tool calls to the permission prompt in
 * bypassPermissions mode (its bypass-immune safety checks: compound `cd … && git`, writes under .git/ or a config folder,
 * commands it can't statically validate), so a bypass agent stops and flags Needs you anyway. When the agent's mode
 * *right now* is a full-trust mode, Follow-up answers those plain tool permissions with allow, and logs each one.
 *
 * Never answered: anything that needs the developer's own input (questions, plan approval, MCP elicitation or auth), or
 * any request whose kind isn't a plain tool permission. Never for an agent in any other mode.
 */
export const FULL_TRUST_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "full-access"]);
/** Tool names that ask the developer something even when their kind says "tool" (Codex sends elicitation as one). */
const NEEDS_DEVELOPER = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "CodexMcpElicitation"]);
const NEEDS_DEVELOPER_PATTERN = /elicit|question|ask[_-]?user|oauth|authenticat|authoriz|login|consent/i;

export type PermissionRequestShape = { id: string; kind?: string; name?: string; title?: string; description?: string; input?: Record<string, unknown> | null; actions?: { intent?: string }[] | null };

/** A plain tool permission: the only kind a trusted agent's mode already answers. Pure, so every exclusion is tested. */
export function plainToolPermission(request: PermissionRequestShape): boolean {
  if (request.kind !== "tool") return false;
  const name = String(request.name ?? "");
  if (!name || NEEDS_DEVELOPER.has(name) || NEEDS_DEVELOPER_PATTERN.test(name)) return false;
  // Actions with an intent are plan-style choices (implement / resume / dismiss), not a yes to a tool call.
  if (request.actions?.some(action => action.intent)) return false;
  return true;
}

/**
 * Secret-looking values a command line can carry, masked before it reaches the audit log or Settings: values after
 * token/key/secret/password flags or variables, Authorization headers, credentials in URLs, and long opaque tokens.
 */
export function redact(text: string): string {
  return text
    .replace(/((?:--?|\b)[\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w-]*\s*[=:\s]\s*)("[^"]*"|'[^']*'|[^\s-]\S*)/gi, "$1•••")
    .replace(/\b(authorization:\s*(?:bearer|basic|token)?\s*)\S+/gi, "$1•••")
    .replace(/(\/\/[^\/\s:@]+:)[^@\s\/]+@/g, "$1•••@")
    .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abpsr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|ya29\.[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, "•••");
}

/** "Bash: cd repo && git status" — the tool and a short, single-line, redacted view of what it ran, for the audit log. */
export function summarize(request: PermissionRequestShape, max = 160): string {
  const input = request.input ?? {};
  const detail = [input.command, input.file_path, input.path, input.url, input.pattern].find(v => typeof v === "string") as string | undefined;
  const text = redact((detail ?? request.title ?? request.description ?? "").replace(/\s+/g, " ").trim());
  const line = text ? `${request.name}: ${text}` : String(request.name ?? "tool");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** An agent as Paseo's agent list reports it (metadata only: listing never loads an agent). */
export type ListedAgent = { id: string; status?: string; archivedAt?: string | null; pendingPermissions?: unknown[] | null };

export type Approval = { at: string; agentId: string; tool: string; summary: string; mode: string };
export type Decision = { approved: true; mode: string } | { approved: false; reason: "off" | "not-a-tool" | "mode" | "error"; mode?: string | null };

export type TrustOptions = {
  enabled: () => Promise<boolean>;
  /** The agent's current mode, read at request time (one fetch). Null when unknown. */
  mode: (agentId: string) => Promise<string | null>;
  approve: (agentId: string, requestId: string) => Promise<void>;
  now?: () => number;
  /** Lines the audit log keeps; it is trimmed back to this once it grows half again past it. */
  keep?: number;
};

export class TrustBypass {
  private readonly file: string;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(directory: string, private readonly o: TrustOptions) { this.file = join(directory, "trust-bypass.jsonl"); }

  async handle(agent: { id: string }, request: PermissionRequestShape): Promise<Decision> {
    if (!await this.o.enabled().catch(() => false)) return { approved: false, reason: "off" };
    if (!plainToolPermission(request)) return { approved: false, reason: "not-a-tool" };
    const mode = await this.o.mode(agent.id).catch(() => null);
    if (!mode || !FULL_TRUST_MODES.has(mode)) return { approved: false, reason: "mode", mode };
    try { await this.o.approve(agent.id, request.id); } catch { return { approved: false, reason: "error", mode }; }
    await this.record({ at: new Date((this.o.now ?? Date.now)()).toISOString(), agentId: agent.id, tool: String(request.name), summary: summarize(request), mode }).catch(() => undefined);
    return { approved: true, mode };
  }

  /**
   * Prompts that were already pending when Follow-up loaded or updated never raise a new event, so they would wait for
   * the developer. Runs each one through `handle`, the same checks as a new prompt (setting, plain tool, current mode).
   * Only agents the list shows with a pending prompt: those are loaded (an unloaded agent has none), so nothing here
   * loads or wakes an agent. Archived and closed agents are skipped.
   */
  async sweep(agents: readonly ListedAgent[]): Promise<Decision[]> {
    const decisions: Decision[] = [];
    for (const agent of agents) {
      if (agent.archivedAt || agent.status === "closed" || !agent.pendingPermissions?.length) continue;
      for (const request of agent.pendingPermissions) {
        if (typeof request !== "object" || request === null || typeof (request as { id?: unknown }).id !== "string") continue;
        decisions.push(await this.handle(agent, request as PermissionRequestShape));
      }
    }
    return decisions;
  }

  /** Appends one line; past keep × 1.5 lines, keeps the newest `keep`. Serialized so concurrent approvals don't race the trim. */
  private record(entry: Approval): Promise<void> {
    const keep = this.o.keep ?? 500;
    const run = async () => {
      await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
      await appendFile(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
      const lines = (await readFile(this.file, "utf8")).split("\n").filter(Boolean);
      if (lines.length <= keep * 1.5) return;
      const temporary = `${this.file}.${randomUUID()}`;
      await writeFile(temporary, lines.slice(-keep).join("\n") + "\n", { mode: 0o600 });
      await rename(temporary, this.file);
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** The newest approvals, newest first, and how many landed since local midnight. Unreadable lines are skipped. */
  async recent(limit = 20): Promise<{ today: number; recent: Approval[] }> {
    const text = await readFile(this.file, "utf8").catch(() => "");
    const all = text.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Approval]; } catch { return []; } });
    const midnight = new Date((this.o.now ?? Date.now)()); midnight.setHours(0, 0, 0, 0);
    return { today: all.filter(a => Date.parse(a.at) >= midnight.getTime()).length, recent: all.slice(-limit).reverse() };
  }
}
