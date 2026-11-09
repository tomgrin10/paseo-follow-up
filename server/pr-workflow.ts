import { access, constants, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { repoKey } from "../shared/reviewers";
import {
  commandName, detect, emptyPrWorkflowConfig, prWorkflowConfigSchema, repoSetting, resolveWorkflow, reviewFixFor,
  type AgentWorkflow, type Detection, type PrWorkflow, type PrWorkflowConfig, type PrWorkflowView, type RepoWorkflowView, type ReviewFix,
} from "../shared/pr-workflow";

/**
 * The PR workflow setting (`pr-workflow.json`, owner-only, next to state.json) and its auto-detection. Detection
 * reads only the filesystem: PATH for a `gt` executable, Graphite's saved sign-in, and the repository's git directory
 * for `.graphite_repo_config` (what `gt init` writes). It never runs gt, and it caches for ten minutes; Settings'
 * "Check again" refreshes it.
 */
export type Probe = {
  gtInstalled(): Promise<boolean>;
  signedIn(): Promise<boolean>;
  initialised(path: string): Promise<boolean>;
};
const exists = (path: string, mode = constants.F_OK) => access(path, mode).then(() => true, () => false);
export const fsProbe = (environment: NodeJS.ProcessEnv = process.env): Probe => ({
  async gtInstalled() {
    for (const dir of (environment.PATH ?? "").split(delimiter)) if (dir && await exists(join(dir, "gt"), constants.X_OK)) return true;
    return false;
  },
  async signedIn() {
    const config = environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), ".config");
    try { const { authToken } = JSON.parse(await readFile(join(config, "graphite", "auth"), "utf8")); return typeof authToken === "string" && authToken.length > 0; }
    catch { return false; }
  },
  async initialised(path) {
    const common = await gitCommonDir(path);
    return !!common && exists(join(common, ".graphite_repo_config"));
  },
});
/** The shared git directory for a checkout or a worktree, read from `.git` without running git. */
export async function gitCommonDir(path: string): Promise<string | null> {
  const dotGit = join(path, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return dotGit;
  const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1]?.trim();
  if (!gitdir) return null;
  const worktree = isAbsolute(gitdir) ? gitdir : resolve(path, gitdir);
  const common = (await readFile(join(worktree, "commondir"), "utf8").catch(() => "")).trim();
  return common ? (isAbsolute(common) ? common : resolve(worktree, common)) : worktree;
}

export const REVIEW_FIX_SEED = "/fix-pr";
/** Where an existing install already keeps a /fix-pr skill or command. */
export async function hasFixPr(claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): Promise<boolean> {
  return await exists(join(claudeHome, "commands", "fix-pr.md")) || await exists(join(claudeHome, "skills", "fix-pr", "SKILL.md"));
}

type Detected = { at: number; workflow: PrWorkflow; reason: string; path: string | null };
export class PrWorkflowStore {
  private tail: Promise<unknown> = Promise.resolve();
  private cached: PrWorkflowConfig | null = null;
  private machine: { at: number; gtInstalled: boolean; signedIn: boolean } | null = null;
  private detected = new Map<string, Detected>();
  /**
   * Repository (owner/name, lowercase) → local checkouts to look at, best first: the Paseo project's root, then the
   * working directories of tracked workspaces with PRs there (a repository often has no project registered). Set by the server.
   */
  paths: () => Promise<Map<string, string[]>> = async () => new Map();
  /** Called after every save, so derived files (scopes.json) can be rewritten. */
  onChanged: () => void = () => undefined;
  constructor(readonly directory: string, private probe: Probe = fsProbe(), private now = Date.now, private ttl = 600_000) {}
  private get path() { return join(this.directory, "pr-workflow.json"); }

  async read(): Promise<PrWorkflowConfig> {
    if (this.cached) return this.cached;
    let config: PrWorkflowConfig;
    try { config = prWorkflowConfigSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      // An unreadable file means the defaults (auto everywhere), never an error that stops merging or tracking.
      config = emptyPrWorkflowConfig();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") config.migratedAt = new Date(this.now()).toISOString();
    }
    this.cached = config;
    return config;
  }
  /** Synchronous view for hot paths (attention, scopes); defaults until the first read finishes. */
  current(): PrWorkflowConfig { return this.cached ?? emptyPrWorkflowConfig(); }

