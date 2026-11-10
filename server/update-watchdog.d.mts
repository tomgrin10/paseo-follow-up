export declare const PROBATION_MS: number;
export declare const LOAD_TIMEOUT_MS: number;
export declare const WATCH_EVERY_MS: number;
export type ProbationInput = { now: number; appliedAt: number; to: string; plugin: { status: "running" | "disabled" | "failed" | "missing"; version: string | null; error: string | null }; heartbeat: { version: string; at: number; error: string | null } | null };
export type ProbationVerdict = { verdict: "wait" } | { verdict: "ok" } | { verdict: "rollback"; reason: string };
export declare function probation(input: ProbationInput): ProbationVerdict;
export type UpdateJob = { directory: string; pluginId: string; from: string; to: string; integrity: string; tarball: string; clientEntry: string; daemon: Record<string, unknown> };
export declare function run(job: UpdateJob, io?: { connect?: () => Promise<unknown>; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<"failed" | "updated" | "rolled-back">;
