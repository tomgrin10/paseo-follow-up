import { z } from "zod";
import type { Workspace } from "./model";
import { summary } from "./model";
import { batchView } from "./status";
import { sendDecision } from "./send-decision";
import { MEMORY_CONSTRAINED, MEMORY_PRESSURE_CONSTRAINED, RESOURCES_STALE_MS, type Resources } from "./resources";

/**
 * Home's "Sending" group (Q51, 2026-11-13; it replaces "Follow-up is fixing"): a message that is out with the agent,
 * or queued to go out without the developer. A send that waits on the developer is a Needs-you item with its Send
 * button and never shows here (invariant sending-never-waits-on-you). Home, the agent tools (workspace_status,
 * inbox_list, workstreams) and the panel read this one answer, so they never disagree.
 */
export type Sending = {
  batchId: string;
  /** queued: goes out on its own (after the agent's turn, the settle, GitHub's answer…). sent: out with the agent. */
  state: "queued" | "sent";
  count: number;
  /** Why it hasn't gone out yet (queued), or what Follow-up waits for (sent), in the send decision's words. */
  why: string;
  /** Queued: when it goes out on its own (ISO), if Follow-up knows. Sent: when it went out. */
  when: string | null;
  /** The developer's Send now would go through, and the send doesn't wait on them: the row offers Send now. */
  canSendNow: boolean;
  /** The row's line: count, then why. Said once: never the workspace's or the agent's title. */
  line: string;
};

const tasks = (n: number) => `${n} task${n === 1 ? "" : "s"}`;
/** The queued reason while the machine holds auto-sends (Home shows the hold itself once, above the group). */
export const HELD_REASON = "next when auto-sends resume";
/** After a send the agent never acknowledged: what happens to the tasks still open, said on the queued row. */
export const UNACKNOWLEDGED_NOTE = "no reply to the last message, so they go again";

/** The newest settled send of this workspace (not recovery), when it ended without an acknowledgment. */
function lastUnacknowledged(w: Workspace) {
  const settled = w.batches.filter(b => b.state === "completed" && b.sentAt && b.settledAt).sort((a, b) => Date.parse(b.settledAt!) - Date.parse(a.settledAt!))[0];
  return settled?.unacknowledged ? settled : undefined;
}

/**
 * The workspace's Sending row, or null when nothing is out or going out on its own. `held`: the machine holds
 * auto-sends (the resource governor), so a queued message that would go out now waits for it to ease instead.
 */
export function sendingOf(w: Workspace, now: number, o: { held?: boolean } = {}): Sending | null {
  if (w.archived || !w.enable_tracking || summary(w, now).status === "done") return null;
  const view = batchView(w, now);
  if (!view) return null;
  if (view.phase === "sent") {
    const at = view.batch.sentAt ?? null;
    return { batchId: view.batch.id, state: "sent", count: view.batch.tasks.length, why: "waiting for it to report back", when: at, canSendNow: false, line: view.line };
  }
  if (view.phase !== "queued" || view.kind !== "repairs" || view.waitingOn === "you" || !w.enable_auto_sends) return null;
  const d = sendDecision(w, now, { batch: view.batch });
  const held = !!o.held && d.waitingOn === null;
  const why = held ? HELD_REASON : d.reason;
  const n = view.batch.tasks.length;
  const again = lastUnacknowledged(w) ? ` · ${UNACKNOWLEDGED_NOTE}` : "";
  return { batchId: view.batch.id, state: "queued", count: n, why, when: held ? null : d.eta, canSendNow: d.canSendNow,
    line: `${tasks(n)} queued${again} · ${why}` };
}

/**
 * The machine-wide hold, said once above the Sending group, the same words on every width. Null when auto-sends
 * aren't held. The percentage shows only when the reading is current and memory is what holds them back.
 */
export function autoSendHold(r: Resources | null | undefined, now: number): string | null {
  if (!r || r.level === "ok") return null;
  const at = r.at ? Date.parse(r.at) : NaN;
  const current = Number.isFinite(at) && now - at <= RESOURCES_STALE_MS;
  const memoryHigh = (r.memoryPct ?? 0) >= MEMORY_CONSTRAINED;
  const why = memoryHigh ? current ? `Paseo is at ${r.memoryPct}% of its memory limit` : "Paseo is near its memory limit"
    : (r.memoryPressure ?? 0) >= MEMORY_PRESSURE_CONSTRAINED ? "Paseo's memory is under pressure"
    : "the machine's CPU is under sustained load";
  return `Auto-sends are paused on this machine · ${why}. Queued tasks go out when it eases; Send now still sends.`;
}

/** What agents read about a Sending row (workspace_status, inbox_list, workstreams): the same answer Home shows. */
export const sendingSchema = z.object({
  batchId: z.string(), state: z.enum(["queued", "sent"]), count: z.number(), why: z.string(), when: z.string().nullable(), canSendNow: z.boolean(), line: z.string(),
});
