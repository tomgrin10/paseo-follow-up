import type { HomeGroupId, Workstream } from "./home";
import type { Priority } from "./priorities";

/**
 * Home's sort orders (1.3.0-beta.2). They apply inside each group; the group order never changes, and search
 * results ignore them (they rank by match).
 */
export const SORT_MODES = ["priority", "recent", "oldest", "name", "project"] as const;
export type SortMode = typeof SORT_MODES[number];
export const SORT_LABEL: Record<SortMode, string> = { priority: "Priority", recent: "Recent", oldest: "Oldest waiting", name: "Name", project: "By project" };
export const SORT_HINT: Record<SortMode, string> = {
  priority: "Most important first",
  recent: "Latest activity first",
  oldest: "Longest-waiting first",
  name: "A to Z",
  project: "Project, then most important",
};
export const DEFAULT_SORT: SortMode = "priority";
export const isSortMode = (v: unknown): v is SortMode => typeof v === "string" && (SORT_MODES as readonly string[]).includes(v);

const time = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const oldestFirst = (a: string | null | undefined, b: string | null | undefined) => (time(a) ?? Infinity) - (time(b) ?? Infinity);
const newestFirst = (a: string | null | undefined, b: string | null | undefined) => (time(b) ?? -Infinity) - (time(a) ?? -Infinity);
const byName = (a: Workstream, b: Workstream) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) || (a.agent ?? "").localeCompare(b.agent ?? "");
const tie = (a: Workstream, b: Workstream) => a.key.localeCompare(b.key);
const score = (s: Workstream, p: Map<string, Priority>) => s.workspaceId ? p.get(s.workspaceId)?.score ?? -1 : -1;

/**
 * Urgency, the Priority sort without a ranker: blocking asks, then decisions only the developer makes, then finished
 * turns (the tier). Inside a tier: important ones (a big open question), then the nearest task deadline, then the
 * oldest ask. Outside Needs you, the default order of each group.
 */
export function byUrgency(group: HomeGroupId) {
  return (a: Workstream, b: Workstream): number => {
    if (group === "needs") return (a.tier ?? 3) - (b.tier ?? 3) || Number(b.urgent) - Number(a.urgent) || oldestFirst(a.due, b.due) || oldestFirst(a.at, b.at) || tie(a, b);
    if (group === "waiting") return oldestFirst(a.at, b.at) || tie(a, b);
    if (group === "quiet") return Number(b.readyToArchive) - Number(a.readyToArchive) || newestFirst(a.activityAt ?? a.at, b.activityAt ?? b.at) || tie(a, b);
    return newestFirst(a.at, b.at) || tie(a, b);
  };
}

/**
 * Priority with fresh external priorities: blocking asks stay above everything; inside that and in the rest,
 * the ranker's score decides, then urgency. Rows without a score keep their urgency order after the scored ones.
 */
export function byPriority(group: HomeGroupId, priorities: Map<string, Priority>) {
  const urgency = byUrgency(group);
  if (!priorities.size) return urgency;
  return (a: Workstream, b: Workstream): number => {
    const blockA = group === "needs" && a.tier === 0, blockB = group === "needs" && b.tier === 0;
    return Number(blockB) - Number(blockA) || score(b, priorities) - score(a, priorities) || urgency(a, b);
  };
}

export function compareFor(mode: SortMode, group: HomeGroupId, priorities: Map<string, Priority> = new Map()) {
  const priority = byPriority(group, priorities);
  switch (mode) {
    case "priority": return priority;
    case "recent": return (a: Workstream, b: Workstream) => newestFirst(a.activityAt ?? a.at, b.activityAt ?? b.at) || tie(a, b);
    case "oldest": return (a: Workstream, b: Workstream) => oldestFirst(a.at, b.at) || tie(a, b);
    case "name": return (a: Workstream, b: Workstream) => byName(a, b) || tie(a, b);
    case "project": return (a: Workstream, b: Workstream) => (a.project ?? "￿").localeCompare(b.project ?? "￿") || priority(a, b);
  }
}

export function sortItems(items: Workstream[], mode: SortMode, group: HomeGroupId, priorities?: Map<string, Priority>): Workstream[] {
  return [...items].sort(compareFor(mode, group, priorities));
}
