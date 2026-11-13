import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { State } from "../shared/model";
import { githubApi, type GithubApi } from "./github-api";
import { cleanList, emptyReviewerConfig, isTeam, repoKey, reviewerConfigSchema, setReviewerConfig, type ReviewerConfig, type ReviewerEntry } from "../shared/reviewers";

/**
 * The developer's reviewer lists, in their own small file next to state.json (`reviewers.json`). Writes are serialized,
 * atomic and owner-only. Every load and save also updates the process-wide config shared code reads.
 */
export class ReviewerConfigStore {
  private tail: Promise<unknown> = Promise.resolve();
  private cached: ReviewerConfig | null = null;
  constructor(readonly directory: string) {}
  private get path() { return join(this.directory, "reviewers.json"); }

  async read(): Promise<ReviewerConfig> {
    if (this.cached) return this.cached;
    let config: ReviewerConfig;
    try { config = reviewerConfigSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Saved reviewers could not be read. Fix or remove reviewers.json in Follow-up's data folder.");
      config = emptyReviewerConfig();
    }
    this.cached = config; setReviewerConfig(config);
    return config;
  }

  mutate(work: (config: ReviewerConfig) => void): Promise<ReviewerConfig> {
    const next = this.tail.then(async () => {
      const config = structuredClone(await this.read());
      work(config);
      for (const [key, list] of Object.entries(config.repos)) { const clean = cleanList(list); if (clean.length) config.repos[key] = clean; else delete config.repos[key]; }
      config.defaults = cleanList(config.defaults);
      const parsed = reviewerConfigSchema.parse(config);
      await this.write(parsed);
      this.cached = parsed; setReviewerConfig(parsed);
      return parsed;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Replace one repository's list (null: the default for all repos). An empty list removes it. */
  save(repo: string | null, reviewers: ReviewerEntry[]): Promise<ReviewerConfig> {
    return this.mutate(config => { if (repo === null) config.defaults = reviewers; else config.repos[repoKey(repo)] = reviewers; });
  }

  /** Runs the one-time seed (see `seedFromHistory`) and marks it done, whatever it found. */
  async migrate(state: State, now = new Date()): Promise<ReviewerConfig> {
    const config = await this.read();
    if (config.migratedAt) return config;
    const seeds = seedFromHistory(state);
    return this.mutate(c => {
      if (c.migratedAt) return;
      for (const [repo, list] of Object.entries(seeds)) if (!c.repos[repo]?.length) c.repos[repo] = list;
      c.migratedAt = now.toISOString();
    });
  }

  private async write(config: ReviewerConfig): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `reviewers.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(config, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}

/**
 * Upgrades keep what the developer already used: for each repository, the reviewers of the most recent submitted
 * Add-reviewers request become its saved list. Only Follow-up's own recorded requests count, so a fresh install
 * (or one that never requested reviewers) starts empty and gets the picker. Logins only: names come from the developer
 * or an agent (save_reviewers), never from the code (public-code-carries-no-host-identifiers).
 */
export function seedFromHistory(state: State): Record<string, ReviewerEntry[]> {
  const latest = new Map<string, { at: string; logins: string[] }>();
  for (const w of state.workspaces) for (const a of w.prActions) {
    if (a.kind !== "request_reviewers" || a.state !== "submitted" || !a.reviewers?.length) continue;
    for (const key of a.prs) {
      const repo = repoKey(key.split("#")[0]);
      const seen = latest.get(repo);
      if (!seen || a.createdAt > seen.at) latest.set(repo, { at: a.createdAt, logins: a.reviewers });
    }
  }
  return Object.fromEntries([...latest].map(([repo, { logins }]) => [repo, cleanList(logins.map(login => ({ login, name: null })))]));
}

export type Suggestion = { login: string; name: string | null; kind: "user" | "team" };

/**
 * Autocomplete for the picker: the repository's collaborators and teams, read on demand only (never polled),
 * one page each, cached for ten minutes, at most 20 repositories. A failure answers with what it couldn't read.
 */
export class ReviewerSuggestions {
  private cache = new Map<string, { until: number; value: Promise<{ suggestions: Suggestion[]; error: string | null }> }>();
  /** Reads in process through `api` (worker-reads-github-in-process). */
  constructor(private api: Pick<GithubApi, "rest"> = githubApi(), private now = Date.now) {}
  suggest(repo: string): Promise<{ suggestions: Suggestion[]; error: string | null }> {
    const key = repoKey(repo);
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.value;
    const value = this.load(repo);
    this.cache.delete(key); this.cache.set(key, { until: this.now() + 600_000, value });
    while (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
    // A failed read isn't kept for ten minutes: the next open tries again after a minute.
    void value.then(r => { if (r.error && this.cache.get(key)?.value === value) this.cache.set(key, { until: this.now() + 60_000, value }); });
    return value;
  }
  private async load(repo: string) {
    const owner = repo.split("/")[0];
    const read = (path: string) => this.api.rest(repo, path);
    const [people, teams] = await Promise.allSettled([read(`repos/${repo}/collaborators?per_page=100`), read(`repos/${repo}/teams?per_page=100`)]);
    const suggestions: Suggestion[] = [];
    if (people.status === "fulfilled" && Array.isArray(people.value))
      for (const p of people.value as { login?: unknown; type?: unknown }[]) if (typeof p?.login === "string" && p.type !== "Bot") suggestions.push({ login: p.login, name: null, kind: "user" });
    // Teams only exist on organization repositories; a personal repository answers 404, which isn't an error here.
    if (teams.status === "fulfilled" && Array.isArray(teams.value))
      for (const t of teams.value as { slug?: unknown; name?: unknown }[]) if (typeof t?.slug === "string") suggestions.push({ login: `${owner}/${t.slug}`, name: typeof t.name === "string" ? t.name : null, kind: "team" });
    const error = people.status === "rejected" ? "Couldn't read this repository's collaborators from GitHub. Type a login or org/team instead." : null;
    return { suggestions, error };
  }
}
