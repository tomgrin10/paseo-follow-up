import type { Fetch } from "./update-registry";
import { packageUrl } from "./update-registry";

/**
 * Where a version came from, before Follow-up installs it on its own. npm publishes each version with a SLSA
 * provenance statement (an in-toto statement in a DSSE envelope, signed through Sigstore). Follow-up reads that
 * statement and checks two things: its subject's sha512 is the tarball npm will hand Paseo (`dist.integrity`), and it
 * was built by this repository's workflow.
 *
 * What this is not: Follow-up does not verify the Sigstore signature or certificate chain itself. The statement comes
 * from the same registry as the tarball, so this catches a version published by hand or from another repository (a
 * leaked npm token without the GitHub workflow), not a compromised registry. The integrity it checks is then pinned:
 * Paseo's installer refuses a tarball whose integrity differs from the one reviewed here.
 */

export const SOURCE_REPOSITORY = "https://github.com/tomgrin10/paseo-follow-up";
const SLSA = /^https:\/\/slsa\.dev\/provenance\/v1/;

export type Provenance =
  | { ok: true; version: string; integrity: string; tarball: string; workflow: string; publishedAt: string | null }
  | { ok: false; version: string; reason: string; retry: boolean };

/** "sha512-<base64>" → hex, or null for any other algorithm. */
export function integrityHex(integrity: string): string | null {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  return m ? Buffer.from(m[1]!, "base64").toString("hex") : null;
}

type Statement = { subject?: { name?: string; digest?: { sha512?: string } }[]; predicate?: { buildDefinition?: { externalParameters?: { workflow?: { repository?: string; path?: string; ref?: string } } } } };

/** The checks on an already-decoded statement. Pure, for tests. */
export function judgeStatement(statement: Statement, input: { name: string; version: string; integrity: string; repository?: string }): string | null {
  const hex = integrityHex(input.integrity);
  if (!hex) return "npm doesn't list a sha512 checksum for it.";
  const subject = statement.subject?.find(s => s.name === `pkg:npm/${input.name}@${input.version}`);
  if (!subject) return "Its provenance names a different package or version.";
  if (subject.digest?.sha512?.toLowerCase() !== hex) return "Its provenance is for a different file than the one npm serves.";
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const repo = (workflow?.repository ?? "").replace(/\.git$/, "").replace(/\/$/, "");
  if (repo !== (input.repository ?? SOURCE_REPOSITORY)) return repo ? `It was built from ${repo.replace(/^https:\/\//, "")}, not ${(input.repository ?? SOURCE_REPOSITORY).replace(/^https:\/\//, "")}.` : "Its provenance doesn't say which repository built it.";
  return null;
}

/** One version's provenance. Two requests: the version's metadata, then its attestations. Only run for a new version. */
export async function checkProvenance(input: { fetch: Fetch; registry: string; name: string; version: string; repository?: string; timeoutMs?: number }): Promise<Provenance> {
  const { fetch, registry, name, version } = input;
  const fail = (reason: string, retry = false): Provenance => ({ ok: false, version, reason, retry });
  const get = async (url: string) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), input.timeoutMs ?? 20_000);
    try { return await fetch(url, { headers: { accept: "application/json" }, signal: abort.signal }); } finally { clearTimeout(timer); }
  };
  let meta: { dist?: { integrity?: string; tarball?: string; attestations?: { url?: string; provenance?: { predicateType?: string } } } };
  try {
    const res = await get(`${packageUrl(registry, name)}/${encodeURIComponent(version)}`);
    if (res.status !== 200) return fail(`npm answered ${res.status} for ${version}.`, res.status >= 500);
    meta = await res.json() as typeof meta;
  } catch { return fail("Couldn't reach npm to check where it came from.", true); }
  const integrity = meta.dist?.integrity, tarball = meta.dist?.tarball, url = meta.dist?.attestations?.url;
  if (!integrity || !tarball) return fail("npm doesn't list its file and checksum.");
  if (!url) return fail("It was published without provenance.");
  let bundle: { attestations?: { predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string; payloadType?: string } } }[] };
  try {
    const res = await get(url);
    if (res.status !== 200) return fail(`npm answered ${res.status} for its provenance.`, res.status >= 500);
    bundle = await res.json() as typeof bundle;
  } catch { return fail("Couldn't reach npm to check where it came from.", true); }
  const slsa = bundle.attestations?.find(a => SLSA.test(a.predicateType ?? ""));
  const payload = slsa?.bundle?.dsseEnvelope?.payload;
  if (!payload) return fail("It was published without provenance.");
  let statement: Statement;
  try { statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Statement; } catch { return fail("Its provenance can't be read."); }
  const problem = judgeStatement(statement, { name, version, integrity, repository: input.repository });
  if (problem) return fail(problem);
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  return { ok: true, version, integrity, tarball, workflow: `${workflow?.path ?? "?"}@${workflow?.ref ?? "?"}`, publishedAt: null };
}

/**
 * The release notes inside a version's tarball (package/CHANGELOG.md), for Settings to show before installing. One
 * download per new version (the same file Paseo installs, a few hundred KB), checked against the integrity that
 * provenance confirmed. Returns null when it can't be read; nothing else in the tarball is looked at.
 */
export async function tarballChangelog(input: { fetch: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>; tarball: string; integrity: string; timeoutMs?: number; maxBytes?: number }): Promise<string | null> {
  const { createHash } = await import("node:crypto");
  const { gunzipSync } = await import("node:zlib");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), input.timeoutMs ?? 30_000);
  try {
    const res = await input.fetch(input.tarball, { headers: { accept: "application/octet-stream" }, signal: abort.signal });
    if (res.status !== 200) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > (input.maxBytes ?? 20 << 20)) return null;
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== input.integrity) return null;
    return tarFile(gunzipSync(bytes, { maxOutputLength: 80 << 20 }), "package/CHANGELOG.md");
  } catch { return null; } finally { clearTimeout(timer); }
}

/** One file from an uncompressed ustar archive, by path. */
export function tarFile(tar: Buffer, path: string): string | null {
  const field = (b: Buffer) => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString("utf8"); };
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every(x => x === 0)) return null;
    const name = field(header.subarray(0, 100)), prefix = field(header.subarray(345, 500));
    const size = parseInt(field(header.subarray(124, 136)).trim() || "0", 8);
    const full = prefix ? `${prefix}/${name}` : name;
    if (!Number.isFinite(size) || size < 0) return null;
    if (full === path) return tar.subarray(at + 512, at + 512 + size).toString("utf8");
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}
