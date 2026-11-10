import { z } from "zod";
import { waitStatusSchema } from "./wait";

/**
 * Which agent each of Follow-up's special roles uses (Settings → Agents), kept in `agents.json` next to state.json.
 *
 * - `about`: Summaries, a one-shot job (server/ai-jobs.ts).
 * - `ranker`: the Overseer's priority ranker, a one-shot job.
 * - `overseer`: the long-lived Overseer agent in Paseo.
 * - `recovery`: the agent Follow-up starts to rebuild a workspace's tracking; "Same as main agent" by default.
 *
 * Every entry is optional and parsed on its own: a missing or invalid entry (or field) falls back to today's default,
 * so nothing changes for anyone who never opens the screen.
 */

export const AGENT_ROLES = ["about", "overseer", "recovery", "ranker"] as const;
export type AgentRole = typeof AGENT_ROLES[number];
/**
 * One-shot jobs run on any Paseo provider. These two have a headless CLI fast path (server/ai-jobs.ts); every other
 * provider runs the job as a short-lived hidden agent (server/job-agent.ts).
 */
export const CLI_JOB_PROVIDERS = ["claude", "codex"] as const;
export const isJobRole = (role: AgentRole) => role === "about" || role === "ranker";

const name = z.string().trim().min(1).max(120).regex(/^[\w.:@/[\]-]+$/);
/** What the developer saved for one role. `model: null` means the provider's default; `same` is recovery only. */
export const savedRoleSchema = z.object({
  provider: name.optional(),
  model: name.nullable().optional(),
  thinking: name.nullable().optional(),
  mode: name.nullable().optional(),
  same: z.boolean().optional(),
  dailyCap: z.number().int().min(0).max(500).optional(),
  maxPromptChars: z.number().int().min(4000).max(200_000).optional(),
  cadenceMinutes: z.number().int().min(5).max(24 * 60).optional(),
});
export type SavedRole = z.infer<typeof savedRoleSchema>;
/** `enable_wait`: Wait for background jobs (shared/wait.ts); absent means on. */
export type AgentSettingsFile = { version: 1; roles: Partial<Record<AgentRole, SavedRole>>; enable_wait?: boolean };
export const EMPTY_AGENT_SETTINGS: AgentSettingsFile = { version: 1, roles: {} };

/** A role as used: every field filled in. `model: null` is the provider's default (for the Overseer: the newest Opus). */
export type RoleConfig = {
  role: AgentRole;
  provider: string;
  model: string | null;
  thinking: string | null;
  /** Paseo agents only (overseer, recovery). */
  mode: string | null;
  /** Recovery only: copy the main agent's provider, model, mode and thinking. */
  same: boolean;
  /** Jobs only. */
  dailyCap: number | null;
  maxPromptChars: number | null;
  cadenceMinutes: number | null;
  /** True when nothing saved differs from the default. */
  isDefault: boolean;
};

export const ROLE_DEFAULTS: Record<AgentRole, Omit<RoleConfig, "role" | "isDefault">> = {
  about: { provider: "claude", model: "haiku", thinking: null, mode: null, same: false, dailyCap: 60, maxPromptChars: 40_000, cadenceMinutes: null },
  overseer: { provider: "claude", model: null, thinking: null, mode: "bypassPermissions", same: false, dailyCap: null, maxPromptChars: null, cadenceMinutes: null },
  recovery: { provider: "claude", model: null, thinking: null, mode: "bypassPermissions", same: true, dailyCap: null, maxPromptChars: null, cadenceMinutes: null },
  ranker: { provider: "claude", model: "sonnet", thinking: null, mode: null, same: false, dailyCap: 24, maxPromptChars: 60_000, cadenceMinutes: 60 },
};

export const ROLE_INFO: Record<AgentRole, { title: string; does: string }> = {
  about: { title: "Summaries", does: "Writes the summary and one-line gist at the top of a workspace." },
  overseer: { title: "Overseer", does: "Routes your asks to the agents that own them." },
  recovery: { title: "Recovery", does: "Rebuilds a workspace's tracking when Follow-up lost track of it." },
  ranker: { title: "Priority ranker", does: "Ranks workspaces for Home's Priority sort." },
};

/** Reads the file leniently: anything unreadable becomes empty, each role and field is checked on its own. */
export function parseAgentSettings(raw: unknown): { file: AgentSettingsFile; invalid: AgentRole[] } {
  const roles: AgentSettingsFile["roles"] = {};
  const invalid: AgentRole[] = [];
  const source = raw && typeof raw === "object" && (raw as { roles?: unknown }).roles && typeof (raw as { roles: unknown }).roles === "object" ? (raw as { roles: Record<string, unknown> }).roles : {};
  for (const role of AGENT_ROLES) {
    const entry = source[role];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== "object") { invalid.push(role); continue; }
    const kept: SavedRole = {};
    let bad = false;
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      const field = (savedRoleSchema.shape as Record<string, z.ZodType>)[key];
      if (!field) continue;
      const parsed = field.safeParse(value);
      if (parsed.success) Object.assign(kept, { [key]: parsed.data }); else bad = true;
    }
    if (bad) invalid.push(role);
    if (Object.keys(kept).length) roles[role] = kept;
  }
  const wait = raw && typeof raw === "object" ? (raw as { enable_wait?: unknown }).enable_wait : undefined;
  return { file: { version: 1, roles, ...(typeof wait === "boolean" ? { enable_wait: wait } : {}) }, invalid };
}

