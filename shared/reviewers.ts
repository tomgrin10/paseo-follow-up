import { z } from "zod";
import type { Pr } from "./model";

/**
 * Who "Add reviewers" asks, per repository, set by the developer in Settings → Reviewers or remembered from the
 * picker. A login is a GitHub user (`octocat`) or a team as `org/team-slug`. Nothing is hardcoded: a repository
 * with no list falls back to "Default for all repos", and with neither the button opens the picker.
 */
export const USER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const TEAM_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const REPO = /^[\w.-]+\/[\w.-]+$/;
export const MAX_REVIEWERS = 15;

export const reviewerLoginSchema = z.string().trim().max(140).refine(v => USER_LOGIN.test(v) || TEAM_SLUG.test(v), "A reviewer is a GitHub login or an org/team slug.");
export const reviewerEntrySchema = z.object({ login: reviewerLoginSchema, name: z.string().trim().max(80).nullish().transform(v => v || null) });
export type ReviewerEntry = z.infer<typeof reviewerEntrySchema>;
export const reviewerListSchema = z.array(reviewerEntrySchema).max(MAX_REVIEWERS);
export const reviewerConfigSchema = z.object({
  version: z.literal(1),
  /** Keyed by lower-case owner/repo. An empty list is the same as none: the default applies. */
  repos: z.record(z.string(), reviewerListSchema),
  defaults: reviewerListSchema,
  /** Set once the one-time seed from earlier reviewer requests has run, so it never runs again. */
  migratedAt: z.string().nullable(),
});
export type ReviewerConfig = z.infer<typeof reviewerConfigSchema>;
export const emptyReviewerConfig = (): ReviewerConfig => ({ version: 1, repos: {}, defaults: [], migratedAt: null });

export const isTeam = (login: string) => login.includes("/");
export const repoKey = (repo: string) => repo.trim().toLowerCase();
/** What a person reads: the display name, else the login. Teams read as their full org/team slug. */
export const reviewerLabel = (r: ReviewerEntry) => r.name || r.login;
export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** One entry per login (case-insensitive), in order, at most MAX_REVIEWERS. */
export function cleanList(list: readonly ReviewerEntry[]): ReviewerEntry[] {
  const out: ReviewerEntry[] = [];
  for (const r of list) if (!out.some(o => sameLogin(o.login, r.login))) out.push({ login: r.login.trim(), name: r.name?.trim() || null });
  return out.slice(0, MAX_REVIEWERS);
}

export type ReviewerSource = "repo" | "default" | "none";
/** Repository list, else the default for all repos, else nobody. */
export function resolveReviewers(config: ReviewerConfig, repo: string): { reviewers: ReviewerEntry[]; source: ReviewerSource } {
  const own = config.repos[repoKey(repo)] ?? [];
  if (own.length) return { reviewers: own, source: "repo" };
  if (config.defaults.length) return { reviewers: config.defaults, source: "default" };
  return { reviewers: [], source: "none" };
}

/** The PR author can't review their own PR; a team is never the author. */
export function withoutAuthor(list: readonly ReviewerEntry[], author: string | null | undefined): ReviewerEntry[] {
  return author ? list.filter(r => isTeam(r.login) || !sameLogin(r.login, author)) : [...list];
}

/** GitHub's request body splits people from teams; a team goes by its slug within the repository's org. */
export function splitReviewers(logins: readonly string[]): { users: string[]; teams: string[] } {
  return { users: logins.filter(l => !isTeam(l)), teams: logins.filter(isTeam).map(l => l.split("/")[1]) };
}

/** Whether every asked reviewer now shows on the PR (requested or already reviewed). */
export function allAssigned(logins: readonly string[], assigned: { requested: string[]; teams: string[]; reviewed: string[] }): boolean {
  return logins.every(l => isTeam(l)
    ? assigned.teams.some(t => sameLogin(t, l.split("/")[1]) || sameLogin(t, l))
    : [...assigned.requested, ...assigned.reviewed].some(x => sameLogin(x, l)));
}

/**
 * The config this process last loaded. The server sets it on load and on every save; the client sets it from
 * `follow.reviewers-config`. Shared code (Needs you, briefs) reads it through `configuredReviewers`.
 */
let current: ReviewerConfig = emptyReviewerConfig();
const listeners = new Set<() => void>();
export function setReviewerConfig(config: ReviewerConfig): void { current = config; for (const l of listeners) l(); }
export function reviewerConfig(): ReviewerConfig { return current; }
export function onReviewerConfig(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function configuredReviewers(repo: string): ReviewerEntry[] { return resolveReviewers(current, repo).reviewers; }

export function noReviewers(pr: Pr): boolean {
  const s = pr.snapshot;
  return !pr.error && !!s?.complete && s.state === "OPEN" && !!s.reviewers?.complete && !s.reviewers.requested.length && !s.reviewers.teams.length && !s.reviewers.reviewed.length;
}
