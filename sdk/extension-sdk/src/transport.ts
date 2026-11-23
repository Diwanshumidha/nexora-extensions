import { createInterface } from "node:readline";
import type { Extension, ToolError as ToolErrorType } from "./extension.js";
import { ErrorCodes, Methods, type InitializeParams, type RpcMessage } from "./protocol.js";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

/**
 * Serves newline-delimited JSON-RPC on stdin/stdout for one extension.
 * stdout is reserved for protocol frames, so console.log is redirected to
 * stderr, which the host captures as logs.
 */
export function serve(ext: Extension<any>): void {
  console.log = console.error;
  console.info = console.error;

  const send = (msg: RpcMessage) => process.stdout.write(JSON.stringify(msg) + "\n");
  const notify = (level: string) => (message: string) =>
    send({ jsonrpc: "2.0", method: Methods.log, params: { level, message } });
  const log: Logger = { debug: notify("debug"), info: notify("info"), warn: notify("warn"), error: notify("error") };

  const handlers: Record<string, (params: any) => Promise<unknown>> = {
    [Methods.initialize]: async (p: InitializeParams) =>
      ext._start({ extensionId: p.extensionId, hostVersion: p.hostVersion, dataDir: p.dataDir }, log, p.settings ?? {}),
    [Methods.settingsUpdate]: async ({ settings }: { settings: Record<string, unknown> }) => {
      await ext._updateSettings(settings ?? {});
      return {};
    },
    [Methods.toolsCall]: async ({ name, args }: { name: string; args?: unknown }) => {
      if (!ext._has(name)) throw new RpcError(ErrorCodes.toolNotFound, `unknown tool "${name}"`);
      try {
        return await ext._call(name, args);
      } catch (err) {
        const e = err as Partial<ToolErrorType>;
        throw new RpcError(ErrorCodes.toolFailed, err instanceof Error ? err.message : String(err), e?.data);
      }
    },
    [Methods.shutdown]: async () => {
      await ext._stop();
      setImmediate(() => process.exit(0));
      return {};
    },
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", error: { code: ErrorCodes.parseError, message: "invalid JSON" } });
      return;
    }
    if (msg.id === undefined) return; // host notifications: none defined yet
    const handler = msg.method ? handlers[msg.method] : undefined;
    if (!handler) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: ErrorCodes.methodNotFound, message: `unknown method ${msg.method}` } });
      return;
    }
    try {
      send({ jsonrpc: "2.0", id: msg.id, result: await handler(msg.params) });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ErrorCodes.internalError;
      const data = err instanceof RpcError ? err.data : undefined;
      send({ jsonrpc: "2.0", id: msg.id, error: { code, message: err instanceof Error ? err.message : String(err), data } });
    }
  });
  rl.on("close", () => process.exit(0));
}
