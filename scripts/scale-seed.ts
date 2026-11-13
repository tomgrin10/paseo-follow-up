// A realistic state.json for scripts/scale-check.mjs: the live install's shape at 141 workspaces is ~1.3 MB of state
// (about 9 KB a workspace: three PRs with full snapshots, tasks with evidence, a settled batch history, questions,
// main-agent history, artifacts). The old seed (empty workspaces, no PRs) used a fraction of the worker's memory and
// let a 450 MB worker pass a 240 MB budget. Synthetic data only.
//   npx tsx scripts/scale-seed.ts <out state.json> <created.json> [prsPerWorkspace=3] [freshFirst=0] [out inbox.json]
// Live-sized (2026-11-13, the live install that stepped 315 → 405 MB): workspace 0 tracks BIG_PRS PRs, nearly all
// merged and in their own stacks, with BIG_TASKS tasks and BIG_QUESTIONS questions; inbox.json (when asked for) has
// INBOX_ENTRIES entries, about half flagged, with seenKeys up to the 200-key ring for the big workspace's agent, briefs,
// 81 unsorted agents and the 500-row brief-origin log.
// freshFirst: the first N workspaces get no batch history (test:scale --awake-fresh: the awake ones send under any rule).
// created.json: [{ workspaceId, agentId }] for the daemon's real workspaces and agents. Prints the bytes written.
import { readFileSync, writeFileSync } from "node:fs";
import { stateSchema, type State, type Workspace } from "../shared/model";
import { inboxStateSchema, newEntry, type InboxState } from "../shared/inbox";
import { BRIEF_KINDS, BRIEF_SOURCES } from "../shared/brief";

const [out, createdPath, perArg, freshArg, inboxOut] = process.argv.slice(2);
export const BIG_PRS = 153, BIG_MERGED = 150, BIG_TASKS = 39, BIG_QUESTIONS = 52, INBOX_ENTRIES = 86;
const FRESH = Number(freshArg ?? 0);
const created = JSON.parse(readFileSync(createdPath!, "utf8")) as { workspaceId: string; agentId: string; agentIds?: string[] }[];
const PRS = Number(perArg ?? 3);
const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();
const H = 3_600_000, D = 24 * H;
const repos = ["example/app", "example/api", "example/web", "example/infra"];
const words = "migration rollout retry backoff billing ledger reconcile webhook signing audit export search index cache invalidation dashboard tokens onboarding email deploy anchor release notes schema backfill".split(" ");
const phrase = (seed: number, n: number) => Array.from({ length: n }, (_, k) => words[(seed * 7 + k * 13) % words.length]).join(" ");
const sentence = (seed: number, n: number) => { const s = phrase(seed, n); return s[0]!.toUpperCase() + s.slice(1) + "."; };
const sha = (seed: number) => Array.from({ length: 40 }, (_, k) => "0123456789abcdef"[(seed * 31 + k * 17) % 16]).join("");

/**
 * The live share of followed workspaces that are archived (49 of 139 on 2026-11-13), past the first 10 (awake and fresh
 * ones stay live). Most PRs are merged, as on live. The live copy's detail sizes also set the per-item text: deployment evidence ~240 B a deployed PR,
 * task evidence ~340 B on nearly every task, one task per settled batch, no open threads on merged PRs.
 */
const archived = (i: number) => i >= 10 && i % 20 < 7;

