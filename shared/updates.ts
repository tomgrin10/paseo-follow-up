import { moveViewSchema } from "./plugin-move";
import { z } from "zod";
import { compareVersions, type Channel } from "./version";
import { INSTALL_KINDS, releaseNoteSchema as noteSchema } from "./changelog";
export type { InstallKind } from "./changelog";

/**
 * Settings → General: the view the server sends, and the words each state shows. Pure, so every state's copy is
 * testable without rendering. Also the contract for onboarding's Updates step: it reads `follow.updates` and writes
 * `follow.set-updates` with `{ mode, channel }`, exactly like Settings.
 */

export const UPDATE_MODES = ["auto", "notify", "off"] as const;
export type UpdateMode = typeof UPDATE_MODES[number];
export const MODE_LABEL: Record<UpdateMode, string> = { auto: "Install automatically", notify: "Tell me", off: "Off" };
export const MODE_HINT: Record<UpdateMode, string> = {
  auto: "Installs new versions when no agent is using Follow-up. Checked about every 6 hours.",
  notify: "Shows new versions here and on Home. You choose when to install.",
  off: "No checks on its own. You can still check and install from here.",
};
export const MODE_SHORT: Record<UpdateMode, string> = { auto: "installs automatically", notify: "tells you", off: "updates off" };
export const updatePhaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("checking") }),
  z.object({ kind: z.literal("available"), version: z.string(), publishedAt: z.string().nullable() }),
  /** Ready and allowed, waiting for a quiet moment. `busy` is what it waits on ("2 agents are mid-turn"), or null while settling. */
  z.object({ kind: z.literal("waiting"), version: z.string(), busy: z.string().nullable(), idleAt: z.number().nullable(), capAt: z.number(), capped: z.boolean() }),
  z.object({ kind: z.literal("installing"), version: z.string(), since: z.number() }),
  /** Installed; still inside the watch window that would roll it back. */
  z.object({ kind: z.literal("settling"), version: z.string(), from: z.string(), at: z.number(), until: z.number() }),
  z.object({ kind: z.literal("updated"), version: z.string(), from: z.string(), at: z.number() }),
  z.object({ kind: z.literal("rolled-back"), version: z.string(), from: z.string(), reason: z.string(), at: z.number() }),
  z.object({ kind: z.literal("install-failed"), version: z.string(), reason: z.string(), at: z.number() }),
  /** The version's provenance didn't check out: never installed automatically. */
  z.object({ kind: z.literal("untrusted"), version: z.string(), reason: z.string() }),
]);
export type UpdatePhase = z.infer<typeof updatePhaseSchema>;

export const historyEntrySchema = z.object({ at: z.number(), from: z.string(), to: z.string(), result: z.enum(["updated", "rolled-back", "failed", "skipped"]), reason: z.string().nullable() });
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const updatesViewSchema = z.object({
  version: z.string(),
  installKind: z.enum(INSTALL_KINDS),
  mode: z.enum(UPDATE_MODES),
  channel: z.enum(["stable", "beta"]),
  /** Newest version on each channel per the last check (null: nothing published, or never checked). */
  channels: z.object({ stable: z.string().nullable(), beta: z.string().nullable() }),
  checkedAt: z.number().nullable(),
  nextCheckAt: z.number().nullable(),
  /** The last check failed; what was known before is still shown. */
  registryError: z.string().nullable(),
  phase: updatePhaseSchema,
  /** Notes for the pending version(s), newest first, when known. */
  pendingNotes: z.array(noteSchema),
  history: z.array(historyEntrySchema),
  /** The Home line, if one should show (dismissed ones are already filtered out). */
  notice: z.object({ id: z.string(), kind: z.enum(["available", "rolled-back"]), version: z.string(), from: z.string().nullable() }).nullable(),
  /** 2.0's one-time move to the new plugin id (shared/plugin-move.ts); absent or null when there's nothing to say. */
  move: moveViewSchema.nullable().optional(),
});
export type UpdatesView = z.infer<typeof updatesViewSchema>;

