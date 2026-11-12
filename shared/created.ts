import { z } from "zod";
import { modelName } from "./agent-settings";
import { PRESENCE, type TaskAgentState } from "./task-status";

/**
 * The chat card for an agent or workspace another agent creates (Paseo's create_agent / create_workspace tool calls).
 * The card stands in for the raw call, so Paseo's "N tool calls" group no longer counts it (a transform can only
 * replace an item, like the Done card). Parsing is pure and conservative: a completed call whose result carries no
 * agentId / workspaceId keeps Paseo's plain row.
 */
export const CREATED_KIND = "follow-up.created";
export const CREATED_VERSION = 1;

export const createdCardSchema = z.object({
  kind: z.enum(["agent", "workspace"]),
  phase: z.enum(["starting", "created", "failed"]),
  /** The new agent's or workspace's id; null until the call completes. */
  id: z.string().nullable(),
  title: z.string().nullable(),
  /** "Opus 5.5"; agents only. */
  model: z.string().nullable(),
  /** "claude", "codex": which tile glyph to draw. */
  provider: z.string().nullable(),
  /** The workspace the agent lives in (agents), from the result. */
  workspaceId: z.string().nullable(),
  /** Workspaces: the branch and the repository, as the call asked for them. */
  branch: z.string().nullable(),
  repo: z.string().nullable(),
  error: z.string().nullable(),
});
export type CreatedCard = z.infer<typeof createdCardSchema>;

type ToolCallLike = { name: string; status: "running" | "completed" | "failed" | "canceled"; error: unknown; detail: unknown };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const CREATE_TOOL = /^(?:mcp__)?paseo(?:__|\.|\/|:)create_(agent|workspace)$/;

/** Which create call this is, by tool name across providers ("mcp__paseo__create_agent", "paseo.create_workspace"). */
export function createdKind(name: string): "agent" | "workspace" | null {
  const m = CREATE_TOOL.exec(name);
  return m ? m[1] as "agent" | "workspace" : null;
}

/** An MCP result: a JSON string, `{ content: [{ type: "text", text }] }`, or the object itself. */
function resultObject(output: unknown): Record<string, unknown> | null {
  if (record(output) && Array.isArray(output.content)) {
    const text = output.content.map(c => record(c) && typeof c.text === "string" ? c.text : "").join("");
    return resultObject(text);
  }
  if (typeof output === "string") { try { const v: unknown = JSON.parse(output); return record(v) ? v : null; } catch { return null; } }
  return record(output) ? output : null;
}

const errorText = (v: unknown): string | null => {
  if (typeof v === "string") return str(v);
  if (record(v)) return str(v.message) ?? str(v.error) ?? errorText(v.content);
  if (Array.isArray(v)) return str(v.map(c => record(c) && typeof c.text === "string" ? c.text : "").join(" "));
  return null;
};

/** "claude/claude-opus-5-5" → { provider: "claude", model: "Opus 5.5" }; a bare provider has no model. */
function providerModel(provider: unknown, model: unknown): { provider: string | null; model: string | null } {
  const p = str(provider); const m = str(model);
  if (!p) return { provider: null, model: m ? modelName(m) : null };
  const [id, ...rest] = p.split("/");
  const named = m ?? (rest.length ? rest.join("/") : null);
  return { provider: id || null, model: named ? modelName(named) : null };
}