  mutate(work: (config: PrWorkflowConfig) => void): Promise<PrWorkflowConfig> {
    const next = this.tail.then(async () => {
      const config = structuredClone(await this.read());
      work(config);
      for (const [key, value] of Object.entries(config.repos)) if (!value.workflow && !value.mergeMethod && !value.reviewFix) delete config.repos[key];
      const parsed = prWorkflowConfigSchema.parse(config);
      await this.write(parsed);
      this.cached = parsed;
      this.onChanged();
      return parsed;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  /**
   * One-time seed: an install that already has a /fix-pr skill or command keeps using it for review comments.
   * Everyone else gets the built-in instructions. Runs once, whatever it finds.
   */
  async migrate(found: () => Promise<boolean> = () => hasFixPr()): Promise<PrWorkflowConfig> {
    const config = await this.read();
    if (config.migratedAt) return config;
    const seed = await found();
    return this.mutate(c => {
      if (c.migratedAt) return;
      if (seed && c.reviewFix.kind === "builtin") c.reviewFix = { kind: "command", command: REVIEW_FIX_SEED };
      c.migratedAt = new Date(this.now()).toISOString();
    });
  }

  private async machineState(fresh: boolean) {
    if (!fresh && this.machine && this.now() - this.machine.at < this.ttl) return this.machine;
    const [gtInstalled, signedIn] = await Promise.all([this.probe.gtInstalled(), this.probe.signedIn()]);
    this.machine = { at: this.now(), gtInstalled, signedIn };
    return this.machine;
  }
  /** What auto picks for a repository, cached for ten minutes (fresh: Settings' Check again). */
  async detect(repo: string, fresh = false, freshMachine = fresh): Promise<Detected> {
    const key = repoKey(repo);
    const hit = this.detected.get(key);
    if (!fresh && hit && this.now() - hit.at < this.ttl) return hit;
    const machine = await this.machineState(freshMachine);
    const candidates = [...new Set((await this.paths()).get(key) ?? [])];
    let path = candidates[0] ?? null;
    const detection: Detection = { gtInstalled: machine.gtInstalled, signedIn: machine.signedIn, path, initialised: false };
    // File reads only, stopping at the first checkout set up for Graphite.
    if (machine.gtInstalled && machine.signedIn) for (const candidate of candidates) {
      if (await this.probe.initialised(candidate).catch(() => false)) { detection.initialised = true; path = candidate; break; }
    }
    const value = { at: this.now(), path, ...detect(detection) };
    this.detected.set(key, value);
    return value;
  }
  /** Auto's answer before a repository is known: Graphite only where the CLI is installed and signed in. */
  private guess(): PrWorkflow { return this.machine?.gtInstalled && this.machine.signedIn ? "graphite" : "github"; }
  /** The cached resolution, without touching the disk: hot paths use this. */
  cachedWorkflow(repo: string | null): PrWorkflow {
    const { setting } = repo ? repoSetting(this.current(), repo) : { setting: this.current().default };
    if (setting !== "auto") return setting;
    return (repo && this.detected.get(repoKey(repo))?.workflow) || this.guess();
  }
  async workflow(repo: string): Promise<PrWorkflow> {
    const config = await this.read();
    const { setting } = repoSetting(config, repo);
    return resolveWorkflow(setting, setting === "auto" ? (await this.detect(repo)).workflow : "github");
  }
  /** Resolve every repository up front so `cachedWorkflow` is right for the observe loop. Cheap: fs checks only. */
  async warm(repos: Iterable<string>): Promise<void> {
    await this.read();
    await this.machineState(false);
    for (const repo of new Set([...repos].map(repoKey))) await this.detect(repo).catch(() => undefined);
  }
  agentWorkflow(repo: string | null): AgentWorkflow {
    return { mode: this.cachedWorkflow(repo), reviewFix: commandName(reviewFixFor(this.current(), repo)) };
  }
  reviewFix(repo: string | null): ReviewFix { return reviewFixFor(this.current(), repo); }

  async view(repos: Iterable<string>, fresh = false, github: (repo: string) => RepoWorkflowView["github"] = () => null): Promise<PrWorkflowView> {
    const config = await this.read();
    const machine = await this.machineState(fresh);
    const rows: RepoWorkflowView[] = [];
    for (const repo of [...new Set([...repos].map(repoKey))].sort()) {
      const d = await this.detect(repo, fresh, false);
      const { setting, inherits } = repoSetting(config, repo);
      const own = config.repos[repo];
      rows.push({ repo, setting, inherits, detected: d.workflow, effective: resolveWorkflow(setting, d.workflow), reason: d.reason, path: d.path, mergeMethod: own?.mergeMethod ?? null, reviewFix: own?.reviewFix ?? null, github: github(repo) });
    }
    return { gt: { installed: machine.gtInstalled, signedIn: machine.signedIn }, default: config.default, reviewFix: config.reviewFix, repos: rows };
  }

  private async write(config: PrWorkflowConfig): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `pr-workflow.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(config, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}
