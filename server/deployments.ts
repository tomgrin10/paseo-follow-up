import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Deployment, Pr } from "../shared/model";
import type { DeployConfig } from "../shared/pr-workflow";
import { githubApi, type GithubApi } from "./github-api";

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40}$/;
type Node = Record<string, any>;
type Run = (command: string, args: string[]) => Promise<string>;
type Fleet = { commits: string[]; evidence: string; observedAt: string };
/** The deploy check's configuration for a repository (host settings, pr-workflow.json); undefined: no deploy check. */
export type DeployConfigFor = (repo: string) => DeployConfig | undefined;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Messages this probe throws itself. Anything else (gcloud, gh, fetch) is summarized so no transport detail leaks. */
const OWN_REASONS = new Set(["Deployment image unavailable", "Deployment image metadata exceeds the read limit", "Serving image must have an immutable production digest", "Serving image config unavailable", "Serving source revision is unknown", "Production service catalog incomplete", "Production traffic is not ready", "Serving revision unavailable", "Serving revision is not ready"]);
export function probeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (OWN_REASONS.has(message)) return message;
  const command = (error as { cmd?: unknown; path?: unknown } | null)?.cmd ?? (error as { path?: unknown } | null)?.path;
  if (typeof command === "string" && /^(gcloud|gh)\b/.test(command)) return `${command.split(" ")[0]} call failed`;
  if (error instanceof SyntaxError) return "unreadable response";
  if (error instanceof Error && error.name === "AbortError") return "registry timed out";
  return "lookup failed";
}

