export declare const ALLOWED: { token: string; reason: string; files: string[] }[];
export declare function machineNames(env?: Record<string, string | undefined>, host?: string, user?: string): string[];
export declare function deniedNames(text: string, where?: string, machine?: string[]): string[];
export declare function assertNoRealNames(text: string, label?: string): void;
