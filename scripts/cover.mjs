// Renders Follow-up's slide set: the README's cover and the plugin page's media (paseo-plugin.json `media`, cover
// first). Every slide is 16:10 (1920×1200 at 2×), because Paseo's plugin page shows media as 288×180 tiles and its
// list card shows the first one at aspect 1.6. One dark look on every slide, grown from assets/icon.svg (tile #222126,
// accent #B79CF0), because most people run Paseo dark: a violet-black ground lit from above by the lilac, a faint grid
// behind the words, Follow-up's icon and name centred at the top, a one-line headline (its second part in the lilac)
// over one plain line in mono, and a real screen in Follow-up's dark theme on a sheet below them that runs off the
// bottom edge.
//   - follow-up-slide-1-cover.png: the headline and the purpose line over Home's Follow-up pane, enlarged on a wider
//     sheet so its rows still read at a README column's width, and kept lossless (no pngquant).
//   - follow-up-slide-2…6: one feature each, a short headline and one plain line saying what it does for you, over that
//     feature's real element filling the sheet's width, cropped from an 8× render. Slide 6 is a phone screen, on a
//     narrower sheet with phone corners.
// An HTML composition rendered with headless Chromium. The sources come from `scripts/screenshots.mjs --only frames`
// (synthetic data only); scripts/readme-shots.sh runs both.
//
//   node scripts/cover.mjs --from <frames out dir> --out <dir> [--only cover,decision,…]
//     [--headline "First part|Second part"] [--subline "…"] (or COVER_HEADLINE, COVER_SUBLINE)
//
// Needs PLAYWRIGHT_CORE and CHROMIUM (docs/testing.md). The fonts load from Google Fonts;
// without a network system fonts stand in. Run it through ~/paseo-harness/tools/harness-slot (it starts a browser).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { harness } from "./harness.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const fail = message => { console.error(`cover: ${message}`); process.exit(1); };
const from = arg("--from"), outDir = arg("--out");
if (!from || !outDir) fail("needs --from <frames dir> --out <dir>");
if (!process.env.PLAYWRIGHT_CORE || !process.env.CHROMIUM) fail("set PLAYWRIGHT_CORE and CHROMIUM (docs/testing.md)");
const W = 1920, H = 1200;

/** The slides, in plugin-page order. `src` names a file of the frames run (follow-up-<src>.png). */
export const SLIDES = [
  { name: "1-cover", kind: "cover",
    headline: process.env.COVER_HEADLINE || "Every agent,|one inbox.",
    subline: process.env.COVER_SUBLINE || "Your agents work in parallel. Your attention span doesn't.",
    src: "cover-home" },
  { name: "2-decision", headline: "Answer|in seconds", line: "Agents always tell you exactly what they need from YOU.", src: "slide-decision" },
  { name: "3-overseer", headline: "Ask across|every workspace", line: "One agent knows them all. Ask it anything from Home's search box.", src: "slide-overseer" },
  { name: "4-repairs", headline: "Fixes go back|by themselves", line: "Failed checks, conflicts and review comments go to the agent that made the PR.", src: "slide-repairs" },
  { name: "5-deploy", headline: "It keeps|following up", line: "Tasks come due after the merge or the deploy, and go back to their agent.", src: "slide-deploy" },
  { name: "6-catch-up", headline: "Catch up|from your phone", line: "Inspired by Slack: a catch-up mode to swipe through every task that needs you.", src: "slide-catch-up", phone: true },
];
if (arg("--headline")) SLIDES[0].headline = arg("--headline");
if (arg("--subline")) SLIDES[0].subline = arg("--subline");
const onlyNames = arg("--only")?.split(",");

