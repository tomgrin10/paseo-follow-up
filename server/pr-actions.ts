import { STOP_WAIT_MS, settleWithin, type Deadline } from "./teardown";
import { randomUUID } from "node:crypto";
import { downstack, isGithubFlow, mergeBlockers, prActionBlocks, type ActionPlan, type BrowserPr, type MergeStage, type PrActionKind } from "../shared/pr-actions";
import type { MergeMethod } from "../shared/pr-workflow";
import type { Workspace, Pr } from "../shared/model";
import { findWorkspace } from "./engine";
import { Store } from "./store";
import type { Github } from "./github";
import { GraphiteWriteError, type Graphite } from "./graphite";
import { BrowserBridge } from "./browser-bridge";
import { allAssigned, configuredReviewers, noReviewers, reviewerLabel, sameLogin, withoutAuthor, type ReviewerEntry } from "../shared/reviewers";
import { chooseMethod, GithubWriteError, ReviewRequestError } from "./github";

function active(w: Workspace) {
  if (!w.enable_tracking || w.archived) throw new Error("This workspace is not actively tracked.");
}
function identity(prs: Pr[]) { return JSON.stringify(prs.map(p => [p.key, p.parent, p.snapshot?.head, p.snapshot?.base, p.snapshot?.trunk])); }
/** The service that ships these PRs, for messages. */
const via = (prs: Pr[]) => prs.some(p => isGithubFlow(p.snapshot)) ? "GitHub" : "Graphite";
const AUTO_MERGE_OFF = "Auto-merge is off in this repository's settings. Turn on Allow auto-merge in the repository's GitHub settings to use When ready.";
function wire(prs: Pr[]) { return prs.map(p => ({ number: p.number, head: p.snapshot!.head, trunk: p.snapshot!.trunk })); }

export class PrActions {
  private plans = new Map<string, { plan: ActionPlan; identity: string }>();
  private reads = new Map<string, Promise<BrowserPr[]>>();
  private running = new Set<Promise<unknown>>();
  private reviewerRequests = new Map<string, Promise<{ state: "submitted" | "failed" | "uncertain"; result: string }>>();
  /** The repository's saved merge method (Settings), used when GitHub still allows it. */
  savedMethod: (repo: string) => MergeMethod | null = () => null;
  /** Pause between a parent's merge and its child's, while GitHub recomputes the child's mergeability. */
  settle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  /** Re-derives a workspace's queued tasks inside the write that records a merge (Engine.settleTasks). */
  settleTasks: (w: Workspace) => void = () => undefined;
  constructor(private store: Store, private github: Pick<Github, "observe"> & Partial<Pick<Github, "requestReviewers" | "merge" | "autoMerge" | "retarget">>, private graphite: Pick<Graphite, "merge" | "invalidate">, readonly browser: BrowserBridge, private now = Date.now, private reviewersFor: (repo: string) => ReviewerEntry[] = configuredReviewers) {}

