// no-real-names-in-renders-or-fixtures: the repo is public. A render (a screenshot's page text) or any committed file
// must never name the real machine, its user, the company, its people, its customers or its ticket keys.
//
// The denied words are stored only as sha256 hashes of lowercase word tokens, never in clear: the goal is that no
// public file carries the plain text for anyone to grep or index. Short words are guessable from their hash, and that
// is fine: this keeps the text out of the repo; it is not a secret. The checker splits text into [a-z0-9]+ tokens
// (so hyphen, dot, slash and underscore compounds are split into their words) and compares each token's hash.
// The real hostname and user name are read from the environment at run time (os.hostname(), os.userInfo()).
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

/** sha256 of a lowercase word token. */
export const hashWord = word => createHash("sha256").update(word.toLowerCase()).digest("hex");

/**
 * Denied word tokens, matched case-insensitively: the company, its logins, its product word, its work account.
 * A compound such as an env var or a login is caught by any one of its words.
 */
export const COMPANY_HASHES = [
  "ae6c79d10f1fd410650790e63186ec108fa106325b52fbd88de21a43540e6f2c",
  "0d3c9bd949dbaec23f3a1c4eecac17404fb479a5e6badc24df461bd9b1ac1967",
  "6cb8db69e915b8b8dfb7dd1875e126c6d0dc1480629dc0d7fdfed5cba14bd998",
  "0f76cdd5fed837950ac865909dc3eccdd37c3c90b3a0e5d404e93741e513e31b",
  "8f47468a8f522f6b2861b2f6604076115815f499f2a8d9ecfcdb6a656527a26d",
  "0d19277699bfbd15b8b475343dddc8757f394eeae10475db34718756e8c8ac9e",
];
/**
 * Denied names, matched only as a capitalised word (case-sensitive), since some are also common lower-case words:
 * people's first names and customer names.
 */
export const NAME_HASHES = [
  "e43de1c745c6bf275743528a029e49f73532ccfc0591df181bcabbb0fdcc5d5d",
  "acc539b5c96544fe89f57530fd17376553e2ea45f49ae83f686296c47de3b443",
  "00ce2d4b3eb395e57abd986505b3357cddc314464faedaeecdf69c2d4a256d16",
  "5cea8a2076b11069708f9f18c1b190d4110c9c3e66de0676d3054c00f1a4e10e",
];
/** Denied ticket-key prefixes: followed by a hyphen and digits, or a team key in capitals (fixtures use ACME-123 or APP-123). */
export const TICKET_HASHES = [
  "354cbfc814262a7a81d343f7d6ebc4adfb4266e5081a78f6a19ff16802dce8b2",
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
export function deniedNames(text, { machine = machineNames(), hashes = COMPANY_HASHES, names = NAME_HASHES, tickets = TICKET_HASHES, allow = [] } = {}) {
  let rest = text;
  for (const a of allow) if (a) rest = rest.split(a).join(" ");
  const denied = new Set(hashes); const deniedNames = new Set(names); const deniedTickets = new Set(tickets);
  const hits = [];
  for (const token of rest.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (denied.has(hashWord(token))) hits.push(token);
  const exact = word => createHash("sha256").update(word).digest("hex");
  for (const token of rest.match(/[A-Z][a-z]+/g) ?? []) if (deniedNames.has(exact(token))) hits.push(token);
  // A ticket prefix: followed by -digits or a template's -${, or on its own in capitals (a team key, "key": "ABC").
  for (const [, prefix, rest2] of rest.matchAll(/(?<![A-Za-z0-9])([A-Za-z]+)-(\d+|\$\{)/g)) if (deniedTickets.has(hashWord(prefix))) hits.push(`${prefix}-${rest2}`);
  for (const token of rest.match(/(?<![A-Za-z0-9])[A-Z]{2,}(?![A-Za-z0-9])/g) ?? []) if (deniedTickets.has(hashWord(token))) hits.push(token);
  for (const name of machine) if (rest.toLowerCase().includes(name.toLowerCase())) hits.push(name);
  return [...new Set(hits)];
}

/** For a render: throws when the page names the machine, its user or the company. */
export function assertNoRealNames(text, label = "render", allow = []) {
  const hits = deniedNames(text, { allow });
  if (hits.length) throw new Error(`${label} shows a real name (${hits.length} hit${hits.length > 1 ? "s" : ""}); renders use fictional names only (scripts/real-names.mjs)`);
}
