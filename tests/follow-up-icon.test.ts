/**
 * follow-up-has-one-mark (2026-11-16): every surface that stands for Follow-up itself draws FOLLOW_UP_ICON, a
 * self-contained currentColor glyph, and none falls back to lucide GitPullRequest (that icon means a pull request).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { findSvgIconProblem, PLUGIN_SVG_ICON_MAX_BYTES } from "@getpaseo/plugin";
import { FOLLOW_UP_DOT, FOLLOW_UP_ICON, NEED_DOT, needDotBox } from "../client/follow-up-icon";

test("the Follow-up glyph is valid inline SVG for the host, takes the host colour and is small", () => {
  const { svg } = FOLLOW_UP_ICON;
  assert.equal(findSvgIconProblem(svg), null);
  assert.ok(new TextEncoder().encode(svg).byteLength < PLUGIN_SVG_ICON_MAX_BYTES / 16, "well under the size cap");
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /fill="currentColor"/, "the end dot is filled with the host colour");
  assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b/i, "no fixed colour: the glyph follows the theme");
});

test("the end dot the Needs-you dot covers is the glyph's filled circle", () => {
  const dot = FOLLOW_UP_ICON.svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="currentColor"/);
  assert.ok(dot, "one filled end dot");
  assert.deepEqual(FOLLOW_UP_DOT, { x: Number(dot[1]) / 24, y: Number(dot[2]) / 24 });
});

test("one source for the glyph: no other file draws its path", async () => {
  const path = FOLLOW_UP_ICON.svg.match(/<path d="([^"]+)"/)![1];
  const { readdir } = await import("node:fs/promises");
  const hits: string[] = [];
  for (const dir of ["client", "shared", "server", "."]) {
    for (const name of await readdir(dir)) {
      if (!/\.(tsx?|mjs)$/.test(name)) continue;
      const file = dir === "." ? name : `${dir}/${name}`;
      if (file !== "client/follow-up-icon.ts" && (await readFile(file, "utf8")).includes(path.slice(0, 40))) hits.push(file);
    }
  }
  assert.deepEqual(hits, []);
});

test("the app tile is the same mark", async () => {
  const tile = await readFile("assets/icon.svg", "utf8");
  const path = FOLLOW_UP_ICON.svg.match(/<path d="([^"]+)"/)?.[1];
  assert.ok(path && tile.includes(`d="${path}"`), "assets/icon.svg draws the glyph's path");
  const manifest = JSON.parse(await readFile("paseo-plugin.json", "utf8"));
  assert.equal(manifest.icon, "assets/icon.png");
});

test("Follow-up's own surfaces use the mark, never GitPullRequest", async () => {
  const entry = await readFile("index.client.tsx", "utf8");
  const settings = await readFile("client/settings-screens.ts", "utf8");
  assert.match(settings, /addSettingsScreen\(\{ id: SETTINGS_SCREEN, title: "Follow-up", icon: FOLLOW_UP_ICON/, "the one-screen Settings (Paseo 0.15)");
  for (const call of [/addWorkspacePanel\(\{ id: PANEL[^\n]*/, /addCommandCenterItem\(\{ id: "open-follow-up",[^\n]*/]) {
    const line = entry.match(call)?.[0];
    assert.ok(line, String(call));
    assert.match(line, /icon: FOLLOW_UP_ICON/, line.slice(0, 60));
    assert.doesNotMatch(line, /GitPullRequest/);
  }
  const live = await readFile("client/live.tsx", "utf8");
  const header = live.slice(live.indexOf("export function headerIcon"), live.indexOf("export function sidebarItem"));
  assert.match(header, /<Icon icon=\{FOLLOW_UP_ICON\}/, "header button");
  assert.doesNotMatch(header, /GitPullRequest/);
  const sidebar = live.slice(live.indexOf("export function sidebarItem"));
  assert.match(sidebar, /<SidebarRow icon=\{FOLLOW_UP_ICON\}/, "sidebar row");
  assert.doesNotMatch(sidebar.slice(0, sidebar.indexOf("</>;")), /GitPullRequest/);
  const large = await readFile("client/large.tsx", "utf8");
  assert.match(large, /icon=\{FOLLOW_UP_ICON\} title="Nothing to show here"/, "the retired larger view's empty state (a link with no workspace)");
});

test("the header's Needs-you dot stays whole inside the icon box, on the end dot as near as fits", () => {
  // Paseo clips a header button's icon to its box (overflow hidden); 2026-11-16 the centred dot drew flat-topped.
  for (const size of [14, 16, 20, 24]) {
    const { left, top } = needDotBox(size);
    assert.ok(left >= 0 && top >= 0 && left + NEED_DOT <= size && top + NEED_DOT <= size, `inside at ${size}`);
    // As near as fits: the centre is the end dot's, pulled in only as far as the box edge makes it.
    const near = (v: number) => Math.min(Math.max(v, NEED_DOT / 2), size - NEED_DOT / 2);
    assert.ok(Math.abs(left + NEED_DOT / 2 - near(size * FOLLOW_UP_DOT.x)) < 1e-9, `x at ${size}`);
    assert.ok(Math.abs(top + NEED_DOT / 2 - near(size * FOLLOW_UP_DOT.y)) < 1e-9, `y at ${size}`);
    if (size === 16) assert.ok(Math.hypot(left + NEED_DOT / 2 - 16 * FOLLOW_UP_DOT.x, top + NEED_DOT / 2 - 16 * FOLLOW_UP_DOT.y) < 1, "on the end dot at Paseo's 16 px");
  }
  const live = readFileSync("client/live.tsx", "utf8");
  assert.match(live, /\.\.\.needDotBox\(props\.size\)/, "the header icon places its dot with needDotBox");
});
