import { z } from "zod";
import { BATCH_PREFIXES, RECOVERY_TITLES } from "./legacy";
import { imageRefSchema, MAX_IMAGES } from "./images";

/**
 * The message queue (server/message-queue.ts): every message Follow-up sends to an agent is saved here before anything
 * talks to Paseo, and reaches its agent exactly once (a-message-is-saved-before-sent-and-arrives-once).
 *
 * Paseo does not refuse a resend under the same messageId: it only skips the second timeline row, and the provider still
 * runs the prompt (agent-manager recordSubmittedPrompt). So a send that left without a confirmation is never resent
 * blind: the agent's chat is read for it first.
 */
export const QUEUE_KINDS = ["answer", "brief", "repair", "recovery", "message", "checks", "scheduled"] as const;
export type QueueKind = typeof QUEUE_KINDS[number];

/**
 * - queued: waiting to go out (fresh, or a send that never left: Paseo unreachable, no agent, a permission prompt).
 * - sending: the send is out and Paseo hasn't answered yet.
 * - uncertain: a send left (or may have) without a confirmation; the chat is read before anything is resent.
 * - failed: only when the target can't take messages (its conversation is gone, `gone` names it); Retry resends.
 *   An unknown arrival is never failed: it keeps checking (a-queued-message-never-stops-short).
 * - sent, cancelled: settled; kept only in the file's short tail.
 */
export const QUEUE_STATES = ["queued", "sending", "uncertain", "failed", "sent", "cancelled"] as const;
export type QueueState = typeof QUEUE_STATES[number];

/**
 * Paseo 0.17.2+ (#10483): `sendMessage` returns an AgentMessageReceipt. `deliveryStatus: "queued"` means Paseo took the
 * message but holds it until the agent's running turn ends; `activeTurnBehavior` is what Paseo did with a running
 * turn (Follow-up asks to steer; a provider that can't fell back, e.g. to interrupt); `guidance` is Paseo's note.
 * Older hosts return nothing, and nothing changes there.
 */
export const deliveryReceiptSchema = z.object({
  deliveryStatus: z.string().max(40).optional(),
  activeTurnBehavior: z.string().max(40).optional(),
  guidance: z.string().max(400).optional(),
});
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;
/** The receipt a send returned, kept only when it says something (a 0.17.1 send returns undefined or {}). */
export function deliveryReceipt(value: unknown): DeliveryReceipt | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown, n: number) => typeof x === "string" && x ? x.slice(0, n) : undefined;
  const r: DeliveryReceipt = { deliveryStatus: str(v.deliveryStatus, 40), activeTurnBehavior: str(v.activeTurnBehavior, 40), guidance: str(v.guidance, 400) };
  for (const k of Object.keys(r) as (keyof DeliveryReceipt)[]) if (r[k] === undefined) delete r[k];
  return Object.keys(r).length ? r : null;
}