const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/'/g, "\u2019");
const file = name => { const p = join(resolve(from), `follow-up-${name}.png`); if (!existsSync(p)) fail(`no ${p}; run screenshots.mjs --only frames first`); return p; };
const data = name => `data:image/png;base64,${readFileSync(file(name)).toString("base64")}`;
const size = name => { const b = readFileSync(file(name)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const icon = `data:image/svg+xml;base64,${readFileSync(new URL("../assets/icon.svg", import.meta.url)).toString("base64")}`;
// One line: "First part|Second part" sets the second part in the accent.
const headline = h => { const [a, b = ""] = h.split("|"); return `<h1>${esc(a)}${b ? ` <em>${esc(b)}</em>` : ""}</h1>`; };

const SHEET = 1440; // CSS px: the feature slides' sheet
const COVER_SHEET = 1320; // CSS px: keep three extra status rows readable below Needs you
const PHONE_SHEET = 760;
const STRETCH = 1.15; // the most a source is enlarged past its own pixels
const SIDE = 80; // the headline keeps this clear of each edge
const MIN_SHOWN = 560; // CSS px of the sheet that must stay on the slide below the words
// The look: a deep violet-black ground grown from the icon's tile, lit from above by its lilac end dot, with a faint
// grid that fades out before the screen; the headline in the light ink, its second part in the lilac; the plain line
// set in mono; and the app's real dark theme on a sheet with a lilac hairline and one lit top edge.
const css = `
  :root { --ground: #0b0a10; --ink: #f2eff8; --accent: #b79cf0; --muted: #bdb5d0; --line: rgba(183,156,240,.075); }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body { position: relative; color: var(--ink); font-family: Geist, Inter, "Liberation Sans", Arial, sans-serif;
    background:
      radial-gradient(1100px 520px at 50% -8%, rgba(183,156,240,.17), rgba(183,156,240,0) 70%),
      radial-gradient(1500px 700px at 50% 118%, rgba(122,85,214,.22), rgba(122,85,214,0) 70%),
      var(--ground);
    display: flex; flex-direction: column; align-items: center; padding-top: 64px; -webkit-font-smoothing: antialiased; }
  /* The grid: 48px cells, strongest behind the words, gone before the screen's edges. */
  body::before { content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 48px 48px; background-position: center -1px;
    -webkit-mask-image: radial-gradient(1200px 760px at 50% 18%, #000 30%, transparent 78%); }
  body > * { position: relative; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; }
  .brand img { width: 52px; height: 52px; border-radius: 12px; box-shadow: 0 0 0 1px rgba(255,255,255,.12), 0 8px 24px rgba(0,0,0,.5); }
  h1 { margin-top: 26px; font: 600 132px/1.02 Geist, Inter, "Liberation Sans", sans-serif; letter-spacing: -0.045em; white-space: nowrap; }
  /* The cover's top breathes like the slides' (brand, headline, line); only the gap to its sheet is tighter, so Home's
     extra status rows still show above the bottom edge. */
  .cover h1 { font-size: 146px; }
  .cover .stage { margin-top: 40px; }
  .cover .sheet { min-height: calc(100% + 32px); border-radius: 20px 20px 0 0; }
  h1 em { font-style: normal; color: var(--accent); }
  .line { margin-top: 30px; font: 500 32px/1.3 "Geist Mono", "JetBrains Mono", "Liberation Mono", monospace; letter-spacing: -0.02em;
    color: var(--muted); white-space: nowrap; }
  .stage { margin-top: 56px; flex: 1 0 0; width: 100%; display: flex; justify-content: center; align-items: flex-start; }
  .sheet { position: relative; flex: none; overflow: hidden; background: #1b1c1c; border-radius: 20px;
    box-shadow: 0 0 0 1px rgba(183,156,240,.22), 0 -24px 90px -30px rgba(183,156,240,.35), 0 40px 100px -10px rgba(0,0,0,.75); }
  /* One lit edge: the top hairline brightens toward the middle. */
  .sheet::after { content: ""; position: absolute; top: 0; left: 8%; right: 8%; height: 1px;
    background: linear-gradient(90deg, rgba(183,156,240,0), rgba(214,198,250,.85), rgba(183,156,240,0)); }
  .sheet.phone { border-radius: 56px; }
  .sheet img { display: block; width: 100%; }
`;const brand = `<div class="brand"><img src="${icon}" alt="">Follow-up</div>`;

function page(s) {
  // Every desktop sheet is SHEET wide and every phone sheet PHONE_SHEET, so the set lines up; the element fills it,
  // stretched at most STRETCH past its own pixels (the slide renders at 2×, so an image of w device pixels shows crisp
  // up to w/2 CSS pixels). A tall element runs off the slide's bottom; a short one ends its sheet just below it.
  const { w } = size(s.src);
  const width = s.phone ? PHONE_SHEET : s.kind === "cover" ? COVER_SHEET : SHEET;
  if (width > w / 2 * STRETCH) fail(`${s.name}: follow-up-${s.src}.png is ${w} px wide, too small for a ${width} px sheet; shoot it at a higher scale`);
  const words = s.kind === "cover" ? s.subline : s.line;
  return `<body class="${s.kind === "cover" ? "cover" : "slide"}">${brand}${headline(s.headline)}<p class="line">${esc(words)}</p>
    <div class="stage"><div class="sheet${s.phone ? " phone" : ""}" style="width:${width}px"><img src="${data(s.src)}" alt=""></div></div></body>`;
}

await harness();
const dir = mkdtempSync(join(tmpdir(), "follow-up-cover-"));
const exec = promisify(execFile);
try {
  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  try {
    for (const s of SLIDES.filter(x => !onlyNames || onlyNames.some(n => x.name.endsWith(n)))) {
      writeFileSync(join(dir, "slide.html"), `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@500;600&family=Geist+Mono:wght@500&display=block" rel="stylesheet"><style>${css}</style></head>${page(s)}</html>`);
      const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
      await p.goto(`file://${join(dir, "slide.html")}`);
      await p.evaluate(() => document.fonts.ready);
      await p.waitForFunction(() => [...document.images].every(i => i.complete));
      // The headline stays on one line, SIDE clear of each edge: the size steps down until it fits.
      const px = await p.evaluate(max => {
        const h = document.querySelector("h1");
        let px = parseFloat(getComputedStyle(h).fontSize);
        while (px > 56 && h.getBoundingClientRect().width > max) h.style.fontSize = `${(px -= 2)}px`;
        return px;
      }, W - 2 * SIDE);
      if (px <= 56) fail(`${s.name}: the headline is too long even at 56px; shorten it`);
      // The plain line fits the slide, and the words leave at least MIN_SHOWN px of the screen below them.
      const fit = await p.evaluate(() => ({ line: document.querySelector(".line").getBoundingClientRect().width, sheet: document.querySelector(".sheet").getBoundingClientRect().top }));
      if (fit.line > W - 2 * SIDE) fail(`${s.name}: the line is wider than the slide; shorten it`);
      if (H - fit.sheet < MIN_SHOWN) fail(`${s.name}: the words leave too little of the screen (${Math.round(H - fit.sheet)}px)`);
      const out = resolve(outDir, `follow-up-slide-${s.name}.png`);
      await p.screenshot({ path: out });
      await p.close();
      // The cover stays lossless: pngquant's dithering speckles Home's small text once the cover is scaled down.
      if (s.kind !== "cover") await exec("pngquant", ["--force", "--skip-if-larger", "--quality", "70-95", "--strip", "--output", out, out]).catch(() => {});
      console.log(`cover: ${out}`);
    }
  } finally { await browser.close(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
