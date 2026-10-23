import type { Pr } from "./model";

export function defaultReviewers(repo: string): { name: string; login: string }[] {
  return repo.toLowerCase() === "herosecurity/hero-poc" ? [{ name: "Uri", login: "uyy-hero-security" }, { name: "Yuval", login: "yuvalgoder-star" }] : [];
}
export function noReviewers(pr: Pr): boolean {
  const s = pr.snapshot;
  return !pr.error && !!s?.complete && s.state === "OPEN" && !!s.reviewers?.complete && !s.reviewers.requested.length && !s.reviewers.teams.length && !s.reviewers.reviewed.length;
}