export const queueItemSchema = z.object({
  /** Stable per message: the same answer is always the same item (answer:<ws>:<Qn>:<messageId>, brief:<agent>:<answerId>). */
  id: z.string().min(1).max(400),
  kind: z.enum(QUEUE_KINDS),
  /** The partition the sender drains together: the agent's workspace (or agent:<id> when it has none). */
  key: z.string().min(1).max(200),
  /** What the item is about, for its channel: { workspaceId, questionId } or { agentId, briefId, answerId }. */
  ref: z.record(z.string(), z.string()),
  /** The message's own id: the envelope's messageId when it goes out alone. */
  messageId: z.string().min(1).max(100),
  text: z.string().max(40_000),
  /** Pasted images (server/image-store.ts): refs only, never the bytes. They go with this part's envelope. */
  images: z.array(imageRefSchema).max(MAX_IMAGES).default([]),
  /** Ledger sender for this part: "developer" or "agent:<id>"; absent is Follow-up's own. */
  by: z.string().max(100).optional(),
  priority: z.enum(["now", "idle"]).default("now"),
  state: z.enum(QUEUE_STATES),
  /** Tries that never left (unreachable, no agent): they never end in failed. */
  attempts: z.number().int().min(0).default(0),
  /** Unconfirmed sends and arrival checks that couldn't tell: the ambiguous ladder's step (AMBIGUOUS_MS). */
  unknowns: z.number().int().min(0).default(0),
  /** When it is due again. Null: fresh, it goes out after the quiet window. */
  nextAt: z.string().nullable().default(null),
  /** Why it waits, failed or was cancelled, in a few plain words. */
  reason: z.string().max(400).nullable().default(null),
  /** Every messageId an envelope carrying this item went out under: the arrival check looks for each. */
  sentIds: z.array(z.string()).max(50).default([]),
  /** Bumped when Paseo refuses the messageId for good (idRefused): the next send, after the chat shows it missing, goes under a fresh id derived from it. */
  generation: z.number().int().min(0).default(0),
  /** The last send that left or may have: the arrival check reads the chat for this messageId. */
  envelope: z.object({ messageId: z.string(), to: z.string().nullable(), at: z.string() }).nullable().default(null),
  /** The agent whose provider conversation is gone (a send's ConversationGone), so its channel can say so. */
  gone: z.string().nullable().default(null),
  /** Who got it, once sent. */
  to: z.string().nullable().default(null),
  /** Paseo 0.17.2+: what Paseo did with the send (deliveryReceipt). Null on older hosts, or before it was sent. */
  receipt: deliveryReceiptSchema.nullable().default(null),
  createdAt: z.string(),
  settledAt: z.string().nullable().default(null),
});
export type QueueItem = z.infer<typeof queueItemSchema>;
export type QueueItemInput = z.input<typeof queueItemSchema>;
/** A new message: createdAt defaults to now. */
export type NewQueueItem = Omit<QueueItemInput, "createdAt"> & { createdAt?: string };

export const queueFileSchema = z.object({
  version: z.literal(1),
  items: z.array(queueItemSchema).default([]),
  /** The newest settled items (text dropped), for follow_queue_list. */
  recent: z.array(queueItemSchema).default([]),
  /** One-time moves into the queue (answers from state.json, the old outbox in inbox.json). */
  migrations: z.array(z.string()).default([]),
});
export type QueueFile = z.infer<typeof queueFileSchema>;

/**
 * One message can carry several parts for the same agent (an answer and the repairs that ride along): each part keeps its
 * own header line (Follow-up answer …, Follow-up batch …) and contract, separated by a line holding only `---`.
 */
export const ENVELOPE_SEPARATOR = "\n\n---\n\n";
/** The headers a part starts with, any version's spelling (shared/legacy.ts keeps 1.x's). */
export const PART_HEADERS: readonly string[] = ["Follow-up answer ", ...BATCH_PREFIXES.map(p => `${p} `), ...RECOVERY_TITLES.map(t => `${t} `), "From the developer via Overseer:"];
export const envelopeText = (parts: readonly string[]) => parts.join(ENVELOPE_SEPARATOR);
/** A message's parts: split only where `---` is followed by a part header, so a part's own `---` stays in it. */
export function envelopeParts(text: string): string[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`\\n\\n---\\n\\n(?=${PART_HEADERS.map(escape).join("|")})`));
}

/** Settled items kept for the read; everything older is dropped, so queue.json stays a few KB. */
export const QUEUE_RECENT = 20;
/** The quiet window: an envelope goes out once its workspace has been quiet this long… */
export const QUEUE_QUIET_MS = 2_000;
/** …but never later than this after its first item, so a stream of clicks can't starve it. */
export const QUEUE_CAP_MS = 8_000;
/** A send that never left retries on this ladder, its last step forever: it never ends in failed. */
export const NEVER_LEFT_MS = [15_000, 60_000, 300_000] as const;
/**
 * A send that left unconfirmed: the chat is read after each step, and the last step repeats until the chat can tell
 * (found: sent; not there: resent). It never ends in failed: an unknown isn't a no (a-queued-message-never-stops-short).
 */
