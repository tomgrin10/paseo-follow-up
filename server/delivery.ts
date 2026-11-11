import { createHash } from "node:crypto";
export class DeliveryDeferred extends Error {}

/** The provider no longer has the agent's conversation: every send fails, so Follow-up stops sending to it. */
export class ConversationGone extends Error { constructor(readonly agentId: string, reason: string) { super(reason); this.name = "ConversationGone"; } }

/** A UUID-shaped id fixed by `seed`: the same answer always goes out under the same messageId. */
export function stableMessageId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** `work`, or a rejection after `ms`: a hung call never holds a record in `sending` forever. */
export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); (timer as { unref?: () => void }).unref?.(); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
