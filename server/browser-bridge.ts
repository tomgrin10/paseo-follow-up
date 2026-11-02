import { randomUUID } from "node:crypto";
import { browserCommandSchema, type BrowserCommand, type BrowserPr, type BrowserResult } from "../shared/pr-actions";

type Pending = { command: BrowserCommand; clientId: string | null; timer: ReturnType<typeof setTimeout>; resolve: (r: BrowserResult) => void };
export class BrowserBridge {
  private clients = new Map<string, { at: number; ready: boolean; repositories: string[] }>();
  private pending = new Map<string, Pending>();
  private observations = new Map<string, { at: number; pr: BrowserPr }>();
  status(repo?: string) {
    const ready = [...this.clients.values()].some(c => c.ready && c.repositories.length > 0 && (!repo || c.repositories.includes(repo.toLowerCase())) && Date.now() - c.at < 15_000);
    return { ready, reason: ready ? null : "Open Graphite in Chrome and grant this machine access to the repository in Send to Paseo settings." };
  }
  cached(repo: string, number: number, head: string): BrowserPr | null {
    const saved = this.observations.get(`${repo}#${number}`);
    return saved && Date.now() - saved.at < 15_000 && saved.pr.head === head ? saved.pr : null;
  }
  exchange(clientId: string, ready: boolean, results: BrowserResult[], acceptJobs = true, repositories: string[] = []): { jobs: BrowserCommand[]; accepted: string[] } {
    const accepted: string[] = [];
    for (const [id, client] of this.clients) if (Date.now() - client.at > 60_000) this.clients.delete(id);
    if (!this.clients.has(clientId) && this.clients.size >= 100) return { jobs: [], accepted };
    const scopes = repositories.map(r => r.toLowerCase());
    this.clients.set(clientId, { at: Date.now(), ready, repositories: scopes });
    for (const result of results) {
      const job = this.pending.get(result.id);
      if (!job || job.clientId !== clientId || job.command.nonce !== result.nonce || Date.parse(job.command.expiresAt) <= Date.now()) continue;
      if (!scopes.includes(job.command.repo.toLowerCase()) && !(result.outcome === "failed" && !result.prs.length && !result.applied.length)) continue;
      if (new Set(result.prs.map(p => p.number)).size !== result.prs.length || new Set(result.applied).size !== result.applied.length) continue;
      if (result.outcome === "completed" && (result.prs.length !== job.command.prs.length || result.prs.some(p => {
        const target = job.command.prs.find(t => t.number === p.number);
        return !target || p.head !== target.head || job.command.op !== "read" && (p.state !== "OPEN" || p.mergeWhenReady !== (job.command.op === "enable_mwr"));
      }) || job.command.op !== "read" && result.applied.length !== job.command.prs.length)) continue;
      if (result.prs.some(p => p.repo !== job.command.repo || !job.command.prs.some(t => t.number === p.number))) continue;
      if (result.applied.some(n => !job.command.prs.some(p => p.number === n))) continue;
      clearTimeout(job.timer); this.pending.delete(result.id);
      for (const pr of result.prs) this.observations.set(`${pr.repo}#${pr.number}`, { at: Date.now(), pr });
      while (this.observations.size > 1000) this.observations.delete(this.observations.keys().next().value!);
      job.resolve(result); accepted.push(result.id);
    }
    if (!ready || !acceptJobs) return { jobs: [], accepted };
    const jobs = [...this.pending.values()].filter(p => !p.clientId && scopes.includes(p.command.repo.toLowerCase()) && Date.parse(p.command.expiresAt) > Date.now()).slice(0, 1);
    for (const job of jobs) job.clientId = clientId;
    return { jobs: jobs.map(j => j.command), accepted };
  }
  request(op: BrowserCommand["op"], repo: string, prs: BrowserCommand["prs"]): Promise<BrowserResult> {
    if (!this.status(repo).ready) return Promise.reject(new Error(this.status(repo).reason!));
    if (this.pending.size >= 50) return Promise.reject(new Error("Too many browser requests are pending."));
    const budget = op === "read" ? 20_000 : 120_000;
    const command = browserCommandSchema.parse({ id: randomUUID(), nonce: randomUUID(), expiresAt: new Date(Date.now() + budget).toISOString(), op, repo, prs });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const leased = !!this.pending.get(command.id)?.clientId; this.pending.delete(command.id);
        resolve({ id: command.id, nonce: command.nonce, outcome: op !== "read" && leased ? "uncertain" : "failed", prs: [], applied: [], error: leased ? "Graphite did not confirm the result. Check state before trying again." : "The browser disconnected before this request was delivered." });
      }, budget);
      this.pending.set(command.id, { command, clientId: null, timer, resolve });
    });
  }
  close() {
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.resolve({ id: job.command.id, nonce: job.command.nonce, outcome: job.clientId && job.command.op !== "read" ? "uncertain" : "failed", prs: [], applied: [], error: "Follow-through reloaded before the request was confirmed. Check state." }); }
    this.pending.clear(); this.clients.clear(); this.observations.clear();
  }
}
