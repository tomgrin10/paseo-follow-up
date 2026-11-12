import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Node = Record<string, any>;

/**
 * How Follow-up reads GitHub while polling: GraphQL and REST GETs for one repository. Writes (merge, retarget,
 * reviewers) still go through the gh CLI; they're rare and user-driven.
 *
 * 2026-11-11 (cpu-load REPORT.md §5): polling through `gh` spawned ~40 processes a minute (the ~/.local/bin/gh
 * wrapper is bash + a token lookup + gh). `httpApi` resolves each owner's token once and talks HTTPS in-process, so
 * a poll spawns nothing. tests/github-poll-cost.test.ts counts requests per tick.
 */
export interface GithubApi {
  /** The parsed GraphQL body, `errors` included: a partial response is data, not a failure. */
  graphql(repo: string, query: string, variables: Record<string, string>): Promise<Node>;
  /** A parsed REST GET (`repos/...`). Throws on HTTP errors. */
  rest(repo: string, path: string): Promise<unknown>;
}

/** The same reads through a `gh` runner (tests, and hosts that inject one). */
export function cliApi(run: (args: string[], repo: string) => Promise<string>): GithubApi {
  return {
    async graphql(repo, query, variables) {
      const args = ["api", "graphql", ...Object.entries(variables).flatMap(([k, v]) => ["-f", `${k}=${v}`]), "-f", `query=${query}`];
      try { return JSON.parse(await run(args, repo)); } catch (error) {
        // gh exits non-zero on a partial response but still prints the body.
        const stdout = (error as { stdout?: string }).stdout;
        if (stdout) { try { const body = JSON.parse(stdout); if (body && typeof body === "object" && "data" in body) return body; } catch { /* not a body */ } }
        throw error;
      }
    },
    async rest(repo, path) { return JSON.parse(await run(["api", path], repo)); },
  };
}

export class GithubAuthError extends Error {}

/** `owner account` lines, `*` as the fallback: the same file and rules as the ~/.local/bin/gh wrapper. */
export function accountFor(map: string, owner: string): string | null {
  let fallback: string | null = null;
  for (const line of map.split("\n")) {
    const [o, account] = line.trim().split(/\s+/);
    if (!o || o.startsWith("#") || !account) continue;
    if (o === owner) return account;
    if (o === "*" && !fallback) fallback = account;
  }
  return fallback;
}

/** No session bus on a headless host: without this, gh's keyring lookup leaks a dbus-daemon + gnome-keyring pair. */
export const DEAD_BUS = "unix:path=/nonexistent/gh-no-session-bus";