/** The role as used. A provider that changed without a model drops the old model, thinking and mode. */
export function resolveRole(file: AgentSettingsFile | null | undefined, role: AgentRole): RoleConfig {
  const base = ROLE_DEFAULTS[role];
  const saved = file?.roles?.[role] ?? {};
  const provider = saved.provider ?? base.provider;
  const sameProvider = provider === base.provider;
  const pick = <K extends "model" | "thinking" | "mode">(key: K) => saved[key] !== undefined ? saved[key] ?? null : sameProvider ? base[key] : null;
  const jobs = isJobRole(role);
  const out: RoleConfig = {
    role, provider, model: pick("model"), thinking: pick("thinking"),
    mode: jobs ? null : pick("mode") ?? (sameProvider ? base.mode : null),
    same: role === "recovery" ? saved.same ?? base.same : false,
    dailyCap: jobs ? saved.dailyCap ?? base.dailyCap : null,
    maxPromptChars: jobs ? saved.maxPromptChars ?? base.maxPromptChars : null,
    cadenceMinutes: role === "ranker" ? saved.cadenceMinutes ?? base.cadenceMinutes : null,
    isDefault: false,
  };
  out.isDefault = (["provider", "model", "thinking", "mode", "same", "dailyCap", "maxPromptChars", "cadenceMinutes"] as const).every(k => out[k] === base[k]);
  return out;
}

export const resolveAll = (file: AgentSettingsFile | null | undefined): Record<AgentRole, RoleConfig> =>
  Object.fromEntries(AGENT_ROLES.map(r => [r, resolveRole(file, r)])) as Record<AgentRole, RoleConfig>;

/** The "provider/model" string Paseo's agent create takes; null model: let the caller pick the provider's default. */
export const providerModelId = (c: Pick<RoleConfig, "provider" | "model">) => c.model ? `${c.provider}/${c.model}` : null;

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot" };
const titleWord = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const providerName = (id: string, label?: string | null) => label || PROVIDER_NAMES[id] || titleWord(id);
/** "haiku" → "Haiku", "claude-opus-5-5" → "Opus 5.5", "gpt-6-luna" → "GPT-6-Luna" (catalog labels win when known). */
export function modelName(model: string | null, label?: string | null): string {
  if (label) return label;
  if (!model) return "Default";
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(model);
  if (claude) return `${titleWord(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  if (/^gpt-/i.test(model)) return model.replace(/^gpt/i, "GPT").split("-").map((p, i) => i === 0 ? p : titleWord(p)).join("-");
  return titleWord(model);
}
/** "Claude · Haiku", "Same as main agent", "Codex · GPT-6-Luna · low". */
export function roleSummary(c: RoleConfig, labels?: { provider?: string | null; model?: string | null; thinking?: string | null }): string {
  if (c.role === "recovery" && c.same) return "Same as main agent";
  const parts = [providerName(c.provider, labels?.provider), c.model || c.role !== "overseer" ? modelName(c.model, labels?.model) : "Newest Opus"];
  if (c.thinking) parts.push(labels?.thinking ?? c.thinking);
  return parts.join(" · ");
}

/** What the Settings screen gets from the live provider catalog. */
export type CatalogModel = { id: string; label: string; isDefault: boolean; description?: string; thinking: { id: string; label: string; isDefault: boolean }[] };
export type CatalogProvider = { id: string; label: string; available: boolean; reason: string | null; models: CatalogModel[]; modes: { id: string; label: string }[]; defaultMode: string | null };
export type Catalog = { providers: CatalogProvider[]; error: string | null; fetchedAt: string | null };

export const roleConfigSchema = z.object({
  role: z.enum(AGENT_ROLES), provider: z.string(), model: z.string().nullable(), thinking: z.string().nullable(), mode: z.string().nullable(), same: z.boolean(),
  dailyCap: z.number().nullable(), maxPromptChars: z.number().nullable(), cadenceMinutes: z.number().nullable(), isDefault: z.boolean(),
});
const catalogModelSchema = z.object({ id: z.string(), label: z.string(), isDefault: z.boolean(), description: z.string().optional(), thinking: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() })) });
export const catalogSchema = z.object({
  providers: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean(), reason: z.string().nullable(), models: z.array(catalogModelSchema), modes: z.array(z.object({ id: z.string(), label: z.string() })), defaultMode: z.string().nullable() })),
  error: z.string().nullable(), fetchedAt: z.string().nullable(),
});
/** Settings → Agents: every role as used, which saved entries were invalid, and (when asked) the live catalog. */
export const agentSettingsViewSchema = z.object({
  roles: z.array(roleConfigSchema.extend({ summary: z.string() })),
  invalid: z.array(z.enum(AGENT_ROLES)),
  catalog: catalogSchema.nullable(),
  /** Wait for background jobs; optional so an older worker's reply still parses. */
  wait: waitStatusSchema.optional(),
});
export type AgentSettingsView = z.infer<typeof agentSettingsViewSchema>;

/** Display labels for a role from the catalog, when it has them ("Opus 5.5" instead of "claude-opus-5-5"). */
export function labelsFor(c: RoleConfig, catalog: Catalog | null | undefined): { provider?: string; model?: string; thinking?: string } {
  const p = catalog?.providers.find(x => x.id === c.provider);
  if (!p) return {};
  const m = c.model ? p.models.find(x => x.id === c.model) : null;
  const t = c.thinking ? m?.thinking.find(x => x.id === c.thinking) : null;
  return { provider: p.label, ...(m ? { model: m.label } : {}), ...(t ? { thinking: t.label } : {}) };
}
