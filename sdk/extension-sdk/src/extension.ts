import type { InitializeResult, JSONSchema, ToolSpec } from "./protocol.js";
import { serve, type Logger } from "./transport.js";

export interface ToolOptions {
  /** Shown to the AI in the generated `tools` type declaration. */
  description?: string;
  input?: JSONSchema;
  output?: JSONSchema;
  /** Override the tool name (defaults to the method name). */
  name?: string;
  /**
   * The tool only reads: no writes, sends or other side effects. Read-only
   * tools run without asking in "Ask first" and "Read only" modes; anything
   * not marked is treated as a write and needs the user's approval.
   */
  readOnly?: boolean;
}

export interface ExtensionContext {
  extensionId: string;
  hostVersion: string;
  /** Private, writable directory for this extension. */
  dataDir: string;
}

/** Values of the settings declared in nexora.json, keyed by setting key. */
export type Settings = Record<string, unknown>;

type ToolMethod = (input: any) => unknown;

interface RegisteredTool {
  spec: ToolSpec;
  method: ToolMethod;
}

// Keyed by instance rather than stored as a class field: method decorator
// initializers run before field initializers, which would reset a field.
const registry = new WeakMap<Extension, Map<string, RegisteredTool>>();

function toolsOf(ext: Extension): Map<string, RegisteredTool> {
  let tools = registry.get(ext);
  if (!tools) registry.set(ext, (tools = new Map()));
  return tools;
}

/** Thrown from a tool to report a failure to the AI with a clean message. */
export class ToolError extends Error {
  constructor(message: string, readonly data?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Marks a method as a tool, exposed to the AI as
 * `tools.<namespace>.<methodName>(input)`.
 *
 *   class Excel extends Extension {
 *     @tool({ description: "Read a sheet", input: ReadInput })
 *     async readSheet({ path }: Infer<typeof ReadInput>) { ... }
 *   }
 */
export function tool(options: ToolOptions = {}) {
  return function <This extends Extension, M extends ToolMethod>(
    method: M,
    context: ClassMethodDecoratorContext<This, M>,
  ): void {
    if (context.private || context.static) {
      throw new Error(`@tool cannot be used on private or static member ${String(context.name)}`);
    }
    const name = options.name ?? String(context.name);
    context.addInitializer(function (this: This) {
      toolsOf(this).set(name, {
        spec: {
          name,
          description: options.description,
          inputSchema: options.input,
          outputSchema: options.output,
          readOnly: options.readOnly || undefined,
        },
        method: method.bind(this) as ToolMethod,
      });
    });
  };
}

/**
 * Base class for every Nexora extension. Subclass it, decorate methods with
 * `@tool`, then call `MyExtension.run()` at the bottom of the entry file.
 * The type parameter describes the settings declared in nexora.json.
 */
export abstract class Extension<S extends Settings = Settings> {
  #context?: ExtensionContext;
  #log?: Logger;
  #settings: S = {} as S;

  /**
   * The user's values for the settings declared in nexora.json, with
   * defaults applied. Updated live when the user changes them (settings that
   * grant folder access restart the extension instead).
   */
  protected get settings(): Readonly<S> {
    return this.#settings;
  }

  /** Called after the user changes settings that don't need a restart. */
  protected onSettingsChanged(_next: Readonly<S>, _prev: Readonly<S>): void | Promise<void> {}

  /** Host-provided context, available from onStart() onwards. */
  protected get context(): ExtensionContext {
    if (!this.#context) throw new Error("extension context is not available before onStart()");
    return this.#context;
  }

  /** Shortcut for this.context.dataDir. */
  protected get dataDir(): string {
    return this.context.dataDir;
  }

  /** Structured logs forwarded to the host. Avoid console.log. */
  protected get log(): Logger {
    if (!this.#log) throw new Error("logger is not available before onStart()");
    return this.#log;
  }

  /** Called once after the host handshake, before any tool call. */
  protected onStart(): void | Promise<void> {}

  /** Called when the host shuts the extension down. */
  protected onStop(): void | Promise<void> {}

  /** @internal */
  async _start(context: ExtensionContext, log: Logger, settings: Settings = {}): Promise<InitializeResult> {
    this.#context = context;
    this.#log = log;
    this.#settings = settings as S;
    await this.onStart();
    return { tools: [...toolsOf(this).values()].map((t) => t.spec) };
  }

  /** @internal */
  async _call(name: string, input: unknown): Promise<unknown> {
    const t = toolsOf(this).get(name);
    if (!t) return undefined;
    return (await t.method(input ?? {})) ?? null;
  }

  /** @internal */
  _has(name: string): boolean {
    return toolsOf(this).has(name);
  }

  /** @internal */
  async _updateSettings(next: Settings): Promise<void> {
    const prev = this.#settings;
    this.#settings = next as S;
    await this.onSettingsChanged(this.#settings, prev);
  }

  /** @internal */
  async _stop(): Promise<void> {
    await this.onStop();
  }

  /** Instantiates the extension and serves the Nexora protocol on stdio. */
  static run<T extends Extension<any>>(this: new () => T): T {
    const instance = new this();
    serve(instance);
    return instance;
  }
}
