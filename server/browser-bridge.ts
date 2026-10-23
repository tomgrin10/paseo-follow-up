import { randomUUID } from "node:crypto";
import { browserCommandSchema, type BrowserCommand, type BrowserPr, type BrowserResult } from "../shared/pr-actions";

type Pending = { command: BrowserCommand; clientId: string | null; timer: ReturnType<typeof setTimeout>; resolve: (r: BrowserResult) => void };
export class BrowserBridge {
  private clients = new Map<string, { at: number; ready: boolean }>();
  private pending = new Map<string, Pending>();
  private observations = new Map<string, { at: number; pr: BrowserPr }>();
  status() {
    const ready = [...this.clients.values()].some(c => c.ready && Date.now() - c.at < 15_000);
    return { ready, reason: ready ? null : "Open Graphite in Chrome with the updated Send to Paseo extension to connect merge controls." };
  }
  cached(repo: string, number: number, head: string): BrowserPr | null {
    const saved = this.observations.get(`${repo}#${number}`);
    return saved && Date.now() - saved.at < 15_000 && saved.pr.head === head ? saved.pr : null;
  }
  exchange(clientId: string, ready: boolean, results: BrowserResult[], acceptJobs = true): BrowserCommand[] {
    this.clients.set(clientId, { at: Date.now(), ready });
    for (const result of results) {
      const job = this.pending.get(result.id);
      if (!job || job.clientId !== clientId || job.command.nonce !== result.nonce) continue;
      if (result.prs.some(p => p.repo !== job.command.repo || !job.command.prs.some(t => t.number === p.number))) continue;
      if (result.applied.some(n => !job.command.prs.some(p => p.number === n))) continue;
      clearTimeout(job.timer); this.pending.delete(result.id);
      for (const pr of result.prs) this.observations.set(`${pr.repo}#${pr.number}`, { at: Date.now(), pr });
      job.resolve(result);
    }
    if (!ready || !acceptJobs) return [];
    const jobs = [...this.pending.values()].filter(p => !p.clientId && Date.parse(p.command.expiresAt) > Date.now()).slice(0, 1);
    for (const job of jobs) job.clientId = clientId;
    return jobs.map(j => j.command);
  }
  request(op: BrowserCommand["op"], repo: string, prs: BrowserCommand["prs"]): Promise<BrowserResult> {
    if (!this.status().ready) return Promise.reject(new Error(this.status().reason!));
    const command = browserCommandSchema.parse({ id: randomUUID(), nonce: randomUUID(), expiresAt: new Date(Date.now() + 20_000).toISOString(), op, repo, prs });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const leased = !!this.pending.get(command.id)?.clientId; this.pending.delete(command.id);
        resolve({ id: command.id, nonce: command.nonce, outcome: op !== "read" && leased ? "uncertain" : "failed", prs: [], applied: [], error: leased ? "Graphite did not confirm the result. Check state before trying again." : "The browser disconnected before this request was delivered." });
      }, 20_000);
      this.pending.set(command.id, { command, clientId: null, timer, resolve });
    });
  }
  close() {
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.resolve({ id: job.command.id, nonce: job.command.nonce, outcome: job.clientId && job.command.op !== "read" ? "uncertain" : "failed", prs: [], applied: [], error: "Follow-through reloaded before the request was confirmed. Check state." }); }
    this.pending.clear();
  }
}
