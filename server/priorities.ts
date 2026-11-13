import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mergePriorities, prioritiesFileSchema, type Priority } from "../shared/priorities";

/**
 * External priorities (plugin-data/follow-up/priorities.json), kept apart from state.json so a ranker
 * writing every few minutes never contends with the engine's state writes. Unreadable means none.
 */
export class PriorityStore {
  private tail: Promise<unknown> = Promise.resolve();
  /** After each write (the Home feed pushes the new order). */
  onWrite: () => void = () => {};
  constructor(readonly directory: string) {}
  private get path() { return join(this.directory, "priorities.json"); }
  async read(): Promise<Priority[]> {
    try { return prioritiesFileSchema.parse(JSON.parse(await readFile(this.path, "utf8"))).items; } catch { return []; }
  }
  async write(batch: Priority[], replace: boolean): Promise<Priority[]> {
    const next = this.tail.then(async () => {
      const items = mergePriorities(await this.read(), batch, replace);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `priorities.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, items }, null, 2)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
      } finally { await unlink(temporary).catch(() => undefined); }
      return items;
    });
    void next.then(() => this.onWrite(), () => undefined);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
