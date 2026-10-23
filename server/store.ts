import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateSchema, type State } from "../shared/model";

export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  async read(): Promise<State> {
    try { return stateSchema.parse(JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: [] };
      throw new Error("Saved follow-through state could not be read. Restore state.json before continuing.");
    }
  }
  async mutate<T>(work: (state: State) => T | Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const state = await this.read();
      const value = await work(state);
      await this.write(state);
      return structuredClone(value);
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  async snapshot(): Promise<State> { await this.tail; return this.read(); }
  private async write(state: State): Promise<void> {
    stateSchema.parse(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `state.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.directory, "state.json"));
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "worker.lock");
    const token = `${process.pid}:${randomUUID()}`;
    const claim = async () => {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(token); } finally { await file.close(); }
    };
    try { await claim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await readFile(path, "utf8");
      const pid = Number(prior.split(":")[0]);
      if (!Number.isInteger(pid) || pid < 1) throw new Error("Worker lock has an invalid owner.");
      try { process.kill(pid, 0); throw new Error("Another follow-through worker is running."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      const recovery = await open(`${path}.recovery`, "wx", 0o600);
      try {
        if (await readFile(path, "utf8") !== prior) throw new Error("Worker ownership changed. Retry loading.");
        await unlink(path); await claim();
      } finally { await recovery.close(); await unlink(`${path}.recovery`); }
    }
    return async () => { if (await readFile(path, "utf8").catch(() => "") === token) await unlink(path); };
  }
}
