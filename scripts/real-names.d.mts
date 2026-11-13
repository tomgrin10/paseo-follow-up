export declare const hashWord: (word: string) => string;
export declare const COMPANY_HASHES: string[];
export declare const EXCLUDED: Record<string, string>;
export declare function machineNames(env?: Record<string, string | undefined>, host?: string, user?: string): string[];
export declare const NAME_HASHES: string[];
export declare const TICKET_HASHES: string[];
export declare function deniedNames(text: string, opts?: { machine?: string[]; hashes?: string[]; names?: string[]; tickets?: string[]; allow?: string[] }): string[];
export declare function assertNoRealNames(text: string, label?: string, allow?: string[]): void;
