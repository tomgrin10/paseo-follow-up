import { randomBytes } from "node:crypto";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { JsonFileStore } from "./json-file-store";
import { NoSourceError, type SourceDirectory } from "./source-tools";
import type { AiJobs } from "./ai-jobs";
import type { MorningBriefStore } from "./morning-brief";
import { artifactLinks, parseChatRefs } from "../shared/morning-brief";
import { isWorkday, priorityName, zoned, type Clock, type QueueIssue } from "../shared/linear-queue";
import { parseEvents, rangeArgs } from "../shared/brief-sources";
import { compassSince, digestLines, suggestions, type CompassSince, type Suggestion } from "../shared/nobody";
import {
  COMPASS, EXTRACT_SYSTEM, ROLE_INFO, applyCompassChange, batchItems, compassFileSchema, emptyCompassFile, extractPrompt, extractReplySchema, guardedProvider,
  HAND_LABEL, HAND_SOURCE, applyNoteAction, cadenceMs, noteLines, noteWho, tellText, type NoteAction,
  noteRole, parseConversation, placeKey, placeNote, presetsView, rankNotes, settleNotes, unguardedWhy, validateExtraction, whoFilter,
  DOC_FILE, READER_MISSING, docBlocks, fileDocId, priorityStrength, ruleUntil, shortHash, syncRuleNotes, trackerRef, type Readers, type Role, type RuleItem,
  type CompassChange, type CompassFile, type CompassItem, type CompassNote, type CompassSettings, type CompassSource, type Place, type PlaceIndex, type RankCompassNote, type RefuseCode,
} from "../shared/compass";

export class CompassStore extends JsonFileStore<CompassFile> {
  constructor(directory: string) {
    super({ path: join(directory, "compass.json"), schema: compassFileSchema as never, empty: emptyCompassFile });
  }
}

export type CompassDeps = {
  /** morning-brief.json: Compass's settings live beside the brief's (Settings → Morning brief, the Compass card). */
  settings: MorningBriefStore;
  store: CompassStore;
  tools: SourceDirectory;
  jobs: AiJobs;
  /** The Summaries role (Settings → Agents): the fast model extraction runs on, and the provider's display name. */
  role: () => Promise<{ provider: string; model: string | null; thinking: string | null; label: string }>;
  clock: () => Promise<Clock>;
  /** The sweep time (HH:MM): the morning read runs once a workday after it, with the sweep. */
  sweepAt: () => Promise<string>;
  /** Built once per read from state the worker holds: workspaces, issue keys → workspace, no reads of its own. */
  index: () => Promise<Omit<PlaceIndex, "glossary">>;
  /** The brief's switch for a recipe: which servers may be read (a source turned off isn't read). Throws when off. */
  allowed?: (recipe: "chat" | "doc" | "calendar") => Promise<((server: string) => boolean) | undefined>;
  /** The Linear queue's snapshot (the sweep's, no read of its own): a Linear tracker place reads its projects and milestones. */
  queue?: () => Promise<QueueIssue[]>;
  /** Follow-up's in-process GitHub reads (a GET as the repository owner's account): a GitHub tracker place's issues. */
  github?: { rest(repo: string, path: string): Promise<unknown> };
  tight?: () => boolean;
  /**
   * Tell the agent (compass-reaches-an-agent-only-by-a-click): one queued message to the workspace's main agent
   * (invariant 36). Null when the workspace has no main agent to tell. The only way a note reaches an agent.
   */
  tell?: (workspaceId: string, text: string, by: string) => Promise<{ agentId: string } | null>;
  /**
   * A "Posts the plan" source shared a claude.ai artifact (plans come from Compass on arrival): the brief records it as
   * this week's plan and reads its title at once (MorningBrief.recordPlan). Resolves whether it was new.
   */
  onPlan?: (found: { url: string; postedAt: string; where: string; source: string }) => Promise<boolean>;
  /**
   * Whether an app client is open: a subscriber on the home feed, or (Paseo 0.15) a poll in the last 2 minutes. The
   * daytime read runs only then (the-brief-has-one-timer); with the app closed nothing is read on a schedule.
   */
  appOpen?: () => boolean;
  /** Issue titles and links the queue's snapshot already holds, so a suggestion names its issue (no read of its own). */
  issues?: () => Promise<ReadonlyMap<string, { title: string; url: string | null }>>;
  /** Notes changed: AI priority's next tick runs once (Ranker.markDue) and the feeds push. */
  onChange?: () => void;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
};

/** One line for a failed read: a timeout, mcpproxy's first line, or the error's. Never the text read. */
function readError(e: unknown): string {
  const x = e as { killed?: unknown; signal?: unknown; message?: unknown };
  if (x?.killed || x?.signal === "SIGTERM") return "The chat tool didn't answer in time.";
  const m = typeof x?.message === "string" ? x.message.split("\n")[0] : String(e);
  return /^Command failed/i.test(m) ? "mcpproxy couldn't run the read." : m.slice(0, 200);
}

