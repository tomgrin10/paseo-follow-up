import type { Workspace } from "./model";
import { recoveryBatch } from "./follow-up";
import { shortRefs } from "./attention";

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
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * What happened in this workspace, newest first, from what Follow-up already stores: repairs sent
 * and finished (with how long they took), PR merges, merge and reviewer actions, questions and Done.
 */
export function activity(w: Workspace): Activity[] {
  const rows: Activity[] = [];
  for (const b of w.batches) {
    if (recoveryBatch(b)) {
      if (b.sentAt) rows.push({ key: `recovery:${b.id}`, at: b.settledAt ?? b.sentAt, icon: "History", tone: b.state === "completed" ? "success" : b.state === "sent" ? "muted" : "warning", text: b.state === "completed" ? "Recovery finished" : b.state === "sent" ? "Recovery started" : "Recovery needs a check", detail: b.result || null, took: b.settledAt ? duration(b.sentAt, b.settledAt) : null });
      continue;
    }
    if (!b.sentAt) continue;
    const n = plural(b.tasks.length, "repair");
    rows.push({ key: `sent:${b.id}`, at: b.sentAt, icon: "Send", tone: "muted", text: `Sent ${n} to the main agent`, detail: b.tasks.map(t => shortRefs(t.title, w)).join(" · "), took: null });
    if (b.settledAt && b.state === "completed") rows.push({ key: `done:${b.id}`, at: b.settledAt, icon: "Wrench", tone: "success", text: `Main agent finished ${n}`, detail: b.result || null, took: duration(b.sentAt, b.settledAt) });
    else if (b.settledAt && ["blocked", "cancelled"].includes(b.state)) rows.push({ key: `stopped:${b.id}`, at: b.settledAt, icon: "OctagonAlert", tone: b.state === "blocked" ? "danger" : "muted", text: b.state === "blocked" ? `${n} didn't finish` : `${n} cancelled`, detail: b.result || null, took: duration(b.sentAt, b.settledAt) });
  }
  for (const p of w.prs) if (p.snapshot?.state === "MERGED" && p.snapshot.mergedAt)
    rows.push({ key: `merged:${p.key}`, at: p.snapshot.mergedAt, icon: "GitMerge", tone: "merged", text: `#${p.number} merged`, detail: p.snapshot.title, took: null });
  for (const a of w.prActions) {
    const numbers = a.prs.map(key => `#${key.split("#")[1]}`).join(", ");
    const what = a.kind === "merge" ? `Merge requested for ${numbers}` : a.kind === "request_reviewers" ? `Reviewers requested on ${numbers}` : a.kind === "enable_mwr" ? `Merge when ready on for ${numbers}` : `Merge when ready off for ${numbers}`;
    rows.push({ key: `action:${a.id}`, at: a.createdAt, icon: a.kind === "request_reviewers" ? "UserPlus" : "GitMerge", tone: a.state === "failed" ? "danger" : a.state === "uncertain" ? "warning" : "muted", text: what, detail: a.state === "submitted" ? null : a.result || null, took: null });
  }
  for (const q of w.questions ?? []) {
    rows.push({ key: `asked:${q.id}`, at: q.askedAt, icon: "MessageCircleQuestion", tone: "warning", text: `${q.id} asked: ${q.title}`, detail: null, took: null });
    if (q.answer) rows.push({ key: `answered:${q.id}`, at: q.answer.at, icon: "MessageCircleReply", tone: "success", text: `${q.id} answered: ${q.answer.choice}${q.options.find(o => o.letter === q.answer!.choice) ? ` · ${q.options.find(o => o.letter === q.answer!.choice)!.label}` : ""}`, detail: q.answer.by === "agent" ? "Answered in chat" : null, took: duration(q.askedAt, q.answer.at) });
    if (q.closed) rows.push({ key: `withdrawn:${q.id}`, at: q.closed.at, icon: "MessageCircleOff", tone: "muted", text: `${q.id} withdrawn`, detail: q.closed.reason, took: null });
  }
  if (w.completion) rows.push({ key: "done", at: w.completion.declaredAt, icon: "CircleCheck", tone: "success", text: "Main agent declared Done", detail: null, took: null });
  return rows.filter(r => Number.isFinite(Date.parse(r.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key));
}
