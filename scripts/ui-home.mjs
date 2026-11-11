// Playwright helpers that land on Follow-up Home, or fail loudly. For screenshot scripts against an isolated daemon.
//
// Why: Paseo's sidebar lists every workspace under the same title Home shows for its row. Clicking "Follow-up" by text
// and then a row by its title matched the sidebar entry first, so shots silently landed on the workspace page instead
// of Home. These helpers go to Home by URL, wait for something only Home renders, and look rows up only in Home's column.
//
//   import { openHome, homeRow } from "./ui-home.mjs";
//   await openHome(page, { origin: "http://127.0.0.1:<port>", serverId, failShot: "shots/home-failed.png" });
//   await (await homeRow(page, "TKT-1 Fix the build")).click();

/** Follow-up Home's route in Paseo's web app. `serverId` is the daemon's `$PASEO_HOME/server-id`. */
export const homeUrl = (origin, serverId) => `${origin.replace(/\/$/, "")}/h/${serverId}/plugin/follow-through/surface/follow-through`;

// Only Home renders these, on desktop and phone: the status strip and the search field (client/home-chrome.tsx).
// The "Home" heading is desktop-only; phones use the host's header.
const SEARCH = /^(Search, or ask the Overseer|Search or ask the Overseer|Search workspaces, branches, PRs)$/;
const anchors = page => ({ status: page.getByRole("toolbar", { name: "Status", exact: true }), search: page.getByRole("textbox", { name: SEARCH }) });

async function fail(page, failShot, why) {
  if (failShot) await page.screenshot({ path: failShot }).catch(() => {});
  const headings = await page.getByRole("heading").allInnerTexts().catch(() => []);
  throw new Error(`Not on Follow-up Home: ${why}. url=${page.url()} headings=${JSON.stringify(headings.slice(0, 6))}${failShot ? ` screenshot=${failShot}` : ""}`);
}

/**
 * Opens Follow-up Home and waits until Home itself is on screen. Throws (after a `failShot` screenshot) otherwise.
 * `keepDialogs: true` only loads Home's URL and leaves any sheet over it open (Getting started, What's new): the caller
 * waits for what that sheet shows.
 */
export async function openHome(page, { origin, serverId, timeout = 30_000, failShot, keepDialogs = false } = {}) {
  if (!origin || !serverId) throw new Error("openHome needs { origin, serverId }");
  // A fresh browser that opens a deep link before the app has connected to the host lands on /open-project, so load
  // the app first and retry the URL; the sidebar's "Follow-up" entry (exact text, unlike workspace rows) is the fallback.
  await page.goto(origin);
  await page.getByText("Follow-up", { exact: true }).first().waitFor({ state: "attached", timeout }).catch(() => {});
  const { status, search } = anchors(page);
  const onHome = ms => Promise.all([status.first().waitFor({ state: "visible", timeout: ms }), search.first().waitFor({ state: "visible", timeout: ms })]).then(() => true, () => false);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(homeUrl(origin, serverId));
    if (keepDialogs) return;
    // Paseo's first-run sheet can cover the app; close it if it's there.
    await page.getByRole("button", { name: "Close", exact: true }).last().click({ timeout: 1500 }).catch(() => {});
    if (await onHome(8000)) return;
  }
  await page.getByText("Follow-up", { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
  await assertHome(page, { timeout, failShot });
}

/** Throws unless Follow-up Home is what's on screen. */
export async function assertHome(page, { timeout = 10_000, failShot } = {}) {
  const { status, search } = anchors(page);
  try {
    await status.first().waitFor({ state: "visible", timeout });
    await search.first().waitFor({ state: "visible", timeout });
  } catch {
    await fail(page, failShot, "no Status strip and search field");
  }
}

/**
 * The Home row for a workspace title (prefix allowed). Rows are buttons labelled "<title>[ › agent]. <word>. <line>";
 * the sidebar entry with the same title is excluded by requiring the row to sit in the search field's column.
 */
export async function homeRow(page, title, { timeout = 15_000, failShot } = {}) {
  await assertHome(page, { timeout, failShot });
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = page.getByRole("button", { name: new RegExp(`^${esc}`) });
  const column = await anchors(page).search.first().boundingBox();
  const end = Date.now() + timeout;
  for (;;) {
    for (const row of await rows.all()) {
      const box = await row.boundingBox().catch(() => null);
      if (box && column && box.x + box.width > column.x && box.x < column.x + column.width) return row;
    }
    if (Date.now() > end) await fail(page, failShot, `no Home row for "${title}" (${await rows.count()} matches outside Home's column)`);
    await page.waitForTimeout(250);
  }
}
