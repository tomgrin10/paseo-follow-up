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
