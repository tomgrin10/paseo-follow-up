import { z } from "zod";
import { SCALE } from "./scale";

/**
 * Wait for checks (docs/wait-for-checks.md): an agent asks Follow-up to tell it when a PR's checks finish, ends its
 * turn, and gets one message afterwards. Follow-up answers from the reads it already makes of every tracked PR (a
 * watched PR reads at the running-checks cadence, inside the backoff and the reserve), so waiting adds no GitHub
 * read of its own (waiting-for-checks-adds-no-github-read). Pure: the server keeps the watches (server/check-watches.ts).
 */

/** How long a watch lasts when the agent doesn't say (like Wait's job limit). */
export const WATCH_DEFAULT_MS = 3 * 60 * 60_000;
export const WATCH_MAX_MS = 12 * 60 * 60_000;
/**
 * "All passed" needs the head to have been quiet this long, or checks seen running on it: right after a push GitHub
 * can list a head with no check suites yet, which reads as "nothing running" for a few seconds.
 */
export const WATCH_SETTLE_MS = 60_000;
/** At most this many open watches per agent: a watch per PR of the biggest stack fits (pr-scale-lists-batch-not-throw); this only stops a runaway loop. */
export const WATCHES_PER_AGENT = SCALE.perWorkspace;

export const checkWatchSchema = z.object({
  id: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  /** owner/repo#number */
  prKey: z.string().min(1).max(300),
  url: z.string().max(2000),
  createdAt: z.string(),
  until: z.string(),
  /** Set while the tool call that made it is still answering: that call reports the verdict itself, never a message too. */
  answering: z.boolean().default(false),
  /** A head on which checks were seen running: they finished on that head, so "all passed" needs no settle wait. */
  runningHead: z.string().nullable().default(null),
});
export type CheckWatch = z.infer<typeof checkWatchSchema>;
export const checkWatchFileSchema = z.object({ version: z.literal(1), watches: z.array(checkWatchSchema).default([]) });
export type CheckWatchFile = z.infer<typeof checkWatchFileSchema>;

export type WatchedPr = {
  key: string; repo: string; number: number; error: string | null;
  snapshot: {
    url: string; state: "OPEN" | "MERGED" | "CLOSED"; head: string; conflict: boolean; complete: boolean; observedAt: string;
    failedChecks: string[]; otherFailedChecks?: string[]; checksPending: boolean; checksRunning?: boolean; checksHead?: string | null;
  } | null;
};
export type VerdictKind = "passed" | "failed" | "merged" | "closed" | "conflict" | "expired" | "gone";
export type Verdict = { kind: VerdictKind; prKey: string; head: string | null; failed: string[]; text: string };

const short = (sha: string | null | undefined) => sha ? sha.slice(0, 7) : "unknown";
const checksUrl = (pr: WatchedPr) => pr.snapshot?.url ? `${pr.snapshot.url.replace(/\/$/, "")}/checks` : null;
export const WATCH_HEADER = "Follow-up checks";

/** The message (or the tool's immediate answer) for a verdict: one header line, then what happened and what to do. */
export function verdictText(kind: VerdictKind, pr: WatchedPr, extra: { failed?: string[]; pending?: boolean; running?: boolean } = {}): string {
  const name = `${pr.repo}#${pr.number}`;
  const head = short(pr.snapshot?.head);
  const link = checksUrl(pr);
  switch (kind) {
    case "passed": return `${WATCH_HEADER} ${name}: all checks passed on ${head}.${extra.pending ? " A required check hasn't reported yet, so GitHub may still block the merge." : ""}`;
    case "failed": {
      const failed = extra.failed ?? [];
      return `${WATCH_HEADER} ${name}: ${failed.length} check${failed.length === 1 ? "" : "s"} failed on ${head}: ${failed.join(", ")}.${extra.running ? " Others are still running." : ""}${link ? ` Details: ${link}` : ""}`;
    }
    case "merged": return `${WATCH_HEADER} ${name}: merged.`;
    case "closed": return `${WATCH_HEADER} ${name}: closed without merging.`;
    case "conflict": return `${WATCH_HEADER} ${name}: it has a merge conflict with its base on ${head}; checks may not run until it's resolved.`;
    case "expired": return `${WATCH_HEADER} ${name}: stopped waiting after the time limit; the last read showed checks still running on ${head}. Call wait_for_checks again if you still need the result.`;
    case "gone": return `${WATCH_HEADER} ${name}: Follow-up no longer follows this PR, so it stopped waiting.`;
  }
}