export const setUpdatesInputSchema = z.strictObject({ mode: z.enum(UPDATE_MODES).optional(), channel: z.enum(["stable", "beta"]).optional() });

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
};
/** A reason from the server, as a sentence: the next sentence never runs into it. */
export const sentence = (s: string) => { const t = s.trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };
const within = (ms: number) => { const m = Math.max(1, Math.round(ms / 60_000)); return m === 1 ? "the next minute" : m < 60 ? `the next ${m} minutes` : Math.round(m / 60) === 1 ? "the next hour" : `the next ${Math.round(m / 60)} hours`; };
const inAbout = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
};
export const checkedText = (checkedAt: number | null, now: number) => checkedAt == null ? "Not checked yet" : `Checked ${ago(now - checkedAt)}`;
const clock = (at: number, now: number) => {
  const d = new Date(at), n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.toDateString() === n.toDateString();
  const tomorrow = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).toDateString() === d.toDateString();
  return sameDay ? hm : tomorrow ? `${hm} tomorrow` : `${hm} on ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
};
const channelName = (c: Channel) => c === "beta" ? "Beta" : "Stable";

export type Tone = "success" | "warning" | "muted";
export type StatusAction = "check" | "install" | "install-anyway" | "retry" | "copy-details" | "copy-command" | "view-npm" | "whats-new";
export type StatusCopy = { icon: string; tone: Tone; title: string; detail: string; primary: StatusAction | null; secondary: StatusAction[]; spinning?: boolean };

/** The status card: one glyph, one sentence, one line of why, and the actions that fit. */
export function statusCopy(view: UpdatesView, now: number): StatusCopy {
  const p = view.phase;
  if (view.installKind !== "npm") {
    const from = view.installKind === "directory" ? "a local folder" : view.installKind === "git" ? "a Git checkout" : view.installKind === "registry" ? "the Paseo plugin registry" : "a source Follow-up can't update";
    const how = view.installKind === "registry" ? "Paseo's own plugin updates manage it." : "Pull and rebuild to update.";
    return { icon: "GitBranch", tone: "muted", title: "Updates are managed by your checkout", detail: `Installed from ${from} (${view.version}). ${how}`, primary: null, secondary: [] };
  }
  switch (p.kind) {
    case "checking":
      return { icon: "RefreshCw", tone: "muted", title: "Checking for updates…", detail: `Asking npm for the newest ${view.channel === "beta" ? "beta" : "stable release"}.`, primary: null, secondary: [], spinning: true };
    case "available":
      if (view.mode === "auto") return { icon: "CircleArrowUp", tone: "muted", title: `Update available: ${p.version}`, detail: "Installs at the next quiet moment, when no agent is using Follow-up.", primary: null, secondary: ["install", "check"] };
      return { icon: "CircleArrowUp", tone: "warning", title: `Update available: ${p.version}`,
        detail: view.mode === "off" ? "Automatic updates are off." : `${p.publishedAt ? `Released ${new Date(p.publishedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}. ` : ""}Installing reloads Follow-up for a few seconds.`,
        primary: "install", secondary: ["check"] };
    case "waiting": {
      const why = p.busy ? `${p.busy[0]!.toUpperCase()}${p.busy.slice(1)}.` : p.idleAt ? `Waiting for 5 idle minutes (${inAbout(p.idleAt - now)} left).` : "Waiting for 5 idle minutes.";
      const cap = p.capped ? " It has waited a day, so it installs the moment nothing is running." : now - (p.capAt - 24 * 3_600_000) > 3_600_000 ? ` It installs no later than the first idle moment after ${clock(p.capAt, now)}.` : "";
      return { icon: "Clock", tone: "muted", title: `Waiting to install ${p.version}`, detail: `${why}${cap}`, primary: null, secondary: ["install-anyway"] };
    }
    case "installing":
      return { icon: "Download", tone: "muted", title: `Installing ${p.version}…`, detail: "Follow-up reloads when it finishes, usually in under a minute. This page comes back by itself.", primary: null, secondary: [], spinning: true };
    case "settling":
      return { icon: "CircleCheck", tone: "success", title: `Updated to ${p.version}`, detail: `${ago(now - p.at)[0]!.toUpperCase()}${ago(now - p.at).slice(1)}, from ${p.from}. If it fails within ${within(p.until - now)}, Follow-up goes back to ${p.from} by itself.`, primary: null, secondary: ["whats-new"] };
    case "updated":
      return { icon: "CircleCheck", tone: "success", title: `Up to date: ${p.version}`, detail: `Updated ${ago(now - p.at)} from ${p.from}.`, primary: null, secondary: ["check", "whats-new"] };
    case "rolled-back":
      return { icon: "Undo2", tone: "warning", title: `Update to ${p.version} failed, rolled back`, detail: `${sentence(p.reason)} You're on ${p.from} again. Follow-up won't try ${p.version} again on its own; it waits for the next version.`, primary: null, secondary: ["copy-details", "retry"] };
    case "install-failed":
      return { icon: "TriangleAlert", tone: "warning", title: `Couldn't install ${p.version}`, detail: `${sentence(p.reason)} Nothing changed. Follow-up tries again at the next check.`, primary: null, secondary: ["retry", "copy-details"] };
    case "untrusted":
      return { icon: "ShieldAlert", tone: "warning", title: `Not installed: can't confirm where ${p.version} came from`, detail: `${sentence(p.reason)} Follow-up won't install it automatically. Install it by hand only if you trust it.`, primary: null, secondary: ["copy-command", "view-npm"] };
    case "current":
    default: {
      if (view.registryError && view.checkedAt == null) return { icon: "CloudOff", tone: "muted", title: "Couldn't reach npm", detail: `${sentence(view.registryError)} Follow-up tries again later.`, primary: null, secondary: ["check"] };
      if (view.registryError) return { icon: "CloudOff", tone: "muted", title: "Couldn't reach npm", detail: `Last good check ${ago(now - view.checkedAt!)}.${view.nextCheckAt ? ` Follow-up tries again in about ${inAbout(view.nextCheckAt - now)}.` : ""}`, primary: null, secondary: ["check"] };
      if (view.mode === "off") return { icon: "CirclePause", tone: "muted", title: "Automatic updates are off", detail: `You're on ${view.version}. Follow-up doesn't check for updates on its own.`, primary: null, secondary: ["check"] };
      const next = view.nextCheckAt ? ` Next check in about ${inAbout(view.nextCheckAt - now)}.` : "";
      const ahead = view.channel === "stable" && (!view.channels.stable || compareVersions(view.channels.stable, view.version) < 0);
      return { icon: "CircleCheck", tone: "success", title: `Up to date: ${view.version}`, detail: `${ahead ? "Stable has nothing newer than this beta." : `${channelName(view.channel)} channel.`}${next}`, primary: null, secondary: ["check"] };
    }
  }
}