export const AMBIGUOUS_MS = [15_000, 60_000, 300_000, 900_000] as const;
/** One attempt's cap: past it the send counts as left but unconfirmed. */
export const QUEUE_ATTEMPT_MS = 120_000;

/**
 * A send that never left because Paseo was unreachable waits for Paseo instead of the ladder: one connect-only probe
 * (no agent read, nothing that could wake one) every PROBE_MS while any item waits so, every PROBE_SLOW_MS once the
 * outage has lasted PROBE_BACKOFF_AFTER_MS, and none when nothing waits. A probe that connects, or any connection the
 * worker opens, sends them at once: they go out within about 15 s of Paseo coming back.
 */
export const PASEO_UNREACHABLE = "Paseo unreachable";
export const PROBE_MS = 15_000;
export const PROBE_SLOW_MS = 60_000;
export const PROBE_BACKOFF_AFTER_MS = 10 * 60_000;

export const ambiguousDelay = (unknowns: number) => AMBIGUOUS_MS[Math.min(Math.max(unknowns, 0), AMBIGUOUS_MS.length - 1)];
export const neverLeftDelay = (attempts: number) => NEVER_LEFT_MS[Math.min(Math.max(attempts, 1), NEVER_LEFT_MS.length) - 1];

/**
 * One delivery vocabulary for every card (question dialog, chat brief card, Needs you): Queued, Sending, Sent,
 * Retrying (with when) and Failed with Retry. Records keep this shape as their mirror of the queue item.
 */
export const DELIVERY_STATES = ["queued", "sending", "sent", "retrying", "failed", "cancelled"] as const;
export type DeliveryState = typeof DELIVERY_STATES[number];

/** The record's mirror of a queue item: a fresh item reads Sending (it goes out within seconds). */
export function deliveryOf(item: Pick<QueueItem, "state" | "nextAt" | "reason">): DeliveryState {
  switch (item.state) {
    case "queued": return item.nextAt === null && !item.reason ? "sending" : "queued";
    case "sending": return "sending";
    case "uncertain": return "retrying";
    case "failed": return "failed";
    case "sent": return "sent";
    case "cancelled": return "cancelled";
  }
}

export type DeliveryView = { state: DeliveryState; reason?: string | null; nextAt?: string | null; receipt?: DeliveryReceipt | null };
export type DeliveryStatus = {
  /** A card corner's short word. */
  label: string;
  /** The sentence under the answer. */
  detail: string;
  /** Failed is amber (the developer's to check: DESIGN.md), never red; Retrying is muted (Follow-up's own work). */
  tone: "muted" | "spinner" | "success" | "warning" | "danger";
  /** The button the card offers: Retry (failed) or Try now (waiting on a timer). */
  action: "retry" | "try-now" | null;
  /** Still the queue's to deliver (not sent, failed or cancelled). */
  pending: boolean;
};
const hhmm = (iso: string) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""; };

/** The one reason a queued message ends Failed: its target can't take messages (a-queued-message-never-stops-short). */
export const GONE_REASON = "The agent's conversation is gone, so it can't take messages.";
/** What a Paseo 0.17.2+ receipt adds to "Sent", one sentence, on every surface (null: nothing to add). */
export function receiptNote(receipt: DeliveryReceipt | null | undefined): string | null {
  if (receipt?.deliveryStatus === "queued") return "Paseo holds it until the agent's current turn ends.";
  if (receipt?.activeTurnBehavior === "interrupt") return "The agent's turn was stopped so it could read it.";
  return null;
}
export const RETRYING_DETAIL = "Not confirmed yet. Follow-up reads the agent's chat before sending again, so it never arrives twice.";
export const FAILED_DETAIL = "Follow-up couldn't confirm the agent got it. Check the agent's chat, then Retry.";

