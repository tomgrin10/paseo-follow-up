import { GROUP_TITLE, quietFolds, type HomeGroupId, type HomeModel, type Workstream } from "./home";
import type { ArrangedHome } from "./home-arrange";
import { rowHit, type OmniboxItem, type RowHit, type SearchHit, type WorkspaceItem } from "./search";

/**
 * What HomeList draws, in order: one entry per row, header, fold and line (client/home-list.tsx). Pure, so the keyboard
 * walk's order (walkOrder, shared/list-keys.ts) is testable: it is exactly the rows drawn.
 */
export const QUIET_PAGE = 20;
export const BRIEF_KEY = "brief";
export const OVERSEER_KEY = "overseer";
export type Entry =
  | { type: "brief"; key: string }
  | { type: "overseer"; key: string; pinned?: boolean }
  | { type: "header"; key: string; group: HomeGroupId; title: string; count: number; open: boolean }
  /** Pinned, or a project under Grouping › Project: a quiet header like Paseo's sidebar sections. */
  | { type: "section"; key: string; title: string; count: number | null; open: boolean; project: string | null }
  | { type: "row"; key: string; s: Workstream; hit?: RowHit | null }
  | { type: "fold"; key: string; project: string; count: number; archivable: number; open: boolean }
  | { type: "more"; key: string; project: string; left: number }
  | { type: "result"; key: string; item: WorkspaceItem; index: number; s: Workstream; hit: RowHit; archived: boolean }
  | { type: "ask"; key: string; ask: string; index: number }
  | { type: "label"; key: string; text: string }
  | { type: "hold"; key: string; text: string }
  | { type: "empty"; key: string }
  | { type: "slot"; key: string }
  /** Decision Q8's raised Linear issues, first in Needs you (client/brief-since.tsx RaisedRows). */
  | { type: "raised"; key: string };

/** The line under an open Older header (briefs-from-closed-agents). */
export const OLDER_NOTE = "Closed agents with nothing new for 3 days. A row comes back when its agent runs again.";

/** A search hit on a workspace Follow-up has archived: a muted row with the Archive glyph, reading "Archived". */
export function archivedRow(hit: SearchHit): Workstream {
  return { key: hit.key, agentId: null, workspaceId: hit.key.startsWith("ws:") ? hit.key.slice(3) : null, title: hit.title, agent: null, project: null, group: "quiet", tier: null,
    icon: "Archive", tone: "muted", line: "Archived", word: null, badges: [], pr: null, at: null, readyToArchive: false, sig: `archived:${hit.key}` } as unknown as Workstream;
}

