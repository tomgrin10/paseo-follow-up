import { z } from "zod";
import { REPO, repoKey } from "./reviewers";

/**
 * How a repository ships PRs. "auto" picks Graphite only where Graphite is actually set up (the CLI on PATH, its
 * sign-in, and the repository initialised with `gt`); everywhere else it is plain GitHub, which is a full mode:
 * readiness, merge, auto-merge and base-branch stacks all come from GitHub itself.
 */
export const PR_WORKFLOWS = ["auto", "graphite", "github"] as const;
export type PrWorkflowSetting = typeof PR_WORKFLOWS[number];
export type PrWorkflow = Exclude<PrWorkflowSetting, "auto">;
export const prWorkflowSettingSchema = z.enum(PR_WORKFLOWS);
export const prWorkflowSchema = z.enum(["graphite", "github"]);

/** The same plain words Settings and onboarding show. The github hint never mentions Graphite. */
export const PR_WORKFLOW_LABELS: Record<PrWorkflowSetting, { label: string; hint: string }> = {
  auto: { label: "Auto", hint: "Works it out per repository from what's installed and how the repository is set up." },
  graphite: { label: "Graphite", hint: "Merge, merge when ready and stack readiness through Graphite. Needs the gt CLI signed in on this machine." },
  github: { label: "GitHub", hint: "Readiness, merge and auto-merge straight from GitHub. Stacks follow each PR's base branch." },
};
export const workflowName = (w: PrWorkflow) => w === "graphite" ? "Graphite" : "GitHub";

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = typeof MERGE_METHODS[number];
export const mergeMethodSchema = z.enum(MERGE_METHODS);
export const MERGE_METHOD_SHORT: Record<MergeMethod, string> = { squash: "Squash", merge: "Merge commit", rebase: "Rebase" };
export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" };

/**
 * How agents address review comments: Follow-up's built-in steps (read unresolved threads with gh, fix, push, reply
 * and resolve), or a named skill or slash command such as `/fix-pr`.
 */
export const reviewFixSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin") }),
  z.object({ kind: z.literal("command"), command: z.string().trim().regex(/^\/?[\w:.-]{1,80}$/, "Use a skill or command name such as /fix-pr.") }),
]);
export type ReviewFix = z.infer<typeof reviewFixSchema>;
export const BUILTIN_REVIEW_FIX: ReviewFix = { kind: "builtin" };
export const commandName = (fix: ReviewFix): string | null => fix.kind === "command" ? (fix.command.startsWith("/") ? fix.command : `/${fix.command}`) : null;

/**
 * Who reviews and merges a repository's PRs. "team" (the default): the developer adds reviewers and merges, so
 * Follow-up asks for both. "none": the agent reviews and merges its own PRs once checks pass, so Follow-up never asks.
 */
export const REVIEW_MODES = ["team", "none"] as const;
export type ReviewMode = typeof REVIEW_MODES[number];
export const reviewModeSchema = z.enum(REVIEW_MODES);
/** One sentence per mode, said the same way everywhere: Settings, its menu and the undo bar. */
export const REVIEW_MODE_LABELS: Record<ReviewMode, { label: string; hint: string }> = {
  team: { label: "Team review", hint: "Follow-up asks you to add reviewers and to merge." },
  none: { label: "No review", hint: "The agent merges its own PRs once checks pass." },
};

export const repoWorkflowSchema = z.object({
  workflow: prWorkflowSettingSchema.optional(),
  mergeMethod: mergeMethodSchema.optional(),
  reviewFix: reviewFixSchema.optional(),
  review: reviewModeSchema.optional(),
});
export type RepoWorkflow = z.infer<typeof repoWorkflowSchema>;
/** `plugin-data/follow-up/pr-workflow.json`. Missing fields are the defaults. */
export const prWorkflowConfigSchema = z.object({
  version: z.literal(1).default(1),
  default: prWorkflowSettingSchema.default("auto"),
  reviewFix: reviewFixSchema.default(BUILTIN_REVIEW_FIX),
  repos: z.record(z.string(), repoWorkflowSchema).default({}),
  /** The one-time review-fix seed ran (see server/pr-workflow.ts). */
  migratedAt: z.string().optional(),
});
export type PrWorkflowConfig = z.infer<typeof prWorkflowConfigSchema>;
export const emptyPrWorkflowConfig = (): PrWorkflowConfig => prWorkflowConfigSchema.parse({});

