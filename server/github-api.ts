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
/**
 * A token per repository owner, resolved like the wrapper: an explicit GH_TOKEN/GITHUB_TOKEN wins; else the account
 * the account map names for the owner (`gh auth token --user`), else gh's active account. The real gh is called
 * directly (never the wrapper, which would inject a token of its own) with GH_TOKEN stripped and a dead bus.
 */
export function ghTokens(environment: NodeJS.ProcessEnv = process.env, run = async (bin: string, args: string[], env: NodeJS.ProcessEnv) => (await exec(bin, args, { env, timeout: 15_000 })).stdout): TokenSource {
  return async owner => {
    const explicit = environment.GH_TOKEN || environment.GITHUB_TOKEN;
    if (explicit) return explicit;
    const mapPath = environment.GH_ACCOUNT_MAP || join(environment.HOME || homedir(), ".config/gh/account-map");
    const account = accountFor(await readFile(mapPath, "utf8").catch(() => ""), owner);
    const { GH_TOKEN: _a, GITHUB_TOKEN: _b, ...rest } = environment;
    const env = { ...rest, DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS || DEAD_BUS };
    const bin = environment.FOLLOW_UP_GH_BIN || (existsSync("/usr/bin/gh") ? "/usr/bin/gh" : "gh");
    const token = (await run(bin, ["auth", "token", ...(account ? ["--user", account] : [])], env).catch(() => "")).trim();
    if (!token) throw new GithubAuthError("No GitHub token for this repository's owner; sign in with gh auth login");
    return token;
  };
}

const LIMIT = 4 * 1024 * 1024;
/** In-process HTTPS with one token per owner, refreshed once on a 401. `FOLLOW_UP_GITHUB_API` points tests at a fake. */
export function httpApi(o: { tokens?: TokenSource; request?: typeof fetch; base?: string; timeoutMs?: number } = {}): GithubApi {
  const tokens = o.tokens ?? ghTokens();
  const request = o.request ?? fetch;
  const base = (o.base ?? process.env.FOLLOW_UP_GITHUB_API ?? "https://api.github.com").replace(/\/$/, "");
  const cache = new Map<string, Promise<string>>();
  const token = (owner: string) => {
    let value = cache.get(owner);
    if (!value) { value = tokens(owner); cache.set(owner, value); void value.catch(() => cache.delete(owner)); }
    return value;
  };
  const call = async (repo: string, url: string, init: { method: string; body?: string }, retried = false): Promise<unknown> => {
    const owner = repo.split("/")[0];
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? 25_000);
    try {
      const response = await request(url, { ...init, signal: abort.signal, headers: { authorization: `bearer ${await token(owner)}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "paseo-follow-up", "x-github-api-version": "2022-11-28" } });
      if (response.status === 401 && !retried) { cache.delete(owner); return call(repo, url, init, true); }
      const text = await response.text();
      if (text.length > LIMIT) throw new Error("GitHub response exceeds the read limit");
      if (response.status === 401) throw new GithubAuthError("GitHub refused the token (HTTP 401)");
      if ((response.status === 403 || response.status === 429) && (response.headers?.get("x-ratelimit-remaining") === "0" || response.headers?.get("retry-after"))) {
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000 || Date.now() + Number(response.headers.get("retry-after") ?? 600) * 1000;
        throw Object.assign(new Error("GitHub API rate limit exceeded"), { status: response.status, rateLimited: true, resetAt: reset });
      }
      if (!response.ok) throw Object.assign(new Error(`GitHub HTTP ${response.status}`), { status: response.status });
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  };
  return {
    graphql: async (repo, query, variables) => call(repo, `${base}/graphql`, { method: "POST", body: JSON.stringify({ query, variables }) }) as Promise<Node>,
    rest: (repo, path) => call(repo, `${base}/${path.replace(/^\//, "")}`, { method: "GET" }),
  };
}
