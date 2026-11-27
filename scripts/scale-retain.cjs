// Preloaded (node --require) by scripts/scale-check.mjs --retain-mb <n>: a synthetic regression for proving the scale
// gate still catches growth. A plugin process holds SCALE_RETAIN_MB MB for its whole life, half on V8's heap and half
// native (touched Buffers), the two places a real leak lands. Other processes (the daemon, agents) are left alone.
const mb = Number(process.env.SCALE_RETAIN_MB || 0);
if (mb > 0 && process.argv.some(a => /plugin-process/.test(a))) {
  const held = (globalThis.__scaleRetained = []);
  const half = Math.round(mb / 2);
  for (let i = 0; i < half; i++) held.push(Buffer.alloc(1024 * 1024, 1));
  for (let i = 0; i < mb - half; i++) held.push(new Array(1024 * 1024 / 8).fill(i + 0.5));
}

// SCALE_LEAK_MB_PER_MIN (scale-check --leak-mb-per-min <n>): a leak, not a level. The plugin process keeps n MB more
// every minute for its whole life (a tenth every 6 s, half heap, half native), so what the bursts' window grows never
// comes back: the burst-return gate must fail on it while a constant --retain-mb, which moves the baseline too, passes.
const leak = Number(process.env.SCALE_LEAK_MB_PER_MIN || 0);
if (leak > 0 && process.argv.some(a => /plugin-process/.test(a))) {
  const kept = (globalThis.__scaleLeaked = []); let n = 0;
  setInterval(() => { const mbs = leak / 10; const bytes = Math.round(mbs * 1024 * 1024); if (n++ % 2) kept.push(Buffer.alloc(bytes, 1)); else kept.push(new Array(Math.round(bytes / 8)).fill(n + 0.5)); }, 6_000).unref();
}