/** The Channel select's hint. Never assumes a stable release newer than a beta exists. */
export function channelHint(view: Pick<UpdatesView, "channel" | "version" | "channels">): string {
  if (view.channel === "beta") return `New features first, updated often.${/-/.test(view.version) ? ` You're on Beta because ${view.version} is a beta.` : ""}`;
  const stable = view.channels.stable;
  if (!stable) return `No stable release yet. You stay on ${view.version} until one comes out.`;
  if (compareVersions(stable, view.version) < 0) return `The newest stable, ${stable}, is older than yours. You stay on ${view.version} until a newer stable comes out.`;
  return "Tested releases, updated less often.";
}

/** General's line in the phone's Settings list: "Up to date · 1.4.0-beta.24", "Update available · 1.4.0-beta.25". */
export function generalSummary(view: Pick<UpdatesView, "version" | "installKind" | "phase">): string {
  if (view.installKind !== "npm") return `Follow-up ${view.version} · managed by your checkout`;
  const p = view.phase;
  switch (p.kind) {
    case "available": return `Update available · ${p.version}`;
    case "waiting": return `Waiting to install · ${p.version}`;
    case "untrusted": return `Not verified · ${p.version}`;
    case "installing": return `Installing ${p.version}`;
    case "rolled-back": return `Update to ${p.version} rolled back`;
    case "install-failed": return `Update to ${p.version} failed`;
    default: return `Up to date · ${view.version}`;
  }
}

/** The tab dot: only when something needs a look. */
export const needsLook = (view: Pick<UpdatesView, "installKind" | "mode" | "phase">) =>
  view.installKind === "npm" && (view.phase.kind === "rolled-back" || view.phase.kind === "untrusted" || view.phase.kind === "install-failed" || (view.phase.kind === "available" && view.mode !== "auto"));

export const copyCommand = (version: string) => `paseo plugin update follow-up --version ${version}`;
export type { ReleaseNote } from "./changelog";

/**
 * Home's version marker ("v1.4.0-beta.34"): the version the update check runs as (UpdatesView.version, from the
 * running plugin's own install), then a quiet word for the update state. The dot is the tab dot (needsLook): only
 * when something needs the developer, never for an update that's already on its way. Never a popup.
 */
export function versionMark(view: Pick<UpdatesView, "version" | "installKind" | "mode" | "phase">): { version: string; suffix: string | null; dot: boolean; label: string } {
  const k = view.phase.kind;
  const suffix = k === "available" ? "update" : k === "waiting" || k === "installing" ? "updating" : k === "install-failed" || k === "rolled-back" || k === "untrusted" ? "check" : null;
  const said = { update: "update available", updating: "update on its way", check: "the last update needs a look" } as const;
  return { version: `v${view.version}`, suffix, dot: needsLook(view), label: `Follow-up version ${view.version}${suffix ? `, ${said[suffix as keyof typeof said]}` : ""}` };
}