export type ListEntriesInput = {
  model: HomeModel; closed: Set<string>; openProjects: Set<string>; pages: Record<string, number>; briefLine: string | null | undefined;
  results: OmniboxItem[] | null | undefined; hits: Map<string, SearchHit> | null; filter: HomeGroupId | null; overseer: boolean; touch: boolean; afterNeeds: boolean;
  /**
   * The Display arrangement (shared/home-arrange.ts): Pinned, then status groups, projects or one flat list. Ignored
   * by a search's results and by the status strip's one-group filter, which list a group as it is.
   */
  arranged?: ArrangedHome | null;
};
export function listEntries({ model, closed, openProjects, pages, briefLine, results, hits, filter, overseer, touch, afterNeeds, arranged = null }: ListEntriesInput): Entry[] {
  const out: Entry[] = [];
  if (results) {
    // Search ignores the sort and the groups: ranked by match, archived ones last under their own label.
    let archivedShown = false;
    results.forEach((item, index) => {
      if (item.ask !== undefined) {
        // The ask row closes the list; with no match it follows the "no match" line.
        if (index === 0) out.push({ type: "label", key: "l:none", text: "No workspace, branch or PR matches." });
        out.push({ type: "ask", key: item.key, ask: item.ask, index });
        return;
      }
      if (item.hit.group === "archived" && !archivedShown) { archivedShown = true; out.push({ type: "label", key: "l:archived", text: "Archived" }); }
      const live = model.byKey.get(item.key);
      const s = live ?? archivedRow(item.hit);
      out.push({ type: "result", key: `r:${item.provider}:${item.key}`, item, index, s, hit: rowHit(item.hit, s), archived: !live });
    });
    if (!results.length) out.push({ type: "label", key: "l:none", text: "No workspace, branch or PR matches." });
    return out;
  }
  if (briefLine !== undefined && !filter) out.push({ type: "brief", key: BRIEF_KEY });
  const arrange = filter ? null : arranged;
  const hitOf = (s: Workstream) => { const h = hits?.get(s.key); return h ? rowHit(h, s) : null; };
  // Pinned: the Overseer first, then pinned workspaces' rows. With nothing pinned (or a host without pins), the
  // Overseer stays on top on its own, as before pins.
  if (arrange?.pinned?.length) {
    out.push({ type: "section", key: "h:pinned", title: "Pinned", count: null, open: true, project: null });
    if (overseer) out.push({ type: "overseer", key: OVERSEER_KEY, pinned: true });
    for (const s of arrange.pinned) out.push({ type: "row", key: s.key, s, hit: hitOf(s) });
  } else if (overseer && !filter) out.push({ type: "overseer", key: OVERSEER_KEY });
  if (arrange && arrange.sections.some(x => x.kind !== "group")) {
    for (const x of arrange.sections) {
      const open = !!hits || !closed.has(x.key);
      if (x.kind === "project") out.push({ type: "section", key: `h:${x.key}`, title: x.title, count: x.count, open, project: x.title });
      if (!open && x.kind === "project") continue;
      for (const s of x.items) out.push({ type: "row", key: s.key, s, hit: hitOf(s) });
    }
    if (hits && !out.some(e => e.type === "row")) out.push({ type: "label", key: "l:none", text: "No workspace matches." });
    else if (!out.some(e => e.type === "row")) out.push(arrange.hidden ? { type: "label", key: "l:filtered", text: "No workspace matches these filters." } : { type: "empty", key: "l:nothing" });
    return out;
  }
  // Raised issues (Q8) are Needs-you items with no workspace row: they open the group, or make it when it has no rows.
  const raised = model.raised ?? 0;
  const base = arrange ? arrange.sections.map(x => ({ id: x.group!, title: x.title, items: x.items, count: x.count })) : model.groups.map(g => ({ ...g, count: g.items.length }));
  const groups = raised && !base.some(g => g.id === "needs") ? [{ id: "needs" as const, title: GROUP_TITLE.needs, items: [] as Workstream[], count: 0 }, ...base] : base;
  for (const g of groups) {
    if (filter && g.id !== filter) continue;
    const open = !!filter || !!hits || !closed.has(g.id);
    const extra = g.id === "needs" && !hits ? raised : 0;
    // Phones with one group filtered: the chip above already says "N Needs you ×"; no header repeating it.
    if (!(touch && filter)) out.push({ type: "header", key: `h:${g.id}`, group: g.id, title: g.title, count: g.count + extra, open });
    if (!open) { if (g.id === "needs" && afterNeeds && !filter) out.push({ type: "slot", key: "s:afterNeeds" }); continue; }
    if (extra) out.push({ type: "raised", key: "s:raised" });
    // One hold line per machine, once, at the top of Sending (the model has it only while Sending has rows).
    if (g.id === "sending" && model.hold) out.push({ type: "hold", key: "l:hold", text: model.hold });
    // briefs-from-closed-agents: Older says why its rows are there, since their ages alone can't.
    if (g.id === "older") out.push({ type: "label", key: "l:older", text: OLDER_NOTE });
    if (g.id !== "quiet") { for (const s of g.items) out.push({ type: "row", key: s.key, s, hit: hitOf(s) }); if (g.id === "needs" && afterNeeds && !filter) out.push({ type: "slot", key: "s:afterNeeds" }); continue; }
    for (const f of quietFolds(g.items)) {
      const fopen = !!hits || openProjects.has(f.project);
      out.push({ type: "fold", key: `f:${f.project}`, project: f.project, count: f.items.length, archivable: f.archivable, open: fopen });
      if (!fopen) continue;
      const shown = (pages[f.project] ?? 1) * QUIET_PAGE;
      for (const s of f.items.slice(0, shown)) out.push({ type: "row", key: s.key, s, hit: hitOf(s) });
      if (f.items.length > shown) out.push({ type: "more", key: `m:${f.project}`, project: f.project, left: f.items.length - shown });
    }
  }
  // Nothing followed yet says so and how to start, instead of a blank list under the pinned rows (a first run lands here).
  if (hits && !out.some(e => e.type === "row")) out.push({ type: "label", key: "l:none", text: "No workspace matches." });
  // Only when the list has nothing at all: raised issues (Needs you's own rows) are something.
  else if (!filter && !hits && (arrange ? !arrange.sections.length && !arrange.pinned?.length : model.groups.every(g => !g.items.length)) && !raised) out.push(arrange?.hidden ? { type: "label", key: "l:filtered", text: "No workspace matches these filters." } : { type: "empty", key: "l:nothing" });
  return out;
  if (filter && !out.length) out.push({ type: "label", key: "l:empty", text: `Nothing in ${GROUP_TITLE[filter as HomeGroupId]} right now.` });
  return out;
}
