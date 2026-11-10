import { ROLE_DEFAULTS, type AgentRole, type CatalogModel, type CatalogProvider, type RoleConfig } from "./agent-settings";

/**
 * Which model each helper job should use, from whatever providers Paseo has. Setup's "Helper agents" step and
 * Settings → Agents both read this, so they always agree.
 *
 * With Claude available the declared defaults stand (Haiku, Sonnet, the newest Opus). Otherwise each job gets a model of
 * the size it needs, judged from the catalog's own wording first and the model's name only as a fallback; when nothing
 * fits, the provider's default with a hint.
 */
export type Tier = "small" | "mid" | "strong";
export const ROLE_TIER: Record<AgentRole, Tier | "same"> = { about: "small", ranker: "mid", overseer: "strong", recovery: "same" };

/** One plain line per job: what it needs and why. */
export const ROLE_NEED: Record<AgentRole, string> = {
  about: "Short, frequent and cheap, so a small, fast model.",
  ranker: "Reads a lot and has to give reasons, so a mid-size model.",
  overseer: "Long-lived and reasons across everything, so your strongest model.",
  recovery: "Rebuilds a workspace, so the same setup as its main agent.",
};
const HINT: Record<Tier, string> = {
  small: "None of its models says which is small, so this is its default.",
  mid: "None of its models says which is mid-size, so this is its default.",
  strong: "None of its models says which is strongest, so this is its default.",
};

// Name fallbacks, as whole words so "gemini" isn't "mini". Order matters only when a name has both.
const SMALL_NAME = /(^|[^a-z])(haiku|mini|flash|small|lite|nano)([^a-z]|$)/i;
const STRONG_NAME = /(^|[^a-z])(opus|pro|large|max)([^a-z]|$)/i;
const SMALL_WORDS = /\b(fast(est)?|small(est)?|lightweight|light-weight|cheap(est)?|quick(est)?|low[- ]latency|low[- ]cost|budget)\b/i;
const STRONG_WORDS = /\b(most (capable|intelligent|powerful|advanced)|strongest|frontier|flagship|complex (tasks|reasoning)|deep(est)? reasoning|hardest)\b/i;

/** A model's size from the catalog: its description first ("metadata"), then its id and label ("name"). */
export function modelTier(m: Pick<CatalogModel, "id" | "label" | "description">): { tier: Tier; source: "metadata" | "name" } | null {
  const d = m.description ?? "";
  const small = SMALL_WORDS.test(d), strong = STRONG_WORDS.test(d);
  if (small !== strong) return { tier: small ? "small" : "strong", source: "metadata" };
  const name = `${m.id} ${m.label}`;
  const sn = SMALL_NAME.test(name), st = STRONG_NAME.test(name);
  if (sn !== st) return { tier: sn ? "small" : "strong", source: "name" };
  return null;
}

export type Recommendation = {
  role: AgentRole;
  /** "same": recovery copies the main agent. */
  same: boolean;
  provider: string | null;
  /** null: the provider's default model. */
  model: string | null;
  thinking: string | null;
  /** How it was picked: Claude's declared default, the catalog's wording, the model's name, or the provider's default. */
  source: "default" | "same" | "metadata" | "name" | "fallback" | "none";
  /** Said under the pick when it's only the provider's default. */
  hint: string | null;
};

const order = (catalog: readonly CatalogProvider[]) => catalog.filter(p => p.available).sort((a, b) => rank(a.id) - rank(b.id));
const rank = (id: string) => id === "claude" ? 0 : id === "codex" ? 1 : 2;

/** The lowest effort a small model offers ("minimal", "low"), else the provider's own. */
const lowEffort = (m: CatalogModel) => m.thinking.find(t => /^(minimal|low)$/i.test(t.id))?.id ?? null;

export function recommend(role: AgentRole, catalog: readonly CatalogProvider[]): Recommendation {
  const tier = ROLE_TIER[role];
  if (tier === "same") return { role, same: true, provider: ROLE_DEFAULTS.recovery.provider, model: null, thinking: null, source: "same", hint: null };
  const providers = order(catalog);
  if (!providers.length) return { role, same: false, provider: null, model: null, thinking: null, source: "none", hint: null };
  if (providers[0].id === "claude") { const d = ROLE_DEFAULTS[role]; return { role, same: false, provider: d.provider, model: d.model, thinking: d.thinking, source: "default", hint: null }; }
  for (const want of ["metadata", "name"] as const) {
    for (const p of providers) {
      const hit = pick(p.models, tier, want);
      if (hit) return { role, same: false, provider: p.id, model: hit.id, thinking: tier === "small" ? lowEffort(hit) : null, source: want, hint: null };
    }
  }
  return { role, same: false, provider: providers[0].id, model: null, thinking: null, source: "fallback", hint: HINT[tier] };
}

/**
 * small/strong: a model judged that size. mid: an unjudged model (most mid-size models carry no size word), the
 * provider's default first; judged only by name, so a "metadata" pass looks for descriptions that say neither.
 */
function pick(models: readonly CatalogModel[], tier: Tier, want: "metadata" | "name"): CatalogModel | null {
  const judged = models.map(m => ({ m, t: modelTier(m) }));
  if (tier !== "mid") {
    // A whole family where only names tell sizes apart still ranks by name: prefer the provider's default among ties.
    const fits = judged.filter(x => x.t?.tier === tier && x.t.source === want);
    return (fits.find(x => x.m.isDefault) ?? fits[0])?.m ?? null;
  }
  const plain = judged.filter(x => !x.t && (want === "name" || !!x.m.description));
  if (!plain.length) return null;
  return (plain.find(x => x.m.isDefault) ?? plain[0]).m;
}

export function recommendAll(catalog: readonly CatalogProvider[]): Record<AgentRole, Recommendation> {
  return { about: recommend("about", catalog), ranker: recommend("ranker", catalog), overseer: recommend("overseer", catalog), recovery: recommend("recovery", catalog) };
}

/** Whether a role as used matches the recommendation (Settings' "Recommended" marker). */
export function isRecommended(r: Pick<RoleConfig, "provider" | "model" | "same">, rec: Recommendation): boolean {
  if (rec.same) return r.same;
  if (r.same || !rec.provider) return false;
  return r.provider === rec.provider && (r.model ?? null) === rec.model;
}
