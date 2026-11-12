import { z } from "zod";
import { resourcesSchema } from "./resources";

/**
 * Provider session limits at a glance (1.3.0-beta.2), read from the Smart Session plugin. One meter per provider
 * ("Claude 5h 62% · 7d 41% · resets 14:10"); with ZeroSub running several accounts, the meter shows the default
 * one and its detail lists each. Amber from 80%, red at the limit.
 */
export const FAMILIES = ["claude", "codex"] as const;
export type Family = typeof FAMILIES[number];
export const FAMILY_LABEL: Record<Family, string> = { claude: "Claude", codex: "Codex" };

const windowSchema = z.object({ id: z.string(), label: z.string(), pct: z.number(), resetsAt: z.string().nullable() });
const accountSchema = z.object({ id: z.string(), name: z.string(), family: z.enum(FAMILIES), isDefault: z.boolean(), windows: z.array(windowSchema), readAt: z.string().nullable() });
export const usageSchema = z.object({
  /** False when Smart Session isn't installed or has nothing: the meters are hidden, no error. */
  available: z.boolean(),
  source: z.enum(["rpc", "file"]).nullable(),
  accounts: z.array(accountSchema),
  /** 1.3.0-beta.4: the VM's memory and CPU for Home's meter. Absent from older workers. */
  resources: resourcesSchema.optional(),
});
export type UsageWindow = z.infer<typeof windowSchema>;
export type UsageAccount = z.infer<typeof accountSchema>;
export type Usage = z.infer<typeof usageSchema>;
export const NO_USAGE: Usage = { available: false, source: null, accounts: [] };

const WINDOW_LABEL: Record<string, string> = { five_hour: "5h", seven_day: "7d" };
/** The windows a meter shows, in order; others (per-model weeks) only appear in the detail. */
export const METER_WINDOWS = ["five_hour", "seven_day"];
export const windowLabel = (id: string) => WINDOW_LABEL[id] ?? id.replace(/_/g, " ").replace(/^weekly /, "7d ");
const pct = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
const iso = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
const isFamily = (v: unknown): v is Family => v === "claude" || v === "codex";
function windowsOf(list: { id: string; pct: unknown; resetsAt?: unknown }[]): UsageWindow[] {
  return list.flatMap(w => { const p = pct(w.pct); return p === null ? [] : [{ id: w.id, label: windowLabel(w.id), pct: p, resetsAt: iso(w.resetsAt) }]; });
}

type Subscriptions = { zerosub?: boolean; accounts?: { id: string; family: string; name?: string; isDefault?: boolean; signedIn?: boolean; disabled?: boolean; readAt?: string | null; windows?: { id: string; pct: number; resetsAt: string | null }[] }[] };
/** `smart-session.subscriptions`: every ZeroSub account that's signed in and enabled. */
export function fromSubscriptions(out: unknown): UsageAccount[] {
  const o = out as Subscriptions | null;
  if (!o?.zerosub || !Array.isArray(o.accounts)) return [];
  return o.accounts.filter(a => isFamily(a.family) && a.signedIn !== false && !a.disabled)
    .map(a => ({ id: a.id, name: a.name || a.id, family: a.family as Family, isDefault: !!a.isDefault, windows: windowsOf(a.windows ?? []), readAt: iso(a.readAt) }))
    .filter(a => a.windows.length > 0);
}

type Budget = { windows?: { id: string; pct: number; resetsAt: string | null }[]; recorder?: { newestAt?: string | null } };
/** `smart-session.budget` without ZeroSub: the CLI login's Claude windows. */
export function fromBudget(out: unknown): UsageAccount[] {
  const o = out as Budget | null;
  const windows = windowsOf(o?.windows ?? []);
  return windows.length ? [{ id: "claude-cli", name: "CLI login", family: "claude", isDefault: true, windows, readAt: iso(o?.recorder?.newestAt) }] : [];
}

