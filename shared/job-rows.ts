import { EMPTY_AGENT_SETTINGS, ROLE_DEFAULTS, ROLE_INFO, isJobRole, labelsFor, resolveRole, roleSummary, type AgentRole, type AgentSettingsView, type Catalog, type RoleConfig, type SavedRole } from "./agent-settings";
import { ROLE_NEED, isRecommended, recommend, type Recommendation } from "./recommend";

/**
 * One job row, as both setup's Helper agents step and Settings → Agents show it (client/job-rows.tsx renders it).
 * Everything a row says comes from here, so the two surfaces can't drift apart (tests/job-rows.test.ts).
 */
export const SETUP_ORDER: readonly AgentRole[] = ["about", "ranker", "overseer", "recovery"];
export const SETTINGS_ORDER: readonly AgentRole[] = ["about", "overseer", "recovery", "ranker"];

type RoleView = AgentSettingsView["roles"][number];
export type JobRowModel = {
  role: AgentRole;
  title: string;
  does: string;
  need: string;
  /** What the job uses now: "Codex · GPT-6-Luna · Low". */
  pick: string;
  recommended: boolean;
  rec: Recommendation | null;
  /** The recommendation's own label, when there is one and it differs. */
  recPick: string | null;
  /** Under the need line: amber when the saved provider can't run, muted when it only differs. */
  notice: { tone: "warning" | "muted"; text: string } | null;
  /** Said after the need line while the job is on the provider-default fallback. */
  hint: string | null;
};

/** The provider each Paseo agent role switches to without prompting. */
export const NO_PROMPT_MODE: Record<string, string> = { claude: "bypassPermissions", codex: "full-access" };

const WONT_RUN: Record<AgentRole, string> = {
  about: "this won't run", ranker: "this won't run", overseer: "the Overseer can't start", recovery: "recovery agents won't start",
};

/** A recommendation's label, in the same words as a saved pick. */
export function recLabel(rec: Recommendation, catalog: Catalog | null | undefined): string | null {
  if (rec.same) return "Same as main agent";
  if (!rec.provider) return null;
  const config: RoleConfig = { role: rec.role, provider: rec.provider, model: rec.model, thinking: rec.thinking, mode: null, same: false, dailyCap: null, maxPromptChars: null, cadenceMinutes: null, isDefault: false };
  const label = roleSummary(config, labelsFor(config, catalog));
  // A fallback pick is the provider's own default model: say which, when the catalog knows.
  if (!rec.model && !(rec.role === "overseer" && rec.provider === "claude")) {
    const d = catalog?.providers.find(p => p.id === rec.provider)?.models.find(m => m.isDefault);
    if (d) return label.replace(/Default$/, `Default (${d.label})`);
  }
  return label;
}

/** A row's content. `catalog` null or empty: nothing is known yet, so no recommendation and no warnings. */
export function jobRow(r: RoleView, catalog: Catalog | null | undefined): JobRowModel {
  const role = r.role;
  const providers = catalog?.providers ?? [];
  const known = providers.length > 0 && !catalog?.error;
  const rec = known ? recommend(role, providers) : null;
  const usable = rec && rec.source !== "none" ? rec : null;
  const recommended = !!usable && isRecommended(r, usable);
  const recPick = usable && !recommended ? recLabel(usable, catalog) : null;
  const current = providers.find(p => p.id === r.provider);
  const broken = known && !r.same && !current?.available;
  let notice: JobRowModel["notice"] = null;
  if (broken) {
    const name = current?.label ?? roleSummary(r).split(" · ")[0];
    notice = { tone: "warning", text: `${name} isn't available here, so ${WONT_RUN[role]}.${recPick ? ` Recommended: ${recPick}.` : ""}` };
  } else if (recPick) notice = { tone: "muted", text: `Recommended: ${recPick}` };
  return {
    role, title: ROLE_INFO[role].title, does: ROLE_INFO[role].does, need: ROLE_NEED[role], pick: r.summary, recommended, rec: usable, recPick, notice,
    hint: recommended && usable?.source === "fallback" ? usable.hint : null,
  };
}

/**
 * What Use recommended saves for one job: provider, model and effort only. Limits and schedule stay as they are
 * (Reset to defaults in the row's More does that). The permissions mode moves only when the provider does, to that
 * provider's no-prompt mode, since a mode from another provider doesn't apply.
 */
