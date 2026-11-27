// Types for the parts of server/mcp.mjs the worker imports (the file itself stays plain JS: it ships as the stdio bridge).
export type ToolTuple = [name: string, description: string, method: string, properties: Record<string, unknown>, required: string[]];
export type ToolSchema = { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false }; annotations: Record<string, boolean> };
export const tools: ToolTuple[];
export const actionTools: ToolTuple[];
export const overseerTools: ToolTuple[];
export const waitInstruction: string;
export const backgroundWorkInstruction: string;
export function toolList(recovery?: boolean, contributor?: boolean, brief?: boolean, briefOnly?: boolean, actions?: boolean): ToolTuple[];
export function schemas(list: ToolTuple[], workflows?: "graphite" | "github" | "mixed" | null): ToolSchema[];
export function validate(value: unknown, schema: unknown, path?: string): void;
export function compact(tool: string, input: any, result: any): unknown;
export function callInput(tool: ToolTuple, input: Record<string, unknown>): Record<string, unknown>;
export const needsYouInstruction: string;
export const actionInstruction: string;
export const overseerInstruction: string;
export function batchInstructions(workflow?: { mode: "graphite" | "github"; reviewFix: string | null } | null): string;
export function describeAction(name: string, description: string, workflows: "graphite" | "github" | "mixed" | null): string;
/** The action lookup (agent-tools-by-role): find_action and run_action. */
export const lookupTools: ToolTuple[];
/** Which tools each kind of agent lists, and which actions it may run ("all" through the lookup). */
export const ROLE_TOOLS: Record<"main" | "contributor" | "recovery" | "untracked", { tools: string[]; actions: "all" | string[] }>;
export function callableTools(recovery?: boolean, contributor?: boolean, brief?: boolean, briefOnly?: boolean, actions?: boolean): ToolTuple[];
export function roleActions(role: "main" | "contributor" | "recovery" | "untracked", actions: boolean): string[];
export function findActions(input: { query?: string; names?: string[] }, callable: ToolTuple[], workflows?: "graphite" | "github" | "mixed" | null): { actions: Array<Record<string, unknown>>; unknown?: string[]; note?: string; next?: string };
export function resolveAction(input: { action?: unknown; args?: Record<string, unknown> }, callable: ToolTuple[]): { tool: ToolTuple; args: Record<string, unknown> };
export function runTool(tool: ToolTuple, input: Record<string, unknown>, callable: ToolTuple[], invoke: (method: string, input: Record<string, unknown>) => Promise<unknown>, workflows?: "graphite" | "github" | "mixed" | null): Promise<{ name: string; args: Record<string, unknown>; value: any }>;
