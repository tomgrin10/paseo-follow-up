import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { copyOnAccess, deepFreeze, detach, type Collection } from "./cow";

/**
 * A JSON file one worker owns (about.json, linked.json, rename.json): read and validated once, then kept in memory,
 * deep-frozen and shared by every read. A mutation follows a-mutation-copies-only-what-it-changes (server/cow.ts):
 * its draft copies only what it reads, unchanged items keep their saved objects, only what changed is validated, and
 * a real change is serialised once and written atomically; nothing is written when nothing changed.
 *
 * 2026-11-13: these stores re-read and re-parsed their whole file on every read (linked.json, 90 KB live, on every
 * search and panel view) and stringified it on every mutation, the same class as InboxStore's per-mutation copies.
 */
export class JsonFileStore<T extends object> {
  private tail: Promise<unknown> = Promise.resolve();
  private saved: T | null = null;
  /** The file as last read or written (mtime and size): someone else's edit is read again, a stat instead of a parse. */
  private seen: string | null = null;
  /** Writes to the file, for tests. */
  writes = 0;
  constructor(private o: {
    path: string;
    schema: z.ZodType<T>;
    empty: () => T;
    /** Keyed collections whose items are copied, compared and validated one by one. */
    collections?: Record<string, Collection & { item: z.ZodType<unknown> }>;
    /** How the temporary file replaces the real one (default fs.rename). */
    move?: (from: string, to: string) => Promise<void>;
  }) {}
  /** The saved value, shared and frozen: read it, never change it (strict mode throws). */
  async read(): Promise<T> {
    const print = await this.print();
    if (this.saved && print === this.seen) return this.saved;
    let value: T;
    try { value = this.o.schema.parse(JSON.parse(await readFile(this.o.path, "utf8"))); } catch { value = this.o.empty(); }
    this.saved = deepFreeze(value); this.seen = print;
    return this.saved;
  }
  private print(): Promise<string | null> { return stat(this.o.path).then(s => `${s.mtimeMs}:${s.size}`, () => null); }
  mutate<R>(fn: (file: T) => R): Promise<R> {
    const next = this.tail.then(async () => {
      const current = await this.read();
      const { draft, finish } = copyOnAccess(current, this.o.collections ?? {});
      const value = fn(draft);
      const done = finish();
      if (done.changed) {
        const next = done.next as Record<string, unknown>;
        const top: Record<string, unknown> = { ...next };
        for (const [field, c] of Object.entries(this.o.collections ?? {})) {
          const items = next[field] as Record<string, unknown> | unknown[] | undefined;
          for (const id of done.changes.items.get(field) ?? []) {
            const item = Array.isArray(items) ? items.find(i => (c as { id?: (i: never) => string }).id?.(i as never) === id) : items?.[id];
            c.item.parse(item); deepFreeze(item);
          }
          top[field] = Array.isArray(items) ? [] : {};
          if (items) Object.freeze(items);
        }
        this.o.schema.parse(top);
        for (const field of done.changes.fields) if (!this.o.collections?.[field]) deepFreeze(next[field]);
        Object.freeze(next);
        await this.write(next as T);
      }
      return detach(value);
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async write(value: T): Promise<void> {
    await mkdir(dirname(this.o.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.o.path}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await (this.o.move ?? rename)(temporary, this.o.path);
      this.saved = value; this.seen = await this.print(); this.writes++;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}