/** The cursor a page reply carries for the next page ("cursor: `…`", or JSON next_cursor). */
const nextCursor = (reply: string) => /next_cursor"?\s*[:=]\s*"([^"]+)"/.exec(reply)?.[1] ?? /cursor[^`\n]{0,40}`([^`]{4,200})`/.exec(reply)?.[1] ?? null;

export type FindKind = "people" | "channels" | "docs" | "file" | "trackers" | "calendars";

/** A docs tool's text: the JSON reply's text field when it has one (markdown, text, content), else the reply itself. */
function docText(reply: string): string {
  try {
    const j = JSON.parse(reply) as Record<string, unknown>;
    for (const k of ["markdown", "text", "content", "body", "plain_text"]) if (typeof j[k] === "string") return j[k] as string;
  } catch { /* text form */ }
  return reply;
}
/** A docs tool's search results: objects with an id and a title or name (a link when it has one). At most 10. */
function parseDocRefs(reply: string): { id: string; name: string; url: string | null }[] {
  const out: { id: string; name: string; url: string | null }[] = []; const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || out.length >= 10) return;
    if (typeof v === "string" && /^\s*[[{]/.test(v)) { try { walk(JSON.parse(v), depth + 1); } catch { /* text */ } return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : null; const name = [o.title, o.name].find(x => typeof x === "string") as string | undefined;
    if (id && name && !seen.has(id) && id.length <= 300) { seen.add(id); out.push({ id, name: name.slice(0, 100), url: typeof o.url === "string" && /^https:\/\//.test(o.url) ? o.url.slice(0, 500) : null }); }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  try { walk(JSON.parse(reply), 0); } catch { /* not JSON */ }
  return out;
}
/** A local file's read error in one line, never its path. */
function fileError(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (code === "ENOENT") return "The file is gone. Pick it again in the source.";
  if (code === "EACCES" || code === "EPERM") return "Follow-up isn't allowed to read the file.";
  const m = (e as { message?: unknown })?.message;
  return typeof m === "string" && !m.includes("/") ? m.slice(0, 200) : "The file can't be read.";
}

export type CompassView = {
  settings: CompassSettings;
  readers: Readers & { history: boolean };
  presets: ReturnType<typeof presetsView>;
  /** Null: Compass reads. Else the one line why it doesn't (the Summaries provider has no guard). */
  blocked: string | null;
  places: Record<string, { status: string; readAt: string | null; at: string | null; error: string | null }>;
  notes: CompassNote[];
  /** The titles of the workspaces the live notes went to, so a note names where it went. */
  workspaces: Record<string, string>;
  unplaced: number;
  lastRead: CompassFile["lastRead"];
  today: { extractions: number; cap: number };
  running: boolean;
};

/**
 * Compass (docs/compass.md): reads the places its sources name, by cursor in time order (compass-reads-only-what-was-named),
 * turns what the source's people said into notes on the Summaries role's fast model with no tools (compass-text-is-data),
 * validates every note against what was said (a-compass-note-quotes-its-source), places it, and keeps it until it ends
 * (a-compass-note-ends). Once a workday after the sweep time from the worker's 15 s loop (the-brief-has-one-timer), on
 * Read now, and over the last week when a place is added.
 */
export class Compass {
  private reading: Promise<CompassFile["lastRead"]> | null = null;
  private queued: Promise<CompassFile["lastRead"]> | null = null;
  constructor(private d: CompassDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private newId(prefix: string) { return this.d.newId?.() ?? `${prefix}${randomBytes(5).toString("hex")}`; }

  async settings(): Promise<CompassSettings> { return (await this.d.settings.read()).compass; }

  /**
   * Which readers this host has, from what discovery last found (Settings answers at once; unknown counts as there): a
   * chat tool, a docs tool (a local file always works), a tracker (the Linear queue's recipe, or GitHub), a calendar.
   */
  async readers(fresh = false): Promise<Readers & { history: boolean }> {
    const found = fresh ? await this.d.tools.discover().catch(() => null) : this.d.tools.cached();
    if (!found) return { conversation: true, history: true, doc: true, tracker: true, calendar: true };
    const chat = found.matched.filter(m => m.recipe === "chat");
    const has = (id: string) => found.matched.some(m => m.recipe === id);
    return { conversation: chat.some(m => m.roles.messages || m.roles.history), history: chat.some(m => m.roles.history), doc: has("doc"), tracker: has("linear") || !!this.d.github, calendar: has("calendar") };
  }

  /** Null when Compass may read: the Summaries role runs on a provider Follow-up can guard (Claude, Codex). */
  async blocked(): Promise<string | null> {
    const r = await this.d.role();
    return guardedProvider(r.provider) ? null : unguardedWhy(r.label);
  }

  async view(opts: { workspace?: string } = {}): Promise<CompassView> {
    const [settings, file, readers, blocked] = await Promise.all([this.settings(), this.d.store.read(), this.readers(), this.blocked()]);
    const today = zoned(this.now(), (await this.d.clock()).timeZone).day;
    const live = file.notes.filter(n => n.state === "live" && (!opts.workspace || n.match.workspace === opts.workspace));
    const placed = new Set(live.flatMap(n => n.match.workspace ? [n.match.workspace] : []));
    const workspaces = placed.size ? Object.fromEntries((await this.d.index().catch(() => ({ workspaces: [] as { id: string; title: string }[] }))).workspaces.filter(w => placed.has(w.id)).map(w => [w.id, w.title])) : {};
    return {
      settings, readers, presets: presetsView(readers), blocked,
      places: Object.fromEntries(Object.entries(file.cursors).map(([k, c]) => [k, { status: c.status, readAt: c.readAt, at: c.at, error: c.error }])),
      notes: live, workspaces, unplaced: live.filter(n => !n.match.workspace).length, lastRead: file.lastRead,
      today: { extractions: file.day?.date === today ? file.day.extractions : 0, cap: COMPASS.extractionsPerDay }, running: !!this.reading,
    };
  }

  /**
   * Change the settings (Settings and a confirmed set_compass send the same change). A source added or given new places
   * is read at once over the last week, in the background, so it is useful right away.
   */
  async set(change: CompassChange, by: string, opts: { workspaceExists?: (id: string) => boolean } = {}): Promise<CompassView> {
    const before = await this.settings();
    const readers = await this.readers();
    const r = applyCompassChange(before, change, { now: this.now(), newId: () => this.newId("s-"), by, readers, workspaceExists: opts.workspaceExists });
    if (!r.ok) throw new Error(r.error);
    await this.d.settings.mutate(f => { f.compass = r.settings; });
    if (change.remove) await this.d.store.mutate(f => { f.notes = f.notes.map(n => n.source === change.remove && n.state === "live" ? { ...n, state: "unpinned", endedAt: new Date(this.now()).toISOString() } : n); });
    const was = before.sources.find(s => s.id === r.touched);
    const now = r.settings.sources.find(s => s.id === r.touched);
    const fresh = now && now.enabled && now.places.some(p => !was?.places.some(q => placeKey(q) === placeKey(p)));
    if (fresh) void this.read("added", { source: now!.id }).catch(() => undefined);
    if (change.remove || change.glossary || change.routing) this.d.onChange?.();
    return this.view();
  }

  /**
   * The worker's 15 s loop (the-brief-has-one-timer): the morning read once a workday after the sweep time, with the
   * sweep; then the daytime read every `cadence` (1, 2 or 4 h; Off: none) while an app client is open, on workdays
   * between 08:00 and 20:00 in the developer's zone. Both wait while the governor is tight. Nothing here has a timer.
   */
  async tick(): Promise<void> {
    if (this.reading || this.d.tight?.()) return;
    const settings = await this.settings();
    if (!settings.sources.some(s => s.enabled && s.roles.some(r => ROLE_INFO[r].extracts))) return;
    const clock = await this.d.clock();
    const now = this.now();
    const z = zoned(now, clock.timeZone);
    if (!isWorkday(now, clock)) return;
    const file = await this.d.store.read();
    if (file.readDay !== z.day) {
      const [h, m] = (await this.d.sweepAt()).split(":").map(Number);
      if (z.hour * 60 + z.minute >= h * 60 + m) {
        await this.d.store.mutate(f => { f.readDay = z.day; });
        await this.read("morning");
        return;
      }
    }
    const period = cadenceMs(settings.cadence);
    if (!period || !this.d.appOpen?.() || z.hour < COMPASS.dayStartHour || z.hour >= COMPASS.dayEndHour) return;
    const last = Math.max(Date.parse(file.dayReadAt ?? "") || 0, Date.parse(file.lastRead?.at ?? "") || 0);
    if (now - last < period) return;
    await this.d.store.mutate(f => { f.dayReadAt = new Date(now).toISOString(); });
    await this.read("day");
  }

  /**
   * Read now (Settings' Read now, read_compass): every enabled source, or one. A scheduled read joins one already going;
   * a read someone asked for (a new place, Read now) waits for it and runs after, once for every such ask meanwhile, so
   * a source added during another's first read still gets its own.
   */
  read(trigger: "morning" | "day" | "manual" | "agent" | "added", opts: { source?: string; plans?: boolean } = {}): Promise<CompassFile["lastRead"]> {
    if (!this.reading) return this.reading = this.readOnce(trigger, opts).finally(() => { this.reading = null; });
    if (trigger === "morning" || trigger === "day") return this.reading;
    return this.queued ??= this.reading.catch(() => undefined).then(() => { this.queued = null; return this.read(trigger, opts.plans ? opts : {}); });
  }
  /** Drain active and queued reads before disposing of their dependencies. Callers must stop starting new work. */
  async idle(): Promise<void> {
    while (this.reading || this.queued) await Promise.allSettled([this.reading, this.queued]);
  }

  /** Read now, waiting at most `ms`; then `running` (read_compass). */
  async readWithin(trigger: "manual" | "agent", ms = COMPASS.waitMs): Promise<{ running: true } | { running: false; lastRead: CompassFile["lastRead"] }> {
    const p = this.read(trigger);
    const timeout = new Promise<"t">(resolve => { const t = setTimeout(() => resolve("t"), ms); t.unref?.(); });
    const r = await Promise.race([p, timeout]);
    return r === "t" ? { running: true } : { running: false, lastRead: r };
  }

  private async readOnce(trigger: string, opts: { source?: string; plans?: boolean }): Promise<CompassFile["lastRead"]> {
    const at = new Date(this.now()).toISOString();
    const settings = await this.settings();
    const sources = settings.sources.filter(s => s.enabled && (!opts.source || s.id === opts.source) && (!opts.plans || s.roles.includes("plan")) && noteRole(s.roles));
    const blocked = await this.blocked();
    const finish = async (ok: boolean, notes: number, error: string | null) => {
      const lastRead = { at, trigger, ok, notes, error };
      await this.d.store.mutate(f => { f.lastRead = lastRead; });
      return lastRead;
    };
    // No guard on this provider: nothing is read at all, so no one's words reach a model that has tools.
    if (blocked) return finish(false, 0, blocked);
    if (!sources.length) return finish(true, 0, null);
    const index = { ...await this.d.index(), glossary: settings.glossary };
    let made = 0; const errors: string[] = [];
    for (const source of sources) {
      for (const place of source.places) {
        try { made += await this.readPlace(source, place, settings, index, trigger); }
        catch (e) { errors.push(`${source.label}: ${readError(e)}`); }
      }
    }
    if (made) this.d.onChange?.();
    return finish(!errors.length, made, errors[0] ?? null);
  }

  /** One place: read since its cursor, by its kind's reader, then extract (words) or apply rules (structured items). Returns notes made. */
  private async readPlace(source: CompassSource, place: Place, settings: CompassSettings, index: PlaceIndex, trigger: string): Promise<number> {
    const key = placeKey(place);
    const now = this.now();
    const readAt = new Date(now).toISOString();
    const file = await this.d.store.read();
    const cursor = file.cursors[key];
    const setCursor = (patch: Partial<CompassFile["cursors"][string]> & { status: CompassFile["cursors"][string]["status"] }) =>
      this.d.store.mutate(f => { const was = f.cursors[key]; f.cursors[key] = { at: was?.at ?? cursor?.at ?? null, readAt, error: null, hash: was?.hash ?? null, seen: was?.seen ?? [], stat: was?.stat ?? null, ...patch }; });
    if (place.kind === "tracker" || place.kind === "calendar") {
      // Structured places become notes by rule, with no model: they use none of the day's extractions.
      try { return place.kind === "tracker" ? await this.readTracker(source, place, settings, index, cursor, trigger, setCursor) : await this.readCalendar(source, place, index, setCursor); }
      catch (e) { await setCursor({ status: "failed", error: e instanceof NoSourceError ? READER_MISSING[place.kind] : readError(e) }); throw e; }
    }
    const clock = await this.d.clock();
    const today = zoned(now, clock.timeZone).day;
    const used = file.day?.date === today ? file.day.extractions : 0;
    if (used >= COMPASS.extractionsPerDay) { await setCursor({ status: "paused", error: `Paused until tomorrow: ${COMPASS.extractionsPerDay} reads today.` }); return 0; }
    if (place.kind === "doc") return this.readDocPlace(source, place, settings, index, cursor, setCursor, { used, today, clock });

    const since = cursor?.at ? Date.parse(cursor.at) : now - COMPASS.firstReadDays * 86_400_000;
    let read: { messages: ReturnType<typeof parseConversation>; slow: boolean; partial: boolean };
    try { read = await this.readConversation(place, since); }
    catch (e) {
      // A read that can't reach the cursor keeps it, and the next read covers the gap.
      await setCursor({ status: "failed", error: e instanceof NoSourceError ? "No connected chat tool can read this conversation." : readError(e) });
      throw e;
    }
    const self = await this.d.tools.selfId(await this.d.allowed?.("chat")).catch(() => null);
    const whose = whoFilter(source.who, self);
    let items: CompassItem[] = [];
    let newest = since;
    // Oldest first, one item per message (a page overlap reads a message twice).
    const seen = new Set<string>();
    for (const m of [...read.messages].sort((a, b) => a.at.localeCompare(b.at))) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const t = Date.parse(m.at);
      if (!(t > since)) continue;
      newest = Math.max(newest, t);
      const kind = whose(m.by);
      if (kind) items.push({ id: `m${items.length + 1}`, by: m.by, at: m.at, link: m.link, text: m.text, ...(kind === "context" ? { context: true } : {}) });
    }
    // Everyone in a place (decision R1): one read takes its newest COMPASS.items messages, in one extraction; the older
    // ones are skipped and the place says so. A busy channel never runs the day's extractions down.
    let skipped = 0;
    if (source.who.kind === "anyone") {
      const words = items.filter(i => !i.context);
      if (words.length > COMPASS.items) {
        const from = words[words.length - COMPASS.items].at;
        skipped = words.length - COMPASS.items;
        items = items.filter(i => i.at >= from);
      }
    }
    // Plans come from Compass on arrival: the newest claude.ai artifact the source's people shared here.
    if (source.roles.includes("plan") && this.d.onPlan) {
      const posted = items.filter(i => !i.context).flatMap(i => artifactLinks(i.text).map(url => ({ url, at: i.at }))).sort((a, b) => b.at.localeCompare(a.at))[0];
      const where = place.sub === "dm" ? "their DM" : `#${place.name}`;
      if (posted) await this.d.onPlan({ url: posted.url, postedAt: posted.at, where, source: source.id }).catch(() => false);
    }
    const status = read.slow ? "slow-path" as const : "ok" as const;
    const note = read.partial ? `More than ${COMPASS.pagesMax * COMPASS.pageSize} messages since the last read; the newest were read.`
      : skipped ? `A busy place: this read took its newest ${COMPASS.items} messages and skipped ${skipped} older.` : null;
    if (!items.some(i => !i.context)) {
      // Nothing new: a note the last read left (newest only, older skipped) stays until a read takes new words.
      const kept = cursor && (cursor.status === "ok" || cursor.status === "slow-path") ? cursor.error : null;
      await setCursor({ status, at: new Date(newest).toISOString(), error: note ?? kept });
      return 0;
    }
    const r = await this.extract(source, key, items, settings, index, { used, today, clock, once: source.who.kind === "anyone" });
    if (r.failed) { await setCursor({ status: "failed", at: r.cursorAt > since ? new Date(r.cursorAt).toISOString() : cursor?.at ?? null, error: r.failed }); return r.made; }
    await setCursor({ status: r.all ? status : "paused", at: new Date(r.all ? newest : r.cursorAt).toISOString(), error: r.all ? note : `Paused until tomorrow: ${COMPASS.extractionsPerDay} reads today.` });
    return r.made;
  }

  /**
   * Items through the extraction job, a batch at a time (at most COMPASS.items and COMPASS.chars, oldest first), until
   * they're done, the day's extractions run out, or `once`. Each batch's notes are validated, placed and settled.
   */
  private async extract(source: CompassSource, key: string, items: CompassItem[], settings: CompassSettings, index: PlaceIndex, o: { used: number; today: string; clock: Clock; once?: boolean }):
    Promise<{ made: number; all: boolean; cursorAt: number; done: Set<string>; failed: string | null }> {
    const now = this.now(); const readAt = new Date(now).toISOString();
    const role = await this.d.role();
    const open = (await this.d.store.read()).notes.filter(n => n.state === "live" && n.source === source.id);
    let made = 0; let extractions = o.used; let rest = items; let cursorAt = 0;
    const done = new Set<string>();
    const refused: RefuseCode[] = [];
    while (rest.some(i => !i.context)) {
      if (extractions >= COMPASS.extractionsPerDay) break;
      const { batch } = batchItems(rest);
      const r = await this.d.jobs.run({
        name: "compass-extract", outside: true, system: EXTRACT_SYSTEM, schema: extractReplySchema, provider: role.provider, model: role.model ?? undefined, thinking: role.thinking,
        prompt: extractPrompt({ source, global: settings.instructions, items: batch, open, now, clock: o.clock }), maxPromptChars: 24_000, maxOutputChars: 8_000, timeoutMs: 90_000,
      });
      extractions++;
      await this.d.store.mutate(f => { f.day = { date: o.today, extractions }; });
      if (!r.ok) return { made, all: false, cursorAt, done, failed: `The model couldn't read it (${r.reason}).` };
      const v = validateExtraction(r.value, { source, items: batch, open, glossary: settings.glossary, instructions: settings.instructions, clock: o.clock, now, newId: () => this.newId("n-") });
      refused.push(...v.refused);
      const fresh = v.notes.map(n => { const note = { ...n, place: key }; return { ...note, match: placeNote(note, index) }; });
      made += fresh.length;
      await this.d.store.mutate(f => {
        f.notes = settleNotes(f.notes as CompassNote[], { now, expiry: settings.expiry, fresh, retracts: v.retracts, updates: v.updates });
        if (v.refused.length) f.refused = [...f.refused, ...v.refused.map(code => ({ at: readAt, code }))].slice(-50);
      });
      cursorAt = Math.max(cursorAt, ...batch.map(i => Date.parse(i.at)));
      for (const i of batch) done.add(i.id);
      rest = rest.filter(i => !done.has(i.id));
      if (o.once) { rest = []; break; }
    }
    if (refused.length) this.d.log?.(`[follow-up] compass: refused ${refused.length} note(s): ${[...new Set(refused)].join(", ")}`);
    return { made, all: !rest.some(i => !i.context), cursorAt, done, failed: null };
  }

  /**
   * A doc place: a page a docs tool serves (the doc recipe's read, by the tool's own id), or a Markdown or text file on
   * this machine (decision R2: read in process only when its modified time or size moved; at most COMPASS.docBytes).
   * An unchanged doc makes no model call; a changed one sends only its new or changed blocks. The path never reaches a
   * log or an error.
   */
  private async readDocPlace(source: CompassSource, place: Extract<Place, { kind: "doc" }>, settings: CompassSettings, index: PlaceIndex, cursor: CompassFile["cursors"][string] | undefined,
    setCursor: (patch: Partial<CompassFile["cursors"][string]> & { status: CompassFile["cursors"][string]["status"] }) => Promise<unknown>, o: { used: number; today: string; clock: Clock }): Promise<number> {
    const now = this.now();
    let text: string; let stat: string | null = null;
    try {
      if (place.path) {
        const st = await fsStat(place.path);
        if (!st.isFile()) throw new Error("The file isn't a regular file any more.");
        stat = `${Math.round(st.mtimeMs)}:${st.size}`;
        if (cursor?.stat === stat && cursor.hash && cursor.status !== "failed" && cursor.status !== "paused") { await setCursor({ status: "ok" }); return 0; }
        if (st.size > COMPASS.docBytes) throw new Error(`The file is over ${COMPASS.docBytes / 1024} KB, so Compass doesn't read it.`);
        text = await fsReadFile(place.path, "utf8");
      } else {
        const allowed = await this.d.allowed?.("doc");
        text = docText(await this.d.tools.call("doc", "read", { id: place.id, page_id: place.id, pageId: place.id, document_id: place.id, documentId: place.id, doc_id: place.id, url: place.link ?? place.id }, { reason: "read the developer's Compass", timeoutMs: 30_000, allowed }));
      }
    } catch (e) {
      const why = e instanceof NoSourceError ? READER_MISSING.doc : place.path ? fileError(e) : readError(e);
      await setCursor({ status: "failed", error: why });
      throw new Error(why);
    }
    text = text.slice(0, COMPASS.docBytes);
    const hash = shortHash(text);
    if (cursor?.hash === hash && cursor.status !== "paused") { await setCursor({ status: "ok", stat, at: cursor.at }); return 0; }
    const blocks = docBlocks(text);
    const seen = new Set(cursor?.seen ?? []);
    const who = source.who;
    const by = who.kind === "person" ? who.person : who.kind === "people" ? who.people[0] : who.kind === "me" ? { id: "developer", name: "You" } : { id: "doc", name: place.name };
    const at = new Date(now).toISOString();
    const fresh = blocks.filter(b => !seen.has(b.hash));
    const items: CompassItem[] = fresh.map((b, i) => ({ id: `d${i + 1}`, by, at, link: place.link ?? null, text: b.text }));
    if (source.roles.includes("plan") && this.d.onPlan) {
      const posted = fresh.flatMap(b => artifactLinks(b.text))[0];
      if (posted) await this.d.onPlan({ url: posted, postedAt: at, where: place.name, source: source.id }).catch(() => false);
    }
    // Blocks still in the doc stay remembered; ones gone from it are forgotten (the hashes are bounded).
    const keep = (done: Set<string>) => blocks.map(b => b.hash).filter(h => seen.has(h) || done.has(h)).slice(-COMPASS.docBlocks);
    if (!items.length) { await setCursor({ status: "ok", at, hash, stat, seen: keep(new Set()) }); return 0; }
    const r = await this.extract(source, placeKey(place), items, settings, index, o);
    const doneHashes = new Set(fresh.filter((_, i) => r.done.has(`d${i + 1}`)).map(b => b.hash));
    if (r.failed) { await setCursor({ status: "failed", error: r.failed, seen: keep(doneHashes) }); return r.made; }
    // Not every block was read (the day's cap): the hash stays unset, so the next read takes the rest.
    await setCursor({ status: r.all ? "ok" : "paused", at, hash: r.all ? hash : null, stat: r.all ? stat : null, seen: keep(doneHashes), error: r.all ? null : `Paused until tomorrow: ${COMPASS.extractionsPerDay} reads today.` });
    return r.made;
  }

  /**
   * A tracker place, by rule: a Linear project or milestone from the queue's own snapshot (no read of its own), or a
   * GitHub label or milestone through Follow-up's in-process GitHub reads (at most once per COMPASS.trackerEveryMs, or
   * on Read now). Each open issue in scope is a note quoting its own fields; one that leaves the scope ends its note.
   */
  private async readTracker(source: CompassSource, place: Extract<Place, { kind: "tracker" }>, _settings: CompassSettings, index: PlaceIndex, cursor: CompassFile["cursors"][string] | undefined, trigger: string,
    setCursor: (patch: Partial<CompassFile["cursors"][string]> & { status: CompassFile["cursors"][string]["status"] }) => Promise<unknown>): Promise<number> {
    const ref = trackerRef(place.id);
    if (!ref) throw new Error("This tracker place isn't one Compass reads. Pick it again.");
    const now = this.now();
    const role = noteRole(source.roles) ?? "priorities";
    const plan = role === "plan";
    let items: RuleItem[];
    if (ref.tracker === "linear") {
      if (!this.d.queue) throw new NoSourceError("linear", "list_issues");
      const issues = (await this.d.queue()).filter(i => (ref.scope === "project" ? i.project : i.milestone)?.toLowerCase() === ref.value.toLowerCase());
      items = issues.map(i => ({
        ref: i.key, key: i.key, title: i.title, kind: "issue" as const, link: i.url, at: i.updatedAt ?? new Date(now).toISOString(),
        quote: [`${i.key} ${i.title}`, i.due ? `due ${i.due.slice(0, 10)}` : null, priorityName(i.priority), i.state].filter(Boolean).join(" · "),
        until: ruleUntil(i.due, now), strength: plan ? "low" as const : priorityStrength(i.priority) ?? "normal",
      }));
    } else {
      if (!this.d.github) throw new NoSourceError("github" as never, "issues");
      const fresh = cursor?.status === "ok" && now - Date.parse(cursor.readAt) < COMPASS.trackerEveryMs;
      if (fresh && trigger !== "manual" && trigger !== "agent" && trigger !== "added") return 0;
      const q = ref.scope === "label" ? `labels=${encodeURIComponent(ref.value)}` : `milestone=${ref.value}`;
      const raw = await this.d.github.rest(ref.repo, `repos/${ref.repo}/issues?state=open&per_page=50&${q}`);
      const list = (Array.isArray(raw) ? raw : []) as { number?: unknown; title?: unknown; html_url?: unknown; updated_at?: unknown; pull_request?: unknown; milestone?: { due_on?: unknown } | null }[];
      items = list.filter(i => !i.pull_request && typeof i.number === "number" && typeof i.title === "string").map(i => {
        const key = `${ref.repo}#${i.number}`;
        const due = typeof i.milestone?.due_on === "string" ? i.milestone.due_on.slice(0, 10) : null;
        return {
          ref: key, key, title: i.title as string, kind: "issue" as const, link: typeof i.html_url === "string" ? i.html_url : null, at: typeof i.updated_at === "string" ? i.updated_at : new Date(now).toISOString(),
          quote: [`${key} ${i.title}`, ref.scope === "label" ? `label ${ref.value}` : `milestone ${place.name}`, due ? `due ${due}` : null].filter(Boolean).join(" · "),
          // A label the developer named as a source is the ask itself; a milestone is a plan of work.
          until: ruleUntil(due, now), strength: plan ? "low" as const : ref.scope === "label" ? "high" as const : "normal" as const,
        };
      });
    }
    items.sort((a, b) => ({ high: 0, normal: 1, low: 2 })[a.strength] - ({ high: 0, normal: 1, low: 2 })[b.strength] || (a.until ?? "9999").localeCompare(b.until ?? "9999") || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
    return this.applyRules(source, placeKey(place), role, items, index, true, COMPASS.trackerNotes, setCursor);
  }

  /**
   * A calendar place, by rule: the calendar recipe's events over the next COMPASS.calendarDays, re-read each read. An
   * event lends its date to the work it matches (the glossary, then a title score); one that matches nothing isn't kept.
   */
  private async readCalendar(source: CompassSource, place: Extract<Place, { kind: "calendar" }>, index: PlaceIndex,
    setCursor: (patch: Partial<CompassFile["cursors"][string]> & { status: CompassFile["cursors"][string]["status"] }) => Promise<unknown>): Promise<number> {
    const now = this.now();
    const clock = await this.d.clock();
    const allowed = await this.d.allowed?.("calendar");
    const tool = await this.d.tools.tool("calendar", "events", allowed);
    if (!tool) throw new NoSourceError("calendar", "events");
    const start = new Date(now).toISOString(); const end = new Date(now + COMPASS.calendarDays * 86_400_000).toISOString();
    const args = { ...rangeArgs(await this.d.tools.props(tool), start, end, clock.timeZone), ...(place.id !== "primary" ? { calendarId: place.id, calendar_id: place.id } : {}) };
    const events = parseEvents(await this.d.tools.call("calendar", "events", args, { reason: "read the developer's Compass", timeoutMs: 30_000, allowed }));
    const filter = place.filter ?? "all";
    const role = noteRole(source.roles) ?? "deadlines";
    const items: RuleItem[] = events.flatMap(e => {
      const t = e.start ? Date.parse(e.start) : NaN;
      if (Number.isNaN(t) || t < now - 3_600_000) return [];
      // Unknown guests count as guests: a reply that doesn't say never hides a meeting (unknown is not off).
      if (filter === "with-guests" && e.guests === 0) return [];
      const dayOf = zoned(t, clock.timeZone).day;
      // A meeting that names an issue ("APP-142 review") goes to that issue, as a note's own key would.
      const key = /(?:^|[^A-Za-z0-9-])([A-Z][A-Z0-9]{1,9}-\d{1,7})(?![A-Za-z0-9])/.exec(e.title)?.[1] ?? null;
      return [{ ref: `${e.title}|${e.start}`, key, title: e.title, kind: "event" as const, link: e.url, at: new Date(now).toISOString(), quote: `${e.title} · ${e.start}`, until: dayOf, strength: "normal" as const }];
    });
    return this.applyRules(source, placeKey(place), role, items, index, false, COMPASS.calendarNotes, setCursor);
  }

  private async applyRules(source: CompassSource, key: string, role: Role, items: RuleItem[], index: PlaceIndex, keepUnplaced: boolean, cap: number,
    setCursor: (patch: Partial<CompassFile["cursors"][string]> & { status: CompassFile["cursors"][string]["status"] }) => Promise<unknown>): Promise<number> {
    const now = this.now();
    let made = 0; let ended = 0;
    await this.d.store.mutate(f => {
      const r = syncRuleNotes(f.notes as CompassNote[], { source, place: key, role, items, now, index, newId: () => this.newId("n-"), keepUnplaced, cap });
      made = r.made; ended = r.ended;
      if (r.made || r.ended || r.notes.some((n, i) => n !== f.notes[i])) f.notes = r.notes;
    });
    await setCursor({ status: "ok", at: new Date(now).toISOString() });
    if (ended) this.d.onChange?.();
    return made;
  }

  /**
   * A conversation since `since`, in time order, never a relevance search: the chat tool's history read (a conversation
   * id and an oldest time), newest page first until it passes the cursor, at most `pagesMax` pages; without one, the
   * message search sorted by time, one day at a time (the slower path, said so on the place).
   */
  private async readConversation(place: Extract<Place, { kind: "conversation" }>, since: number): Promise<{ messages: ReturnType<typeof parseConversation>; slow: boolean; partial: boolean }> {
    const allowed = await this.d.allowed?.("chat");
    const opts = { reason: "read the developer's Compass", timeoutMs: 30_000, allowed };
    const history = await this.d.tools.tool("chat", "history", allowed);
    const oldest = (since / 1000).toFixed(6);
    if (history) {
      const out: ReturnType<typeof parseConversation> = [];
      let page: string | null = null; let partial = false;
      for (let i = 0; i < COMPASS.pagesMax; i++) {
        const reply = await this.d.tools.call("chat", "history", { channel_id: place.id, channel: place.id, conversation_id: place.id, oldest, limit: COMPASS.pageSize, response_format: "detailed", ...(page ? { cursor: page } : {}) }, opts);
        const got = parseConversation(reply);
        out.push(...got);
        page = nextCursor(reply);
        if (!page || !got.length || got.some(m => Date.parse(m.at) <= since)) break;
        if (i === COMPASS.pagesMax - 1) partial = true;
      }
      return { messages: out, slow: false, partial };
    }
    const out: ReturnType<typeof parseConversation> = [];
    const where = place.sub === "dm" ? `in:<@${place.id}>` : `in:<#${place.id}>`;
    for (let day = Math.floor(since / 86_400_000) * 86_400_000; day <= this.now(); day += 86_400_000) {
      const after = new Date(day - 86_400_000).toISOString().slice(0, 10); const before = new Date(day + 86_400_000).toISOString().slice(0, 10);
      const reply = await this.d.tools.call("chat", "messages", { keywords: [], query: "", natural_language_query: "", filters: `${where} after:${after} before:${before}`, sort: "timestamp", sort_dir: "asc", limit: 50, include_context: false, response_format: "detailed" }, opts);
      out.push(...parseConversation(reply));
    }
    return { messages: out, slow: true, partial: false };
  }

  /**
   * compass_find: the only way a place gets its id (compass-reads-only-what-was-named). People and channels from the
   * chat tool's own search (a person comes with their DM); docs from the docs tool's search; a local file by its
   * absolute path, checked first (Markdown or text, at most COMPASS.docBytes); tracker scopes from the Linear queue's
   * snapshot (projects, milestones) or a GitHub repository's labels and milestones ("owner/repo", then words to
   * narrow); calendars from the calendar tool.
   */
  async find(kind: FindKind, query: string): Promise<{ results: { id: string; name: string; place: Place | null; detail?: string }[]; error: string | null }> {
    const q = query.trim();
    try {
      if (kind === "people" || kind === "channels") {
        const allowed = await this.d.allowed?.("chat").catch(() => undefined);
        const words = q.split(/\s+/).filter(Boolean).slice(0, 4);
        const reply = await this.d.tools.call("chat", kind, { keywords: words, query: q, natural_language_query: "", limit: 10, response_format: "detailed", ...(kind === "channels" ? { channel_types: "public_channel,private_channel" } : {}) }, { reason: "set up the developer's Compass", timeoutMs: 20_000, allowed });
        const results = parseChatRefs(reply, kind).flatMap(r => r.id ? [{ id: r.id, name: r.name, place: { kind: "conversation" as const, sub: kind === "people" ? "dm" as const : "channel" as const, id: r.id, name: r.name } }] : []);
        return { results, error: null };
      }
      if (kind === "docs") {
        const allowed = await this.d.allowed?.("doc").catch(() => undefined);
        const reply = await this.d.tools.call("doc", "search", { query: q, q, limit: 10 }, { reason: "set up the developer's Compass", timeoutMs: 20_000, allowed });
        return { results: parseDocRefs(reply).map(d => ({ id: d.id, name: d.name, place: { kind: "doc" as const, id: d.id, name: d.name, ...(d.url ? { link: d.url } : {}) } })), error: null };
      }
      if (kind === "file") {
        if (!isAbsolute(q)) return { results: [], error: "Give the file's full path, like /home/user/notes/now.md." };
        if (!DOC_FILE.test(q)) return { results: [], error: "Compass reads Markdown or text files (.md, .txt)." };
        const st = await fsStat(q).catch(() => null);
        if (!st?.isFile()) return { results: [], error: "There's no file there that Follow-up can read." };
        if (st.size > COMPASS.docBytes) return { results: [], error: `That file is over ${COMPASS.docBytes / 1024} KB; Compass reads smaller ones.` };
        const name = basename(q).slice(0, 100);
        return { results: [{ id: fileDocId(q), name, place: { kind: "doc", id: fileDocId(q), name, path: q }, detail: "A file on this machine" }], error: null };
      }
      if (kind === "calendars") {
        const tool = await this.d.tools.tool("calendar", "events", await this.d.allowed?.("calendar").catch(() => undefined));
        if (!tool) return { results: [], error: READER_MISSING.calendar };
        return { results: [{ id: "primary", name: "Your calendar", place: { kind: "calendar", id: "primary", name: "Your calendar", filter: "with-guests" }, detail: "Meetings with guests" }], error: null };
      }
      // Trackers: "owner/repo [words]" reads that repository's labels and milestones; anything else, the queue's projects and milestones.
      const repo = /^([\w.-]+\/[\w.-]+)(?:\s+(.*))?$/.exec(q);
      const want = (name: string) => !(repo ? repo[2] ?? "" : q).trim() || name.toLowerCase().includes((repo ? repo[2] ?? "" : q).trim().toLowerCase());
      if (repo) {
        if (!this.d.github) return { results: [], error: READER_MISSING.tracker };
        const [labels, milestones] = await Promise.all([this.d.github.rest(repo[1], `repos/${repo[1]}/labels?per_page=100`), this.d.github.rest(repo[1], `repos/${repo[1]}/milestones?state=open&per_page=50`)]);
        const out: { id: string; name: string; place: Place; detail: string }[] = [];
        for (const l of (Array.isArray(labels) ? labels : []) as { name?: unknown }[]) if (typeof l.name === "string" && want(l.name)) out.push({ id: `github:${repo[1]}:label:${l.name}`, name: l.name, place: { kind: "tracker", scope: "label", id: `github:${repo[1]}:label:${l.name}`, name: l.name }, detail: `Label in ${repo[1]}` });
        for (const m of (Array.isArray(milestones) ? milestones : []) as { number?: unknown; title?: unknown }[]) if (typeof m.number === "number" && typeof m.title === "string" && want(m.title)) out.push({ id: `github:${repo[1]}:milestone:${m.number}`, name: m.title, place: { kind: "tracker", scope: "milestone", id: `github:${repo[1]}:milestone:${m.number}`, name: m.title }, detail: `Milestone in ${repo[1]}` });
        return { results: out.slice(0, 20), error: null };
      }
      if (!this.d.queue) return { results: [], error: "No Linear queue here. For GitHub, search \"owner/repo\"." };
      const issues = await this.d.queue();
      const seen = new Map<string, { scope: "project" | "milestone"; name: string; n: number }>();
      for (const i of issues) for (const [scope, name] of [["project", i.project], ["milestone", i.milestone]] as const) {
        if (!name || !want(name)) continue;
        const k = `${scope}:${name}`; const was = seen.get(k);
        seen.set(k, { scope, name, n: (was?.n ?? 0) + 1 });
      }
      return { results: [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 20).map(x => ({ id: `linear:${x.scope}:${x.name}`, name: x.name, place: { kind: "tracker" as const, scope: x.scope, id: `linear:${x.scope}:${x.name}`, name: x.name }, detail: `Linear ${x.scope} · ${x.n} of your issues` })), error: null };
    } catch (e) {
      return { results: [], error: e instanceof NoSourceError ? (kind === "people" || kind === "channels" ? "No chat search is connected." : kind === "docs" ? READER_MISSING.doc : READER_MISSING.tracker) : readError(e) };
    }
  }

  /**
   * One note, by hand (Why it matters' menu, a confirmed compass_note): pin, edit, unpin, or tell its workspace's main
   * agent. A tell changes no note; it is the only path from a note to an agent.
   */
  async note(a: NoteAction, by: string, opts: { workspaceExists?: (id: string) => boolean } = {}): Promise<{ view: CompassView; told: { agentId: string } | null }> {
    const file = await this.d.store.read();
    const r = applyNoteAction(file.notes as CompassNote[], a, { now: this.now(), by: by === "developer" ? "developer" : by, newId: () => this.newId("n-"), workspaceExists: opts.workspaceExists ?? (() => true) });
    if (!r.ok) throw new Error(r.error);
    let told: { agentId: string } | null = null;
    if (a.action === "tell") {
      const workspace = r.note.match.workspace;
      if (!workspace) throw new Error("This note isn't on a workspace. Move it onto one first.");
      if (!this.d.tell) throw new Error("Follow-up can't send messages here.");
      const settings = await this.settings();
      const source = settings.sources.find(s => s.id === r.note.source) ?? null;
      const place = source?.places.find(p => placeKey(p) === r.note.place) ?? null;
      const where = place?.kind === "conversation" ? (place.sub === "dm" ? "a DM" : `#${place.name}`) : place?.name ?? null;
      told = await this.d.tell(workspace, tellText(r.note, source, where), by);
      if (!told) throw new Error("This workspace has no main agent to tell.");
    } else {
      await this.d.store.mutate(f => { f.notes = r.notes; });
      this.d.onChange?.();
    }
    return { view: await this.view(a.workspace || r.note.match.workspace ? { workspace: (a.workspace ?? r.note.match.workspace)! } : {}), told };
  }

  /** Each workspace's first live note as one line ("Dana: …"), for Home rows and Catch up. Reads compass.json only. */
  async lines(): Promise<Record<string, string>> {
    const [settings, file] = await Promise.all([this.settings(), this.d.store.read()]);
    if (!file.notes.length) return {};
    return noteLines(file.notes as CompassNote[], this.now(), settings.expiry);
  }

  /**
   * why_suggested: for a workspace, an issue or a note, the live notes behind it, who said them, where, the source
   * and role, how each was matched, and whether (and why) it is a suggestion in Needs you, first in New, or neither.
   */
  async why(input: { workspace?: string; issue?: string; note?: string }): Promise<{ notes: unknown[]; needsYou: { suggested: boolean; urgent: boolean; why: string } }> {
    const [settings, file] = await Promise.all([this.settings(), this.d.store.read()]);
    const label = new Map([...settings.sources.map(s => [s.id, s.label] as const), [HAND_SOURCE, HAND_LABEL] as const]);
    const key = input.issue?.toUpperCase();
    const notes = (file.notes as CompassNote[]).filter(n => n.state === "live" && (input.note ? n.id === input.note
      : input.workspace ? n.match.workspace === input.workspace : key ? n.keys.some(k => k.toUpperCase() === key) || n.match.issue?.toUpperCase() === key : true));
    const all = await this.suggestions();
    const s = all.find(x => (key && x.key === key) || notes.some(n => n.id === x.note)) ?? null;
    const routing = settings.routing;
    const why = s ? (s.urgent ? `In Needs you as "Nobody's on it": ${s.reason} (${s.source}), strong enough and due within ${routing.urgentWithinWorkdays} workdays.` : `First in New's My issues: ${s.reason} (${s.source}). Not urgent enough for Needs you (it needs strength ${routing.urgentStrength}, a date within ${routing.urgentWithinWorkdays} workdays and the source's Needs-you switch on).`)
      : input.workspace ? "It has a workspace, so it's no suggestion: its notes reorder AI priority."
      : routing.suggestions === "off" ? "Suggestions are off (compass routing)."
      : notes.some(n => n.match.issue) ? "Its issue already has a workspace, or the developer removed the suggestion."
      : "No live note names an issue nobody started.";
    return {
      notes: notes.map(n => ({ id: n.id, what: n.what, quote: n.quote, who: noteWho(n), at: n.at, source: label.get(n.source) ?? "a removed source", role: n.role, strength: n.strength, until: n.until,
        matched: { how: n.match.how, score: Math.round(n.match.score * 100) / 100, workspace: n.match.workspace ?? null, issue: n.match.issue ?? null } })),
      needsYou: { suggested: !!s, urgent: !!s?.urgent, why },
    };
  }

  /**
   * Suggestions (shared/nobody.ts): live notes about an issue with no workspace (invariant 95's one predicate, from
   * the index the worker already holds). Reads compass.json; with no such note it builds no index at all.
   */
  async suggestions(known?: ReadonlyMap<string, { title: string; url: string | null }>): Promise<Suggestion[]> {
    const [settings, file] = await Promise.all([this.settings(), this.d.store.read()]);
    if (!file.notes.some(n => n.state === "live" && n.match.issue && !n.match.workspace)) return [];
    const [clock, index, issues] = await Promise.all([this.d.clock(), this.d.index().catch(() => null), known ? Promise.resolve(known) : this.d.issues?.().catch(() => null) ?? Promise.resolve(null)]);
    return suggestions(file.notes as CompassNote[], settings, {
      now: this.now(), clock, taken: k => !!index?.issueWorkspace(k), removed: new Set(file.removed.map(r => r.note)),
      issue: k => issues?.get(k) ?? null,
    });
  }

  /**
   * Remove a suggestion (Needs you's or New's Remove, `dismiss_item {compass}`), or bring it back with undo. Only this
   * record changes; nothing is sent. A later note on the same issue is new and suggests it again.
   */
  async removeSuggestion(note: string, undo: boolean): Promise<{ name: string }> {
    const file = await this.d.store.read();
    const n = file.notes.find(x => x.id === note);
    if (!n) throw new Error(`No Compass note ${note}.`);
    const name = n.match.issue ?? n.what;
    if (undo) {
      if (!file.removed.some(r => r.note === note)) throw new Error(`${name} isn't removed.`);
      await this.d.store.mutate(f => { f.removed = f.removed.filter(r => r.note !== note); });
    } else {
      if (!(await this.suggestions()).some(s => s.note === note)) throw new Error(`${name} is already gone from your suggestions.`);
      await this.d.store.mutate(f => { f.removed = [...f.removed.filter(r => r.note !== note), { note, at: new Date(this.now()).toISOString() }].slice(-COMPASS.removed); });
    }
    this.d.onChange?.();
    return { name };
  }

  /** "Nobody's on it" Remove on an issue: every live Compass note on it stops suggesting it (the queue's raise is the queue's). */
  async removeIssue(key: string, undo: boolean): Promise<number> {
    const file = await this.d.store.read();
    const k = key.toUpperCase();
    const ids = file.notes.filter(n => n.state === "live" && n.match.issue?.toUpperCase() === k).map(n => n.id);
    if (!ids.length) return 0;
    const at = new Date(this.now()).toISOString();
    await this.d.store.mutate(f => { f.removed = undo ? f.removed.filter(r => !ids.includes(r.note)) : [...f.removed.filter(r => !ids.includes(r.note)), ...ids.map(note => ({ note, at }))].slice(-COMPASS.removed); });
    this.d.onChange?.();
    return ids.length;
  }

  /** The brief's one Since block: what Compass heard since the brief's own point (a-change-is-against-what-you-last-saw). */
  async since(since: string | null, known?: readonly Suggestion[]): Promise<CompassSince> {
    const [settings, file] = await Promise.all([this.settings(), this.d.store.read()]);
    const [list, clock] = await Promise.all([known ?? this.suggestions(), this.d.clock()]);
    const placed = new Set(file.notes.flatMap(n => n.match.workspace ? [n.match.workspace] : []));
    const titles = placed.size ? new Map((await this.d.index().catch(() => ({ workspaces: [] as { id: string; title: string }[] }))).workspaces.map(w => [w.id, w.title])) : new Map<string, string>();
    return compassSince(file.notes as CompassNote[], { settings, since, now: this.now(), clock, suggestions: list, titles, lastRead: file.lastRead });
  }

  /**
   * The Overseer's Compass block (compass-without-the-overseer): built only when its digest is, from compass.json,
   * and empty without a live note. The Overseer reads Compass here and through the compass_* tools, never a source.
   */
  async digest(): Promise<string[]> {
    const [settings, file] = await Promise.all([this.settings(), this.d.store.read()]);
    if (!file.notes.some(n => n.state === "live")) return [];
    const placed = new Set(file.notes.flatMap(n => n.state === "live" && n.match.workspace ? [n.match.workspace] : []));
    const titles = placed.size ? new Map((await this.d.index().catch(() => ({ workspaces: [] as { id: string; title: string }[] }))).workspaces.map(w => [w.id, w.title])) : new Map<string, string>();
    return digestLines(file.notes as CompassNote[], settings, titles, this.now(), COMPASS.digestNotes);
  }

  /** What AI priority reads: live notes, settled for time first (an ended note never reaches the ranker). */
  async forRanker(): Promise<RankCompassNote[]> {
    const settings = await this.settings();
    if (!settings.sources.length) return [];
    const file = await this.d.store.read();
    const now = this.now();
    const settled = settleNotes(file.notes as CompassNote[], { now, expiry: settings.expiry });
    if (settled.some((n, i) => n !== file.notes[i]) || settled.length !== file.notes.length) await this.d.store.mutate(f => { f.notes = settled; });
    return rankNotes(settled, settings.sources, now, settings.expiry);
  }
}