/** What the machine and the repository say, gathered without running gt. */
export type Detection = { gtInstalled: boolean; signedIn: boolean; path: string | null; initialised: boolean };
export function detect(d: Detection): { workflow: PrWorkflow; reason: string } {
  if (!d.gtInstalled) return { workflow: "github", reason: "Using GitHub. Graphite isn’t set up on this machine." };
  if (!d.signedIn) return { workflow: "github", reason: "Using GitHub. Graphite isn’t set up on this machine." };
  if (!d.path) return { workflow: "github", reason: "No local checkout to check; using GitHub" };
  if (!d.initialised) return { workflow: "github", reason: "Using GitHub. This repository isn’t set up for Graphite." };
  return { workflow: "graphite", reason: "Using Graphite. The gt CLI is signed in and this repository is initialised." };
}

export function repoSetting(config: PrWorkflowConfig, repo: string): { setting: PrWorkflowSetting; inherits: boolean } {
  const own = config.repos[repoKey(repo)]?.workflow;
  return own ? { setting: own, inherits: false } : { setting: config.default, inherits: true };
}
export function resolveWorkflow(setting: PrWorkflowSetting, detected: PrWorkflow): PrWorkflow {
  return setting === "auto" ? detected : setting;
}
/** Repositories set to No review, from a saved config (keys are already lower-case owner/name). */
export const noReviewRepos = (config: Pick<PrWorkflowConfig, "repos">): string[] => Object.entries(config.repos).filter(([, r]) => r.review === "none").map(([repo]) => repo).sort();

/**
 * The repositories set to No review in this process. The server fills it from pr-workflow.json before the first
 * engine tick and on every save; the client fills it from `follow.reviewers-config`. Hot paths read it through
 * `agentMerges`: a set lookup, nothing more.
 */
let noReview: ReadonlySet<string> = new Set();
let noReviewVersion = 0;
const noReviewListeners = new Set<() => void>();
export function setNoReviewRepos(repos: Iterable<string>): void {
  const next = new Set([...repos].map(repoKey));
  if (next.size === noReview.size && [...next].every(r => noReview.has(r))) return;
  noReview = next; noReviewVersion++;
  for (const l of noReviewListeners) l();
}
/** For the client: re-render what computed Needs you when the set changes (useSyncExternalStore). */
export function onNoReviewRepos(listener: () => void): () => void { noReviewListeners.add(listener); return () => { noReviewListeners.delete(listener); }; }
export const noReviewReposVersion = () => noReviewVersion;
export const noReviewRepoList = (): string[] => [...noReview].sort();
export const repoReview = (repo: string): ReviewMode => noReview.has(repoKey(repo)) ? "none" : "team";
/**
 * Whether the agent merges this PR itself, so Follow-up never asks the developer to add reviewers or merge it and its
 * merge flags nobody. The PR's own register_pr answer wins (false hands a merge back even in a No review repository);
 * otherwise the repository's review mode decides. The ONE reader of `pr.agentMerges`: every consumer goes through it
 * (tests/review-mode.test.ts scans for direct reads). Invariant a-no-review-repo-never-asks-for-review-or-merge.
 */
export function agentMerges(pr: { repo: string; agentMerges?: boolean }): boolean {
  return pr.agentMerges ?? noReview.has(repoKey(pr.repo));
}

export const reviewFixFor = (config: PrWorkflowConfig, repo: string | null): ReviewFix => (repo && config.repos[repoKey(repo)]?.reviewFix) || config.reviewFix;

