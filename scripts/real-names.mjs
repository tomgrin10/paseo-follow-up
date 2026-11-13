// no-real-names-in-renders-or-fixtures: the repo is public. A render (a screenshot's page text) or a committed file
// under scripts/, tests/, docs/ or changes/ must never name the real machine, its user, or the company.
//
// The company words are stored only as sha256 hashes of lowercase word tokens, never in clear: the goal is that no
// public file carries the plain text for anyone to grep or index. Short words are guessable from their hash, and that
// is fine: this keeps the text out of the repo; it is not a secret. The checker splits text into [a-z0-9]+ tokens
// (so hyphen, dot, slash and underscore compounds are split into their words) and compares each token's hash.
// The real hostname and user name are read from the environment at run time (os.hostname(), os.userInfo()).
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { DEFAULT_TRACKED_BASENAME } from "../shared/settings.ts";

/** sha256 of a lowercase word token. */
export const hashWord = word => createHash("sha256").update(word.toLowerCase()).digest("hex");

/** The company, as hashed word tokens: never in a render or a fixture. */
export const COMPANY_HASHES = [
  "ae6c79d10f1fd410650790e63186ec108fa106325b52fbd88de21a43540e6f2c",
  "0d3c9bd949dbaec23f3a1c4eecac17404fb479a5e6badc24df461bd9b1ac1967",
];

/**
 * Product files that still carry the company's configuration on purpose, and the tests and scripts that exercise it.
 * Excluded by path; the Q55 host-config PR moves that configuration into local host settings and deletes this list.
 */
export const EXCLUDED = Object.fromEntries([
  "server/deployments.ts",
  "shared/settings.ts",
  "server/reviewer-config.ts",
  "PRODUCT.md",
  "docs/prs.md",
  "scripts/poll-cost.mjs",
  "tests/deployments.test.ts",
  "tests/github-poll-cost.test.ts",
  "tests/worker-reads-github-in-process.test.ts",
  "tests/project-settings.test.ts",
  "tests/reviewer-config.test.ts",
].map(path => [path, "removed by the Q55 host-config PR"]));

/** This machine's identifying names, from the environment: hostname (full and short) and user name. Not in CI. */
export function machineNames(env = process.env, host = hostname(), user = (() => { try { return userInfo().username; } catch { return ""; } })()) {
  if (env.CI) return []; // a CI runner's names ("runner") are generic words, and the leak this guards against is local
  return [...new Set([host, host.split(".")[0], user].filter(n => n && n.length >= 4))];
}

/**
 * Every denied name in `text`: word tokens whose hash is denied, and this machine's names. `allow` lists exact strings
 * removed first (a render showing a value the caller read from product code at run time, never a literal).
 */
export function deniedNames(text, { machine = machineNames(), hashes = COMPANY_HASHES, allow = [] } = {}) {
  let rest = text;
  for (const a of allow) if (a) rest = rest.split(a).join(" ");
  const denied = new Set(hashes);
  const hits = [];
  for (const token of rest.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (denied.has(hashWord(token))) hits.push(token);
  for (const name of machine) if (rest.toLowerCase().includes(name.toLowerCase())) hits.push(name);
  return [...new Set(hits)];
}

/** Renders may show the default-tracked repository (Settings → Following), read from product code, never spelled here. */
export const RENDER_ALLOW = [`example/${DEFAULT_TRACKED_BASENAME}`];

/** For a render: throws when the page names the machine, its user or the company. */
export function assertNoRealNames(text, label = "render", allow = []) {
  const hits = deniedNames(text, { allow: [...RENDER_ALLOW, ...allow] });
  if (hits.length) throw new Error(`${label} shows a real name (${hits.length} hit${hits.length > 1 ? "s" : ""}); renders use fictional names only (scripts/real-names.mjs)`);
}
