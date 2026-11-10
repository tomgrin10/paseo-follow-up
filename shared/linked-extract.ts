import { extractLinks, keysFromBranch } from "./about";
import type { LinkRef } from "./linked";
import { messageSender } from "./message-sender";

/**
 * Linked items' passive ingress (1.4.0-beta.30): references in text Follow-up already reads. Pure.
 *
 * - The timeline batch discovery already read for a loaded agent. Dormant agents are never read for this.
 * - The workspace's own record: goal, title, PR titles and branches.
 *
 * Strength decides whether a bare Linear key goes to Linear straight away or waits for a second sighting:
 * a tool receipt (the agent read or wrote that issue or thread), the developer's own words, the goal and PRs are
 * strong; an agent's prose is weak. URL-shaped references (Slack threads, artifacts, docs, GitHub issues) don't wait.
 */

const SLACK_TS = /^\d{10}\.\d{6}$/;

type Item = { type?: string; text?: unknown; name?: unknown; status?: unknown; error?: unknown; detail?: { input?: unknown } };
type Entry = { seqStart: number; item: unknown };

const refsIn = (text: string, strong: boolean): LinkRef[] => extractLinks([text], 30).filter(l => l.kind !== "pr").map(l => ({ raw: l.url ?? l.key, strong }));
const stringsOf = (value: unknown, out: string[] = [], depth = 0): string[] => {
  if (depth > 4 || out.length > 40) return out;
  if (typeof value === "string") out.push(value.slice(0, 4000));
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsOf(v, out, depth + 1);
  return out;
};

/** A completed tool call's receipt: Linear keys only from Linear's own tools, a Slack thread it read, URLs it opened. */
function receiptRefs(name: string, input: unknown): LinkRef[] {
  if (/follow[_-]|follow-through/i.test(name)) return [];
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const refs: LinkRef[] = [];
  if (/slack_read_thread/.test(name) && typeof args.channel_id === "string" && typeof args.message_ts === "string" && SLACK_TS.test(args.message_ts))
    refs.push({ raw: `https://slack.com/archives/${args.channel_id}/p${args.message_ts.replace(".", "")}`, strong: true });
  const linear = /linear/i.test(name);
  for (const text of stringsOf(input)) for (const r of refsIn(text, true)) {
    // A bare key in a shell command or a search is noise ("git log --grep HER-12"); only Linear's tools vouch for keys.
    if (!linear && !/^https?:/.test(r.raw)) continue;
    refs.push(r);
  }
  return refs;
}

/** One entry's references, each key once. */
function entryRefs(item: Item): LinkRef[] {
  if (!item || typeof item !== "object") return [];
  if (item.type === "user_message" && typeof item.text === "string") {
    // Only the developer's words vouch for a reference. Another agent's message is prose (as its 0.15 tool-call form
    // below); Follow-up's own messages, Overseer forwards and system text are never evidence.
    const s = messageSender(item.text);
    return s.kind === "developer" ? refsIn(s.text, true) : s.kind === "agent" ? refsIn(s.text, false) : [];
  }
  if (item.type === "assistant_message" && typeof item.text === "string") return refsIn(item.text, false);
  if (item.type === "tool_call" && typeof item.name === "string") {
    // Paseo 0.15 projects another agent's message as a tool call: prose, not a receipt.
    if (item.name === "agent_message" || item.name === "heartbeat") return refsIn(stringsOf(item.detail?.input).join("\n"), false);
    if (item.status !== "completed" || item.error) return [];
    return receiptRefs(item.name, item.detail?.input);
  }
  return [];
}

/**
 * References in a timeline batch, only from entries after `afterSeq` (the cursor the previous read ended at), so the
 * overlap a cursor read re-fetches never counts as a second sighting. One ref per entry per key.
 */
export function timelineRefs(entries: readonly Entry[], afterSeq = -1): LinkRef[] {
  const out: LinkRef[] = [];
  for (const entry of entries) {
    if (entry.seqStart <= afterSeq) continue;
    const seen = new Map<string, LinkRef>();
    for (const r of entryRefs(entry.item as Item)) { const prior = seen.get(r.raw); if (!prior || r.strong && !prior.strong) seen.set(r.raw, r); }
    out.push(...seen.values());
  }
  return out;
}

/** The workspace's own record: its goal and title, and its PRs' titles and branches. All strong. */
export function workspaceRefs(w: { goal?: string | null; title?: string | null; prs?: readonly { snapshot?: { title?: string; headBranch?: string } | null }[] }): LinkRef[] {
  const texts = [w.goal, w.title, ...(w.prs ?? []).map(p => p.snapshot?.title)].filter((t): t is string => !!t);
  const refs = texts.flatMap(t => refsIn(t, true));
  for (const p of w.prs ?? []) for (const key of keysFromBranch(p.snapshot?.headBranch)) refs.push({ raw: key, strong: true });
  return [...new Map(refs.map(r => [r.raw, r])).values()];
}