export function deliveryStatus(d: DeliveryView, clock: (iso: string) => string = hhmm): DeliveryStatus {
  const at = d.nextAt ? clock(d.nextAt) : "";
  switch (d.state) {
    case "sending": return { label: "Sending…", detail: "Sending to the agent…", tone: "spinner", action: null, pending: true };
    case "queued": return { label: "Queued", detail: `Queued${d.reason ? `: ${d.reason}` : ""}.${at ? ` Next try at ${at}.` : ""}`, tone: "muted", action: d.nextAt ? "try-now" : null, pending: true };
    case "retrying": return { label: at ? `Next try at ${at}` : "Retrying", detail: at ? `Next try at ${at}. ${RETRYING_DETAIL}` : RETRYING_DETAIL, tone: "muted", action: "try-now", pending: true };
    case "failed": return { label: "Failed", detail: d.reason ? `${d.reason} Check the agent's chat, then Retry.` : FAILED_DETAIL, tone: "warning", action: "retry", pending: false };
    case "cancelled": return { label: "Not sent", detail: d.reason ?? "Follow-up didn't send it.", tone: "muted", action: null, pending: false };
    // Paseo 0.17.2+ says what it did: held until the agent's turn ends, or a turn stopped to take it.
    case "sent":
      if (d.receipt?.deliveryStatus === "queued") return { label: "Queued", detail: `Sent. ${receiptNote(d.receipt)}`, tone: "muted", action: null, pending: false };
      return { label: "Sent", detail: ["Sent to the agent.", receiptNote(d.receipt)].filter(Boolean).join(" "), tone: "success", action: null, pending: false };
  }
}

/**
 * a-queued-message-never-stops-short: an item still in the queue is either due again (queued or uncertain with a next
 * try, or fresh and inside its quiet window), going out (sending), or Failed because its target is gone, with the
 * reason. Null when that holds; otherwise what is wrong. Settled items (sent, cancelled) always hold.
 */
export function queueItemStop(item: Pick<QueueItem, "state" | "nextAt" | "reason" | "gone" | "envelope">): string | null {
  switch (item.state) {
    case "sent": case "cancelled": case "sending": return null;
    case "failed": return item.gone && item.reason ? null : item.gone ? "failed without saying why" : "failed with no next try, though its target isn't gone";
    case "uncertain": return item.nextAt ? null : "uncertain with no next check";
    case "queued": return item.nextAt || (!item.reason && !item.envelope) ? null : "queued with no next try";
  }
}

/** A message Follow-up couldn't deliver that has no card of its own (an Overseer forward, a report) raises Needs you after this long queued, or at once when Failed. */
export const MESSAGE_STUCK_MS = 10 * 60_000;
/** An item as follow.queue-list and follow_queue_list show it: no message text, only its first line. */
export const queueViewSchema = z.object({
  id: z.string(), kind: z.enum(QUEUE_KINDS), workspaceId: z.string().nullable(), agentId: z.string().nullable(),
  state: z.enum(DELIVERY_STATES), reason: z.string().nullable(), nextAt: z.string().nullable(), to: z.string().nullable(),
  createdAt: z.string(), settledAt: z.string().nullable(), preview: z.string(),
  /** Paseo 0.17.2+: what Paseo did with the send (null on older hosts). */
  receipt: deliveryReceiptSchema.nullable().default(null),
});
export type QueueView = z.infer<typeof queueViewSchema>;
export function queueView(item: QueueItem): QueueView {
  return { id: item.id, kind: item.kind, workspaceId: item.ref.workspaceId ?? (item.key.startsWith("agent:") ? null : item.key), agentId: item.to ?? item.envelope?.to ?? item.ref.agentId ?? null,
    state: deliveryOf(item), reason: item.reason, nextAt: item.nextAt, to: item.to, createdAt: item.createdAt, settledAt: item.settledAt, preview: item.text.split("\n")[0]!.slice(0, 160), receipt: item.receipt ?? null };
}
