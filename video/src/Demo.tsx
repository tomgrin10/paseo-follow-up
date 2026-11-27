import { useMemo } from "react";
import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, Easing, interpolate, spring } from "remotion";
import "@fontsource/inter/latin-600.css";

const fontFamily = "Inter";

export type Box = { x: number; y: number; width: number; height: number };
export type Take = {
  fps: number; seconds: number; view: { width: number; height: number }; scale: number; surface?: Box | null;
  beats: Record<string, number>;
  pointer: [number, number, number][]; presses: [number, number, number][];
  shots: { t: number; name: string; boxes: Box[] }[];
  typing: [number, number][];
};

// ---------- the stage ----------
// 1920×1200. The app (in its dark theme) floats as a window on the slides' ground: violet-black, lit by slowly moving
// lilac light, with the slides' faint 48px grid fading out toward the edges; the camera moves the whole stage, the caption
// stays put in screen space under it.
const W = 1920, H = 1200;
// The window fills most of the frame (a thin margin of field around it) and the caption sits in the band below it.
const WIN = { x: 120, y: 24, w: 1680, h: 1050 };
const INK = "#F2EFF8", LILAC = "#B79CF0", FIELD = "#0B0A10";

const CAPTIONS: { beat: string; words: string; accent: string }[] = [
  { beat: "home", words: "Every agent, one inbox.", accent: "one inbox." },
  { beat: "catchup", words: "Answer in seconds.", accent: "seconds." },
  { beat: "repairs", words: "Fixes go back by themselves.", accent: "by themselves." },
  { beat: "overseer", words: "Ask across every workspace.", accent: "every workspace." },
  { beat: "end", words: "Every agent, one inbox.", accent: "one inbox." },
];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const toStage = (take: Take, x: number, y: number) => [WIN.x + (x / take.view.width) * WIN.w, WIN.y + (y / take.view.height) * WIN.h] as const;

function pointerAt(take: Take, t: number): [number, number] {
  const p = take.pointer;
  if (!p.length) return [take.view.width * 0.86, take.view.height * 0.9];
  if (t <= p[0][0]) return [p[0][1], p[0][2]];
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid][0] <= t) lo = mid; else hi = mid; }
  const [ta, xa, ya] = p[lo], [tb, xb, yb] = p[hi];
  if (t >= tb) return [xb, yb];
  const k = tb > ta ? (t - ta) / (tb - ta) : 1;
  return [xa + (xb - xa) * k, ya + (yb - ya) * k];
}

// ---------- the camera: one framing per shot, from the take's shot list ----------
type Cam = { s: number; x: number; y: number };
const WIDE: Cam = { s: 1, x: W / 2, y: H / 2 };
const CAPTION_TOP = H - 184; // screen y where the caption band starts
const MOVE = 1.6; // seconds a camera move takes
const moveEase = Easing.bezier(0.45, 0, 0.2, 1);

/**
 * The framing of one shot. Two framings exist, both snapped to real UI bounds: the whole window, and the Follow-up
 * surface pane edge to edge (left edge on Paseo's sidebar divider, right edge on the window's, the title bar whole at
 * the top). A shot gets the pane when every box it logged fits inside that frame above the caption; otherwise the
 * window. So the camera only ever rests on one of two compositions and never cuts through content.
 */
function framing(take: Take, boxes: Box[]): Cam {
  if (!boxes.length || !take.surface) return WIDE;
  const [px0] = toStage(take, take.surface.x, 0), [px1] = toStage(take, take.surface.x + take.surface.width, 0);
  const s = W / (px1 - px0);
  const cam = { s, x: (px0 + px1) / 2, y: WIN.y - 10 + H / s / 2 };
  const screen = (x: number, y: number) => { const [sx, sy] = toStage(take, x, y); return [W / 2 + s * (sx - cam.x), H / 2 + s * (sy - cam.y)]; };
  const fits = boxes.every(b => {
    const [x0, y0] = screen(b.x, b.y), [x1, y1] = screen(b.x + b.width, b.y + b.height);
    return x0 >= 0 && x1 <= W && y0 >= 0 && y1 <= CAPTION_TOP - 16;
  });
  return fits ? cam : WIDE;
}

