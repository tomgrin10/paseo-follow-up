import { sendItems } from "./send-words";
import { newestId } from "./sort";
import type { ListWorkspace as Workspace } from "./list";
import { followUpObligations, recoveryBatch } from "./follow-up";
import { shortRefs } from "./attention";
import { isGithubFlow, prRefs } from "./pr-actions";
import { answerLabel, answerStatus, closedLine } from "./questions";

export type ActivityTone = "merged" | "success" | "warning" | "danger" | "muted";
export type Activity = { key: string; at: string; icon: string; tone: ActivityTone; text: string; detail: string | null; took: string | null };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** "12m", "1h 05m", "3d": how long something took, for the activity log. */
export function duration(from: string | null | undefined, to: string | null | undefined): string | null {
  const ms = Date.parse(to ?? "") - Date.parse(from ?? "");
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The Activity card's Questions tab, and its count: the decisions asked here. An action ("tell me when you've done it")
 * is not a question to the developer, so it lists, and counts, only in the Timeline ("Action · title").
 */
export const activityQuestions = <Q extends { need?: string }>(questions: readonly Q[]): Q[] => questions.filter(q => q.need !== "action");

/**
 * What happened in this workspace, newest first, from what Follow-up already stores: repairs sent
 * and finished (with how long they took), PR merges, merge and reviewer actions, questions, finished tasks and Done.
 */
export function activity(w: Workspace): Activity[] {
  const rows: Activity[] = [];
  for (const b of w.batches) {
    if (recoveryBatch(b)) {
      if (b.sentAt) rows.push({ key: `recovery:${b.id}`, at: b.settledAt ?? b.sentAt, icon: "History", tone: b.state === "completed" ? "success" : b.state === "sent" ? "muted" : "warning", text: b.state === "completed" ? "Recovery finished" : b.state === "sent" ? "Recovery started" : "Recovery needs a check", detail: b.result || null, took: b.settledAt ? duration(b.sentAt, b.settledAt) : null });
      continue;
    }
    if (!b.sentAt) continue;
    const n = sendItems(b.tasks);
    rows.push({ key: `sent:${b.id}`, at: b.sentAt, icon: "Send", tone: "muted", text: `Sent ${n} to the main agent`, detail: b.tasks.map(t => shortRefs(t.title, w)).join(" · "), took: null });
    // A human-only outcome (Batch.humanOnly) isn't finished work: it waits on a person.
    if (b.settledAt && b.state === "completed" && b.humanOnly) rows.push({ key: `done:${b.id}`, at: b.settledAt, icon: "UserRound", tone: "warning", text: `${n} ${b.tasks.length === 1 ? "waits" : "wait"} on a person, not the agent`, detail: b.result || null, took: duration(b.sentAt, b.settledAt) });
    // The agent is already on it (Batch.inProgress): progress, not a finish and not a failure, so no "took".
    else if (b.settledAt && b.state === "completed" && b.inProgress) rows.push({ key: `done:${b.id}`, at: b.settledAt, icon: "Hourglass", tone: "muted", text: `Main agent is already on ${n}`, detail: b.result || null, took: null });
    // Moved on since it went out (Batch.movedOn): updated, sent again, or no longer needed. Never a failure on screen.
    // The detail is the agent's own words; Follow-up's own reason would only repeat the title (gone keeps it: it names
    // what ended, "#270 merged").
    else if (b.movedOn) rows.push({ key: `stopped:${b.id}`, at: b.settledAt ?? b.movedOn.at, icon: b.movedOn.why === "gone" ? "CircleSlash" : "RefreshCw", tone: "muted", text: b.movedOn.why === "changed" ? `${changedOnGithub(b, w)} · ${sentAgain(b, w) ? "sent again with what's new" : "the next message says what's new"}` : b.movedOn.why === "gone" ? `${n} no longer needed` : `${n} sent again`, detail: b.result && (b.movedOn.why === "gone" || b.result !== b.movedOn.reason) ? b.result : null, took: b.settledAt ? duration(b.sentAt, b.settledAt) : null });
    else if (b.settledAt && b.state === "completed") rows.push({ key: `done:${b.id}`, at: b.settledAt, icon: "Wrench", tone: "success", text: `Main agent finished ${n}`, detail: b.result || null, took: duration(b.sentAt, b.settledAt) });
    else if (b.settledAt && ["blocked", "cancelled"].includes(b.state)) rows.push({ key: `stopped:${b.id}`, at: b.settledAt, icon: "OctagonAlert", tone: b.state === "blocked" ? "danger" : "muted", text: b.state === "blocked" ? `${n} didn't finish` : `${n} cancelled`, detail: b.result || null, took: duration(b.sentAt, b.settledAt) });
  }
  for (const p of w.prs) if (p.snapshot?.state === "MERGED" && p.snapshot.mergedAt)
    rows.push({ key: `merged:${p.key}`, at: p.snapshot.mergedAt, icon: "GitMerge", tone: "merged", text: `#${p.number} merged`, detail: p.snapshot.title, took: null });
  for (const a of w.prActions) {
    // Say a merge once: when every PR it merged has its own "#N merged" row, the action's "Merged …" row would repeat it.
    if (a.kind === "merge" && a.merge === "merged" && a.prs.every(key => { const s = w.prs.find(p => p.key === key)?.snapshot; return s?.state === "MERGED" && !!s.mergedAt; })) continue;
    const numbers = prRefs(a.prs.map(key => key.split("#")[1]));
    const toggle = isGithubFlow(w.prs.find(p => p.key === a.prs[0])?.snapshot) ? "Auto-merge" : "Merge when ready";
    // The same outcome the button and toast said (mergeWords): Merged only when GitHub merged.
    const what = a.kind === "merge" ? a.merge === "merged" ? `Merged ${numbers}` : a.merge === "queued" ? `Queued ${numbers.split(", ")[0]} to merge` : `Merge requested for ${numbers}` : a.kind === "request_reviewers" ? `Reviewers requested on ${numbers}` : a.kind === "enable_mwr" ? `${toggle} on for ${numbers}` : `${toggle} off for ${numbers}`;
    rows.push({ key: `action:${a.id}`, at: a.createdAt, icon: a.kind === "request_reviewers" ? "UserPlus" : "GitMerge", tone: a.state === "failed" ? "danger" : a.state === "uncertain" ? "warning" : "muted", text: what, detail: a.state === "submitted" ? null : a.result || null, took: null });
  }
  for (const q of w.questions ?? []) {
    // An action card ("tell me when you've done it") never shows a question id, so its rows don't either.
    const ref = q.need === "action" ? `Action · ${q.title}` : `${q.id} · ${q.title}`;
    rows.push({ key: `asked:${q.id}`, at: q.askedAt, icon: q.need === "action" ? "Hand" : "MessageCircleQuestion", tone: "warning", text: ref, detail: q.need === "action" ? "Requested" : "Asked", took: null });
    if (q.answer) {
      // "Answered" only once it reached the agent; until then the shared state ("Copied · not sent yet"…), answerStatus.
      const s = answerStatus(q)!;
      const said = !s.delivered ? s.label : q.answer.by === "agent" ? "Answered in chat" : "Answered";
      rows.push({ key: `answered:${q.id}`, at: q.answer.at, icon: "MessageCircleReply", tone: s.delivered ? "success" : "muted", text: ref, detail: `${said}: ${answerLabel(q, q.answer.choice, q.answer.words)}`, took: duration(q.askedAt, q.answer.at) });
    }
    if (q.closed) rows.push({ key: `withdrawn:${q.id}`, at: q.closed.at, icon: "MessageCircleOff", tone: "muted", text: ref, detail: closedLine(q), took: null });
  }
  // Finished tasks live here, not in Tasks (the Tasks card's footer points here): when, and the agent's evidence.
  for (const o of followUpObligations(w)) if ((o.status === "done" || o.status === "waived") && o.finishedAt)
    rows.push({ key: `task:${o.id}`, at: o.finishedAt, icon: o.status === "done" ? "ListChecks" : "CircleSlash", tone: o.status === "done" ? "success" : "muted", text: `${o.status === "done" ? "Task done" : "Task waived"} · ${o.title}`, detail: o.evidence?.trim() || null, took: null });
  if (w.completion) rows.push({ key: "done", at: w.completion.declaredAt, icon: "CircleCheck", tone: "success", text: "Main agent declared Done", detail: null, took: null });
  return rows.filter(r => Number.isFinite(Date.parse(r.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || newestId(a.key, b.key));
}

/** Whether a later message carried one of this batch's items: its "the next message says" has come true. */
function sentAgain(b: { id: string; tasks: readonly { key: string }[] }, w: Pick<Workspace, "batches">): boolean {
  const keys = new Set(b.tasks.map(t => t.key));
  const i = w.batches.findIndex(x => x.id === b.id);
  return w.batches.slice(i + 1).some(x => !!x.sentAt && x.tasks.some(t => keys.has(t.key)));
}

/**
 * Who changed: GitHub, never Follow-up. "#270 changed on GitHub", or "#270 and #271 changed on GitHub"; without a PR
 * Follow-up tracks, "What was sent changed on GitHub". 2026-11-23 critique: "1 repair updated on GitHub" read as if
 * Follow-up had changed GitHub.
 */
export function changedOnGithub(b: { tasks: readonly { target: string }[] }, w: Pick<Workspace, "prs">): string {
  const numbers = [...new Set(b.tasks.flatMap(t => { const pr = w.prs.find(p => p.key === t.target); return pr ? [`#${pr.number}`] : []; }))];
  if (!numbers.length) return "What was sent changed on GitHub";
  const list = numbers.length === 1 ? numbers[0] : numbers.length === 2 ? `${numbers[0]} and ${numbers[1]}` : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
  return `${list} changed on GitHub`;
}
