import { z } from "zod";

/**
 * Rename with AI (docs/ai-roles.md#rename-with-ai): a short workspace name from what Follow-up already stored.
 * Pure: the name rules, the prompt and the ledger's Undo rules, shared by the worker, the dialog and the tests.
 */

export const NAME_MAX_CHARS = 60;
export const NAME_MAX_WORDS = 8;
/** Suggestions a day (each model run counts, a retry too). Separate from Summaries' cap. */
export const RENAME_DAILY_CAP = 30;
/** How long a rename stays undoable after the toast is gone: the tool's `undo` and the dialog's link. */
export const UNDO_WINDOW_MS = 24 * 60 * 60_000;

const ISSUE_KEY = /^([A-Z][A-Z0-9]{1,9}-\d{1,7})$/;
const KEY_PREFIX = /^([A-Z][A-Z0-9]{1,9}-\d{1,7})\s*:\s*(.*)$/;
const QUOTES = /["`“”„«»]|^'|'$|‘|’(?=\s|$)|^’/;
/** "feat/x", "fix: x", "chore(x): x": the shapes of a branch or a commit subject, not a name. */
const BRANCH_PREFIX = /^(feat|fix|chore|refactor|docs|test|tests|ci|build|perf|style|wip|hotfix|release)(\([^)]*\))?[:/!]/i;

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/** Collapses whitespace and drops one trailing period: a name, not a sentence. */
export function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().replace(/(?<!\.)\.$/, "").trim();
}

/**
 * The one rule for a workspace name, for the model's reply and for the developer's edit alike. `keys`: Linear keys
 * linked to the workspace; only those may lead the name ("ABC-123: Fix …"), and the key isn't counted as a word.
 * `current`: the name it has now; the same name is no rename.
 */
