import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { bindRowDoubleClick, useRowOpen } from "../client/row-open";

test("a desktop double-click opens once; controls, menus and touch keep their behavior", () => {
  let listener: ((e: any) => void) | undefined;
  let opens = 0;
  const node = {
    addEventListener(type: string, f: typeof listener) { assert.equal(type, "dblclick"); listener = f; },
    removeEventListener(type: string, f: typeof listener) { assert.equal(type, "dblclick"); assert.equal(f, listener); listener = undefined; },
  };
  const off = bindRowDoubleClick(node, () => opens++);
  const event = (closest: unknown = node, pointerType = "mouse") => ({ target: { closest: () => closest }, pointerType });
  listener!(event());
  assert.equal(opens, 1, "row text or background opens the row");
  for (const control of ["button", "link", "menuitem", "menu", "input"]) listener!(event({ control }));
  listener!(event(node, "touch"));
  assert.equal(opens, 1, "nested controls and touch do not open");
  assert.ok(off);
  off();
  assert.equal(listener, undefined, "unmount removes the listener");
  assert.equal(bindRowDoubleClick(null, () => opens++), undefined, "native has no DOM listener");
});

test("Home's regular rows and search results reuse Enter's opener, with touch and menu guards", async () => {
  const list = await readFile(new URL("../client/home-list.tsx", import.meta.url), "utf8");
  for (const section of [list.slice(list.indexOf('case "result":'), list.indexOf('case "ask":')), list.slice(list.indexOf('case "row":'), list.indexOf('const listRef'))]) {
    assert.match(section, /onOpen=\{onOpen\}/);
  }
  assert.match(list, /const onOpen = useRowOpen\(keys\?\.onOpen\)/);
  assert.doesNotMatch(list, /selectedBg, keys\?\.onOpen\]\)/);
  assert.match(list, /if \(touch \|\| menuOpen \|\| !onOpen\) return;/);
  assert.match(list, /bindRowDoubleClick\(trigger\.ref\.current[^,]*, \(\) => onOpen\(s\.key\)\)/);
  assert.match(list, /onPress=\{\(\) => onSelect\(s\.key\)\}/, "single click still selects");
});


test("a new Home opener keeps the row callback stable and calls the latest opener", async () => {
  const { create, act } = await import("react-test-renderer" as string);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let received: ((key: string) => void) | undefined;
  function Probe({ open }: { open?: (key: string) => void }) {
    received = useRowOpen(open);
    return null;
  }
  const calls: string[] = [];
  let renderer: { update(el: unknown): void; unmount(): void };
  await act(async () => { renderer = create(createElement(Probe, { open: key => calls.push(`first:${key}`) })); });
  const first = received!;
  first("ws:one");
  await act(async () => { renderer.update(createElement(Probe, { open: key => calls.push(`latest:${key}`) })); });
  assert.equal(received, first, "memoized rows receive the same callback after a Home render");
  received!("ws:two");
  assert.deepEqual(calls, ["first:ws:one", "latest:ws:two"], "the stable callback uses the current opener");
  await act(async () => { renderer.update(createElement(Probe, {})); });
  assert.equal(received, undefined, "no opener means no row activation");
  await act(async () => { renderer.unmount(); });
});
