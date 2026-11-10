/**
 * Reduced motion, known on the first render. The system's answer (AccessibilityInfo) arrives asynchronously, so a hook
 * that starts at `false` lets every fade start before it knows. On web the media query answers synchronously; on
 * native the last answer any mount got is remembered, so only the very first mount waits for the system.
 */
const QUERY = "(prefers-reduced-motion: reduce)";
let remembered: boolean | null = null;

/** Records the system's answer (a resolved promise or a change event); `null` forgets it (tests). */
export function rememberReducedMotion(value: boolean | null): void { remembered = value; }

type MediaHost = { matchMedia?: (query: string) => { matches: boolean } };
/** The best synchronous guess: the remembered answer, else the web media query, else motion on. Never throws. */
export function initialReducedMotion(host: MediaHost = globalThis as MediaHost): boolean {
  if (remembered !== null) return remembered;
  try { return typeof host.matchMedia === "function" ? host.matchMedia(QUERY).matches === true : false; } catch { return false; }
}
