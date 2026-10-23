import { randomUUID } from "node:crypto";
import { downstack, mergeBlockers, type ActionPlan, type BrowserPr, type PrActionKind } from "../shared/pr-actions";
import type { Workspace, Pr } from "../shared/model";
import { findWorkspace } from "./engine";
import { Store } from "./store";
import type { Github } from "./github";
import { GraphiteWriteError, type Graphite } from "./graphite";
import { BrowserBridge } from "./browser-bridge";
import { defaultReviewers, noReviewers } from "../shared/reviewers";
import { ReviewRequestError } from "./github";

function active(w: Workspace) {
  if (!w.enable_tracking || w.archived) throw new Error("This workspace is not actively tracked.");
}
function identity(prs: Pr[]) { return JSON.stringify(prs.map(p => [p.key, p.parent, p.snapshot?.head, p.snapshot?.base, p.snapshot?.trunk])); }
function wire(prs: Pr[]) { return prs.map(p => ({ number: p.number, head: p.snapshot!.head, trunk: p.snapshot!.trunk })); }

export class PrActions {
  private plans = new Map<string, { plan: ActionPlan; identity: string }>();
  private reads = new Map<string, Promise<BrowserPr[]>>();
  private running = new Set<Promise<unknown>>();
  constructor(private store: Store, private github: Pick<Github, "observe"> & Partial<Pick<Github, "requestReviewers">>, private graphite: Pick<Graphite, "merge" | "invalidate">, readonly browser: BrowserBridge, private now = Date.now, private reviewersFor = defaultReviewers) {}

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
    const browser = this.browser.status();
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
    if (w.prActions.some(a => ["sending", "uncertain"].includes(a.state))) blockers.push("Check the previous PR action before sending another.");
    if (kind === "merge" && w.prActions.some(a => a.kind === "merge" && a.state === "submitted" && prs.some(p => a.heads[p.key] === p.snapshot?.head) && this.now() - Date.parse(a.createdAt) < 30_000)) blockers.push("A merge was just submitted for this revision. Wait for Graphite's result.");
    const rows = prs.map(p => ({ key: p.key, repo: p.repo, number: p.number, title: p.snapshot?.title ?? p.stack, head: p.snapshot?.head ?? "", parent: p.parent, base: p.snapshot?.base ?? "", trunk: p.snapshot?.trunk ?? "", blockers: kind === "merge" ? mergeBlockers(p) : p.error || !p.snapshot?.complete || p.snapshot.state !== "OPEN" ? ["Refresh an open PR"] : kind === "enable_mwr" && p.snapshot.draft ? ["Draft"] : [] }));
    if (kind === "merge") {
      for (let i = 0; i < prs.length; i++) {
        const s = prs[i].snapshot;
        const expectedBase = i ? prs[i - 1].snapshot?.headBranch : s?.trunk;
        if (!s || !expectedBase || s.base !== expectedBase) rows[i].blockers.push("Refresh the stack's parent relationships");
      }
    } else if (!rows.at(-1)!.blockers.length) {
      const remote = await this.read(prs.slice(-1));
      if (kind === "enable_mwr" && remote[0].merging && !remote[0].mergeWhenReady) rows.at(-1)!.blockers.push("Merge already in progress");
    }
    const plan: ActionPlan = { id: randomUUID(), workspaceId, target: key, kind, expiresAt: new Date(this.now() + 60_000).toISOString(), prs: rows, blockers };
    for (const [id, saved] of this.plans) if (Date.parse(saved.plan.expiresAt) <= this.now()) this.plans.delete(id);
    this.plans.set(plan.id, { plan, identity: identity(prs) });
    return plan;
  }
  confirm(planId: string, scope: "target" | "downstack") {
    const work = this.execute(planId, scope); this.running.add(work);
    void work.finally(() => this.running.delete(work)).catch(() => undefined);
    return work;
  }
  requestReviewers(workspaceId: string, key: string) {
    const work = this.executeReviewers(workspaceId, key); this.running.add(work);
    void work.finally(() => this.running.delete(work)).catch(() => undefined);
    return work;
  }
  private async executeReviewers(workspaceId: string, key: string) {
    const w = await this.fresh(workspaceId);
    const pr = w.prs.find(p => p.key === key);
    if (!pr) throw new Error("This PR is outside the workspace's inventory.");
    if (pr.error || !pr.snapshot?.complete || !pr.snapshot.reviewers?.complete) throw new Error("Reviewer status is unavailable. Refresh before requesting reviews.");
    if (pr.snapshot.state !== "OPEN" || pr.snapshot.draft) throw new Error("Request reviews on an open PR that is ready for review.");
    const defaults = this.reviewersFor(pr.repo);
    if (!defaults.length || !this.github.requestReviewers) throw new Error("Default reviewers are not configured for this repository.");
    if (!noReviewers(pr)) return { state: "submitted" as const, result: "Reviewers already assigned." };
    const reviewers = defaults.filter(r => r.login.toLowerCase() !== pr.snapshot!.reviewers!.author?.toLowerCase());
    if (!reviewers.length) throw new Error("No eligible default reviewers remain after excluding the PR author.");
    const id = randomUUID();
    await this.store.mutate(state => {
      const current = findWorkspace(state, workspaceId); active(current);
      if (current.prActions.some(a => ["sending", "uncertain"].includes(a.state))) throw new Error("Check the previous PR action before sending another.");
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
      if (!observed?.error && assigned?.complete && reviewers.every(r => [...assigned.requested, ...assigned.reviewed].some(login => login.toLowerCase() === r.login.toLowerCase()))) {
        state = "submitted"; result = `Requested ${reviewers.map(r => r.name).join(" and ")}.`;
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
      const remote = await this.read(prs);
      if (plan.kind === "enable_mwr" && remote.some(p => p.merging && !p.mergeWhenReady)) throw new Error("A selected PR is already merging.");
    }
    const id = randomUUID();
    await this.store.mutate(state => {
      const current = findWorkspace(state, w.id); active(current);
      if (current.prActions.some(a => ["sending", "uncertain"].includes(a.state))) throw new Error("A PR action is already in progress or needs checking.");
      if (plan.kind === "merge" && current.prActions.some(a => a.kind === "merge" && a.state === "submitted" && prs.some(p => a.heads[p.key] === p.snapshot?.head) && this.now() - Date.parse(a.createdAt) < 30_000)) throw new Error("A merge was just submitted for this revision. Wait for Graphite's result.");
      if (identity(downstack(current.prs, plan.target)) !== saved.identity) throw new Error("The stack changed before submission.");
      current.prActions.push({ id, kind: plan.kind, prs: prs.map(p => p.key), heads: Object.fromEntries(prs.map(p => [p.key, p.snapshot!.head])), createdAt: new Date(this.now()).toISOString(), state: "sending", result: "Waiting for Graphite to confirm." });
      current.completion = null;
    });
    let state: "submitted" | "failed" | "uncertain" = "submitted";
    let result: string;
    try {
      if (plan.kind === "merge") {
        await this.graphite.merge(prs[0].repo, prs.map(p => p.number), prs[0].snapshot!.trunk);
        result = `Merge submitted to Graphite for ${prs.length} PR${prs.length === 1 ? "" : "s"}. Waiting for the merge result.`;
      } else {
        const reply = await this.browser.request(plan.kind, prs[0].repo, wire(prs));
        state = reply.outcome === "completed" ? "submitted" : reply.outcome;
        const changed = reply.applied.map(n => `#${n}`).join(", ");
        result = reply.outcome === "completed" ? `Merge when ready ${plan.kind === "enable_mwr" ? "enabled" : "disabled"} for ${changed}.` : `${changed ? `Changed ${changed}. ` : ""}${reply.error || "Graphite could not confirm every selected PR."}`;
      }
    } catch (error) {
      state = error instanceof GraphiteWriteError && error.uncertain ? "uncertain" : "failed";
      result = error instanceof Error ? error.message : "Graphite action failed.";
    }
    await this.store.mutate(s => { const action = findWorkspace(s, w.id).prActions.find(a => a.id === id)!; action.state = state; action.result = result; });
    this.graphite.invalidate();
    return { state, result };
  }
  async close() { this.plans.clear(); this.browser.close(); await Promise.allSettled([...this.running]); }
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
    if (open.some(p => action.heads[p.key] !== p.snapshot!.head)) return { state: "uncertain" as const, result: "A PR revision changed. Check its Graphite state before starting another action." };
    if (action.kind === "merge") {
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
    const result = state === "submitted" ? "Current Graphite/PR state confirms the requested action." : state === "failed" ? "Current state shows the action is not active. A new explicit click is required to try again." : "The result is still uncertain. Check state again; no request was resent.";
    await this.store.mutate(s => { const a = findWorkspace(s, w.id).prActions.find(a => a.id === actionId)!; a.state = state; a.result = result; });
    return { state, result };
  }
}
