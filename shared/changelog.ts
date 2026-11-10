import { z } from "zod";
import { compareVersions, parseVersion } from "./version";

/**
 * Release notes: CHANGELOG.md parsing and the What's-new selection. Pure, so parsing, "since last seen" and the
 * first-install rule are testable without a client.
 *
 * Format: `## <version> (<yyyy-mm-dd>)` headings, newest first, each followed by `- ` bullets. Anything before the
 * first version heading is a preamble and is ignored. A bullet may wrap onto indented continuation lines.
 */

export type ReleaseNote = { version: string; date: string | null; items: string[] };
const HEADING = /^##\s+v?(\S+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/;

export function parseChangelog(text: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  let current: ReleaseNote | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
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
  return notes
    .filter(n => compareVersions(n.version, lastSeen) > 0 && compareVersions(n.version, installed) <= 0)
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
  | { show: false; reason: "first-run" | "onboarding" | "seen" | "older" | "no-notes"; record: string | null };

/**
 * Whether this device shows "What's new" now. With no baseline at all (no device record and no previous daemon
 * version) this is a first install: onboarding covers it, so the installed version is recorded silently. Onboarding
 * wins over the sheet and leaves the stored version alone, so the sheet can come after onboarding ends.
 */
export function whatsNew({ installed, deviceSeen, previous, onboarding, notes }: WhatsNewInput): WhatsNew {
  if (onboarding) return { show: false, reason: "onboarding", record: null };
  const lastSeen = deviceSeen ?? previous;
  if (!lastSeen) return { show: false, reason: "first-run", record: installed };
  const c = compareVersions(installed, lastSeen);
  if (c === 0) return { show: false, reason: "seen", record: deviceSeen ? null : installed };
  if (c < 0) return { show: false, reason: "older", record: installed };
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

/** Home's "Updated to X 2h ago · What's new" line shows for three days after an update. */
export const RECENT_UPDATE_MS = 3 * 86_400_000;
export function recentUpdate(view: Pick<ReleaseNotesView, "previous" | "updatedAt">, now: number): boolean {
  return !!view.previous && view.updatedAt != null && now - view.updatedAt >= 0 && now - view.updatedAt < RECENT_UPDATE_MS;
}
/** The notes What's new shows when opened by hand: everything since the previous version, else this version's own. */
export function recentNotes(view: Pick<ReleaseNotesView, "version" | "previous" | "notes">): ReleaseNote[] {
  const since = notesSince(view.notes, view.previous, view.version);
  return since.length ? since : view.notes.filter(n => n.version === view.version);
}
