import type { Batch, Obligation, Task, Workspace } from "./model";
import { completionCheck } from "./model";
import { recoveryBatch } from "./follow-up";
import { sendDecision } from "./send-decision";

/**
 * Repairs are tasks (Q49). A PR condition Follow-up found (a conflict, review feedback, a failing required check, a
 * restack) is a row in the workspace's Tasks next to the developer's and agents' own tasks, and each row shows one
 * delivery state. Nothing is stored per repair: rows come from the queued and sent messages (batches), the tasks
 * reconcile held back (Workspace.heldTasks) and the settled messages for Done. The batch is the delivery record and
 * never shows as a concept.
 *
 * Say it once: the strip at the top of Tasks carries when and why (sendDecision); a row in the message says only
 * "Queued" or "Sent", and adds words only where it differs from the strip (status invariant message-rows-say-it-once).
 */

export const REPAIR_KINDS: readonly Task["kind"][] = ["conflict", "review", "checks", "restack"];
export const isRepair = (t: Pick<Task, "kind">) => REPAIR_KINDS.includes(t.kind);

export type RepairState = "queued" | "sent" | "capped" | "manual" | "done";
export type RepairRow = {
  task: Task;
  state: RepairState;
  /** The row's line: "Queued", "Sent", "Needs you · …", "Auto off · stays with you", "Done · …". */
  text: string;
  /** When it finished (ISO), for a done row. */
  at?: string | null;
  /** "#142": the PR it is about, for its chip. */
  pr: string;
};

/** The one line at the top of Tasks while a message is queued or out. */
export type MessageStrip = {
  phase: "queued" | "sent";
  /** The recipient as the developer knows it: the main agent's Paseo title, else "the main agent". */
  to: string;
  recipientId: string;
  count: number;
  /** Queued: the send decision's reason (what it waits for, and why). Sent: what Follow-up waits for. */
  reason: string;
  /** Queued: when it goes out on its own (ISO), if known. Sent: when it went out. */
  at: string | null;
  /** Send now is offered: the server would take the developer's Send, and the send doesn't wait on them (then Send lives in Needs you only). */
  sendNow: boolean;
  batchId: string;
};

/** The strip's reason when the send waits on the developer: Needs you already says why and holds the Send. */
export const WAITS_ON_YOU = "waits for your Send in Needs you";
/** A task's title as a row shows it: the agent's instruction up to its first colon, without the PR it names (the chip carries it). */
export const shortTitle = (t: Pick<Task, "title">) => t.title.split(": ")[0].replace(/ (on|for) [\w.-]+\/[\w.-]+#\d+/, "").replace(/[\w.-]+\/[\w.-]+#(\d+)/g, "#$1");
const agent = (w: Pick<Workspace, "mainAgentTitle">) => w.mainAgentTitle?.trim() || "the main agent";
const prOf = (t: Pick<Task, "target">) => `#${t.target.split("#")[1] ?? t.target}`;
/** The message batches tasks ride in: never recovery, never the Done check (it isn't a task; it stays "Ready to finish"). */
const message = (b: Batch) => !recoveryBatch(b) && !completionCheck(b);
export const pendingMessage = (w: Workspace) => w.batches.find(b => b.state === "pending" && message(b));
export const sentMessage = (w: Workspace) => w.batches.find(b => ["sending", "sent"].includes(b.state) && message(b));

export function messageStrip(w: Workspace, now: number): MessageStrip | null {
  const sent = sentMessage(w);
  if (sent) return { phase: "sent", to: agent(w), recipientId: sent.recipientAgentId ?? w.mainAgentId, count: sent.tasks.length, reason: "waiting for it to report back", at: sent.sentAt, sendNow: false, batchId: sent.id };
  const pending = pendingMessage(w);
  if (!pending) return null;
  const d = sendDecision(w, now, { batch: pending });
  // Say it once: when the send waits on the developer, Needs you carries the reason and the Send.
  return { phase: "queued", to: agent(w), recipientId: w.mainAgentId, count: pending.tasks.length, reason: d.waitingOn === "you" ? WAITS_ON_YOU : d.reason, at: d.eta, sendNow: d.canSendNow && d.waitingOn !== "you", batchId: pending.id };
}

/** Where an agent's or the developer's own task stands in the message, if it rides one (Auto tasks). */
export function obligationDelivery(w: Workspace, o: Pick<Obligation, "id">): "queued" | "sent" | null {
  const carries = (b: Batch | undefined) => !!b?.tasks.some(t => t.kind === "obligation" && t.target === o.id);
  return carries(sentMessage(w)) ? "sent" : carries(pendingMessage(w)) ? "queued" : null;
}

/**
 * Open repair rows (queued, sent, capped, manual) then done ones. A repair GitHub cleared before it ever went out
 * vanishes: Done only means a task that was sent, so flapping checks never flood Done.
 */
export function repairRows(w: Workspace, doneLimit = 20): { open: RepairRow[]; done: RepairRow[] } {
  const open: RepairRow[] = [];
  const seen = new Set<string>();
  const add = (task: Task, state: RepairState, text: string) => { if (!isRepair(task) || seen.has(task.key)) return; seen.add(task.key); open.push({ task, state, text, pr: prOf(task) }); };
  for (const t of sentMessage(w)?.tasks ?? []) add(t, "sent", "Sent");
  for (const t of pendingMessage(w)?.tasks ?? []) add(t, "queued", "Queued");
  for (const h of w.heldTasks ?? []) add(h.task, h.held, h.held === "capped" ? "Needs you · sent twice, no change on GitHub" : "Auto off · stays with you");
  const done: RepairRow[] = [];
  // Newest settled message first; a task key still open (another fingerprint) isn't done.
  const settled = w.batches.filter(b => b.state === "completed" && b.sentAt && message(b)).sort((a, b) => Date.parse(b.settledAt ?? b.sentAt!) - Date.parse(a.settledAt ?? a.sentAt!));
  for (const b of settled) for (const t of b.tasks) {
    if (!isRepair(t) || seen.has(t.key) || done.length >= doneLimit) continue;
    seen.add(t.key);
    done.push({ task: t, state: "done", text: b.unacknowledged ? "Done · resolved on GitHub" : `Done · ${agent(w)} finished it`, at: b.settledAt, pr: prOf(t) });
  }
  return { open, done };
}

/** The next message for workspace_status (agent parity with Preview): who it goes to, its tasks, exact text, and when and why. */
export function nextMessageInfo(w: Workspace, now: number): { to: string; tasks: string[]; text: string; reason: string; eta: string | null } | null {
  const pending = pendingMessage(w);
  if (!pending) return null;
  const d = sendDecision(w, now, { batch: pending });
  return { to: agent(w), tasks: pending.tasks.map(t => t.title), text: w.nextMessage ?? pending.tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n"), reason: d.reason, eta: d.eta };
}

