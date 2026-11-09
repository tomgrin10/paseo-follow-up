import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyOnboarding, classifyGhError, classifyInstall, ghCheck, initialOnboarding, offerVisible, onboardingFileSchema, onboardingView, providerChecks, toolsCheck,
  type Check, type Checks, type GhResult, type OnboardingAction, type OnboardingFile, type OnboardingStep, type OnboardingView, type ProviderInfo, type ProviderUse, type ToolsInput } from "../shared/onboarding";

/**
 * Getting started's progress, in `onboarding.json` beside state.json. Created the first time the worker starts with
 * this version: a host with any Follow-up data already on disk is an existing install and is never shown the flow
 * unless the developer asks (Settings → Set up Follow-up again). Resumes from the saved step after a reload.
 */
export class OnboardingStore {
  private tail: Promise<unknown> = Promise.resolve();
  private cached: OnboardingFile | null = null;
  constructor(readonly directory: string, private now = () => new Date()) {}
  private get path() { return join(this.directory, "onboarding.json"); }

  /**
   * Call once at worker start, before anything writes state.json: decides fresh or existing from what is on disk.
   * Returns the file (created or as saved).
   */
  async init(present?: string[]): Promise<OnboardingFile> {
    const saved = await this.load();
    if (saved) return saved;
    const files = present ?? await readdir(this.directory).catch(() => [] as string[]);
    const file = initialOnboarding(classifyInstall(files), this.now());
    await this.write(file);
    return file;
  }
  private async load(): Promise<OnboardingFile | null> {
    if (this.cached) return this.cached;
    try { this.cached = onboardingFileSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); return this.cached; }
    // Missing: not initialised yet. Unreadable: treat as an existing install that finished, never force the flow.
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; this.cached = { ...initialOnboarding("existing", this.now()), status: "done", offerDismissed: true }; return this.cached; }
  }
  private async write(file: OnboardingFile) {
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    this.cached = file;
  }
  private mutate(work: (file: OnboardingFile) => OnboardingFile): Promise<OnboardingFile> {
    const next = this.tail.then(async () => { const file = work((await this.load()) ?? await this.init()); await this.write(file); return file; });
    this.tail = next.catch(() => undefined);
    return next;
  }
  /** The client's view. The first time the existing-install offer is shown, its day starts. */
  async view(): Promise<OnboardingView> {
    let file = (await this.load()) ?? await this.init();
    if (offerVisible(file, this.now().getTime()) && !file.offeredAt) file = await this.mutate(f => ({ ...f, offeredAt: this.now().toISOString() }));
    return onboardingView(file, this.now().getTime());
  }
  async act(action: OnboardingAction, step: OnboardingStep | null = null): Promise<OnboardingView> {
    const file = await this.mutate(f => applyOnboarding(f, action, step, this.now()));
    return onboardingView(file, this.now().getTime());
  }
}

export type CheckDeps = {
  /** `gh api user --jq .login` on the daemon host. */
  gh: () => Promise<string>;
  catalog: () => Promise<{ providers: ProviderInfo[]; error: string | null } | null>;
  /** Which helper roles use which provider right now. */
  use: () => Promise<ProviderUse>;
  tools: () => Promise<ToolsInput>;
  now?: () => number;
};

/**
 * The readiness checks. Run only when the setup flow asks (no polling), one run at a time, and cached for a minute
 * so moving between steps doesn't re-run gh. `fresh` (Check again) skips the cache.
 */
export class ReadinessChecks {
  private cache: { at: number; value: Promise<Checks> } | null = null;
  constructor(private deps: CheckDeps, private ttlMs = 60_000) {}
  run(fresh = false): Promise<Checks> {
    const now = (this.deps.now ?? Date.now)();
    if (!fresh && this.cache && now - this.cache.at < this.ttlMs) return this.cache.value;
    const value = this.collect(now);
    this.cache = { at: now, value };
    return value;
  }
  private async collect(now: number): Promise<Checks> {
    const gh = async (): Promise<Check[]> => {
      let result: GhResult;
      try { const login = (await this.deps.gh()).trim(); result = login ? { login } : { error: "signed-out", message: "" }; }
      catch (error) { result = classifyGhError(error); }
      return [ghCheck(result)];
    };
    const providers = async (): Promise<Check[]> => providerChecks(await this.deps.catalog().catch(e => ({ providers: [], error: e instanceof Error ? e.message : String(e) })), await this.deps.use().catch(() => ({})));
    const tools = async (): Promise<Check[]> => toolsCheck(await this.deps.tools());
    const groups = await Promise.all([gh(), providers(), tools()]);
    return { checks: groups.flat(), checkedAt: new Date(now).toISOString() };
  }
}

/** Agents that got Follow-up's tools natively: one `hook-state/native-<agent>.json` per agent (see index.server.ts). */
export async function nativeAgentCount(directory: string): Promise<number> {
  try { return (await readdir(join(directory, "hook-state"))).filter(n => /^native-[\w-]+\.json$/.test(n)).length; } catch { return 0; }
}