export const repoWorkflowViewSchema = z.object({
  repo: z.string(), setting: prWorkflowSettingSchema, detected: prWorkflowSchema, effective: prWorkflowSchema, reason: z.string(),
  path: z.string().nullable(), inherits: z.boolean(),
  mergeMethod: mergeMethodSchema.nullable(), reviewFix: reviewFixSchema.nullable(),
  review: reviewModeSchema.default("team"),
  /** What GitHub allows here, from the newest PR Follow-up read in this repository; null until it has read one. */
  github: z.object({ methods: z.array(mergeMethodSchema), preferred: mergeMethodSchema.nullable(), autoMerge: z.boolean(), mergeQueue: z.boolean() }).nullable().default(null),
});
export type RepoWorkflowView = z.infer<typeof repoWorkflowViewSchema>;
export const prWorkflowViewSchema = z.object({
  gt: z.object({ installed: z.boolean(), signedIn: z.boolean() }),
  default: prWorkflowSettingSchema,
  reviewFix: reviewFixSchema,
  repos: z.array(repoWorkflowViewSchema),
});
export type PrWorkflowView = z.infer<typeof prWorkflowViewSchema>;
export const setPrWorkflowInputSchema = z.strictObject({
  repo: z.string().regex(REPO).optional(),
  setting: prWorkflowSettingSchema.nullable().optional(),
  default: prWorkflowSettingSchema.optional(),
  mergeMethod: mergeMethodSchema.nullable().optional(),
  reviewFix: reviewFixSchema.nullable().optional(),
  /** null: back to the default, Team review. */
  review: reviewModeSchema.nullable().optional(),
});

/** Settings' line for the default: "Auto · GitHub in 5 repositories, Graphite in 3". */
export function shippingSummary(view: Pick<PrWorkflowView, "default" | "repos">): string {
  const counts = (["github", "graphite"] as const).map(w => [w, view.repos.filter(r => r.effective === w).length] as const).filter(([, n]) => n > 0);
  const lead = PR_WORKFLOW_LABELS[view.default].label;
  if (!counts.length) return lead;
  if (counts.length === 1) return `${lead} · ${workflowName(counts[0][0])} everywhere`;
  return `${lead} · ${counts.map(([w, n]) => `${workflowName(w)} in ${n}`).join(", ")}`;
}
/** One repository's folded line: "GitHub · Auto", "Graphite · set here", plus a merge method chosen here. */
export function repoShippingSummary(row: RepoWorkflowView): string {
  // What was set here comes before "Auto", so a phone's truncation cuts the least useful part.
  const method = row.mergeMethod && row.effective === "github" ? MERGE_METHOD_SHORT[row.mergeMethod] : "";
  const review = row.review === "none" ? REVIEW_MODE_LABELS.none.label : "";
  return [workflowName(row.effective), method, review, row.inherits ? (row.setting === "auto" ? "Auto" : "default") : "set here"].filter(Boolean).join(" · ");
}
/** "3 GitHub · 2 Graphite · 1 set here". */
export function reposShippingSummary(rows: readonly RepoWorkflowView[]): string {
  const gh = rows.filter(r => r.effective === "github").length, gt = rows.length - gh, own = rows.filter(r => !r.inherits || r.mergeMethod || r.reviewFix || r.review === "none").length;
  return [gh ? `${gh} GitHub` : "", gt ? `${gt} Graphite` : "", own ? `${own} set here` : ""].filter(Boolean).join(" · ") || "None yet";
}
export const reviewFixLabel = (fix: ReviewFix) => fix.kind === "builtin" ? "Built-in steps" : commandName(fix)!;

/** What an agent's instructions depend on: the workspace's workflow and its review-fix command (null: built-in). */
export type AgentWorkflow = { mode: PrWorkflow; reviewFix: string | null; noReview?: boolean };

/**
 * What setup's per-repository select writes. "Auto" while the default is Auto means inherit (null), as Settings'
 * "Default" does, so going Graphite → Auto doesn't leave the repository pinned.
 */
export function setupWrite(view: Pick<PrWorkflowView, "default">, repo: string, choice: PrWorkflowSetting): { repo: string; setting: PrWorkflowSetting | null } {
  return { repo, setting: choice === "auto" && view.default === "auto" ? null : choice };
}
/** Setup's select value: an inheriting repository under an Auto default shows Auto. */
export const setupValue = (view: Pick<PrWorkflowView, "default">, row: Pick<RepoWorkflowView, "inherits" | "setting">): PrWorkflowSetting => row.inherits ? view.default : row.setting;
