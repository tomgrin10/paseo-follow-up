// A realistic state.json for scripts/scale-check.mjs: the live install's shape at 141 workspaces is ~1.3 MB of state
// (about 9 KB a workspace: three PRs with full snapshots, tasks with evidence, a settled batch history, questions,
// main-agent history, artifacts). The old seed (empty workspaces, no PRs) used a fraction of the worker's memory and
// let a 450 MB worker pass a 240 MB budget. Synthetic data only.
//   npx tsx scripts/scale-seed.ts <out state.json> <created.json> [prsPerWorkspace=3] [freshFirst=0]
// freshFirst: the first N workspaces get no batch history (test:scale --awake-fresh: the awake ones send under any rule).
// created.json: [{ workspaceId, agentId }] for the daemon's real workspaces and agents. Prints the bytes written.
import { readFileSync, writeFileSync } from "node:fs";
import { stateSchema, type State, type Workspace } from "../shared/model";

const [out, createdPath, perArg, freshArg] = process.argv.slice(2);
const FRESH = Number(freshArg ?? 0);
const created = JSON.parse(readFileSync(createdPath!, "utf8")) as { workspaceId: string; agentId: string }[];
const PRS = Number(perArg ?? 3);
const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();
const H = 3_600_000, D = 24 * H;
const repos = ["example/app", "example/api", "example/web", "example/infra"];
const words = "migration rollout retry backoff billing ledger reconcile webhook signing audit export search index cache invalidation dashboard tokens onboarding email deploy anchor release notes schema backfill".split(" ");
const phrase = (seed: number, n: number) => Array.from({ length: n }, (_, k) => words[(seed * 7 + k * 13) % words.length]).join(" ");
const sentence = (seed: number, n: number) => { const s = phrase(seed, n); return s[0]!.toUpperCase() + s.slice(1) + "."; };
const sha = (seed: number) => Array.from({ length: 40 }, (_, k) => "0123456789abcdef"[(seed * 31 + k * 17) % 16]).join("");

function workspace(i: number, { workspaceId, agentId }: { workspaceId: string; agentId: string }): Workspace {
  const repo = repos[i % repos.length]!;
  const stack = `${phrase(i, 2)} ${i}`;
  const prs = Array.from({ length: PRS }, (_, k) => {
    const number = 1000 + i * PRS + k;
    const state = k === 0 && i % 3 === 0 ? "MERGED" as const : "OPEN" as const;
    return {
      key: `${repo}#${number}`, repo, number, stack, parent: k ? `${repo}#${number - 1}` : null, disposition: null, error: null,
      registeredAgentId: agentId,
      snapshot: {
        title: sentence(number, 6), url: `https://github.com/${repo}/pull/${number}`, state, head: sha(number), headBranch: `feat/${phrase(number, 2).replace(/ /g, "-")}-${number}`,
        graphiteMergeStatus: null, base: k ? `feat/${phrase(number - 1, 2).replace(/ /g, "-")}-${number - 1}` : "main", trunk: "main", draft: false, conflict: i % 7 === 0 && k === PRS - 1,
        reviewDecision: k === 0 ? "APPROVED" : "REVIEW_REQUIRED",
        reviewers: { author: "fixture-dev", requested: ["reviewer-one", "reviewer-two"], teams: ["example/platform"], reviewed: ["reviewer-three"], complete: true },
        mergeWhenReady: "off" as const,
        threads: Array.from({ length: 2 }, (_, t) => ({ id: `PRRT_kwDO${sha(number * 10 + t).slice(0, 18)}`, updatedAt: iso((t + 1) * H) })),
        failedChecks: i % 5 === 0 ? ["ci / unit (node 22)", "ci / lint"] : [], otherFailedChecks: [], checksPending: false, checksRunning: false,
        complete: true, observedAt: iso(60_000),
        mergeCommit: state === "MERGED" ? sha(number + 7) : null, mergedAt: state === "MERGED" ? iso(2 * D) : null,
        deployment: state === "MERGED" ? { state: "deployed" as const, environment: "production", commits: [sha(number + 7)], evidence: `Deployed ${sha(number + 7).slice(0, 7)} to production in run 88${number}`, observedAt: iso(H) } : null,
        prWorkflow: "github" as const, mergeStateStatus: "BLOCKED", inMergeQueue: false,
        repoMerge: { methods: ["squash" as const, "merge" as const], preferred: "squash" as const, autoMerge: true, mergeQueue: false },
      },
    };
  });
  const obligations = Array.from({ length: 5 }, (_, k) => ({
    id: `t${k + 1}`, title: sentence(i * 5 + k, 5), status: (["done", "done", "working", "waiting", "pending"] as const)[k]!,
    afterPrs: k > 2 ? [prs[0]!.key] : [], evidence: k < 2 ? sentence(i + k, 14) : "",
    ask: k === 3 ? sentence(i + 9, 10) : undefined, enable_follow_up: k === 3, revision: k + 1, previousTitles: k === 2 ? [sentence(i + 3, 5)] : undefined,
    ...(k === 2 ? { workingAgentId: agentId } : {}),
  }));
  const batches = Array.from({ length: i < FRESH ? 0 : 3 }, (_, k) => ({
    id: `b-${i}-${k}`, messageId: `m-${i}-${k}`, state: "completed" as const, createdAt: iso((k + 2) * D), sentAt: iso((k + 2) * D - 60_000), settledAt: iso((k + 2) * D - 30 * 60_000), attempts: 1,
    tasks: Array.from({ length: 3 }, (_, t) => ({ key: `${(["checks", "review", "conflict"] as const)[t]}:${prs[t % PRS]!.key}`, kind: (["checks", "review", "conflict"] as const)[t]!, target: prs[t % PRS]!.key, title: sentence(i * 12 + k * 3 + t, 7), fingerprint: sha(i * 100 + k * 3 + t).slice(0, 16) })),
    result: `Main agent finished: ${sentence(i + k, 9)}`, recipientAgentId: agentId, contextPath: null, activityAt: iso((k + 2) * D - 20 * 60_000), acknowledgmentError: null, recoveryHandoffs: [],
  }));
  const questions = Array.from({ length: 2 }, (_, k) => ({
    id: `Q${k + 1}`, title: sentence(i + k * 3, 5).slice(0, 110), question: `${sentence(i + k, 16)}?`,
    options: ["A", "B", "C"].map((letter, n) => ({ letter, label: sentence(i + k + n, 6), consequence: sentence(i + k + n + 4, 8) })),
    recommend: "A", big: null, background: sentence(i + k + 5, 12), links: [{ url: `https://github.com/${repo}/pull/${prs[0]!.number}`, label: "PR" }],
    prKey: null, taskId: null, taskRevision: null, askedBy: agentId, askedAt: iso((k + 1) * D), mode: "keep-building" as const,
    answer: k < 2 ? { choice: "A", at: iso(k * D + H), by: "developer" as const, delivery: { state: "sent" as const, to: agentId, messageId: `qa-${i}-${k}`, at: iso(k * D + H), reason: null } } : null,
    closed: null, via: "ask" as const,
  }));
  return {
    id: workspaceId, title: `${sentence(i, 3).slice(0, -1)} (${i})`, goal: `${sentence(i + 1, 14)} ${sentence(i + 2, 10)}`, mainAgentId: agentId,
    contributorAgentIds: [], mainHistory: [{ from: "agent-old", to: agentId, by: "discovery", reason: null, at: iso(9 * D) }], mainWorkAt: iso(2 * H),
    enable_tracking: true, enable_auto_sends: i % 2 === 0, hold: null, archived: false,
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
