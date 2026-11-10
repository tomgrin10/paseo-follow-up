/**
 * Who took a Follow-up action: the developer (a click in the app) or an agent acting on the developer's behalf through
 * its tools (agent parity). The action counterpart of shared/message-sender.ts: nothing but a developer action counts
 * as the developer. Every path that records an actor (the inbox ledger, a question's answer, a brief's answer, the spec
 * link, linked items) takes one from here.
 *
 * RPC handlers read it with `actorOf(context)`. Agent tools reach handlers only through the worker's RPC bridge, which
 * sets `context.actor`; a call without one came from the app, so it is the developer's.
 */
export type Actor = { kind: "developer" } | { kind: "agent"; agentId: string; title: string | null };
export const DEVELOPER: Actor = { kind: "developer" };

export const agentActor = (agentId: string, title?: string | null): Actor => ({ kind: "agent", agentId, title: title?.trim() || null });
export const isDeveloperActor = (a: Actor | null | undefined): boolean => !a || a.kind === "developer";
export function actorOf(context: unknown): Actor {
  const a = (context as { actor?: Actor } | null)?.actor;
  return a && a.kind === "agent" && typeof a.agentId === "string" ? a : DEVELOPER;
}

/** The ledger's `by` (shared/inbox.ts): "developer", or "agent:<id>" for an agent acting on the developer's behalf. */
export const ledgerBy = (a: Actor): "developer" | `agent:${string}` => a.kind === "developer" ? "developer" : `agent:${a.agentId}`;
/** A record's `by` string for stores that keep a free-form actor (linked items, a question's answer). */
export const actorBy = (a: Actor): string => a.kind === "developer" ? "developer" : `agent:${a.agentId}`;

/**
 * The line an agent-sent card answer carries, so the receiving agent, its chat card and every reader know it wasn't
 * the developer's click: "Answered by Release captain (agent 5206…) for the developer."
 */
export function onBehalfLine(a: Actor): string | null {
  return a.kind === "agent" ? `Answered by ${a.title ?? "another agent"} (agent ${a.agentId}) for the developer.` : null;
}
const ON_BEHALF = /^Answered by (.+?) \(agent ([\w-]+)\) for the developer\.$/m;
/** The acting agent named in a card answer's text, or null when the developer sent it. */
export function onBehalfOf(text: string): { title: string; agentId: string } | null {
  const m = ON_BEHALF.exec(text);
  return m ? { title: m[1], agentId: m[2] } : null;
}
