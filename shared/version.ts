/**
 * Version ordering and channel selection for Follow-up's own updates. Pure: no registry access, no clock.
 * Semver 2.0 precedence, including prerelease identifiers (1.4.0-beta.2 < 1.4.0-beta.10 < 1.4.0).
 */

export type Version = { major: number; minor: number; patch: number; pre: (string | number)[]; raw: string };
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw: string): Version | null {
  const m = SEMVER.exec(raw.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map(p => /^\d+$/.test(p) ? Number(p) : p) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, raw: raw.trim().replace(/^v/, "") };
}

/** Negative when a < b, 0 when equal, positive when a > b. Unparseable versions sort below everything. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
  // A release ranks above any of its prereleases.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1; // numeric identifiers rank below alphanumeric ones
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
export const isNewer = (candidate: string, installed: string) => compareVersions(candidate, installed) > 0;
export const isPrerelease = (v: string) => (parseVersion(v)?.pre.length ?? 0) > 0;

export type Channel = "stable" | "beta";
export const CHANNELS: readonly Channel[] = ["stable", "beta"];
export const isChannel = (v: unknown): v is Channel => v === "stable" || v === "beta";
/** npm dist-tag behind each channel. */
export const CHANNEL_TAG: Record<Channel, string> = { stable: "latest", beta: "beta" };
/** Without a saved choice, the channel follows what is installed: a prerelease means Beta. */
export const defaultChannel = (installed: string): Channel => isPrerelease(installed) ? "beta" : "stable";

export type DistTags = Partial<Record<string, string>>;
/**
 * The version a channel offers. Stable offers only `latest`. Beta offers the newer of `beta` and `latest`, so a
 * stable release that overtakes the last beta still reaches beta users. Tags that point at versions the registry
 * didn't list, or that don't parse, are ignored. Returns null when the channel has no published version at all.
 */
export function channelVersion(channel: Channel, tags: DistTags, published?: readonly string[]): string | null {
  const known = (v: string | undefined): v is string => !!v && !!parseVersion(v) && (!published || published.includes(v));
  const candidates = (channel === "beta" ? [tags.beta, tags.latest] : [tags.latest]).filter(known);
  if (channel === "stable") return candidates.filter(v => !isPrerelease(v))[0] ?? null;
  return candidates.sort((a, b) => compareVersions(b, a))[0] ?? null;
}

export type UpdateOffer =
  | { kind: "update"; version: string }
  /** The channel's newest version is the installed one. */
  | { kind: "current"; version: string }
  /** The channel's newest version is older than what is installed (e.g. Stable while on a beta). Never offered. */
  | { kind: "behind"; version: string }
  /** The channel has nothing published yet. */
  | { kind: "none" };
/** Only ever offers a strictly newer version. */
export function offerFor(installed: string, channel: Channel, tags: DistTags, published?: readonly string[]): UpdateOffer {
  const version = channelVersion(channel, tags, published);
  if (!version) return { kind: "none" };
  const c = compareVersions(version, installed);
  return c > 0 ? { kind: "update", version } : c === 0 ? { kind: "current", version } : { kind: "behind", version };
}
