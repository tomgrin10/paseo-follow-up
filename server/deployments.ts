import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Deployment, Pr } from "../shared/model";
import { ghEnvironment } from "./github";

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40}$/;
type Node = Record<string, any>;
type Run = (command: string, args: string[], repo?: string) => Promise<string>;
type Fleet = { commits: string[]; evidence: string; observedAt: string };
const repository = "herosecurity/hero-poc";
const project = "hero-production-environments";
const roles = ["backend", "etl", "interpretation", "public-api", "web"];

export class Deployments {
  private fleet: { until: number; value: Promise<Fleet | null> } | null = null;
  private images = new Map<string, Promise<string>>();
  private ancestry = new Map<string, Promise<boolean>>();
  private token: { value: string; until: number } | null = null;
  constructor(
    private run: Run = async (command, args, repo) => (await exec(command, args, { env: repo ? ghEnvironment(repo) : process.env, timeout: 25_000, maxBuffer: 4 * 1024 * 1024 })).stdout,
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {}
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
  private imageCommit(image: string): Promise<string> {
    const cached = this.images.get(image); if (cached) return cached;
    const work = (async () => {
      const match = image.match(/^us-central1-docker\.pkg\.dev\/(hero-production-environments\/hero-docker-repo\/prod-vspm-(?:backend|web))@(sha256:[a-f0-9]{64})$/);
      if (!match) throw new Error("Serving image must have an immutable production digest");
      const base = `https://us-central1-docker.pkg.dev/v2/${match[1]}`;
      const manifest = await this.json(`${base}/manifests/${match[2]}`);
      if (!/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest)) throw new Error("Serving image config unavailable");
      const config = (await this.json(`${base}/blobs/${manifest.config.digest}`)).config;
      const revision = config?.Labels?.["org.opencontainers.image.revision"];
      const baked = (config?.Env ?? []).find((v: string) => v.startsWith("HERO_BUILD_SHA=") || v.startsWith("GIT_SHA="))?.split("=")[1];
      if (!sha.test(revision ?? baked ?? "") || (revision && baked && revision !== baked)) throw new Error("Serving source revision is unknown");
      return revision ?? baked;
    })();
    if (this.images.size > 500) this.images.clear();
    this.images.set(image, work); void work.catch(() => this.images.delete(image)); return work;
  }
  private async readFleet(): Promise<Fleet> {
    const services: Node[] = JSON.parse(await this.run("gcloud", ["run", "services", "list", "--project", project, "--filter", "metadata.labels.rollout-group=vspm", "--format=json(metadata.name,metadata.labels,status.traffic,status.conditions)"]));
    if (!Array.isArray(services) || roles.some(role => !services.some(s => s.metadata?.name?.startsWith(`hero-service-vspm-${role}-`)))) throw new Error("Production service catalog incomplete");
    const targets = services.filter(s => roles.some(role => s.metadata?.name?.startsWith(`hero-service-vspm-${role}-`)));
    const rows = await Promise.all(targets.map(async service => {
      const region = service.metadata?.labels?.["cloud.googleapis.com/location"];
      const traffic: Node[] = (service.status?.traffic ?? []).filter((t: Node) => t.percent > 0);
      if (!region || !service.status?.conditions?.some((c: Node) => c.type === "Ready" && c.status === "True") || traffic.reduce((n, t) => n + t.percent, 0) !== 100) throw new Error("Production traffic is not ready");
      return Promise.all(traffic.map(async t => {
        if (!/^[a-z0-9-]+$/.test(t.revisionName ?? "")) throw new Error("Serving revision unavailable");
        const revision = JSON.parse(await this.run("gcloud", ["run", "revisions", "describe", t.revisionName, "--project", project, "--region", region, "--format=json(spec.containers,status.conditions)"]));
        if (!revision.status?.conditions?.some((c: Node) => c.type === "Ready" && c.status === "True")) throw new Error("Serving revision is not ready");
        const image = revision.spec?.containers?.find((c: Node) => c.name === "app")?.image;
        return { revision: t.revisionName, commit: await this.imageCommit(image ?? "") };
      }));
    }));
    return { commits: [...new Set(rows.flat().map(r => r.commit))], evidence: `Production serving revisions: ${rows.flat().map(r => `${r.revision}=${r.commit}`).join(", ")}`, observedAt: new Date(this.now()).toISOString() };
  }
  private contains(merge: string, commit: string): Promise<boolean> {
    if (merge === commit) return Promise.resolve(true);
    const key = `${merge}:${commit}`; const cached = this.ancestry.get(key); if (cached) return cached;
    const work = this.run("gh", ["api", `repos/${repository}/compare/${merge}...${commit}`], repository).then(body => {
      const value = JSON.parse(body);
      if (!["ahead", "identical", "behind", "diverged"].includes(value.status)) throw new Error("Commit ancestry unknown");
      return value.status === "ahead" || value.status === "identical";
    });
    if (this.ancestry.size > 1000) this.ancestry.clear();
    this.ancestry.set(key, work); void work.catch(() => this.ancestry.delete(key)); return work;
  }
  async observe(prs: Pr[]): Promise<Map<string, Deployment>> {
    const result = new Map<string, Deployment>();
    const merged = [...new Map(prs.filter(p => p.snapshot?.state === "MERGED").map(p => [p.key, p])).values()];
    if (!merged.length) return result;
    if (merged.some(p => p.repo === repository)) {
      if (!this.fleet || this.fleet.until <= this.now()) this.fleet = { until: this.now() + 60_000, value: this.readFleet().catch(() => null) };
    }
    const fleet = this.fleet ? await this.fleet.value : null;
    for (let start = 0; start < merged.length; start += 4) await Promise.all(merged.slice(start, start + 4).map(async p => {
      const unknown: Deployment = { state: "unknown", environment: p.repo === repository ? "production" : "", commits: [], evidence: p.repo === repository ? "Could not verify serving production revisions. Check gcloud/gh access and refresh." : "No deployment source configured for this repository.", observedAt: new Date(this.now()).toISOString() };
      if (p.repo !== repository || !fleet || !sha.test(p.snapshot?.mergeCommit ?? "")) { result.set(p.key, unknown); return; }
      try {
        const included = await Promise.all(fleet.commits.map(commit => this.contains(p.snapshot!.mergeCommit!, commit)));
        result.set(p.key, { state: included.every(Boolean) ? "deployed" : included.some(Boolean) ? "partial" : "pending", environment: "production", commits: fleet.commits, evidence: fleet.evidence, observedAt: fleet.observedAt });
      } catch { result.set(p.key, unknown); }
    }));
    return result;
  }
}
