import type { JSONSchema } from "./protocol.js";

/**
 * Tiny JSON Schema builder with static type inference, so tool inputs are
 * declared once and typed everywhere:
 *
 *   const ReadInput = s.object({ path: s.string("File path"), sheet: s.optional(s.string()) });
 *   type ReadInput = Infer<typeof ReadInput>; // { path: string; sheet?: string }
 */
export interface Schema<T> extends JSONSchema {
  /** Phantom field carrying the inferred TS type. Never present at runtime. */
  readonly __type?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Optional<T> = Schema<T> & { readonly __optional: true };

type Shape = Record<string, Schema<any>>;
type RequiredKeys<S extends Shape> = { [K in keyof S]: S[K] extends Optional<any> ? never : K }[keyof S];
type OptionalKeys<S extends Shape> = Exclude<keyof S, RequiredKeys<S>>;
type ObjectOf<S extends Shape> = { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };

const OPTIONAL = Symbol("optional");

const desc = (description?: string) => (description ? { description } : {});

export const s = {
  string: (description?: string): Schema<string> => ({ type: "string", ...desc(description) }),
  number: (description?: string): Schema<number> => ({ type: "number", ...desc(description) }),
  integer: (description?: string): Schema<number> => ({ type: "integer", ...desc(description) }),
  boolean: (description?: string): Schema<boolean> => ({ type: "boolean", ...desc(description) }),
  any: (description?: string): Schema<unknown> => ({ ...desc(description) }),

  enum: <const T extends readonly (string | number)[]>(values: T, description?: string): Schema<T[number]> => ({
    enum: [...values],
    ...desc(description),
  }),

  array: <T>(items: Schema<T>, description?: string): Schema<T[]> => ({
    type: "array",
    items: strip(items),
    ...desc(description),
  }),

  object: <S extends Shape>(shape: S, description?: string): Schema<ObjectOf<S>> => {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = strip(value);
      if (!(value as any)[OPTIONAL]) required.push(key);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}), ...desc(description) };
  },

  optional: <T>(schema: Schema<T>): Optional<T> => {
    const out = { ...schema } as Optional<T>;
    Object.defineProperty(out, OPTIONAL, { value: true, enumerable: false });
    return out;
  },
};

/** Drops non-enumerable markers so the schema serialises cleanly. */
function strip(schema: JSONSchema): JSONSchema {
  return { ...schema };
}
