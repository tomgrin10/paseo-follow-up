import { z } from "zod";
import { compareVersions, parseVersion } from "./version";

/**
 * Release notes: CHANGELOG.md parsing and the What's-new selection. Pure, so parsing, "since last seen" and the
 * first-install rule are testable without a client.
 *
 * Format: `## <version> (<yyyy-mm-dd>)` headings, newest first, each followed by `- ` bullets. Anything before the
 * first version heading is a preamble and is ignored. A bullet may wrap onto indented continuation lines. A `<details>`
 * line ends the notes: older history (the 1.1-1.4 betas) is archived below one, for people reading CHANGELOG.md, and
 * never shows in What's new. Image lines (`![…](…)`) are left out; the in-app sheet is text only.
 *
 * Release candidates of a major (2.0.0-rc.0) carry that major's own section (`## 2.0.0`): betas ship no notes, and the
 * rc is where 2.0's notes first reach people. `notesVersion` maps a version to the section it carries.
 */

/** The notes section a version carries: X.0.0-rc.N carries X.0.0's; every other version its own. */
export function notesVersion(version: string): string {
  const p = parseVersion(version);
  return p && p.minor === 0 && p.patch === 0 && p.pre[0] === "rc" ? `${p.major}.0.0` : version;
}
/** A release candidate of a major: X.0.0-rc.N. */
export const isMajorRc = (version: string): boolean => notesVersion(version) !== version;

export type ReleaseNote = { version: string; date: string | null; items: string[] };
const HEADING = /^##\s+v?(\S+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/;

export function parseChangelog(text: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  let current: ReleaseNote | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*<details/i.test(line)) break;
    const heading = HEADING.exec(line);
    if (heading) {
      current = parseVersion(heading[1]!) ? { version: heading[1]!, date: heading[2] ?? null, items: [] } : null;
      if (current) notes.push(current);
      continue;
    }
    if (/^#{1,2}\s/.test(line)) { current = null; continue; }
    if (!current) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) current.items.push(bullet[1]!.trim());
    else if (/^\s+\S/.test(line) && current.items.length) current.items[current.items.length - 1] += ` ${line.trim()}`;
  }
  return notes.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Every version after `lastSeen` up to and including `installed`, newest first. Versions newer than the installed
 * one (notes shipped ahead) are left out. Without a `lastSeen` there is nothing to catch up on.
 */
