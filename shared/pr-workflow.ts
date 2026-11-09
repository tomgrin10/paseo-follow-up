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
  graphite: { label: "Graphite stacks", hint: "Merge, merge when ready and stack readiness through Graphite. Needs the gt CLI signed in on this machine." },
  github: { label: "GitHub", hint: "Readiness, merge and auto-merge straight from GitHub. Stacks follow each PR's base branch." },
};
export const workflowName = (w: PrWorkflow) => w === "graphite" ? "Graphite stacks" : "GitHub";

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = typeof MERGE_METHODS[number];
export const mergeMethodSchema = z.enum(MERGE_METHODS);
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

export const repoWorkflowSchema = z.object({
  workflow: prWorkflowSettingSchema.optional(),
  mergeMethod: mergeMethodSchema.optional(),
  reviewFix: reviewFixSchema.optional(),
});
export type RepoWorkflow = z.infer<typeof repoWorkflowSchema>;
/** `plugin-data/follow-through/pr-workflow.json`. Missing fields are the defaults. */
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
  if (!d.gtInstalled) return { workflow: "github", reason: "No stacking tool found on this machine" };
  if (!d.signedIn) return { workflow: "github", reason: "No signed-in stacking tool on this machine" };
  if (!d.path) return { workflow: "github", reason: "No local checkout to check; using GitHub" };
  if (!d.initialised) return { workflow: "github", reason: "This repository uses plain GitHub branches" };
  return { workflow: "graphite", reason: "Graphite CLI and sign-in found, and this repository uses it" };
}

export function repoSetting(config: PrWorkflowConfig, repo: string): { setting: PrWorkflowSetting; inherits: boolean } {
  const own = config.repos[repoKey(repo)]?.workflow;
  return own ? { setting: own, inherits: false } : { setting: config.default, inherits: true };
}
export function resolveWorkflow(setting: PrWorkflowSetting, detected: PrWorkflow): PrWorkflow {
  return setting === "auto" ? detected : setting;
}
export const reviewFixFor = (config: PrWorkflowConfig, repo: string | null): ReviewFix => (repo && config.repos[repoKey(repo)]?.reviewFix) || config.reviewFix;

export const repoWorkflowViewSchema = z.object({
  repo: z.string(), setting: prWorkflowSettingSchema, detected: prWorkflowSchema, effective: prWorkflowSchema, reason: z.string(),
  path: z.string().nullable(), inherits: z.boolean(),
  mergeMethod: mergeMethodSchema.nullable(), reviewFix: reviewFixSchema.nullable(),
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
});

/** What an agent's instructions depend on: the workspace's workflow and its review-fix command (null: built-in). */
export type AgentWorkflow = { mode: PrWorkflow; reviewFix: string | null };