export function recommendedEntry(r: RoleView, rec: Recommendation): SavedRole {
  const keep: SavedRole = {
    ...(r.dailyCap !== null ? { dailyCap: r.dailyCap } : {}), ...(r.maxPromptChars !== null ? { maxPromptChars: r.maxPromptChars } : {}),
    ...(r.cadenceMinutes !== null ? { cadenceMinutes: r.cadenceMinutes } : {}),
  };
  if (rec.same) return { ...keep, provider: r.provider, model: r.model, thinking: r.thinking, ...(r.mode ? { mode: r.mode } : {}), same: true };
  const provider = rec.provider ?? r.provider;
  const mode = provider === r.provider ? r.mode : provider === ROLE_DEFAULTS[r.role].provider ? ROLE_DEFAULTS[r.role].mode : NO_PROMPT_MODE[provider] ?? null;
  return { ...keep, provider, model: rec.model, thinking: rec.thinking, ...(mode && !isJobRole(r.role) ? { mode } : {}), ...(r.role === "recovery" ? { same: false } : {}) };
}

/**
 * What Reset to defaults saves. Normally nothing (the declared defaults, limits and schedule too). When the declared
 * default can't run here but something can, the recommendation instead, with the default limits and schedule, so a
 * reset never leaves a job that won't run. `label` names that pick for the row's copy.
 */
export function resetEntry(role: AgentRole, catalog: Catalog | null | undefined): { entry: SavedRole | null; label: string | null } {
  const d = resolveRole(EMPTY_AGENT_SETTINGS, role);
  const row = jobRow({ ...d, summary: roleSummary(d) }, catalog);
  if (!(row.notice?.tone === "warning" && row.rec)) return { entry: null, label: null };
  // Only the pick is saved; limits and schedule stay unsaved, which is their default.
  const { dailyCap: _c, maxPromptChars: _m, cadenceMinutes: _k, ...pick } = recommendedEntry({ ...d, summary: row.pick }, row.rec);
  return { entry: pick, label: row.recPick };
}

/** Whether Reset to defaults has nothing left to do for this job. */
export function isReset(r: RoleView, catalog: Catalog | null | undefined): boolean {
  const { entry } = resetEntry(r.role, catalog);
  if (!entry) return r.isDefault;
  const d = resolveRole(EMPTY_AGENT_SETTINGS, r.role);
  return jobRow(r, catalog).recommended && r.dailyCap === d.dailyCap && r.maxPromptChars === d.maxPromptChars && r.cadenceMinutes === d.cadenceMinutes;
}

export type JobsHeader = { text: string; tone: "muted" | "warning"; action: "use" | "retry" | "check" | null };
/** The line above the rows, and its one action. */
export function jobsHeader(rows: readonly JobRowModel[], catalog: Catalog | null | undefined, loading: boolean): JobsHeader {
  if (loading && !catalog) return { text: "Reading your providers…", tone: "muted", action: null };
  if (catalog?.error && !catalog.providers.length) return { text: "Couldn't read Paseo's providers. The current picks still work.", tone: "warning", action: "retry" };
  // Recovery copies the main agent, so it never decides whether any provider is ready.
  const picks = rows.filter(r => r.role !== "recovery");
  if (picks.length && picks.every(r => !r.rec)) return { text: "No provider in Paseo is ready, so these helpers can't run yet. Following PRs and Needs you still work.", tone: "warning", action: "check" };
  const differ = rows.filter(r => r.rec && !r.recommended).length;
  if (!differ) return { text: "Picked for the models Paseo has here.", tone: "muted", action: null };
  return { text: `${differ} job${differ === 1 ? "" : "s"} ${differ === 1 ? "differs" : "differ"} from the recommendation.`, tone: "muted", action: "use" };
}

/**
 * Setup's preselect: the jobs with nothing saved whose default can't run here (only when Claude isn't available), with
 * what to save. A saved choice is never in this list.
 */
export function preselect(roles: readonly RoleView[], catalog: Catalog | null | undefined): { role: AgentRole; entry: SavedRole }[] {
  if (!catalog || catalog.error || !catalog.providers.length || catalog.providers.some(p => p.reason === "Still loading")) return [];
  return roles.flatMap(r => {
    if (!r.isDefault) return [];
    const row = jobRow(r, catalog);
    return row.rec && !row.recommended && row.notice?.tone === "warning" ? [{ role: r.role, entry: recommendedEntry(r, row.rec) }] : [];
  });
}