export function checkName(raw: string, opts: { keys?: readonly string[]; current?: string | null } = {}): NameCheck {
  const name = normalizeName(raw);
  if (!name) return { ok: false, reason: "Give it a name." };
  if (name.length > NAME_MAX_CHARS) return { ok: false, reason: `Keep it to ${NAME_MAX_CHARS} characters (now ${name.length}).` };
  if (QUOTES.test(name)) return { ok: false, reason: "Leave out quotes and backticks." };
  if (/[\n\r\t<>{}[\]|\\]/.test(name)) return { ok: false, reason: "Use plain words." };
  if (ISSUE_KEY.test(name)) return { ok: false, reason: "Add a few words after the issue key." };
  let body = name;
  const prefixed = KEY_PREFIX.exec(name);
  if (prefixed) {
    const key = prefixed[1];
    if (!(opts.keys ?? []).includes(key)) return { ok: false, reason: `${key} isn't linked to this workspace, so leave it out.` };
    body = prefixed[2].trim();
    if (!body) return { ok: false, reason: "Add a few words after the issue key." };
  }
  if (BRANCH_PREFIX.test(body) || /\//.test(body) || /^[\w.-]+$/.test(body) && /[-_]/.test(body)) return { ok: false, reason: "Use words, not a branch name." };
  const words = body.split(" ").filter(Boolean);
  if (words.length > NAME_MAX_WORDS) return { ok: false, reason: `Keep it to ${NAME_MAX_WORDS} words (now ${words.length}).` };
  if (opts.current && opts.current.trim().toLowerCase() === name.toLowerCase()) return { ok: false, reason: "That's the name it has now." };
  return { ok: true, name };
}

/** What the prompt is built from. Stored data only: nothing here reads a chat or loads an agent. */
export type RenameInputs = {
  current: string;
  branch: string | null;
  goal: string | null;
  summary: string | null;
  spec: string | null;
  prs: string[];
  linked: { key: string; title: string | null }[];
  agents: string[];
};

export const RENAME_SYSTEM = "You name software workspaces. Reply with one JSON object only, no prose and no code fence. Use only facts in the material.";

/** Real-shaped examples (anonymised) of how the developer's workspaces read. */
export const NAME_EXAMPLES = [
  "Verify vendor mismatch and check migrations",
  "Plan admin page for schema migrations",
  "Fix retry backoff in the billing worker",
  "ABC-1234: Add CSV export to the audit log",
];

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The prompt, bounded (~3 k chars at most). `rejected`: the last reply and why, for the one retry. */
export function renamePrompt(i: RenameInputs, rejected?: { name: string; reason: string } | null): string {
  const keys = i.linked.map(l => l.key).filter(k => ISSUE_KEY.test(k));
  const lines = [
    "Write a short name for this workspace: what the work does, so the developer can tell it apart in a list.",
    `Rules: sentence case, start with a verb, specific, at most ${NAME_MAX_WORDS} words and ${NAME_MAX_CHARS} characters, no quotes, no branch names, no trailing period.`,
    keys.length ? `It may start with one linked issue key and a colon (${keys.slice(0, 3).join(", ")}); never only the key.` : "Don't add an issue key.",
    `Examples of good names:\n${NAME_EXAMPLES.map(e => `- ${e}`).join("\n")}`,
    "",
    `Current name: ${clip(i.current, 120)}`,
    i.branch && `Branch: ${clip(i.branch, 120)}`,
    i.goal && `Goal: ${clip(i.goal, 400)}`,
    i.summary && `Summary: ${clip(i.summary, 400)}`,
    i.spec && `Spec: ${clip(i.spec, 120)}`,
    i.prs.length > 0 && `Pull requests:\n${i.prs.slice(0, 8).map(p => `- ${clip(p, 140)}`).join("\n")}`,
    i.linked.length > 0 && `Linked items:\n${i.linked.slice(0, 6).map(l => `- ${l.key}${l.title ? `: ${clip(l.title, 140)}` : ""}`).join("\n")}`,
    i.agents.length > 0 && `Agent titles:\n${i.agents.slice(0, 8).map(a => `- ${clip(a, 100)}`).join("\n")}`,
    "",
    rejected && `Your last answer "${clip(rejected.name, 100)}" was rejected: ${rejected.reason} Try again.`,
    'Reply: {"name": "<the name>"}',
  ];
  return lines.filter(l => typeof l === "string").join("\n");
}
export const renameReplySchema = z.object({ name: z.string().max(300) });

/** One applied rename. `from: null`: the workspace had no title of its own (Paseo's default name), and Undo clears it. */
export const renameEntrySchema = z.object({ workspaceId: z.string().max(200), from: z.string().max(300).nullable(), to: z.string().max(300), at: z.string(), by: z.string().max(200) });
export type RenameEntry = z.infer<typeof renameEntrySchema>;
export const renameFileSchema = z.object({
  version: z.literal(1),
  daily: z.object({ date: z.string(), count: z.number().int().nonnegative() }).nullable().default(null),
  entries: z.array(renameEntrySchema).max(500).default([]),
});
export type RenameFile = z.infer<typeof renameFileSchema>;
export const EMPTY_RENAME_FILE: RenameFile = { version: 1, daily: null, entries: [] };

/** Entries still undoable at `now`. Pruned on every write. */
export const freshEntries = (entries: readonly RenameEntry[], now: number) => entries.filter(e => now - Date.parse(e.at) < UNDO_WINDOW_MS);
/** The newest undoable rename of a workspace. */
export const lastRename = (file: RenameFile, workspaceId: string, now: number): RenameEntry | null =>
  freshEntries(file.entries, now).filter(e => e.workspaceId === workspaceId).at(-1) ?? null;

/**
 * Undo restores the name a rename replaced, only while the workspace still has the name that rename gave it: a later
 * rename (by hand in Paseo, or another one here) is never overwritten. Returns the refusal, or null when Undo may run.
 */
export function undoRefusal(entry: RenameEntry | null, currentTitle: string | null): string | null {
  if (!entry) return "Nothing to undo: no rename in the last 24 hours.";
  if ((currentTitle ?? "") !== entry.to) return "It was renamed again since, so Undo would overwrite that. Rename it by hand instead.";
  return null;
}

export const renameStatusSchema = z.object({
  workspaceId: z.string(),
  /** The name shown now (its own title, or Paseo's default name). */
  current: z.string().max(300),
  /** The model's suggestion, when one was asked for. */
  suggestion: z.string().max(300).nullable(),
  /** Linked Linear keys: the dialog's own check allows these as a prefix. */
  keys: z.array(z.string().max(40)).max(20),
  /** The newest undoable rename: the dialog's "Undo last rename" link. */
  last: z.object({ from: z.string().max(300), to: z.string().max(300), at: z.string() }).nullable(),
});
export type RenameStatus = z.infer<typeof renameStatusSchema>;
export const renameResultSchema = z.object({ workspaceId: z.string(), title: z.string().max(300), previous: z.string().max(300), undone: z.boolean() });
export type RenameResult = z.infer<typeof renameResultSchema>;