function workspace(i: number, { workspaceId, agentId }: { workspaceId: string; agentId: string }): Workspace {
  const repo = repos[i % repos.length]!;
  const stack = `${phrase(i, 2)} ${i}`;
  const big = i === 0; const count = big ? BIG_PRS : PRS;
  const prs = Array.from({ length: count }, (_, k) => {
    const number = big ? 50_000 + k : 1000 + i * PRS + k;
    // Live (2026-11-13): 406 of 456 PRs merged, so a workspace's older PRs are merged and every third has its top one open.
    const state = big ? (k < BIG_MERGED ? "MERGED" as const : "OPEN" as const) : k === PRS - 1 && i % 3 === 0 ? "OPEN" as const : "MERGED" as const;
    // The big workspace: mostly one-PR stacks, a few short chains (live: 129 stacks for 154 PRs, depth ≤ 3).
    const chained = big ? k % 6 !== 0 : !!k;
    return {
      key: `${repo}#${number}`, repo, number, stack: big ? `${phrase(i, 2)} ${Math.floor(k * 129 / BIG_PRS)}` : stack, parent: chained && k ? `${repo}#${number - 1}` : null, disposition: null, error: null,
      registeredAgentId: agentId,
      snapshot: {
        title: sentence(number, 6), url: `https://github.com/${repo}/pull/${number}`, state, head: sha(number), headBranch: `feat/${phrase(number, 2).replace(/ /g, "-")}-${number}`,
        graphiteMergeStatus: null, base: k ? `feat/${phrase(number - 1, 2).replace(/ /g, "-")}-${number - 1}` : "main", trunk: "main", draft: false, conflict: i % 7 === 0 && k === PRS - 1,
        reviewDecision: k === 0 ? "APPROVED" : "REVIEW_REQUIRED",
        reviewers: { author: "fixture-dev", requested: ["reviewer-one", "reviewer-two"], teams: ["example/platform"], reviewed: ["reviewer-three"], complete: true },
        mergeWhenReady: "off" as const,
        threads: Array.from({ length: state === "MERGED" ? 0 : 2 }, (_, t) => ({ id: `PRRT_kwDO${sha(number * 10 + t).slice(0, 18)}`, updatedAt: iso((t + 1) * H) })),
        failedChecks: i % 5 === 0 ? ["ci / unit (node 22)", "ci / lint"] : [], otherFailedChecks: [], checksPending: false, checksRunning: false,
        complete: true, observedAt: iso(60_000),
        mergeCommit: state === "MERGED" ? sha(number + 7) : null, mergedAt: state === "MERGED" ? iso(2 * D) : null,
        deployment: state === "MERGED" ? { state: "deployed" as const, environment: "production", commits: [sha(number + 7)], evidence: `Deployed ${sha(number + 7).slice(0, 7)} to production in run 88${number}. ${sentence(number, 30)}`, observedAt: iso(H) } : null,
        prWorkflow: "github" as const, mergeStateStatus: "BLOCKED", inMergeQueue: false,
        repoMerge: { methods: ["squash" as const, "merge" as const], preferred: "squash" as const, autoMerge: true, mergeQueue: false },
      },
    };
  });
  const obligations = Array.from({ length: big ? BIG_TASKS : 5 }, (_, k) => ({
    id: `t${k + 1}`, title: sentence(i * 5 + k, 5), status: (["done", "done", "working", "waiting", "pending"] as const)[k % 5]!,
    afterPrs: k > 2 ? [prs[0]!.key] : [], evidence: sentence(i + k, 45),
    ask: k % 5 === 3 ? sentence(i + 9, 10) : undefined, enable_follow_up: k % 5 === 3, revision: k + 1, previousTitles: k % 5 === 2 ? [sentence(i + 3, 5)] : undefined,
    ...(k % 5 === 2 ? { workingAgentId: agentId } : {}),
  }));
  const batches = Array.from({ length: i < FRESH ? 0 : 3 }, (_, k) => ({
    id: `b-${i}-${k}`, messageId: `m-${i}-${k}`, state: "completed" as const, createdAt: iso((k + 2) * D), sentAt: iso((k + 2) * D - 60_000), settledAt: iso((k + 2) * D - 30 * 60_000), attempts: 1,
    tasks: Array.from({ length: 1 }, (_, t) => ({ key: `${(["checks", "review", "conflict"] as const)[t]}:${prs[t % PRS]!.key}`, kind: (["checks", "review", "conflict"] as const)[t]!, target: prs[t % PRS]!.key, title: sentence(i * 12 + k * 3 + t, 7), fingerprint: sha(i * 100 + k * 3 + t).slice(0, 16) })),
    result: `Main agent finished: ${sentence(i + k, 9)}`, recipientAgentId: agentId, contextPath: null, activityAt: iso((k + 2) * D - 20 * 60_000), acknowledgmentError: null, recoveryHandoffs: [],
  }));
  const questions = Array.from({ length: big ? BIG_QUESTIONS : 2 }, (_, k) => ({
    id: `Q${k + 1}`, title: sentence(i + k * 3, 5).slice(0, 110), question: `${sentence(i + k, 16)}?`,
    options: ["A", "B", "C"].map((letter, n) => ({ letter, label: sentence(i + k + n, 6), consequence: sentence(i + k + n + 4, 8) })),
    recommend: "A", big: null, background: sentence(i + k + 5, 12), links: [{ url: `https://github.com/${repo}/pull/${prs[0]!.number}`, label: "PR" }],
    prKey: null, taskId: null, taskRevision: null, askedBy: agentId, askedAt: iso((k + 1) * D), mode: "keep-building" as const,
    answer: big ? (k % 4 ? { choice: "A", at: iso(k * D + H), by: "developer" as const, delivery: { state: "sent" as const, to: agentId, messageId: `qa-${i}-${k}`, at: iso(k * D + H), reason: null } } : null) : k < 2 ? { choice: "A", at: iso(k * D + H), by: "developer" as const, delivery: { state: "sent" as const, to: agentId, messageId: `qa-${i}-${k}`, at: iso(k * D + H), reason: null } } : null,
    closed: null, via: "ask" as const,
  }));
  return {
    id: workspaceId, title: `${sentence(i, 3).slice(0, -1)} (${i})`, goal: `${sentence(i + 1, 14)} ${sentence(i + 2, 10)}`, mainAgentId: agentId,
    contributorAgentIds: [], mainHistory: [{ from: "agent-old", to: agentId, by: "discovery", reason: null, at: iso(9 * D) }], mainWorkAt: iso(2 * H),
    enable_tracking: true, enable_auto_sends: i % 2 === 0, hold: null, archived: archived(i),
    prs, obligations, batches, excludedStacks: [], prActions: [],
    completion: null, declaration: null, updatedAt: iso(H), managedDoneLabel: false, runtimeReason: null, runtimeBusy: false, backgroundBusy: false,
    questions, spec: { url: `https://linear.app/example/issue/APP-${100 + i}`, title: sentence(i, 4).slice(0, 100), source: "agent", by: agentId, at: iso(8 * D) },
    artifacts: [{ url: `https://claude.ai/artifact/${sha(i).slice(0, 32)}`, title: sentence(i + 4, 4).slice(0, 100), by: agentId, firstAt: iso(5 * D), lastAt: iso(D), publishes: 3 }],
    inventory: { revision: 3, syncedRevision: 3, candidates: prs.map(p => p.key), historyComplete: true, historyError: null, scannedMessageAt: iso(H) },
  } as unknown as Workspace;
}

