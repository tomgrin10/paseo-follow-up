// Types for the parts of server/mcp.mjs the worker imports (the file itself stays plain JS: it ships as the stdio bridge).
export type ToolTuple = [name: string, description: string, method: string, properties: Record<string, unknown>, required: string[]];
export type ToolSchema = { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false }; annotations: Record<string, boolean> };
export const tools: ToolTuple[];
export const actionTools: ToolTuple[];
export const overseerTools: ToolTuple[];
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