/**
 * One watch against the PR as Follow-up last read it. `fire`: the watch ends with this verdict. `next`: the watch,
 * possibly updated (runningHead), when it keeps waiting. Only a read made after the watch began decides anything:
 * an older read may predate the agent's push. Never throws.
 *
 * - merged, closed, a merge conflict: at once.
 * - check results read for a commit other than the head (`checksHead`): nothing yet, keep waiting.
 * - a required check failed: at once (the agent has to fix it whatever else runs); other failures once nothing runs.
 * - all finished and none failed: "passed", once checks were seen running on this head or the head has been quiet
 *   WATCH_SETTLE_MS (`quietSince`: when the PR's content last changed, or null when unknown).
 */
export function watchVerdict(watch: CheckWatch, pr: WatchedPr | undefined, now: number, quietSince: number | null = null): { fire: Verdict | null; next: CheckWatch } {
  const keep = (next: CheckWatch = watch) => ({ fire: null, next });
  const end = (kind: VerdictKind, p: WatchedPr, extra: Parameters<typeof verdictText>[2] = {}) =>
    ({ fire: { kind, prKey: watch.prKey, head: p.snapshot?.head ?? null, failed: extra.failed ?? [], text: verdictText(kind, p, extra) }, next: watch });
  if (!pr) return { fire: { kind: "gone", prKey: watch.prKey, head: null, failed: [], text: verdictText("gone", { key: watch.prKey, ...splitKey(watch.prKey), error: null, snapshot: null }) }, next: watch };
  const s = pr.snapshot;
  if (now >= Date.parse(watch.until)) return end("expired", pr);
  if (!s || pr.error || !s.complete) return keep();
  if (Date.parse(s.observedAt) < Date.parse(watch.createdAt)) return keep();
  if (s.state === "MERGED") return end("merged", pr);
  if (s.state === "CLOSED") return end("closed", pr);
  if (s.conflict) return end("conflict", pr);
  // checks-belong-to-the-current-head: results read for another commit say nothing about this head; keep waiting.
  if (s.checksHead && s.checksHead !== s.head) return keep();
  const running = s.checksRunning ?? s.checksPending;
  if (s.failedChecks.length) return end("failed", pr, { failed: [...s.failedChecks, ...(s.otherFailedChecks ?? [])], running });
  if (running) return watch.runningHead === s.head ? keep() : keep({ ...watch, runningHead: s.head });
  const others = s.otherFailedChecks ?? [];
  if (others.length) return end("failed", pr, { failed: others });
  const settled = watch.runningHead === s.head || quietSince !== null && now - quietSince >= WATCH_SETTLE_MS;
  return settled ? end("passed", pr, { pending: s.checksPending }) : keep();
}
export function splitKey(key: string): { repo: string; number: number } {
  const at = key.lastIndexOf("#");
  return { repo: key.slice(0, at), number: Number(key.slice(at + 1)) || 0 };
}

/**
 * a-waited-for-failure-is-sent-once: a failure the agent waits for that a repair message will carry anyway (the agent
 * is the workspace's main agent, Auto-send is on, and a repair batch with this PR's checks task is queued, going out or
 * out) ends the watch quietly: the repair is the one message. Anything else (Auto-send off, a contributor waiting) gets
 * the watch's message.
 */
export function coveredByRepair(w: { mainAgentId: string; enable_auto_sends: boolean; batches: readonly { state: string; tasks: readonly { kind: string; target: string }[] }[] }, agentId: string, prKey: string): boolean {
  if (w.mainAgentId !== agentId || !w.enable_auto_sends) return false;
  return w.batches.some(b => ["pending", "sending", "sent", "uncertain"].includes(b.state) && !b.tasks.every(t => t.kind === "inventory") && b.tasks.some(t => t.kind === "checks" && t.target === prKey));
}

/** A PR reference from the tool: a URL, owner/repo#N, or a bare number (in the agent's own workspace). */
export function parsePrRef(ref: string): { repo: string | null; number: number; forge: "github" | "other" } | null {
  const text = ref.trim();
  const url = /^https?:\/\/([^/]+)\/([\w.-]+)\/([\w.-]+)\/(?:pull|pulls|merge_requests|-\/merge_requests)\/(\d+)/i.exec(text);
  if (url) return { repo: `${url[2]}/${url[3]}`, number: Number(url[4]), forge: /(^|\.)github\.com$/i.test(url[1]) ? "github" : "other" };
  const key = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
  if (key) return { repo: key[1], number: Number(key[2]), forge: "github" };
  const bare = /^#?(\d+)$/.exec(text);
  if (bare) return { repo: null, number: Number(bare[1]), forge: "github" };
  return null;
}
