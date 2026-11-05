import { z } from "zod";

/**
 * The workspace's spec link: usually a Claude artifact the main agent keeps up to date.
 * Precedence: the developer's choice, then the main agent's set_spec, then detection from
 * completed Artifact publishes in the workspace's root sessions.
 */
export const SPEC_SOURCES = ["developer", "agent", "detected"] as const;
export type SpecSource = (typeof SPEC_SOURCES)[number];

const httpsUrl = z.string().trim().max(2000).url().refine(v => /^https:\/\//i.test(v), "Use an https:// link");
export const specSchema = z.object({
  // null with source "developer" means the developer removed the link; detection stays off until they reset it.
  url: httpsUrl.nullable(),
  title: z.string().trim().max(120).nullable().default(null),
  source: z.enum(SPEC_SOURCES),
  by: z.string().nullable().default(null),
  at: z.string(),
});
export const artifactSchema = z.object({
  url: httpsUrl,
  title: z.string().trim().max(120).nullable().default(null),
  by: z.string().nullable().default(null),
  firstAt: z.string().nullable().default(null),
  lastAt: z.string().nullable().default(null),
  publishes: z.number().int().positive().default(1),
});
export type Spec = z.infer<typeof specSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export const MAX_ARTIFACTS = 8;

export const CLAUDE_ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+$/;
export const isClaudeArtifact = (url: string) => CLAUDE_ARTIFACT.test(url);

/** What to call the link: its title, else "Claude artifact" or the site's host. */
export function specLabel(spec: Pick<Spec, "url" | "title">): string {
  if (spec.title) return spec.title;
  if (!spec.url) return "Spec";
  if (isClaudeArtifact(spec.url)) return "Claude artifact";
  try { return new URL(spec.url).host.replace(/^www\./, ""); } catch { return "Spec"; }
}

export function validSpecUrl(value: string): string | null {
  const url = value.trim();
  return httpsUrl.safeParse(url).success ? url : null;
}