/** The card for one create call, or null to keep Paseo's row (not a create call, canceled, or no id in the result). */
export function createdCard(item: ToolCallLike): CreatedCard | null {
  const kind = createdKind(item.name);
  if (!kind || item.status === "canceled") return null;
  const detail = record(item.detail) ? item.detail : {};
  const input = record(detail.input) ? detail.input : {};
  const output = "output" in detail ? detail.output : undefined;
  const failed = item.status === "failed" || (record(output) && output.isError === true);
  const { provider, model } = kind === "agent" ? providerModel(input.provider, input.model) : { provider: null, model: null };
  const base = {
    kind, title: str(input.title) ?? (kind === "workspace" ? str(input.branchName) ?? str(input.worktreeSlug) : null), model, provider,
    branch: kind === "workspace" ? str(input.branchName) ?? str(input.branch) : null,
    repo: kind === "workspace" ? str(input.path)?.split("/").filter(Boolean).at(-1) ?? null : null,
  };
  if (failed) return { ...base, phase: "failed", id: null, workspaceId: null, error: errorText(item.error) ?? errorText(output) ?? "The call failed" };
  if (item.status === "running") return { ...base, phase: "starting", id: null, workspaceId: null, error: null };
  const result = resultObject(output);
  if (!result) return null;
  const nested = record(result.workspace) ? result.workspace : null;
  const id = kind === "agent" ? str(result.agentId) ?? str(result.id) : str(result.workspaceId) ?? str(nested?.id) ?? str(result.id);
  if (!id) return null;
  return { ...base, phase: "created", id, title: base.title ?? (kind === "workspace" ? str(nested?.name) ?? str(result.name) : null),
    workspaceId: kind === "agent" ? str(result.workspaceId) : id, error: null };
}

/** Live facts the card reads (follow.created-items), from the engine's directory snapshot. Missing: not known yet. */
export type CreatedLive = {
  agents: Record<string, { title: string | null; state: TaskAgentState; workspaceId: string | null; main: boolean }>;
  workspaces: Record<string, { name: string | null; follow: FollowLine | null }>;
};
/** What Follow-up says about a tracked workspace, only when there's something to say. */
export type FollowLine = { question: { id: string; title: string } | null; chips: { text: string; tone: "success" | "danger" | "warning" | "merged" | "muted" }[]; line: string | null };

/** The card's status word and whether it opens, from the same table task lines use (PRESENCE). */
export function cardPresence(card: CreatedCard, live: CreatedLive | undefined): { word: string; tone: TaskAgentState | "pending" | "failed" | "unknown"; opens: boolean } {
  if (card.phase === "starting") return { word: "", tone: "pending", opens: false };
  if (card.phase === "failed" || !card.id) return { word: "", tone: "failed", opens: false };
  if (card.kind === "workspace") return { word: "", tone: "unknown", opens: true };
  const state = live?.agents[card.id]?.state;
  if (!state) return { word: "", tone: "unknown", opens: true };
  const p = PRESENCE[state];
  return { word: p.word.charAt(0).toUpperCase() + p.word.slice(1), tone: state, opens: p.opens };
}

/** "New agent · Opus 5.5 · Pill cleanup" / "New workspace · feat/billing-retry · billing". */
export function cardMeta(card: CreatedCard, live: CreatedLive | undefined): string {
  if (card.phase === "failed") return card.error ?? "";
  if (card.kind === "agent") {
    const ws = card.id ? live?.agents[card.id]?.workspaceId ?? card.workspaceId : card.workspaceId;
    return ["New agent", card.model, ws ? live?.workspaces[ws]?.name ?? null : null].filter(Boolean).join(" · ");
  }
  return ["New workspace", card.branch, card.repo].filter(Boolean).join(" · ");
}

/** The card's headline: the live title once known, else what the call asked for. */
export function cardTitle(card: CreatedCard, live: CreatedLive | undefined): string {
  const named = card.kind === "agent" && card.id ? live?.agents[card.id]?.title?.trim() : card.kind === "workspace" && card.id ? live?.workspaces[card.id]?.name?.trim() : null;
  const title = named || card.title || (card.kind === "agent" ? "New agent" : "New workspace");
  if (card.phase === "starting") return `${card.kind === "agent" ? "Starting" : "Creating"} ${title}…`;
  if (card.phase === "failed") return `Couldn't ${card.kind === "agent" ? "start" : "create"} ${title}`;
  return title;
}

/** The Follow-up line a card shows: for a workspace card, its workspace; for an agent, only when it's that workspace's main agent. */
export function cardFollow(card: CreatedCard, live: CreatedLive | undefined): FollowLine | null {
  if (card.phase !== "created" || !card.id || !live) return null;
  const wsId = card.kind === "workspace" ? card.id : live.agents[card.id]?.main ? live.agents[card.id]?.workspaceId : null;
  const f = wsId ? live.workspaces[wsId]?.follow : null;
  return f && (f.question || f.chips.length || f.line) ? f : null;
}
