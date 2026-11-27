import { z } from "zod";
import { GROUP_TITLE, type HomeGroupId, type HomeModel, type PaseoWorkspaceLite, type Workstream } from "./home";

/**
 * How Home's list and the sidebar view arrange their rows: one model for both, saved in Settings → Display
 * (`home_view`, host-scoped, so it follows the developer across devices and `set_display` sets it). It mirrors the
 * choices in Paseo's own sidebar menu (Grouping, Title, Show, Project, Labels, Show background) with Follow-up's sort.
 * Host is not here: each host runs its own Follow-up, so its lists only ever hold that host's workspaces.
 */
export const GROUPINGS = ["status", "project", "none"] as const;
export type Grouping = typeof GROUPINGS[number];
export const GROUPING_LABEL: Record<Grouping, string> = { status: "Status", project: "Project", none: "None" };
export const TITLE_SOURCES = ["title", "branch"] as const;
export type TitleSource = typeof TITLE_SOURCES[number];
export const TITLE_LABEL: Record<TitleSource, string> = { title: "Workspace title", branch: "Branch name" };
/** The facts a row's detail line may show, in the order the line reads (Paseo's meta line order). */
export const SHOW_ITEMS = ["branch", "project", "pr", "labels", "time"] as const;
export type ShowItem = typeof SHOW_ITEMS[number];
export const SHOW_LABEL: Record<ShowItem, string> = { branch: "Branch", project: "Project", pr: "Pull request", labels: "Labels", time: "Last activity" };
/** Paseo's defaults: branch and project off, the rest on. */
export const DEFAULT_SHOW: Record<ShowItem, boolean> = { branch: false, project: false, pr: true, labels: true, time: true };

export const homeViewSchema = z.object({
  grouping: z.enum(GROUPINGS).default("status"),
  title: z.enum(TITLE_SOURCES).default("title"),
  show: z.object(Object.fromEntries(SHOW_ITEMS.map(k => [k, z.boolean().default(DEFAULT_SHOW[k])])) as Record<ShowItem, z.ZodDefault<z.ZodBoolean>>).default(DEFAULT_SHOW),
  /** Empty: every project. Otherwise only rows of these projects (by display name). */
  projects: z.array(z.string().min(1).max(200)).max(200).default([]),
  /** Empty: every label. Otherwise rows whose workspace carries any of these labels. */
  labels: z.array(z.string().min(1).max(100)).max(100).default([]),
  /** Background workspaces (ones an agent or plugin started in the background) are hidden unless on, as in Paseo. */
  show_background: z.boolean().default(false),
});
export type HomeView = z.infer<typeof homeViewSchema>;
export const DEFAULT_HOME_VIEW: HomeView = homeViewSchema.parse({});
export const parseHomeView = (v: unknown): HomeView => { const r = homeViewSchema.safeParse(v ?? {}); return r.success ? r.data : DEFAULT_HOME_VIEW; };
/** A filter is narrowing the list (the options button's dot, the line above the list). */
export const homeViewFiltered = (v: HomeView) => v.projects.length > 0 || v.labels.length > 0;

/** A section the list draws: a status group, a project, or the whole list (Grouping › None). */
export type HomeSection = { key: string; kind: "group" | "project" | "all"; group: HomeGroupId | null; title: string; items: Workstream[]; count: number };
export type ArrangedHome = {
  /** Rows of pinned workspaces, most recently pinned first. Null when the host has no pins (older Paseo). */
  pinned: Workstream[] | null;
  sections: HomeSection[];
  /** Every project and label the unfiltered list holds, for the Project and Labels pages. */
  projects: string[]; labels: string[];
  /** Rows the filters hid, so an empty list can say why. */
  hidden: number;
};

type Facts = Pick<PaseoWorkspaceLite, "pinnedAt" | "labels" | "background" | "branch">;

/**
 * Arranges Home's model for drawing: drops what the filters and Show background hide, lifts rows of pinned workspaces
 * into Pinned (they keep their mark, and their status group's count still counts them), then groups the rest by
 * status (Home's groups), by project, or not at all. Each group's order is the sort's (buildHome); Project keeps it,
 * so a project's most urgent row leads, and projects follow their first row.
 */
export function arrangeHome(model: HomeModel, view: HomeView, workspaces: (id: string) => Facts | undefined): ArrangedHome {
  const facts = (s: Workstream) => s.workspaceId ? workspaces(s.workspaceId) : undefined;
  const projects = new Set<string>(), labels = new Set<string>();
  let hidden = 0;
  const keep = (s: Workstream) => {
    const f = facts(s);
    if (s.project) projects.add(s.project);
    for (const l of f?.labels ?? []) labels.add(l);
    const ok = (view.show_background || !f?.background)
      && (!view.projects.length || (!!s.project && view.projects.includes(s.project)))
      && (!view.labels.length || (f?.labels ?? []).some(l => view.labels.includes(l)));
    if (!ok) hidden++;
    return ok;
  };
  const groups = model.groups.map(g => ({ ...g, items: g.items.filter(keep) }));
  const hostHasPins = [...model.byKey.values()].some(s => facts(s)?.pinnedAt !== undefined);
  const pinnedAt = (s: Workstream) => facts(s)?.pinnedAt ?? null;
  const pinned = hostHasPins ? groups.flatMap(g => g.items.filter(s => pinnedAt(s)))
    .sort((a, b) => (pinnedAt(b) ?? "").localeCompare(pinnedAt(a) ?? "") || a.key.localeCompare(b.key)) : null;
  const lifted = new Set(pinned?.map(s => s.key));
  const rest = groups.map(g => ({ ...g, all: g.items.length, items: g.items.filter(s => !lifted.has(s.key)) }));
  let sections: HomeSection[];
  if (view.grouping === "status") {
    // A group whose rows all went to Pinned draws no header; the counts that matter (the badge, the strip) still count them.
    sections = rest.filter(g => g.items.length).map(g => ({ key: g.id, kind: "group", group: g.id, title: GROUP_TITLE[g.id], items: g.items, count: g.all }));
  } else {
    const all = rest.flatMap(g => g.items);
    if (view.grouping === "none") sections = all.length ? [{ key: "all", kind: "all", group: null, title: "Workspaces", items: all, count: all.length }] : [];
    else {
      const by = new Map<string, Workstream[]>();
      for (const s of all) { const k = s.project ?? "Other"; by.set(k, [...by.get(k) ?? [], s]); }
      sections = [...by.entries()].map(([p, items]) => ({ key: `project:${p}`, kind: "project", group: null, title: p, items, count: items.length }));
    }
  }
  return { pinned, sections, projects: [...projects].sort((a, b) => a.localeCompare(b)), labels: [...labels].sort((a, b) => a.localeCompare(b)), hidden };
}

/** The title a row shows: the workspace's title, or its branch under Title › Branch name (the title when it has none). */
export const rowTitle = (s: Workstream, view: HomeView, workspaces: (id: string) => Facts | undefined) =>
  view.title === "branch" && s.workspaceId ? workspaces(s.workspaceId)?.branch || s.title : s.title;