type TokenSource = (owner: string) => Promise<string>;
type GhRun = (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
const ghRun: GhRun = async (bin, args, env) => (await exec(bin, args, { env, timeout: 15_000 })).stdout;

/** The real gh (never the wrapper, which would inject a token of its own), with GH_TOKEN stripped and a dead bus. */
function realGh(environment: NodeJS.ProcessEnv) {
  const { GH_TOKEN: _a, GITHUB_TOKEN: _b, ...rest } = environment;
  return { env: { ...rest, DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS || DEAD_BUS }, bin: environment.FOLLOW_UP_GH_BIN || (existsSync("/usr/bin/gh") ? "/usr/bin/gh" : "gh") };
}

/** A gh account's token (`gh auth token --user`), or the active account's for null. */
export function ghAccountToken(environment: NodeJS.ProcessEnv = process.env, run: GhRun = ghRun) {
  return async (account: string | null): Promise<string> => {
    if (!account && (environment.GH_TOKEN || environment.GITHUB_TOKEN)) return (environment.GH_TOKEN || environment.GITHUB_TOKEN)!;
    const { env, bin } = realGh(environment);
    const token = (await run(bin, ["auth", "token", ...(account ? ["--user", account] : [])], env).catch(() => "")).trim();
    if (!token) throw new GithubAuthError(account ? `No GitHub token for the gh account ${account}; sign in with gh auth login` : "No GitHub token for this repository's owner; sign in with gh auth login");
    return token;
  };
}

/** Every github.com account gh is logged in to (`gh auth status` prints "account <login>"). */
export function ghAccounts(status: string): string[] { return [...new Set([...status.matchAll(/account (\S+)/g)].map(m => m[1]))]; }

/**
 * A token per repository owner, resolved like the wrapper: an explicit GH_TOKEN/GITHUB_TOKEN wins; else the account
 * the account map names for the owner (`gh auth token --user`), else gh's active account.
 */
export function ghTokens(environment: NodeJS.ProcessEnv = process.env, run: GhRun = ghRun): TokenSource {
  const token = ghAccountToken(environment, run);
  return async owner => {
    const explicit = environment.GH_TOKEN || environment.GITHUB_TOKEN;
    if (explicit) return explicit;
    const mapPath = environment.GH_ACCOUNT_MAP || join(environment.HOME || homedir(), ".config/gh/account-map");
    return token(accountFor(await readFile(mapPath, "utf8").catch(() => ""), owner));
  };
}

/**
 * Reads made as a gh account rather than for a repository: the ranker's review-requested:@me search runs once per
 * logged-in account. The account list is read once an hour; tokens are cached like owners' ones.
 */
export interface AccountReads {
  accounts(): Promise<string[]>;
  restAs(account: string | null, path: string): Promise<unknown>;
}

/**
 * One REST call as the account `repo`'s owner maps to, resolving with any HTTP status: issue reports
 * (server/report-issue/) create issues, comments and screenshot files through it, in-process like every read.
 */
export interface RestSend {
  send(repo: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<{ status: number; data: any }>;
}

const LIMIT = 4 * 1024 * 1024;
/** In-process HTTPS with one token per owner, refreshed once on a 401. `FOLLOW_UP_GITHUB_API` points tests at a fake. */
export function httpApi(o: { tokens?: TokenSource; accountToken?: (account: string | null) => Promise<string>; status?: () => Promise<string>; request?: typeof fetch; base?: string; timeoutMs?: number; now?: () => number } = {}): GithubApi & AccountReads & RestSend {
  const tokens = o.tokens ?? ghTokens();
  const accountToken = o.accountToken ?? ghAccountToken();
  const request = o.request ?? fetch;
  const now = o.now ?? Date.now;
  const base = (o.base ?? process.env.FOLLOW_UP_GITHUB_API ?? "https://api.github.com").replace(/\/$/, "");
  const cache = new Map<string, Promise<string>>();
  // Owners are keyed by name, accounts by "@login" (null: gh's active account).
  const token = (key: string) => {
    let value = cache.get(key);
    if (!value) { value = key.startsWith("@") ? accountToken(key.slice(1) || null) : tokens(key); cache.set(key, value); void value.catch(() => cache.delete(key)); }
    return value;
  };
  const status = o.status ?? (async () => { const { env, bin } = realGh(process.env); return new Promise<string>(resolve => execFile(bin, ["auth", "status", "--hostname", "github.com"], { env, timeout: 15_000 }, (_e, stdout, stderr) => resolve(`${stdout ?? ""}${stderr ?? ""}`))); });
  let accounts: { until: number; value: Promise<string[]> } | null = null;
  const call = async (key: string, url: string, init: { method: string; body?: string }, retried = false, raw = false): Promise<unknown> => {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? 25_000);
    try {
      const response = await request(url, { ...init, signal: abort.signal, headers: { authorization: `bearer ${await token(key)}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "paseo-follow-up", "x-github-api-version": "2022-11-28" } });
      if (response.status === 401 && !retried) { cache.delete(key); return call(key, url, init, true, raw); }
      const text = await response.text();
      if (text.length > LIMIT) throw new Error("GitHub response exceeds the read limit");
      if (raw) { let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; } return { status: response.status, data }; }
      if (response.status === 401) throw new GithubAuthError("GitHub refused the token (HTTP 401)");
      if ((response.status === 403 || response.status === 429) && (response.headers?.get("x-ratelimit-remaining") === "0" || response.headers?.get("retry-after"))) {
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000 || Date.now() + Number(response.headers.get("retry-after") ?? 600) * 1000;
        throw Object.assign(new Error("GitHub API rate limit exceeded"), { status: response.status, rateLimited: true, resetAt: reset });
      }
      if (!response.ok) throw Object.assign(new Error(`GitHub HTTP ${response.status}`), { status: response.status });
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  };
  const ownerOf = (repo: string) => repo.split("/")[0];
  return {
    graphql: async (repo, query, variables) => call(ownerOf(repo), `${base}/graphql`, { method: "POST", body: JSON.stringify({ query, variables }) }) as Promise<Node>,
    rest: (repo, path) => call(ownerOf(repo), `${base}/${path.replace(/^\//, "")}`, { method: "GET" }),
    accounts: () => {
      if (!accounts || accounts.until <= now()) { const value = status().then(ghAccounts); accounts = { until: now() + 3_600_000, value }; void value.catch(() => { accounts = null; }); }
      return accounts.value;
    },
    restAs: (account, path) => call(`@${account ?? ""}`, `${base}/${path.replace(/^\//, "")}`, { method: "GET" }),
    send: (repo, method, path, body) => call(ownerOf(repo), `${base}/${path.replace(/^\//, "")}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, false, true) as Promise<{ status: number; data: any }>,
  };
}

let shared: (GithubApi & AccountReads & RestSend) | null = null;
/** The worker's one client: every read path shares its per-owner and per-account token cache. */
export function githubApi(): GithubApi & AccountReads & RestSend { return shared ??= httpApi(); }
