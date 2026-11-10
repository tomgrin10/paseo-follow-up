/** RPC errors arrive as "Request failed: <reason> requestType=… code=…"; people only need the reason. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/^Request failed:\s*/i, "").replace(/\s*requestType=\S+.*$/s, "").trim() || "Something went wrong. Try again.";
}

/** A reason as one sentence with exactly one stop, so more text can follow it: "x." and "x" both become "x.". */
export function sentence(reason: string): string {
  const t = reason.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}
