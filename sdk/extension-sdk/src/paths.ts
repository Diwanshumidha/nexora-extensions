import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ToolError } from "./extension.js";

/**
 * Reports whether `target` is inside one of `folders` (or is one of them).
 * Symlinks are resolved where they exist, so a link can't escape a folder.
 * Use it to give a clear error before the sandbox refuses access:
 *
 *   if (!insideFolders(path, this.settings.folders))
 *     throw new ToolError(`${path} is outside your trusted folders`);
 */
export function insideFolders(target: string, folders: readonly string[] | undefined): boolean {
  if (!isAbsolute(target) || !folders?.length) return false;
  const real = realish(resolve(target));
  return folders.some((f) => {
    const rel = relative(realish(resolve(f)), real);
    return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
  });
}

/** realpath of the longest existing ancestor, so new files can be checked. */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cur = parent;
    }
  }
}

/**
 * Resolves a path a tool received against the user's trusted folders:
 * absolute paths are used as-is, relative ones are taken from the first
 * folder. Throws a ToolError that tells the AI what to ask the user when
 * there are no folders or the path is outside them.
 *
 *   const file = trustedPath(input.path, this.settings.folders, "PDF");
 */
export function trustedPath(target: string, folders: readonly string[] | undefined, extName: string): string {
  if (!folders?.length) {
    throw new ToolError(`${extName} has no trusted folders yet. Ask the user to add one in Nexora (${extName} → Settings).`);
  }
  if (typeof target !== "string" || !target.trim()) throw new ToolError("path is required");
  const full = isAbsolute(target) ? resolve(target) : resolve(folders[0], target);
  if (!insideFolders(full, folders)) {
    throw new ToolError(
      `${target} is outside the trusted folders (${folders.join(", ")}). Ask the user to add its folder in Nexora (${extName} → Settings).`,
    );
  }
  return full;
}