  private async fresh(workspaceId: string): Promise<Workspace> {
    const saved = findWorkspace(await this.store.snapshot(), workspaceId); active(saved);
    this.graphite.invalidate();
    const observations = await this.github.observe(saved.prs);
    return this.store.mutate(state => {
      const w = findWorkspace(state, workspaceId); active(w);
      for (const p of w.prs) { const observed = observations.get(p.key); if (observed) { p.error = observed.error; if (observed.snapshot) p.snapshot = observed.snapshot; } }
      return w;
    });
  }
  private async read(prs: Pr[]): Promise<BrowserPr[]> {
    const result = await this.browser.request("read", prs[0].repo, wire(prs));
    if (result.outcome !== "completed") throw new Error(result.error || "Graphite state could not be read.");
    return prs.map(p => {
      const matching = result.prs.filter(r => r.repo === p.repo && r.number === p.number);
      if (matching.length !== 1 || matching[0].head !== p.snapshot?.head || matching[0].state !== p.snapshot.state) throw new Error("GitHub and Graphite show different PR revisions. Refresh before continuing.");
      return matching[0];
    });
  }
  async status(workspaceId: string, key: string) {
    const w = findWorkspace(await this.store.snapshot(), workspaceId); active(w);
    const p = w.prs.find(p => p.key === key);
    if (!p) throw new Error("This PR is outside the workspace's inventory.");
    if (isGithubFlow(p.snapshot)) {
      // GitHub mode: auto-merge is read with the PR itself; no browser companion is involved.
      const s = p.snapshot!;
      const allowed = !!s.repoMerge?.autoMerge;
      const browser = allowed ? { ready: true, reason: null } : { ready: false, reason: AUTO_MERGE_OFF };
      if (!allowed || p.error || !s.complete || s.state !== "OPEN") return { browser, pr: null, error: null };
      return { browser, pr: { repo: p.repo, number: p.number, head: s.head, state: s.state, mergeWhenReady: s.mergeWhenReady === "on", merging: !!s.inMergeQueue }, error: null };
    }
    const browser = this.browser.status(p.repo);
    if (!browser.ready || p.error || !p.snapshot?.complete || p.snapshot.state !== "OPEN") return { browser, pr: null, error: null };
    const cached = this.browser.cached(p.repo, p.number, p.snapshot.head);
    if (cached) return { browser, pr: cached, error: null };
    const rows = w.prs.filter(row => row.repo === p.repo && !row.error && row.snapshot?.complete && row.snapshot.state === "OPEN");
    const readKey = `${w.id}:${identity(rows)}`;
    if (!this.reads.has(readKey)) this.reads.set(readKey, this.read(rows).finally(() => this.reads.delete(readKey)));
    try { return { browser, pr: (await this.reads.get(readKey)!).find(row => row.number === p.number) ?? null, error: null }; }
    catch (error) { return { browser: this.browser.status(), pr: null, error: error instanceof Error ? error.message : "Could not read Graphite state." }; }
  }
  async prepare(workspaceId: string, key: string, kind: PrActionKind): Promise<ActionPlan> {
    const w = await this.fresh(workspaceId);
    const prs = downstack(w.prs, key);
    if (!prs.length || prs.at(-1)?.key !== key) throw new Error("This PR is already merged.");
    const blockers: string[] = [];
    if (w.prActions.some(a => prActionBlocks(a, prs.map(p => p.key)))) blockers.push("Check the previous PR action before sending another.");
    if (kind === "merge" && w.prActions.some(a => a.kind === "merge" && a.state === "submitted" && prs.some(p => a.heads[p.key] === p.snapshot?.head) && this.now() - Date.parse(a.createdAt) < 30_000)) blockers.push(`A merge was just submitted for this revision. Wait for ${via(prs)}'s result.`);
    const rows = prs.map(p => ({ key: p.key, repo: p.repo, number: p.number, title: p.snapshot?.title ?? p.stack, head: p.snapshot?.head ?? "", parent: p.parent, base: p.snapshot?.base ?? "", trunk: p.snapshot?.trunk ?? "", blockers: kind === "merge" ? mergeBlockers(p) : p.error || !p.snapshot?.complete || p.snapshot.state !== "OPEN" ? ["Refresh an open PR"] : kind === "enable_mwr" && p.snapshot.draft ? ["Draft"] : [] }));
    if (kind === "merge") {
      for (let i = 0; i < prs.length; i++) {
        const s = prs[i].snapshot;
        const expectedBase = i ? prs[i - 1].snapshot?.headBranch : s?.trunk;
        if (!s || !expectedBase || s.base !== expectedBase) rows[i].blockers.push("Refresh the stack's parent relationships");
      }
    } else if (isGithubFlow(prs.at(-1)!.snapshot)) {
      for (const [i, p] of prs.entries()) if (!p.snapshot?.repoMerge?.autoMerge && !rows[i].blockers.length) rows[i].blockers.push(AUTO_MERGE_OFF);
      if (kind === "enable_mwr" && prs.at(-1)!.snapshot?.inMergeQueue) rows.at(-1)!.blockers.push("Merge already in progress");
    } else if (!rows.at(-1)!.blockers.length) {
      const remote = await this.read(prs.slice(-1));
      if (kind === "enable_mwr" && remote[0].merging && !remote[0].mergeWhenReady) rows.at(-1)!.blockers.push("Merge already in progress");
    }
    const github = isGithubFlow(prs.at(-1)!.snapshot);
    const plan: ActionPlan = { id: randomUUID(), workspaceId, target: key, kind, expiresAt: new Date(this.now() + 60_000).toISOString(), prs: rows, blockers,
      ...(github ? { via: "github" as const, method: chooseMethod(prs[0].snapshot?.repoMerge, this.savedMethod(prs[0].repo)), mergeQueue: !!prs[0].snapshot?.repoMerge?.mergeQueue } : {}) };
    for (const [id, saved] of this.plans) if (Date.parse(saved.plan.expiresAt) <= this.now()) this.plans.delete(id);
    this.plans.set(plan.id, { plan, identity: identity(prs) });
    return plan;
  }
  confirm(planId: string, scope: "target" | "downstack") {
    const work = this.execute(planId, scope); this.running.add(work);
    void work.finally(() => this.running.delete(work)).catch(() => undefined);
    return work;
  }
  /** The Add reviewers button: the repository's defaults. An agent may name logins instead (agent parity). */
  requestReviewers(workspaceId: string, key: string, logins?: string[]) {
    const requestKey = JSON.stringify([workspaceId, key, logins ?? null]);
    const pending = this.reviewerRequests.get(requestKey);
    if (pending) return pending;
    const work = this.executeReviewers(workspaceId, key, logins);
    this.reviewerRequests.set(requestKey, work); this.running.add(work);
    void work.finally(() => { this.reviewerRequests.delete(requestKey); this.running.delete(work); }).catch(() => undefined);
    return work;
  }
  private async executeReviewers(workspaceId: string, key: string, logins?: string[]) {
    const w = await this.fresh(workspaceId);
    const pr = w.prs.find(p => p.key === key);
    if (!pr) throw new Error("This PR is outside the workspace's inventory.");
    if (pr.error || !pr.snapshot?.complete || !pr.snapshot.reviewers?.complete) throw new Error("Reviewer status is unavailable. Refresh before requesting reviews.");
    if (pr.snapshot.state !== "OPEN" || pr.snapshot.draft) throw new Error("Request reviews on an open PR that is ready for review.");
    // Explicit logins (the picker, or an agent) keep the saved display names where there are any.
    const saved = this.reviewersFor(pr.repo);
    const chosen: ReviewerEntry[] = logins?.length ? logins.map(login => saved.find(r => sameLogin(r.login, login)) ?? { login, name: null }) : saved;
    if (!chosen.length) throw new Error(`No reviewers set for ${pr.repo}. Pick who to ask, or set them in Settings → Reviewers.`);
    if (!this.github.requestReviewers) throw new Error("Requesting reviewers isn't available here.");
    if (!noReviewers(pr)) return { state: "submitted" as const, result: "Reviewers already assigned." };
    const reviewers = withoutAuthor(chosen, pr.snapshot!.reviewers!.author);
    if (!reviewers.length) throw new Error("Only the PR author was picked. Pick someone else to review.");
    const id = randomUUID();
    await this.store.mutate(state => {
      const current = findWorkspace(state, workspaceId); active(current);
      if (current.prActions.some(a => prActionBlocks(a, [key]))) throw new Error("Check the previous PR action before sending another.");
      const latest = current.prs.find(p => p.key === key);
      if (!latest || latest.snapshot?.head !== pr.snapshot!.head || !noReviewers(latest)) throw new Error("PR status changed. Refresh before requesting reviews.");
      current.prActions.push({ id, kind: "request_reviewers", reviewers: reviewers.map(r => r.login), prs: [key], heads: { [key]: pr.snapshot!.head }, createdAt: new Date(this.now()).toISOString(), state: "sending", result: "Waiting for GitHub to confirm the review request." });
    });
    let state: "submitted" | "failed" | "uncertain" = "uncertain";
    let result = "Review request sent; check state to confirm the reviewers.";
    try {
      await this.github.requestReviewers(pr, reviewers.map(r => r.login));
      const observed = (await this.github.observe([pr])).get(key);
      if (observed) await this.store.mutate(saved => { const p = findWorkspace(saved, workspaceId).prs.find(p => p.key === key)!; p.error = observed.error; if (observed.snapshot) p.snapshot = observed.snapshot; });
      const assigned = observed?.snapshot?.reviewers;
      if (!observed?.error && assigned?.complete && allAssigned(reviewers.map(r => r.login), assigned)) {
        state = "submitted"; result = `Requested ${names(reviewers.map(reviewerLabel))}.`;
      }
    } catch (error) {
      state = error instanceof ReviewRequestError && !error.uncertain ? "failed" : "uncertain";
      result = error instanceof Error ? error.message : "GitHub could not confirm the review request. Check state before retrying.";
    }
    await this.store.mutate(saved => { const action = findWorkspace(saved, workspaceId).prActions.find(a => a.id === id)!; action.state = state; action.result = result; });
    return { state, result };
  }
  private async execute(planId: string, scope: "target" | "downstack") {
    const saved = this.plans.get(planId);
    if (!saved || Date.parse(saved.plan.expiresAt) <= this.now()) throw new Error("The confirmation expired. Check readiness again.");
    this.plans.delete(planId);
    const { plan } = saved;
    const w = await this.fresh(plan.workspaceId);
    const full = downstack(w.prs, plan.target);
    if (identity(full) !== saved.identity) throw new Error("PR revisions or stack membership changed. Review a fresh confirmation.");
    const prs = scope === "target" ? full.slice(-1) : full;
    if (plan.kind === "merge") {
      if (scope === "target" && full.length > 1) throw new Error("This PR still depends on downstack PRs. Merge the listed stack together or cancel.");
      const updated = await this.prepare(plan.workspaceId, plan.target, plan.kind); this.plans.delete(updated.id);
      if (updated.blockers.length || updated.prs.some(p => p.blockers.length)) throw new Error("Merge readiness changed. Refresh the confirmation.");
      if (identity(downstack(findWorkspace(await this.store.snapshot(), plan.workspaceId).prs, plan.target)) !== saved.identity) throw new Error("The stack changed during readiness verification.");
    } else {
      if (prs.some(p => p.error || !p.snapshot?.complete || p.snapshot.state !== "OPEN" || plan.kind === "enable_mwr" && p.snapshot.draft)) throw new Error("A selected PR is no longer eligible.");
      if (isGithubFlow(prs[0].snapshot)) {
        if (prs.some(p => !p.snapshot!.repoMerge?.autoMerge)) throw new Error(AUTO_MERGE_OFF);
        if (plan.kind === "enable_mwr" && prs.some(p => p.snapshot!.inMergeQueue)) throw new Error("A selected PR is already merging.");
      } else {
        const remote = await this.read(prs);
        if (plan.kind === "enable_mwr" && remote.some(p => p.merging && !p.mergeWhenReady)) throw new Error("A selected PR is already merging.");
      }
    }
    const id = randomUUID();
    await this.store.mutate(state => {
      const current = findWorkspace(state, w.id); active(current);
      if (current.prActions.some(a => prActionBlocks(a, prs.map(p => p.key)))) throw new Error("A PR action is already in progress or needs checking.");
      if (plan.kind === "merge" && current.prActions.some(a => a.kind === "merge" && a.state === "submitted" && prs.some(p => a.heads[p.key] === p.snapshot?.head) && this.now() - Date.parse(a.createdAt) < 30_000)) throw new Error(`A merge was just submitted for this revision. Wait for ${via(prs)}'s result.`);
      if (identity(downstack(current.prs, plan.target)) !== saved.identity) throw new Error("The stack changed before submission.");
      current.prActions.push({ id, kind: plan.kind, prs: prs.map(p => p.key), heads: Object.fromEntries(prs.map(p => [p.key, p.snapshot!.head])), createdAt: new Date(this.now()).toISOString(), state: "sending", result: isGithubFlow(prs[0].snapshot) ? "Waiting for GitHub to confirm." : plan.kind === "merge" ? "Waiting for Graphite to confirm." : "Confirm this PR setting change in the Send to Paseo extension in Chrome." });
      current.completion = null; current.declaration = null;
    });
    let state: "submitted" | "failed" | "uncertain" = "submitted";
    let result: string;
    let merge: MergeStage | undefined;
    try {
      if (isGithubFlow(prs[0].snapshot)) ({ state, result, merge } = await this.githubExecute(plan.kind, prs));
      else if (plan.kind === "merge") {
        await this.graphite.merge(prs[0].repo, prs.map(p => p.number), prs[0].snapshot!.trunk);
        merge = "requested";
        result = `Merge submitted to Graphite for ${prs.length} PR${prs.length === 1 ? "" : "s"}. Waiting for the merge result.`;
      } else {
        const reply = await this.browser.request(plan.kind, prs[0].repo, wire(prs));
        state = reply.outcome === "completed" ? "submitted" : reply.outcome;
        const changed = reply.applied.map(n => `#${n}`).join(", ");
        result = reply.outcome === "completed" ? `Merge when ready ${plan.kind === "enable_mwr" ? "enabled" : "disabled"} for ${changed}.` : `${changed ? `Changed ${changed}. ` : ""}${reply.error || "Graphite could not confirm every selected PR."}`;
      }
    } catch (error) {
      state = (error instanceof GraphiteWriteError || error instanceof GithubWriteError) && error.uncertain ? "uncertain" : "failed";
      result = error instanceof Error ? error.message : `${via(prs)} action failed.`;
    }
    await this.store.mutate(s => {
      const current = findWorkspace(s, w.id);
      const action = current.prActions.find(a => a.id === id)!; action.state = state; action.result = result; if (state === "submitted" && merge) action.merge = merge;
      // A client keeps the newer of its live copy and a fresh read by updatedAt (useWorkspace): without this bump the
      // read after the click lost to the stale copy, and the panel said "Waiting for GitHub to confirm" beside "Merged".
      current.updatedAt = new Date(this.now()).toISOString();
      // a-merge-outcome-reads-the-same-everywhere: GitHub answered that it merged these PRs, so every surface says so
      // now (header, rows, progress, Needs you), not after the next PR read, which keeps its backoff. That read confirms.
      if (state === "submitted" && merge === "merged") for (const p of current.prs) if (prs.some(m => m.key === p.key) && p.snapshot && p.snapshot.state === "OPEN") {
        p.snapshot = { ...p.snapshot, state: "MERGED", mergedAt: p.snapshot.mergedAt ?? new Date(this.now()).toISOString() };
      }
      // Tasks and Needs you agree too: a queued repair for a PR that just merged goes now, not on the nudged tick.
      if (state === "submitted" && merge === "merged") this.settleTasks(current);
    });
    this.graphite.invalidate();
    return { state, result, ...(state === "submitted" && merge ? { merge } : {}) };
  }
  /**
   * Plain GitHub. Merge goes bottom to top with `gh pr merge` pinned to each reviewed head; after a parent merges, its
   * child is retargeted to trunk with `gh pr edit --base` when GitHub hasn't already, and gets a few seconds for
   * GitHub to recompute mergeability. When ready is GitHub auto-merge. Partial progress is reported as it happened.
   */
  private async githubExecute(kind: PrActionKind, prs: Pr[]): Promise<{ state: "submitted" | "failed" | "uncertain"; result: string; merge?: MergeStage }> {
    const gh = this.github;
    if (!gh.merge || !gh.autoMerge || !gh.retarget) throw new Error("GitHub merging isn't available here.");
    const done: string[] = [];
    const partial = (error: unknown) => { const message = error instanceof Error ? error.message : "GitHub action failed."; return done.length ? `${done.join(" ")} Then: ${message}` : message; };
    const method = (p: Pr) => chooseMethod(p.snapshot!.repoMerge, this.savedMethod(p.repo));
    try {
      if (kind === "merge") {
        const queue = !!prs[0].snapshot!.repoMerge?.mergeQueue;
        for (const [i, p] of prs.entries()) {
          const s = p.snapshot!;
          if (i > 0 && s.base !== s.trunk) { await gh.retarget(p, s.trunk); done.push(`Retargeted #${p.number} to ${s.trunk}.`); }
          for (let attempt = 0; ; attempt++) {
            try { await gh.merge(p, { method: method(p), head: s.head, mergeQueue: queue }); break; }
            catch (error) {
              // A child just behind its merged parent: GitHub needs a moment before it can merge it.
              if (i === 0 || attempt >= 3 || !(error instanceof GithubWriteError) || error.uncertain) throw error;
              await this.settle(3_000);
            }
          }
          done.push(queue ? `Added #${p.number} to the merge queue.` : `Merged #${p.number}.`);
          if (queue) break; // The queue merges the rest in order once the first lands; GitHub retargets nothing yet.
        }
        return { state: "submitted", result: done.join(" "), merge: queue ? "queued" : "merged" };
      }
      for (const p of prs) {
        await gh.autoMerge(p, kind === "enable_mwr" ? { enable: true, method: method(p), head: p.snapshot!.head, mergeQueue: !!p.snapshot!.repoMerge?.mergeQueue } : { enable: false });
        done.push(`#${p.number}`);
      }
      return { state: "submitted", result: `Auto-merge ${kind === "enable_mwr" ? "on" : "off"} for ${done.join(", ")}.` };
    } catch (error) {
      return { state: error instanceof GithubWriteError && !error.uncertain ? "failed" : "uncertain", result: partial(error) };
    }
  }
  /** How long close waits on actions in flight (a gh or gt call can hang for good); tests shorten it. */
  stopWaitMs = STOP_WAIT_MS;
  async close(within?: Deadline) { this.plans.clear(); this.browser.close(); await settleWithin(Promise.allSettled([...this.running]), within ?? this.stopWaitMs); }
  async check(workspaceId: string, actionId: string) {
    const w = await this.fresh(workspaceId);
    const action = w.prActions.find(a => a.id === actionId);
    if (!action || !["sending", "uncertain"].includes(action.state)) throw new Error("This action does not need checking.");
    if (action.kind === "request_reviewers") {
      const pr = w.prs.find(p => p.key === action.prs[0]);
      const s = pr?.snapshot; const reviewers = s?.reviewers;
      const observed = pr && !pr.error && s?.complete && reviewers?.complete;
      const confirmed = observed && (s.state !== "OPEN" || !!action.reviewers?.length && action.reviewers.every(login => [...reviewers.requested, ...reviewers.reviewed].some(current => current.toLowerCase() === login.toLowerCase())));
      const state = confirmed ? "submitted" as const : observed && this.now() - Date.parse(action.createdAt) >= 30_000 ? "failed" as const : "uncertain" as const;
      const result = state === "submitted" ? "Reviewer request confirmed." : state === "failed" ? "The requested reviewers are not assigned. Click Add reviewers to try again." : "Reviewer status is still uncertain. No request was resent.";
      await this.store.mutate(saved => { const a = findWorkspace(saved, workspaceId).prActions.find(a => a.id === actionId)!; a.state = state; a.result = result; });
      return { state, result };
    }
    const prs = action.prs.map(key => w.prs.find(p => p.key === key));
    if (prs.some(p => !p || p.error || !p.snapshot?.complete)) return { state: "uncertain" as const, result: "PR status is unavailable. Check again after refresh." };
    const open = (prs as Pr[]).filter(p => p.snapshot!.state === "OPEN");
    let confirmed = !open.length && (prs as Pr[]).every(p => p.snapshot!.state === "MERGED");
    let inactive = false;
    const github = (prs as Pr[]).some(p => isGithubFlow(p.snapshot));
    if (open.some(p => action.heads[p.key] !== p.snapshot!.head)) return { state: "uncertain" as const, result: `A PR revision changed. Check its ${github ? "GitHub" : "Graphite"} state before starting another action.` };
    if (github) {
      const closed = (prs as Pr[]).some(p => p.snapshot!.state === "CLOSED");
      if (action.kind === "merge") {
        confirmed ||= open.length > 0 && !closed && open.every(p => !!p.snapshot!.inMergeQueue);
        inactive = closed || open.length > 0 && open.every(p => !p.snapshot!.inMergeQueue && mergeBlockers(p).length === 0);
      } else {
        confirmed ||= !closed && open.length > 0 && open.every(p => p.snapshot!.mergeWhenReady === (action.kind === "enable_mwr" ? "on" : "off"));
        inactive = closed || open.every(p => p.snapshot!.mergeWhenReady === (action.kind === "enable_mwr" ? "off" : "on"));
      }
    } else if (action.kind === "merge") {
      confirmed ||= open.length > 0 && !(prs as Pr[]).some(p => p.snapshot!.state === "CLOSED") && open.every(p => ["QUEUED_TO_MERGE", "WAITING_TO_MERGE", "REBASING", "HANDED_OFF_TO_EXTERNAL_MERGE_QUEUE"].includes(p.snapshot!.graphiteMergeStatus ?? ""));
      inactive = (prs as Pr[]).some(p => p.snapshot!.state === "CLOSED") || open.length > 0 && open.every(p => !!p.snapshot!.graphiteMergeStatus && mergeBlockers(p).length === 0);
    } else if ((prs as Pr[]).some(p => p.snapshot!.state === "CLOSED")) {
      inactive = true;
    } else if (open.length) {
      const rows = await this.read(open);
      confirmed ||= !(prs as Pr[]).some(p => p.snapshot!.state === "CLOSED") && rows.every(p => p.mergeWhenReady === (action.kind === "enable_mwr"));
      inactive = rows.every(p => p.mergeWhenReady !== (action.kind === "enable_mwr"));
    }
    const state = confirmed ? "submitted" as const : inactive && this.now() - Date.parse(action.createdAt) >= 30_000 ? "failed" as const : "uncertain" as const;
    const result = state === "submitted" ? `Current ${github ? "GitHub" : "Graphite/PR"} state confirms the requested action.` : state === "failed" ? "Current state shows the action is not active. A new explicit click is required to try again." : "The result is still uncertain. Check state again; no request was resent.";
    await this.store.mutate(s => { const a = findWorkspace(s, w.id).prActions.find(a => a.id === actionId)!; a.state = state; a.result = result; });
    return { state, result };
  }
}

const names = (list: string[]) => list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0] ?? "";