/** The fallback: Smart Session's accounts-YYYY-MM.jsonl. The newest row per account wins; bad lines are skipped. */
export function fromAccountRows(text: string): UsageAccount[] {
  const latest = new Map<string, { family: Family; windows: UsageWindow[]; readAt: string | null; name: string | null }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: { accountId?: unknown; family?: unknown; windows?: Record<string, { pct?: unknown; resetsAt?: unknown } | null>; fetchedAt?: unknown; at?: unknown; account?: unknown };
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.accountId !== "string" || !isFamily(row.family) || !row.windows || typeof row.windows !== "object") continue;
    const readAt = iso(row.fetchedAt) ?? iso(row.at);
    const prior = latest.get(row.accountId);
    if (prior && (prior.readAt ?? "") > (readAt ?? "")) continue;
    const windows = windowsOf(Object.entries(row.windows).filter(([, w]) => w && typeof w === "object").map(([id, w]) => ({ id, pct: w!.pct, resetsAt: w!.resetsAt })));
    if (windows.length) latest.set(row.accountId, { family: row.family, windows, readAt, name: typeof row.account === "string" ? row.account : null });
  }
  const out = [...latest.entries()].map(([id, a]) => ({ id, name: a.name ?? (id.endsWith("-main") ? "Main" : id), family: a.family, isDefault: id.endsWith("-main"), windows: a.windows, readAt: a.readAt }));
  // Without a "-main" account per family, the first one stands for it.
  for (const f of FAMILIES) { const list = out.filter(a => a.family === f); if (list.length && !list.some(a => a.isDefault)) list[0].isDefault = true; }
  return out;
}

export type Tone = "ok" | "warning" | "danger";
/** Amber from 80%, red at the limit. */
export function toneOf(p: number): Tone { return p >= 100 ? "danger" : p >= 80 ? "warning" : "ok"; }

export type Meter = {
  family: Family; label: string;
  /** The default account's 5h and 7d windows. */
  windows: UsageWindow[];
  tone: Tone;
  /** The reset of the fullest shown window: when room comes back. */
  resetsAt: string | null;
  /** Shown when older than 15 minutes. */
  readAt: string | null;
  stale: boolean;
  accounts: UsageAccount[];
};
export const STALE_MS = 15 * 60_000;

export function meters(usage: Usage, now: number): Meter[] {
  if (!usage.available) return [];
  return FAMILIES.flatMap(family => {
    const accounts = usage.accounts.filter(a => a.family === family);
    const main = accounts.find(a => a.isDefault) ?? accounts[0];
    if (!main) return [];
    const windows = METER_WINDOWS.flatMap(id => main.windows.filter(w => w.id === id));
    const shown = windows.length ? windows : main.windows.slice(0, 1);
    const fullest = [...shown].sort((a, b) => b.pct - a.pct)[0];
    const stale = !!main.readAt && now - Date.parse(main.readAt) > STALE_MS;
    return [{ family, label: FAMILY_LABEL[family], windows: shown, tone: toneOf(fullest?.pct ?? 0), resetsAt: fullest?.resetsAt ?? null, readAt: main.readAt, stale, accounts }];
  });
}

/**
 * What the meters show, as a key for the usage feed (server/feeds.ts): percentages rounded as displayed, the reset
 * times, and how old the reading is in five-minute steps (the "40m old" tag). A new reading with the same numbers
 * pushes nothing.
 */
export function usageKey(usage: Usage | null): string {
  if (!usage) return "none";
  return JSON.stringify([usage.available, usage.source, usage.accounts.map(a => [a.id, a.family, !!a.isDefault,
    a.readAt ? Math.floor(Date.parse(a.readAt) / 300_000) : null, a.windows.map(w => [w.id, Math.round(w.pct), w.resetsAt])])]);
}

/** "14:10" today, "Tue 14:10" later this week, else a date. */
export function resetLabel(at: string | null, now: number): string | null {
  if (!at) return null;
  const d = new Date(at); const n = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === n.toDateString()) return time;
  if (d.getTime() - now < 6 * 86_400_000) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "Claude 5h 62% · 7d 41% · resets 14:10" (plus "· 40m old" when stale). */
export function meterText(m: Meter, now: number): string {
  const parts = [m.windows.map(w => `${w.label} ${w.pct}%`).join(" · ")];
  const reset = m.tone !== "ok" || m.windows.length ? resetLabel(m.resetsAt, now) : null;
  if (reset) parts.push(`resets ${reset}`);
  if (m.stale && m.readAt) parts.push(`${ageText(now - Date.parse(m.readAt))} old`);
  return `${m.label} ${parts.join(" · ")}`;
}
const ageText = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/** Smart Session's recorder ticks every minute; polling faster only repeats it. */
export const USAGE_POLL_MS = 60_000;