export function notesSince(notes: readonly ReleaseNote[], lastSeen: string | null, installed: string): ReleaseNote[] {
  if (!lastSeen) return [];
  const from = notesVersion(lastSeen), to = notesVersion(installed);
  return notes
    .filter(n => compareVersions(n.version, from) > 0 && compareVersions(n.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

export type WhatsNewInput = {
  installed: string;
  /** The last version this device acknowledged, or null when it never stored one. */
  deviceSeen: string | null;
  /**
   * The daemon's own record: the version Follow-up ran before the current one, or null on a fresh install. It is
   * the baseline for a device that never stored a version (a new device, or the first version with release notes).
   */
  previous: string | null;
  /** Onboarding is showing or not finished: never cover it. */
  onboarding: boolean;
  notes: readonly ReleaseNote[];
};
export type WhatsNew =
  | { show: true; notes: ReleaseNote[] }
  /** `record` is the version to store as seen without showing anything (first install, downgrade, nothing new). */
  | { show: false; reason: "first-run" | "onboarding" | "seen" | "older" | "not-major" | "no-notes"; record: string | null };

/**
 * The major a version belongs to once released: a beta of X.0.0 (2.0.0-beta.1) is still before X, while a release
 * candidate (2.0.0-rc.0) is X: it carries X's notes, so 1.x to rc.0 announces 2.0 once, and rc.N to X.0.0 doesn't again.
 */
function releasedMajor(v: string): number | null {
  const p = parseVersion(v);
  if (!p) return null;
  return p.pre.length && p.minor === 0 && p.patch === 0 && !isMajorRc(v) ? p.major - 1 : p.major;
}

/**
 * The one rule for every prompt Follow-up makes about its own updates (the What's new sheet, and any update notice):
 * only a newly released major version earns one (1.x to 2.0). Betas, minors and patches are recorded quietly; their
 * changes wait in changes/ and ship in the next stable release's notes. A first install (no `from`) is never announced.
 */
export function announcesUpdate(from: string | null, to: string): boolean {
  if (!from) return false;
  const a = releasedMajor(from), b = releasedMajor(to);
  return a != null && b != null && b > a;
}

/**
 * Whether this device shows "What's new" now. With no baseline at all (no device record and no previous daemon
 * version) this is a first install: onboarding covers it, so the installed version is recorded silently. Onboarding
 * wins over the sheet and leaves the stored version alone, so the sheet can come after onboarding ends. Only a new
 * major opens it (announcesUpdate); any other update records the installed version silently.
 */
export function whatsNew({ installed, deviceSeen, previous, onboarding, notes }: WhatsNewInput): WhatsNew {
  if (onboarding) return { show: false, reason: "onboarding", record: null };
  const lastSeen = deviceSeen ?? previous;
  if (!lastSeen) return { show: false, reason: "first-run", record: installed };
  const c = compareVersions(installed, lastSeen);
  if (c === 0) return { show: false, reason: "seen", record: deviceSeen ? null : installed };
  if (c < 0) return { show: false, reason: "older", record: installed };
  if (!announcesUpdate(lastSeen, installed)) return { show: false, reason: "not-major", record: installed };
  const since = notesSince(notes, lastSeen, installed);
  return since.length ? { show: true, notes: since } : { show: false, reason: "no-notes", record: installed };
}

/** The last Follow-up version before release notes shipped; existing installs that predate the record start here. */
export const LEGACY_BASELINE = "1.4.0-beta.22";
export const LAST_SEEN_KEY = "follow-up.whats-new.seen";

/** Only npm installs can update themselves; everything else is the developer's own checkout. */
export const INSTALL_KINDS = ["npm", "git", "directory", "registry", "unknown"] as const;
export type InstallKind = typeof INSTALL_KINDS[number];

export const releaseNoteSchema = z.object({ version: z.string(), date: z.string().nullable(), items: z.array(z.string()) });
/** `follow.release-notes`: this host's version record and every shipped note. Read once per app session; never polled. */
export const releaseNotesViewSchema = z.object({
  version: z.string(),
  installKind: z.enum(INSTALL_KINDS),
  /** The version Follow-up ran before this one on this host, null on a fresh install (What's new baseline). */
  previous: z.string().nullable(),
  /** When this host first ran this version after another one (ms), else null. Home's "Updated to X 2h ago". */
  updatedAt: z.number().nullable(),
  /** The last version anyone on this host closed What's new for: the "seen" record for apps without local storage. */
  hostSeen: z.string().nullable(),
  /** Every shipped release note, newest first. */
  notes: z.array(releaseNoteSchema),
});
export type ReleaseNotesView = z.infer<typeof releaseNotesViewSchema>;

/**
 * Home's "Updated to X 2h ago · What's new" line shows for three days after an update to a version with notes of its
 * own. Betas ship none, so after one the line stays "Follow-up X · Release notes" rather than opening an empty sheet.
 */
export const RECENT_UPDATE_MS = 3 * 86_400_000;
export function recentUpdate(view: Pick<ReleaseNotesView, "version" | "previous" | "updatedAt" | "notes">, now: number): boolean {
  if (!view.previous || view.updatedAt == null || now - view.updatedAt < 0 || now - view.updatedAt >= RECENT_UPDATE_MS) return false;
  return view.notes.some(n => n.version === notesVersion(view.version) && n.items.length > 0);
}
/** The notes What's new shows when opened by hand: everything since the previous version, else this version's own. */
export function recentNotes(view: Pick<ReleaseNotesView, "version" | "previous" | "notes">): ReleaseNote[] {
  const since = notesSince(view.notes, view.previous, view.version);
  return since.length ? since : view.notes.filter(n => n.version === notesVersion(view.version));
}

/** "just now", "12m ago", "2h ago", "3 days ago". */
export function agoText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)} days ago`;
}
