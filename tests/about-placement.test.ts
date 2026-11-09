import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// "What's this about?" is the first thing under the header, above the ask, on every size (Tom, 2026-11-09).
// The client needs the Paseo host to render, so these read the JSX order of the two surfaces directly.

const source = (path: string) => readFile(resolve(path), "utf8");

test("Home's detail pane renders What's this about? once, for every size, before permissions and the ask", async () => {
  const home = await source("client/home.tsx");
  const pane = home.slice(home.indexOf("const header = "), home.indexOf("function OverseerPane") > 0 ? home.indexOf("function OverseerPane") : undefined);
  const abouts = [...pane.matchAll(/<AboutSection\b[^>]*>/g)];
  assert.equal(abouts.length, 1, "one placement, not a phone and a desktop copy");
  const line = pane.slice(pane.lastIndexOf("\n", abouts[0].index!), abouts[0].index!);
  assert.doesNotMatch(line, /compact\s*&&/, "not gated on the layout size");
  const scroll = pane.indexOf("<ScrollView");
  assert.ok(scroll > 0 && scroll < abouts[0].index!, "inside the scroll body, right under the header");
  for (const later of ["<PermissionBlock", "<BriefCard", "<NeedsYouList", "{actionBar}"]) {
    const at = pane.indexOf(later, scroll);
    assert.ok(at > abouts[0].index!, `${later} comes after What's this about?`);
  }
});

test("the workspace panel renders What's this about? before the main agent's ask", async () => {
  const panel = await source("client/panel.tsx");
  const view = panel.slice(panel.indexOf("export function WorkspaceView"));
  const about = view.indexOf("{about}"); const ask = view.indexOf("{ask}");
  assert.ok(about > 0 && ask > about, "about, then ask");
});
