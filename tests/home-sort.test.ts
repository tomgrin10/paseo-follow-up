import test from "node:test";
import assert from "node:assert/strict";
import { homeSortSync } from "../shared/display";
import type { SortMode } from "../shared/sort";

/** A host Display document behind the settings read/write RPCs, with revisions. */
function host(values: Record<string, unknown>) {
  let doc = { revision: "r1", values };
  const writes: Record<string, unknown>[] = [];
  const client = {
    rpc: async (contract: { method?: string; name?: string } & object, input: { revision?: string; values?: Record<string, unknown> }) => {
      const name = JSON.stringify(contract);
      if (/write/.test(name)) {
        if (input.revision !== doc.revision) return { status: "conflict", error: "changed" };
        writes.push(input.values!);
        doc = { revision: `r${writes.length + 1}`, values: input.values! };
        return { status: "saved", revision: doc.revision, values: doc.values };
      }
      return { status: "ready", revision: doc.revision, values: doc.values };
    },
  };
  return { client: client as never, writes, doc: () => doc };
}
function device(start: SortMode, h: ReturnType<typeof host>) {
  let sort = start;
  const sync = homeSortSync(h.client, () => sort, s => { sort = s; });
  return { sync, sort: () => sort };
}

test("the first device to load moves its per-device order to the host, once", async () => {
  const h = host({ enable_inbox: true });
  const a = device("recent", h);
  assert.equal(await a.sync.read(), false);
  assert.deepEqual(h.writes, [{ enable_inbox: true, home_sort: "recent" }], "merged into the Display document, nothing else changed");
  const b = device("name", h);
  assert.equal(await b.sync.read(), true, "a second device takes the host's order instead of migrating its own");
  assert.equal(b.sort(), "recent");
  assert.equal(h.writes.length, 1);
});

test("a device on the default order migrates nothing; the host's order wins when set", async () => {
  const h = host({});
  await device("priority", h).sync.read();
  assert.deepEqual(h.writes, []);
  const h2 = host({ home_sort: "oldest" });
  const d = device("priority", h2);
  assert.equal(await d.sync.read(), true);
  assert.equal(d.sort(), "oldest");
});

test("choosing an order writes home_sort, re-reading once after a conflicting write", async () => {
  const h = host({ enable_inbox: true, home_sort: "priority" });
  const d = device("priority", h);
  await d.sync.write("project");
  assert.equal(h.doc().values.home_sort, "project");
  assert.equal(h.doc().values.enable_inbox, true);
});
