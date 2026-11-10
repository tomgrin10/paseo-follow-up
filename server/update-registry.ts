import type { DistTags } from "../shared/version";

/**
 * Follow-up's own update check against the npm registry. One request at most every six hours on its own; opening
 * Settings → Updates or Check now may ask sooner, but never more than once a minute. Uses npm's abbreviated
 * metadata and the previous ETag, so an unchanged package costs a 304 with no body.
 */

export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** Opening Settings asks at most once a minute. */
export const SETTINGS_FLOOR_MS = 60_000;
/** Check now (and the agent's check_updates) always asks; this only folds a double press into one request. */
export const MANUAL_FLOOR_MS = 5_000;
export const ABBREVIATED = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

export type RegistrySnapshot = {
  etag: string | null;
  /** Last time the registry was asked (successfully or not). */
  checkedAt: number | null;
  /** Last time it answered (200 or 304). */
  okAt: number | null;
  tags: DistTags;
  versions: string[];
  error: string | null;
};
export const EMPTY_SNAPSHOT: RegistrySnapshot = { etag: null, checkedAt: null, okAt: null, tags: {}, versions: [], error: null };

export type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

/** The registry npm itself would use on the daemon host: `npm_config_registry`, else the public one. */
export function registryUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}
export const packageUrl = (registry: string, name: string) => `${registry}${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;

export type CheckReason = "scheduled" | "settings" | "manual";
/** Whether a check may hit the network now. Scheduled checks wait six hours; asked-for ones a minute. */
export function due(snapshot: Pick<RegistrySnapshot, "checkedAt">, now: number, reason: CheckReason): boolean {
  if (snapshot.checkedAt == null) return true;
  const elapsed = now - snapshot.checkedAt;
  if (elapsed < 0) return true; // clock went backwards: don't stall for six hours
  return elapsed >= (reason === "scheduled" ? CHECK_INTERVAL_MS : reason === "settings" ? SETTINGS_FLOOR_MS : MANUAL_FLOOR_MS);
}

export class RegistryChecker {
  private inFlight: Promise<RegistrySnapshot> | null = null;
  requests = 0;
  constructor(private readonly options: {
    packageName: string;
    fetch: Fetch;
    now?: () => number;
    registry?: string;
    load(): Promise<RegistrySnapshot | null>;
    save(snapshot: RegistrySnapshot): Promise<void>;
    timeoutMs?: number;
  }) {}

  async snapshot(): Promise<RegistrySnapshot> { return (await this.options.load()) ?? EMPTY_SNAPSHOT; }

  /** Checks if due, otherwise returns what is stored. Concurrent callers share one request. */
  check(reason: CheckReason): Promise<RegistrySnapshot> {
    if (this.inFlight) return this.inFlight;
    const run = this.run(reason).finally(() => { this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  private async run(reason: CheckReason): Promise<RegistrySnapshot> {
    const now = (this.options.now ?? Date.now)();
    const previous = await this.snapshot();
    if (!due(previous, now, reason)) return previous;
    const url = packageUrl(this.options.registry ?? registryUrl(), this.options.packageName);
    const headers: Record<string, string> = { accept: ABBREVIATED };
    if (previous.etag && previous.versions.length) headers["if-none-match"] = previous.etag;
    let next: RegistrySnapshot;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 20_000);
    try {
      this.requests++;
      const res = await this.options.fetch(url, { headers, signal: abort.signal });
      if (res.status === 304) next = { ...previous, checkedAt: now, okAt: now, error: null };
      else if (res.status === 200) {
        const body = await res.json() as { "dist-tags"?: Record<string, unknown>; versions?: Record<string, unknown> };
        const tags: DistTags = {};
        for (const [k, v] of Object.entries(body["dist-tags"] ?? {})) if (typeof v === "string") tags[k] = v;
        next = { etag: res.headers.get("etag"), checkedAt: now, okAt: now, tags, versions: Object.keys(body.versions ?? {}), error: null };
      } else if (res.status === 404) next = { ...previous, checkedAt: now, error: "The package isn't on this registry." };
      else next = { ...previous, checkedAt: now, error: `The registry answered ${res.status}.` };
    } catch (e) {
      next = { ...previous, checkedAt: now, error: abort.signal.aborted ? "The registry didn't answer in time." : "Couldn't reach the registry." };
      void e;
    } finally { clearTimeout(timer); }
    await this.options.save(next);
    return next;
  }
}