const state: State = stateSchema.parse({ version: 1, migrations: ["follow-every-1"], workspaces: created.map((c, i) => workspace(i, c)) });
const text = JSON.stringify(state);
writeFileSync(out!, text);
console.log(text.length);

/** The live-shaped inbox: entries for the first INBOX_ENTRIES agents (mains, then helpers). Synthetic text only. */
function inbox(): InboxState {
  const agents = [...created.map(c => c.agentId), ...created.flatMap(c => (c.agentIds ?? []).slice(1))].slice(0, INBOX_ENTRIES);
  const bigPrs = state.workspaces[0]?.prs ?? [];
  const entries = Object.fromEntries(agents.map((agentId, n) => {
    const e = newEntry(agentId);
    const keys = n === 0 ? [...bigPrs.filter(p => p.snapshot?.state === "MERGED").map(p => `${p.key}:MERGED`), ...Array.from({ length: 48 }, (_, k) => `${bigPrs[0]?.key ?? "example/app#1"}:threads:PRRT_${sha(k).slice(0, 20)}`)] : Array.from({ length: n % 9 }, (_, k) => `example/app#${2000 + n * 10 + k}:${sha(n * 10 + k)}:checks`);
    e.seenKeys = keys.slice(-200);
    e.lastEventAt = iso((n % 48) * H);
    if (n % 2 === 0) e.needs = { reasons: [{ reason: (["finished", "ci", "review", "reviewers"] as const)[n % 4]!, at: iso((n % 24) * H), detail: sentence(n, 7), dedupeKey: `seed:${n}` }], since: iso((n % 24) * H) };
    if (n % 7 === 3) e.goneAt = iso(2 * D);
    if (n % 11 < 6) e.brief = { id: `brief:turn-${n}`, turnId: `turn-${n}`, source: BRIEF_SOURCES[3], kind: BRIEF_KINDS[0], ask: sentence(n + 3, 12).slice(0, 140), state: "open", questionIds: [], at: iso((n % 24) * H), seq: 0, flagged: true, slim: false, decisions: [], context: n % 3 ? sentence(n + 5, 30) : null, mono: null, facts: [], factsPr: null, links: [], moves: [], also: null, sourceLine: `From the agent's last message: ${sentence(n + 1, 6)}`, outcome: null, outcomeAt: null } as never;
    return [agentId, e];
  }));
  const unsorted = created.map(c => c.agentIds?.[1]).filter((a): a is string => !!a && !agents.includes(a)).slice(0, 81);
  return inboxStateSchema.parse({ version: 1, entries, importedAt: iso(9 * D), primedAt: iso(9 * D), unsorted, lastSeen: iso(60_000), revision: 99,
    ledger: agents.slice(0, 20).map((agentId, k) => ({ agentId, messageId: `seed-m-${k}`, at: iso(k * 60_000), by: "follow-up" })),
    briefOrigins: Array.from({ length: 500 }, (_, k) => ({ at: iso(k * 600_000), origin: (["tool", "structured", "extraction", "fallback"] as const)[k % 4]! })) });
}
if (inboxOut) { const text = JSON.stringify(inbox()); writeFileSync(inboxOut, text); console.error(`inbox ${text.length}`); }