/** The camera at time t: holds each shot's framing, easing from the previous one over MOVE seconds (none when equal). */
function cameraAt(take: Take, frames: Cam[], t: number): Cam {
  let i = -1;
  for (let k = 0; k < take.shots.length; k++) if (take.shots[k].t <= t) i = k;
  if (i < 0) return frames[0] ?? WIDE;
  const to = frames[i], from = i > 0 ? frames[i - 1] : to;
  const k = moveEase(clamp((t - take.shots[i].t) / MOVE, 0, 1));
  const ls = Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * k;
  return { s: Math.exp(ls), x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

// ---------- pieces ----------
const Field = ({ t }: { t: number }) => {
  const ax = 22 + Math.sin(t * 0.35) * 6, ay = 18 + Math.cos(t * 0.28) * 5;
  const bx = 80 + Math.cos(t * 0.31) * 7, by = 88 + Math.sin(t * 0.24) * 5;
  return (
    <AbsoluteFill style={{
      background: `radial-gradient(60% 55% at ${ax}% ${ay}%, rgba(183,156,240,0.17), rgba(183,156,240,0) 70%),
        radial-gradient(55% 50% at ${bx}% ${by}%, rgba(122,85,214,0.16), rgba(122,85,214,0) 70%), ${FIELD}`,
    }}>
      <AbsoluteFill style={{
        backgroundImage: "linear-gradient(rgba(183,156,240,.075) 1px, transparent 1px), linear-gradient(90deg, rgba(183,156,240,.075) 1px, transparent 1px)",
        backgroundSize: "48px 48px", backgroundPosition: "center -1px",
        WebkitMaskImage: "radial-gradient(75% 70% at 50% 45%, #000 35%, transparent 85%)",
      }} />
    </AbsoluteFill>
  );
};

const Arrow = () => (
  <svg width="30" height="36" viewBox="0 0 22 26" style={{ display: "block", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" }}>
    <path d="M3 2.2 L3 20.4 L7.7 15.9 L10.7 22.9 L13.6 21.7 L10.6 14.8 L17.2 14.4 Z" fill="#fff" stroke="#222126" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

/** The pointer: the take's own path, a dip and a lilac ring on each press. */
const Pointer = ({ take, t, fps }: { take: Take; t: number; fps: number }) => {
  const at = (u: number) => toStage(take, ...pointerAt(take, u));
  const [x, y] = at(t);
  let press = 1;
  const rings: { x: number; y: number; k: number }[] = [];
  for (const [pt, cx, cy] of take.presses) {
    const d = t - pt;
    if (d > -0.12 && d < 0.2) press = Math.min(press, 1 - 0.16 * Math.sin(clamp((d + 0.12) / 0.32, 0, 1) * Math.PI));
    if (d >= 0 && d < 0.65) { const [sx, sy] = toStage(take, cx, cy); rings.push({ x: sx, y: sy, k: d / 0.65 }); }
  }
  return (
    <>
      {rings.map((r, i) => {
        const e = Easing.out(Easing.cubic)(r.k), size = 18 + e * 70;
        return <div key={i} style={{ position: "absolute", left: r.x - size / 2, top: r.y - size / 2, width: size, height: size, borderRadius: "50%",
          border: `3px solid ${LILAC}`, background: "rgba(183,156,240,0.18)", opacity: 1 - e }} />;
      })}
      <div style={{ position: "absolute", left: x - 4, top: y - 3, transform: `scale(${press})`, transformOrigin: "4px 3px" }}><Arrow /></div>
    </>
  );
};

const Mark = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" style={{ display: "block" }}>
    <rect width="256" height="256" rx="58" fill="#222126" stroke="rgba(255,255,255,0.14)" strokeWidth="4" />
    <g transform="translate(24.8 24.8) scale(8.6)">
      <path d="M6.95 19.21C7.25 19.11 8.19 18.91 8.75 18.59C9.3 18.27 9.7 18 10.29 17.29C10.89 16.58 11.8 15.23 12.34 14.32C12.87 13.41 13.14 12.75 13.51 11.84C13.88 10.93 14.29 9.96 14.57 8.87C14.84 7.78 15.17 6.23 15.18 5.28C15.2 4.33 14.88 3.61 14.63 3.18C14.38 2.74 14.04 2.66 13.7 2.68C13.36 2.7 12.92 2.85 12.58 3.3C12.25 3.75 11.93 4.48 11.72 5.4C11.5 6.33 11.32 7.8 11.29 8.87C11.25 9.94 11.36 10.93 11.53 11.84C11.71 12.75 11.97 13.58 12.34 14.32C12.71 15.06 13.23 15.8 13.76 16.3C14.29 16.79 14.98 17.03 15.49 17.29C16.01 17.55 16.63 17.75 16.86 17.85" fill="none" stroke="#fff" strokeWidth="1.42" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="4.85" cy="19.15" r="2.14" fill="none" stroke="#fff" strokeWidth="1.42" />
      <circle cx="20.01" cy="18.03" r="1.92" fill={LILAC} />
    </g>
  </svg>
);

/**
 * The caption: words rise in out of a blur one after another, the accent words in lilac with a line that sweeps under
 * them, then leave upward the same way just before the next beat. The first and last caption are the same, held
 * still at the cut, so the loop has no seam.
 */
const Caption = ({ take, t, zoom, fps }: { take: Take; t: number; zoom: number; fps: number }) => {
  const starts = CAPTIONS.map((c, i) => (i === 0 ? -100 : take.beats[c.beat] ?? Infinity));
  let i = 0;
  for (let k = 0; k < CAPTIONS.length; k++) if (t >= starts[k] - 0.05) i = k;
  const cap = CAPTIONS[i], start = starts[i], end = i + 1 < CAPTIONS.length ? starts[i + 1] : Infinity;
  const words = cap.words.split(" ");
  const accentFrom = words.length - cap.accent.split(" ").length;
  const inE = Easing.bezier(0.16, 1, 0.3, 1), outE = Easing.bezier(0.7, 0, 0.84, 0);
  const sweep = i === 0 ? 1 : inE(clamp((t - start - 0.35 - accentFrom * 0.06) / 0.6, 0, 1));
  const leave = inE(clamp((t - (end - 0.34)) / 0.3, 0, 1));
  const word = (w: string, j: number, color: string) => {
    const enter = i === 0 ? 1 : inE(clamp((t - start - j * 0.06) / 0.55, 0, 1));
    const exit = outE(clamp((t - (end - 0.36) - j * 0.035) / 0.3, 0, 1));
    return (
      <span key={`${i}-${j}`} style={{ display: "inline-block", color, opacity: enter * (1 - exit),
        transform: `translateY(${(1 - enter) * 28 - exit * 18}px)`, filter: `blur(${(1 - enter) * 10 + exit * 8}px)` }}>{w}</span>
    );
  };
  const pop = i === 0 ? 1 : 0.82 + 0.18 * spring({ frame: Math.max(0, (t - start) * fps), fps, config: { damping: 10, stiffness: 170 } });
  // A scrim rises behind the caption while the camera is in, so it reads over the app.
  const scrim = clamp((zoom - 1) / 0.18, 0, 1);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 300, opacity: scrim,
        background: "linear-gradient(to top, rgba(11,10,16,0.94) 0%, rgba(11,10,16,0.78) 40%, rgba(11,10,16,0) 100%)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 22, height: 92, display: "flex", alignItems: "center", justifyContent: "center", gap: 26 }}>
        <div style={{ transform: `scale(${pop}) rotate(${(1 - pop) * -40}deg)` }}><Mark size={66} /></div>
        <div style={{ fontFamily, fontSize: 56, fontWeight: 600, letterSpacing: "-0.028em", color: INK, whiteSpace: "nowrap", display: "flex", gap: "0.26em" }}>
          {words.slice(0, accentFrom).map((w, j) => word(w, j, INK))}
          <span style={{ display: "inline-flex", gap: "0.26em", position: "relative" }}>
            {words.slice(accentFrom).map((w, j) => word(w, accentFrom + j, LILAC))}
            <span style={{ position: "absolute", left: 0, right: "0.32em", bottom: -6, height: 4, borderRadius: 2, background: LILAC,
              opacity: 0.75 * (1 - leave), transformOrigin: "left", transform: `scaleX(${sweep})` }} />
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------- the edit ----------
export const Demo = ({ take }: { take: Take | null }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const shotFrames = useMemo(() => (take ? take.shots.map(sh => framing(take, sh.boxes)) : []), [take]);
  if (!take) return null;
  const t = frame / fps;
  const cam = cameraAt(take, shotFrames, t);
  // The last half second dissolves into the first frame of the app, so the loop's cut is invisible.
  const loopFade = interpolate(frame, [durationInFrames - 16, durationInFrames - 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const shadow = interpolate(cam.s, [1, 1.5], [1, 0.4], { extrapolateRight: "clamp" });
  const video = { position: "absolute" as const, inset: 0, width: WIN.w, height: WIN.h };
  return (
    <AbsoluteFill style={{ background: FIELD, overflow: "hidden" }}>
      <AbsoluteFill style={{ transformOrigin: "0 0", transform: `translate(${W / 2}px, ${H / 2}px) scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)` }}>
        <Field t={t} />
        <div style={{ position: "absolute", left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, borderRadius: 18, overflow: "hidden",
          boxShadow: `0 ${40 * shadow}px ${120 * shadow}px rgba(0,0,0,${0.7 * shadow}), 0 0 0 1px rgba(183,156,240,0.22)`, background: "#1b1c1c" }}>
          <OffthreadVideo src={staticFile("take/raw.mp4")} style={video} muted />
          {loopFade > 0 && (
            <Freeze frame={0}><div style={{ ...video, opacity: loopFade }}><OffthreadVideo src={staticFile("take/raw.mp4")} style={video} muted /></div></Freeze>
          )}
        </div>
        <Pointer take={take} t={t} fps={fps} />
      </AbsoluteFill>
      <Caption take={take} t={t} zoom={cam.s} fps={fps} />
    </AbsoluteFill>
  );
};
