import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Pr, Snapshot } from "../shared/model";

type Scheduling = Snapshot["mergeWhenReady"];
const enabled = new Set(["QUEUED_TO_MERGE", "WAITING_TO_MERGE", "REBASING", "HANDED_OFF_TO_EXTERNAL_MERGE_QUEUE"]);
const disabled = new Set(["DRAFT", "NEEDS_REVIEWERS", "NEEDS_APPROVALS", "NEEDS_CODEOWNER_APPROVALS", "CHANGES_REQUESTED", "NEEDS_RESTACK__BASE_BRANCH_MERGED", "NEEDS_RESTACK__BASE_INCORRECT", "MERGE_CONFLICTS", "FAILING_REQUIRED", "RUNNING", "STALE", "UNRESOLVED_COMMENTS", "WAITING_ON_DOWNSTACK", "HARD_WAITING_ON_DOWNSTACK", "READY_TO_MERGE", "READY_TO_MERGE_AS_STACK", "READY_TO_MERGE_WITHOUT_CI", "READY_TO_MERGE_AS_STACK_WITHOUT_CI", "READY_TO_MERGE_AS_STACK_WITHOUT_DOWNSTACK_CI_PASSING"]);

export function mergeScheduling(status: unknown): Scheduling {
  return typeof status !== "string" ? "unknown" : enabled.has(status) ? "on" : disabled.has(status) ? "off" : "unknown";
}

export class GraphiteWriteError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}
async function requestGraphite(route: "mergeability-status" | "merge", body: Record<string, unknown>): Promise<unknown> {
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const { authToken } = await readFile(join(config, "graphite", "auth"), "utf8").then(s => JSON.parse(s)).catch(() => { throw new GraphiteWriteError("Graphite CLI authentication is unavailable.", false); });
  if (typeof authToken !== "string" || !authToken) throw new GraphiteWriteError("Graphite authentication unavailable.", false);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`https://api.graphite.com/v1/graphite/${route}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `token ${authToken}` },
      body: JSON.stringify(body), signal: controller.signal, redirect: "error",
    });
    if (!response.ok) throw new GraphiteWriteError(`Graphite rejected the request (HTTP ${response.status}). Refresh its state before trying again.`, response.status >= 500 || response.status === 408);
    return route === "merge" ? null : await response.json();
  } catch (error) {
    if (error instanceof GraphiteWriteError) throw error;
    throw new GraphiteWriteError("Graphite did not confirm the request. Check its state before trying again.", true);
  } finally { clearTimeout(timeout); }
}

// The CLI status lookup is read-only despite using POST.
async function lookup(repo: string, prNumbers: number[]): Promise<unknown> {
  const [repoOwner, repoName] = repo.split("/");
  return requestGraphite("mergeability-status", { repoOwner, repoName, prNumbers });
}

export class Graphite {
  private cache = new Map<string, { at: number; state: Scheduling; status: string | null }>();
  constructor(private request = lookup, private now = Date.now) {}
  async observe(prs: Pr[]): Promise<Map<string, Scheduling>> {
    const result = new Map<string, Scheduling>();
    for (const repo of new Set(prs.map(p => p.repo))) {
      const targets = [...new Map(prs.filter(p => p.repo === repo).map(p => [p.key, p])).values()];
      const refresh = targets.filter(p => !this.cache.has(p.key) || this.now() - this.cache.get(p.key)!.at >= 30_000);
      for (let offset = 0; offset < refresh.length; offset += 100) {
        const batch = refresh.slice(offset, offset + 100);
        let rows: { prNumber: number; mergeabilityStatus: unknown }[] = [];
        try {
          const payload = await this.request(repo, batch.map(p => p.number)) as { mergeabilityStatuses?: typeof rows };
          if (Array.isArray(payload?.mergeabilityStatuses)) rows = payload.mergeabilityStatuses;
        } catch { /* Scheduling failure must not erase GitHub review/check observations. */ }
        for (const p of batch) {
          const matching = rows.filter(row => row?.prNumber === p.number);
          const status = matching.length === 1 && typeof matching[0].mergeabilityStatus === "string" ? matching[0].mergeabilityStatus : null;
          this.cache.set(p.key, { at: this.now(), state: mergeScheduling(status), status });
        }
      }
      for (const p of targets) result.set(p.key, this.cache.get(p.key)?.state ?? "unknown");
    }
    return result;
  }
  status(key: string): string | null { return this.cache.get(key)?.status ?? null; }
  invalidate(): void { this.cache.clear(); }
  async merge(repo: string, prNumbers: number[], trunkBranchName: string): Promise<void> {
    const [repoOwner, repoName] = repo.split("/");
    await requestGraphite("merge", { repoOwner, repoName, trunkBranchName, prNumbers });
    this.invalidate();
  }
}