export class Deployments {
  /** One fleet read per configuration (a changed configuration reads afresh). */
  private fleets = new Map<string, { until: number; value: Promise<Fleet | { error: string }> }>();
  /** Why the last fleet read failed, for diagnostics and the PR evidence line; null after a success. */
  lastError: string | null = null;
  private images = new Map<string, Promise<string>>();
  private revisions = new Map<string, Promise<string>>();
  private ancestry = new Map<string, Promise<boolean>>();
  private token: { value: string; until: number } | null = null;
  constructor(
    /** gcloud only: GitHub reads go through `api`, in process (worker-reads-github-in-process). */
    private run: Run = async (command, args) => (await exec(command, args, { env: process.env, timeout: 25_000, maxBuffer: 4 * 1024 * 1024 })).stdout,
    private request: typeof fetch = fetch,
    private now = Date.now,
    private api: Pick<GithubApi, "rest"> = githubApi(),
    /** Which repositories have a deploy check, and how to read it. None by default: no repository is probed. */
    private configFor: DeployConfigFor = () => undefined,
  ) {}
  /** Whether `repo` has a deploy check on this machine. */
  configured(repo: string): boolean { return !!this.configFor(repo); }
  private async json(url: string): Promise<Node> {
    if (!this.token || this.token.until <= this.now()) this.token = { value: (await this.run("gcloud", ["auth", "print-access-token"])).trim(), until: this.now() + 2_700_000 };
    const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 8_000);
    let body: string;
    try {
    const response = await this.request(url, { headers: { Authorization: `Bearer ${this.token.value}`, Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" }, redirect: "error", signal: abort.signal });
    if (!response.ok) { this.token = null; throw new Error("Deployment image unavailable"); }
    body = await response.text();
    } finally { clearTimeout(timeout); }
    if (body.length > 1_000_000) throw new Error("Deployment image metadata exceeds the read limit");
    return JSON.parse(body);
  }
  private imageCommit(image: string, deploy: DeployConfig): Promise<string> {
    const cached = this.images.get(image); if (cached) return cached;
    const work = (async () => {
      const match = image.match(new RegExp(`^${escape(deploy.registry)}/(${escape(deploy.imagePath)}/(?:${deploy.images.map(escape).join("|")}))@(sha256:[a-f0-9]{64})$`));
      if (!match) throw new Error("Serving image must have an immutable production digest");
      // FOLLOW_UP_DEPLOY_REGISTRY points harness runs (scripts/poll-cost.mjs) at a fake registry.
      const base = `${(process.env.FOLLOW_UP_DEPLOY_REGISTRY || `https://${deploy.registry}`).replace(/\/$/, "")}/v2/${match[1]}`;
      const manifest = await this.json(`${base}/manifests/${match[2]}`);
      if (!/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest)) throw new Error("Serving image config unavailable");
      const config = (await this.json(`${base}/blobs/${manifest.config.digest}`)).config;
      const revision = config?.Labels?.["org.opencontainers.image.revision"];
      const baked = (config?.Env ?? []).find((v: string) => (deploy.buildShaEnv && v.startsWith(`${deploy.buildShaEnv}=`)) || v.startsWith("GIT_SHA="))?.split("=")[1];
      if (!sha.test(revision ?? baked ?? "") || (revision && baked && revision !== baked)) throw new Error("Serving source revision is unknown");
      return revision ?? baked;
    })();
    if (this.images.size > 500) this.images.clear();
    this.images.set(image, work); void work.catch(() => this.images.delete(image)); return work;
  }
  /**
   * A Cloud Run revision is immutable: its image (so its commit) never changes. Once a revision has been read ready,
   * its commit is reused, so a fleet read costs one `gcloud run services list` instead of one call per serving
   * revision as well (cpu-load REPORT.md §5: 6 gcloud calls a minute). Failures and unready revisions aren't cached.
   */
  private revisionCommit(name: string, region: string, config: DeployConfig): Promise<string> {
    const key = `${config.gcpProject}/${region}/${name}`; const cached = this.revisions.get(key); if (cached) return cached;
    const work = (async () => {
      const revision = JSON.parse(await this.run("gcloud", ["run", "revisions", "describe", name, "--project", config.gcpProject, "--region", region, "--format=json(spec.containers,status.conditions)"]));
      if (!revision.status?.conditions?.some((c: Node) => c.type === "Ready" && c.status === "True")) throw new Error("Serving revision is not ready");
      const image = revision.spec?.containers?.find((c: Node) => c.name === "app")?.image;
      return this.imageCommit(image ?? "", config);
    })();
    if (this.revisions.size > 500) this.revisions.clear();
    this.revisions.set(key, work); void work.catch(() => this.revisions.delete(key)); return work;
  }
  private async readFleet(config: DeployConfig): Promise<Fleet> {
    const services: Node[] = JSON.parse(await this.run("gcloud", ["run", "services", "list", "--project", config.gcpProject, "--filter", `metadata.labels.${config.serviceLabel}`, "--format=json(metadata.name,metadata.labels,status.traffic,status.conditions)"]));
    const named = (s: Node, role: string) => typeof s.metadata?.name === "string" && s.metadata.name.startsWith(`${config.servicePrefix}${role}-`);
    if (!Array.isArray(services) || config.roles.some(role => !services.some(s => named(s, role)))) throw new Error("Production service catalog incomplete");
    const targets = services.filter(s => config.roles.some(role => named(s, role)));
    const rows = await Promise.all(targets.map(async service => {
      const region = service.metadata?.labels?.["cloud.googleapis.com/location"];
      const traffic: Node[] = (service.status?.traffic ?? []).filter((t: Node) => t.percent > 0);
      if (!region || !service.status?.conditions?.some((c: Node) => c.type === "Ready" && c.status === "True") || traffic.reduce((n, t) => n + t.percent, 0) !== 100) throw new Error("Production traffic is not ready");
      return Promise.all(traffic.map(async t => {
        if (!/^[a-z0-9-]+$/.test(t.revisionName ?? "")) throw new Error("Serving revision unavailable");
        return { revision: t.revisionName, commit: await this.revisionCommit(t.revisionName, region, config) };
      }));
    }));
    return { commits: [...new Set(rows.flat().map(r => r.commit))], evidence: `Production serving revisions: ${rows.flat().map(r => `${r.revision}=${r.commit}`).join(", ")}`, observedAt: new Date(this.now()).toISOString() };
  }
  private contains(repo: string, merge: string, commit: string): Promise<boolean> {
    if (merge === commit) return Promise.resolve(true);
    const key = `${repo}:${merge}:${commit}`; const cached = this.ancestry.get(key); if (cached) return cached;
    const work = this.api.rest(repo, `repos/${repo}/compare/${merge}...${commit}`).then(body => {
      const value = body as { status?: string };
      if (!["ahead", "identical", "behind", "diverged"].includes(value?.status ?? "")) throw new Error("Commit ancestry unknown");
      return value.status === "ahead" || value.status === "identical";
    });
    if (this.ancestry.size > 1000) this.ancestry.clear();
    this.ancestry.set(key, work); void work.catch(() => this.ancestry.delete(key)); return work;
  }
  private fleet(config: DeployConfig): Promise<Fleet | { error: string }> {
    const key = JSON.stringify(config); const cached = this.fleets.get(key);
    if (cached && cached.until > this.now()) return cached.value;
    const entry = { until: this.now() + 60_000, value: this.readFleet(config).then(fleet => { this.lastError = null; return fleet; }, (error: unknown) => {
      // A failure is retried on the next refresh (15 s), not served from cache for a minute.
      entry.until = this.now() + 15_000; this.lastError = probeReason(error);
      return { error: this.lastError };
    }) };
    if (this.fleets.size > 20) this.fleets.clear();
    this.fleets.set(key, entry); return entry.value;
  }
  /**
   * Merged PRs in repositories with a deploy check, each against its repository's production fleet. PRs anywhere else
   * get no entry: the caller keeps what it knew (server/github.ts) rather than this probe saying anything about them.
   */
  async observe(prs: Pr[]): Promise<Map<string, Deployment>> {
    const result = new Map<string, Deployment>();
    const merged = [...new Map(prs.filter(p => p.snapshot?.state === "MERGED" && this.configFor(p.repo)).map(p => [p.key, p])).values()];
    if (!merged.length) return result;
    const reads = new Map<string, Fleet | { error: string }>();
    for (const repo of new Set(merged.map(p => p.repo))) reads.set(repo, await this.fleet(this.configFor(repo)!));
    for (let start = 0; start < merged.length; start += 4) await Promise.all(merged.slice(start, start + 4).map(async p => {
      const read = reads.get(p.repo)!;
      const fleet = "commits" in read ? read : null;
      const reason = "error" in read ? ` (${read.error})` : "";
      const unknown: Deployment = { state: "unknown", environment: "production", commits: [], evidence: `Could not verify serving production revisions${reason}. Check gcloud/gh access and refresh.`, observedAt: new Date(this.now()).toISOString() };
      if (!fleet || !sha.test(p.snapshot?.mergeCommit ?? "")) { result.set(p.key, unknown); return; }
      try {
        const included = await Promise.all(fleet.commits.map(commit => this.contains(p.repo, p.snapshot!.mergeCommit!, commit)));
        result.set(p.key, { state: included.every(Boolean) ? "deployed" : included.some(Boolean) ? "partial" : "pending", environment: "production", commits: fleet.commits, evidence: fleet.evidence, observedAt: fleet.observedAt });
      } catch { result.set(p.key, unknown); }
    }));
    return result;
  }
}
