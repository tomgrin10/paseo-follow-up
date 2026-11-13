// no-real-names-in-renders-or-fixtures: the repo is public. A render (a screenshot's page text) or a committed file
// under scripts/, tests/, docs/ or changes/ must never name the real machine, its user, or the company. This file is the
// one place that lists them, and it lists only the generic company words: the real hostname and user name are read
// from the environment at run time (os.hostname(), os.userInfo()), so the denylist is not a plain-text leak itself.
import { hostname, userInfo } from "node:os";

/** The company, as words: never in a render or a fixture. Matched case-insensitively. */
const COMPANY = [/\bhero\b/i, /herosecurity/i];

/**
 * Product configuration that names the company on purpose, until Tom decides Q55 (move the deploy-check targets, the
 * default tracked repo and the reviewer login map into local host settings, or leave them). Each token is allowed
 * only in the files listed, and only that exact token: any other mention in those files still fails. Product files
 * themselves (server/deployments.ts, shared/settings.ts, server/reviewer-config.ts, PRODUCT.md) are outside the scanned
 * directories.
 */
export const ALLOWED = [
  { token: "herosecurity/hero-poc", reason: "the deploy check's repository (server/deployments.ts, Q55)",
    files: ["scripts/poll-cost.mjs", "tests/deployments.test.ts", "tests/github-poll-cost.test.ts", "tests/worker-reads-github-in-process.test.ts"] },
  { token: "example/hero-poc", reason: "the default-tracked repository basename (shared/settings.ts, Q55)",
    files: ["scripts/check-install.mjs", "scripts/check-project-settings.mjs", "tests/project-settings.test.ts"] },
  { token: "hero-poc", reason: "the default-tracked repository basename (shared/settings.ts, Q55)",
    files: ["tests/project-settings.test.ts"] },
  { token: "hero-production-environments", reason: "the deploy check's GCP project (server/deployments.ts, Q55)",
    files: ["scripts/poll-cost.mjs", "tests/deployments.test.ts", "tests/github-poll-cost.test.ts", "tests/worker-reads-github-in-process.test.ts"] },
  { token: "hero-docker-repo", reason: "the deploy check's image repository (server/deployments.ts, Q55)",
    files: ["scripts/poll-cost.mjs", "tests/deployments.test.ts", "tests/github-poll-cost.test.ts", "tests/worker-reads-github-in-process.test.ts"] },
  { token: "hero-service-vspm", reason: "the deploy check's Cloud Run services (server/deployments.ts, Q55)",
    files: ["scripts/poll-cost.mjs", "tests/deployments.test.ts", "tests/github-poll-cost.test.ts", "tests/worker-reads-github-in-process.test.ts"] },
  { token: "uyy-hero-security", reason: "the legacy reviewer login map (server/reviewer-config.ts, Q55)",
    files: ["tests/reviewer-config.test.ts"] },
  // Renders: the default-tracked project shows its key in Settings → Following.
  { token: "example/hero-poc", reason: "the default-tracked repository shown in Settings (shared/settings.ts, Q55)", files: ["<render>"] },
];

/** This machine's identifying names, from the environment: hostname (full and short) and user name. Not in CI. */
export function machineNames(env = process.env, host = hostname(), user = (() => { try { return userInfo().username; } catch { return ""; } })()) {
  if (env.CI) return []; // a CI runner's names ("runner") are generic words, and the leak this guards against is local
  return [...new Set([host, host.split(".")[0], user].filter(n => n && n.length >= 4))];
}

/** Every denied name in `text` (for `where`: a repo path, or "<render>"), after the allowed tokens for it are removed. */
export function deniedNames(text, where = "<render>", machine = machineNames()) {
  let rest = text;
  for (const a of ALLOWED) if (a.files.includes(where)) rest = rest.split(a.token).join(" ");
  const hits = [];
  for (const re of COMPANY) { const m = rest.match(re); if (m) hits.push(m[0]); }
  for (const name of machine) if (rest.toLowerCase().includes(name.toLowerCase())) hits.push(name);
  return hits;
}

/** For a render: throws when the page names the machine, its user or the company. */
export function assertNoRealNames(text, label = "render") {
  const hits = deniedNames(text, "<render>");
  if (hits.length) throw new Error(`${label} shows a real name (${hits.join(", ")}); renders use fictional names only (scripts/real-names.mjs)`);
}
