// Mirrors internal/protocol/protocol.go. Keep the two in sync.

export const Methods = {
  initialize: "initialize",
  toolsCall: "tools/call",
  shutdown: "shutdown",
  settingsUpdate: "settings/update",
  log: "log",
} as const;

export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  toolNotFound: -32001,
  toolFailed: -32002,
} as const;

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON Schema subset used to describe tool inputs and outputs. */
export type JSONSchema = {
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  [key: string]: unknown;
};

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
  /** No side effects. Undeclared tools are treated as writes. */
  readOnly?: boolean;
}

export interface InitializeParams {
  hostVersion: string;
  extensionId: string;
  dataDir: string;
  /** Values for the settings declared in nexora.json. */
  settings: Record<string, unknown>;
}

export interface InitializeResult {
  tools: ToolSpec[];
}
