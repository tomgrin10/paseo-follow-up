/**
 * Who wrote a user-role message, from its text alone. Pure and shared by every surface that reads a conversation.
 *
 * Paseo delivers more than the developer's words as user-role messages: another agent's message
 * (`<paseo-system kind="agent-message">`), a child agent's finish notification (`kind="agent-notification"`, its
 * reply inside `<agent-response>`), schedule fires (`<paseo-system>` with no attributes), Follow-up's own batches,
 * recoveries and answers, the Overseer's forwards, and the provider harness's wrappers (system reminders, command
 * caveats, AGENTS.md). Anything that treats "user role" as "the developer" without asking this module is the bug
 * class this guards: a raw envelope rendered as "You", or an agent's words clearing a flag or approving work.
 *
 * Only `developer` is the developer. Authority (clearing Needs you, approving a new workspace, answering a brief)
 * additionally needs the delivery ledger for Follow-up's own messages (server/inbox-classifier.ts), because a
 * "Follow-up answer" can be the developer's click.
 */

export type AgentEvent = "message" | "finished" | "errored" | "permission-required" | "closed";
export type MessageSender =
  /** Typed by the developer (also Paseo's `kind="user-message"` quoting envelope, which only the human send path makes). */
  | { kind: "developer"; text: string }
  /** Another agent: its message, or a child's finish notification. `text` is the body with the envelope stripped. */
  | { kind: "agent"; event: AgentEvent; agentId: string; title: string | null; text: string }
  /** Follow-up's own message: a repair batch, a recovery hand-off, or a decision answer (often the developer's click). */
  | { kind: "follow-up"; what: "batch" | "recovery" | "answer"; text: string }
  /** The developer's words routed by the Overseer. `text` has the "From … via Overseer:" prefix stripped. */
  | { kind: "overseer-forward"; text: string }
  /** Paseo's own injected prompts (schedule fires, unknown kinds) and the provider harness's wrappers. */
  | { kind: "system"; source: "paseo" | "harness"; text: string };

/**
 * Every prefix an Overseer forward has carried. The first named the developer; old transcripts keep it, so both are
 * recognised whichever one shared/overseer.ts sends today.
 */
export const FORWARD_PREFIXES = ["From the developer via Overseer:", "From Tom via Overseer:"] as const;
/** Follow-up's own message prefixes, newest spelling first. "Workspace follow-through batch" is the pre-1.0 one. */
const FOLLOW_UP: { prefix: RegExp; what: "batch" | "recovery" | "answer" }[] = [
  { prefix: /^(?:Workspace follow-through batch|Follow-through batch)\b/, what: "batch" },
  { prefix: /^Follow-through recovery\b/, what: "recovery" },
  { prefix: /^Follow-up answer\b/, what: "answer" },
];
/** Harness text that is never typed: a message that opens with a tag and ends with one, or a known instruction header. */
const HARNESS = /^(?:<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*<\/[A-Za-z][\w-]*>\s*$|# AGENTS\.md instructions|<INSTRUCTIONS>|Caveat: The messages below)/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]);
const EVENTS = new Set<AgentEvent>(["finished", "errored", "permission-required", "closed"]);

/** One `<paseo-system …>` envelope at the start of `text`: its attributes, body and where it ends. */
function envelopeAt(text: string): { attrs: Map<string, string>; body: string; end: number } | null {
  const open = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")*)\s*>/.exec(text);
  if (!open) return null;
  const close = text.indexOf("</paseo-system>", open[0].length);
  const attrs = new Map<string, string>();
  for (const m of open[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) attrs.set(m[1], unescape(m[2]));
  const body = (close < 0 ? text.slice(open[0].length) : text.slice(open[0].length, close)).replace(/^\n/, "").replace(/\n$/, "");
  return { attrs, body: unescape(body), end: close < 0 ? text.length : close + "</paseo-system>".length };
}

/** A finish notification's useful part: the child's reply inside `<agent-response>`, else the status line. */
function notificationText(body: string): string {
  const reply = /<agent-response>\n?([\s\S]*?)\n?<\/agent-response>/.exec(body)?.[1]?.trim();
  if (reply) return reply;
  return body.replace(/<permission-request>[\s\S]*?<\/permission-request>/g, "").trim();
}

export function messageSender(raw: string): MessageSender {
  const text = raw.trim();
  if (text.startsWith("<paseo-system")) {
    const first = envelopeAt(text);
    if (!first) return { kind: "system", source: "paseo", text };
    const kind = first.attrs.get("kind");
    if (kind === "agent-message" || kind === "agent-notification") {
      // Paseo batches several envelopes into one prompt when they queue up: one sender row, every body kept.
      const bodies = [first.body];
      for (let rest = text.slice(first.end).trimStart(); rest.startsWith("<paseo-system");) {
        const next = envelopeAt(rest);
        if (!next) break;
        bodies.push(next.attrs.get("kind") === "agent-notification" ? notificationText(next.body) : next.body);
        rest = rest.slice(next.end).trimStart();
      }
      const event = kind === "agent-message" ? "message" : EVENTS.has(first.attrs.get("event") as AgentEvent) ? first.attrs.get("event") as AgentEvent : "finished";
      if (kind === "agent-notification") bodies[0] = notificationText(first.body);
      return { kind: "agent", event, agentId: first.attrs.get("source-agent-id") ?? "", title: first.attrs.get("source-agent-title") || null, text: bodies.filter(Boolean).join("\n\n") };
    }
    // The human send path quotes reserved envelopes as kind="user-message": still the developer's words.
    if (kind === "user-message") return { kind: "developer", text: first.body };
    return { kind: "system", source: "paseo", text: first.body };
  }
  const forward = FORWARD_PREFIXES.find(p => text.startsWith(p));
  if (forward) return { kind: "overseer-forward", text: text.slice(forward.length).trim() };
  const own = FOLLOW_UP.find(f => f.prefix.test(text));
  if (own) return { kind: "follow-up", what: own.what, text };
  if (HARNESS.test(text)) return { kind: "system", source: "harness", text };
  return { kind: "developer", text };
}

/** True only for the developer's own message. The one test for "You" attribution. */
export const isDeveloperMessage = (raw: string) => messageSender(raw).kind === "developer";

/**
 * The developer's words in a message, for goals and Summary inputs: their own message, or what the Overseer
 * forwarded for them (prefix stripped). Null for agents, Follow-up and system text.
 */
export function developerWords(raw: string): string | null {
  const s = messageSender(raw);
  return s.kind === "developer" || s.kind === "overseer-forward" ? s.text || null : null;
}

/** "From Reviewer", "Reviewer finished", "Follow-up batch", "You, via Overseer": the label a non-developer message shows. */
export function senderLabel(s: MessageSender): string | null {
  switch (s.kind) {
    case "developer": return null;
    case "agent": {
      const who = s.title ?? "another agent";
      return s.event === "message" ? `From ${who}` : `${s.title ?? "A child agent"} ${{ finished: "finished", errored: "errored", "permission-required": "needs permission", closed: "closed" }[s.event]}`;
    }
    case "follow-up": return s.what === "batch" ? "Follow-up batch" : s.what === "recovery" ? "Follow-up recovery" : "Follow-up answer";
    case "overseer-forward": return "You, via Overseer";
    case "system": return null;
  }
}
