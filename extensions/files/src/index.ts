import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Extension, ToolError, insideFolders, s, tool, type Infer } from "@nexora/extension-sdk";

interface FilesSettings {
  [key: string]: unknown;
  folders: string[];
  maxReadKB: number;
  showHidden: boolean;
}

const path = s.string("Absolute path, or relative to the first trusted folder");

const ListInput = s.object({ path: s.optional(path) });
const InfoInput = s.object({ path });
const TreeInput = s.object({
  path: s.optional(path),
  depth: s.optional(s.integer("How many levels deep (default 2, max 6)")),
});
const FindInput = s.object({
  path: s.optional(s.string("Folder to search (default: every trusted folder)")),
  name: s.optional(s.string("File name pattern, * and ? wildcards, case-insensitive, e.g. *.pdf or report*")),
  contains: s.optional(s.string("Only text files containing this text (case-insensitive)")),
  type: s.optional(s.enum(["file", "dir", "any"], "Kind of entry (default any)")),
  maxResults: s.optional(s.integer("Default 100, max 1000")),
});
const ReadInput = s.object({
  path,
  offset: s.optional(s.integer("Byte offset to start from, for reading large files in parts")),
});
const WriteInput = s.object({
  path,
  content: s.string(),
  overwrite: s.optional(s.boolean("Replace an existing file (its old version goes to the trash). Default false")),
});
const AppendInput = s.object({ path, content: s.string() });
const MkdirInput = s.object({ path });
const CopyMoveInput = s.object({
  from: path,
  to: s.string("Destination path. If it is an existing folder, the item is placed inside it"),
  overwrite: s.optional(s.boolean("Replace an existing destination (it goes to the trash). Default false")),
});
const RenameInput = s.object({ path, newName: s.string("New name only, not a path") });
const DeleteInput = s.object({
  path,
  permanent: s.optional(s.boolean("Delete for good instead of moving to the trash. Default false")),
});
const RestoreInput = s.object({
  id: s.string("Trash entry id from listTrash"),
  to: s.optional(s.string("Where to restore (default: the original location)")),
});

const entry = s.object({
  name: s.string(),
  path: s.string(),
  type: s.enum(["file", "dir", "symlink", "other"]),
  size: s.number(),
  modified: s.string(),
});

const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "__pycache__"]);
const MAX_WALK = 50_000; // entries visited per search/size, to keep calls bounded

interface TrashMeta {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: string;
  type: "file" | "dir" | "symlink" | "other";
  reason: "deleted" | "overwritten";
}

class Files extends Extension<FilesSettings> {
  /* ------------------------------------------------------------ reading */

  @tool({ description: "List the trusted folders Files can work in. Call this first to know where files can be found.", readOnly: true,
    output: s.array(s.object({ path: s.string(), exists: s.boolean() })) })
  async roots() {
    return Promise.all(this.folders().map(async (p) => ({ path: p, exists: await exists(p) })));
  }

  @tool({ description: "List a folder's contents (folders first, then files).", input: ListInput, output: s.array(entry), readOnly: true })
  async list({ path: p }: Infer<typeof ListInput>) {
    const dir = this.resolve(p ?? this.folders()[0]);
    const names = await fs.readdir(dir);
    const out = [];
    for (const name of names) {
      if (!this.visible(name)) continue;
      out.push(await describe(join(dir, name)));
    }
    return out.sort((a, b) => (a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
  }

  @tool({ description: "Details about a file or folder: type, size, dates, permissions, symlink target.", input: InfoInput, readOnly: true })
  async info({ path: p }: Infer<typeof InfoInput>) {
    const full = this.resolve(p);
    const st = await fs.lstat(full);
    return {
      ...(await describe(full)),
      created: st.birthtime.toISOString(),
      accessed: st.atime.toISOString(),
      mode: "0" + (st.mode & 0o777).toString(8),
      linkTarget: st.isSymbolicLink() ? await fs.readlink(full) : undefined,
    };
  }

  @tool({ description: "An indented text tree of a folder, to get an overview.", input: TreeInput, output: s.string(), readOnly: true })
  async tree({ path: p, depth = 2 }: Infer<typeof TreeInput>) {
    const root = this.resolve(p ?? this.folders()[0]);
    const lines = [root];
    const limit = 500;
    const walk = async (dir: string, level: number, prefix: string) => {
      if (level > Math.min(depth, 6) || lines.length >= limit) return;
      const items = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => this.visible(d.name));
      items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const [i, d] of items.entries()) {
        if (lines.length >= limit) {
          lines.push(prefix + "… (truncated)");
          return;
        }
        const last = i === items.length - 1;
        lines.push(prefix + (last ? "└── " : "├── ") + d.name + (d.isDirectory() ? "/" : ""));
        if (d.isDirectory() && !SKIP_DIRS.has(d.name)) await walk(join(dir, d.name), level + 1, prefix + (last ? "    " : "│   "));
      }
    };
    await walk(root, 1, "");
    return lines.join("\n");
  }

  @tool({
    description: "Search for files and folders by name pattern and/or text content, recursively. Skips node_modules and .git.",
    input: FindInput, readOnly: true,
    output: s.object({ results: s.array(s.any()), truncated: s.boolean() }),
  })
  async find({ path: p, name, contains, type = "any", maxResults = 100 }: Infer<typeof FindInput>) {
    if (!name && !contains) throw new ToolError("Give a name pattern, text to look for, or both.");
    const max = Math.min(Math.max(maxResults, 1), 1000);
    const nameRe = name ? globToRegExp(name) : null;
    const needle = contains?.toLowerCase();
    const results: unknown[] = [];
    let visited = 0;

    const walk = async (dir: string): Promise<boolean> => {
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return true; // unreadable folder: skip it
      }
      for (const d of items) {
        if (results.length >= max || ++visited > MAX_WALK) return false;
        if (!this.visible(d.name)) continue;
        const full = join(dir, d.name);
        const isDir = d.isDirectory();
        const kindOk = type === "any" || (type === "dir") === isDir;
        if (kindOk && (!nameRe || nameRe.test(d.name))) {
          if (!needle) {
            results.push(await describe(full));
          } else if (!isDir) {
            const lines = await grep(full, needle);
            if (lines.length) results.push({ ...(await describe(full)), matches: lines });
          }
        }
        if (isDir && !SKIP_DIRS.has(d.name) && !d.isSymbolicLink()) {
          if (!(await walk(full))) return false;
        }
      }
      return true;
    };
    for (const root of p ? [this.resolve(p)] : this.folders()) {
      if (!(await walk(root))) break;
    }
    return { results, truncated: results.length >= max || visited > MAX_WALK };
  }

  @tool({
    description: "Read a text file. Large files are returned in parts: pass the returned nextOffset to continue.",
    input: ReadInput, readOnly: true,
    output: s.object({ content: s.string(), size: s.number(), nextOffset: s.optional(s.number()) }),
  })
  async readText({ path: p, offset = 0 }: Infer<typeof ReadInput>) {
    const full = this.resolve(p);
    const st = await fs.stat(full);
    if (!st.isFile()) throw new ToolError(`${p} is not a file`);
    const limit = Math.max(1, this.settings.maxReadKB || 512) * 1024;
    const fh = await fs.open(full, "r");
    try {
      const buf = Buffer.alloc(Math.min(limit, Math.max(0, st.size - offset)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      const chunk = buf.subarray(0, bytesRead);
      if (chunk.subarray(0, 8192).includes(0)) {
        throw new ToolError(`${p} looks like a binary file; use info or hash instead, or an extension for its format.`);
      }
      const next = offset + bytesRead;
      return { content: chunk.toString("utf8"), size: st.size, nextOffset: next < st.size ? next : undefined };
    } finally {
      await fh.close();
    }
  }

  @tool({ description: "Total size of a file or folder (recursive), with file and folder counts.", input: InfoInput, readOnly: true,
    output: s.object({ bytes: s.number(), human: s.string(), files: s.number(), dirs: s.number(), truncated: s.boolean() }) })
  async size({ path: p }: Infer<typeof InfoInput>) {
    const full = this.resolve(p);
    let bytes = 0, files = 0, dirs = 0, visited = 0;
    const walk = async (target: string): Promise<void> => {
      if (++visited > MAX_WALK) return;
      const st = await fs.lstat(target);
      if (st.isDirectory()) {
        dirs++;
        for (const name of await fs.readdir(target)) await walk(join(target, name));
      } else {
        files++;
        bytes += st.size;
      }
    };
    await walk(full);
    return { bytes, human: human(bytes), files, dirs, truncated: visited > MAX_WALK };
  }

  @tool({ description: "SHA-256 checksum of a file, e.g. to check two files are identical.", input: InfoInput, output: s.string(), readOnly: true })
  async hash({ path: p }: Infer<typeof InfoInput>) {
    const full = this.resolve(p);
    const h = createHash("sha256");
    for await (const chunk of createReadStream(full)) h.update(chunk as Buffer);
    return h.digest("hex");
  }

  /* ------------------------------------------------------------ writing */

  @tool({ description: "Create a text file, or replace one with overwrite: true (the old version is kept in the trash). Parent folders are created.", input: WriteInput,
    output: entry })
  async writeText({ path: p, content, overwrite = false }: Infer<typeof WriteInput>) {
    const full = this.resolve(p);
    if (await exists(full)) {
      if (!overwrite) throw new ToolError(`${p} already exists; pass overwrite: true to replace it.`);
      if ((await fs.stat(full)).isDirectory()) throw new ToolError(`${p} is a folder`);
      await this.toTrash(full, "overwritten");
    }
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return describe(full);
  }

  @tool({ description: "Append text to the end of a file, creating it if needed.", input: AppendInput, output: entry })
  async appendText({ path: p, content }: Infer<typeof AppendInput>) {
    const full = this.resolve(p);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.appendFile(full, content, "utf8");
    return describe(full);
  }

  @tool({ description: "Create a folder (and any missing parents).", input: MkdirInput, output: entry })
  async mkdir({ path: p }: Infer<typeof MkdirInput>) {
    const full = this.resolve(p);
    await fs.mkdir(full, { recursive: true });
    return describe(full);
  }

  @tool({ description: "Copy a file or folder (recursively). Will not replace an existing destination unless overwrite: true.", input: CopyMoveInput, output: entry })
  async copy({ from, to, overwrite = false }: Infer<typeof CopyMoveInput>) {
    const src = this.resolve(from);
    const dest = await this.destination(src, to, overwrite);
    if (within(dest, src)) throw new ToolError("Can't copy a folder into itself.");
    await fs.mkdir(dirname(dest), { recursive: true });
    await copyTree(src, dest);
    return describe(dest);
  }

  @tool({ description: "Move a file or folder. Will not replace an existing destination unless overwrite: true.", input: CopyMoveInput, output: entry })
  async move({ from, to, overwrite = false }: Infer<typeof CopyMoveInput>) {
    const src = this.resolve(from);
    this.notRoot(src, "move");
    const dest = await this.destination(src, to, overwrite);
    if (within(dest, src)) throw new ToolError("Can't move a folder into itself.");
    await fs.mkdir(dirname(dest), { recursive: true });
    await moveAcross(src, dest);
    return describe(dest);
  }

  @tool({ description: "Rename a file or folder in place.", input: RenameInput, output: entry })
  async rename({ path: p, newName }: Infer<typeof RenameInput>) {
    if (!newName || newName.includes("/") || newName.includes(sep) || newName === "." || newName === "..") {
      throw new ToolError("newName must be a plain name, without slashes.");
    }
    const src = this.resolve(p);
    this.notRoot(src, "rename");
    const dest = join(dirname(src), newName);
    if (await exists(dest)) throw new ToolError(`${newName} already exists in that folder.`);
    await fs.rename(src, dest);
    return describe(dest);
  }

  @tool({ description: "Delete a file or folder. By default it moves to the Nexora trash (see listTrash/restore); permanent: true deletes for good.", input: DeleteInput,
    output: s.object({ deleted: s.string(), trashId: s.optional(s.string()) }) })
  async delete({ path: p, permanent = false }: Infer<typeof DeleteInput>) {
    const full = this.resolve(p);
    this.notRoot(full, "delete");
    await fs.lstat(full); // clear "not found" error
    if (permanent) {
      await fs.rm(full, { recursive: true, force: false });
      return { deleted: full };
    }
    return { deleted: full, trashId: await this.toTrash(full, "deleted") };
  }

  /* -------------------------------------------------------------- trash */

  @tool({ description: "List items in the Nexora trash (deleted or overwritten files), newest first.", readOnly: true,
    output: s.array(s.object({ id: s.string(), name: s.string(), originalPath: s.string(), deletedAt: s.string(), reason: s.string() })) })
  async listTrash() {
    const out: TrashMeta[] = [];
    for (const id of await fs.readdir(this.trashDir()).catch(() => [] as string[])) {
      try {
        out.push(JSON.parse(await fs.readFile(join(this.trashDir(), id, "meta.json"), "utf8")));
      } catch {
        // incomplete entry: ignore
      }
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  @tool({ description: "Restore an item from the trash to where it was (or to another path).", input: RestoreInput, output: entry })
  async restore({ id, to }: Infer<typeof RestoreInput>) {
    if (!/^[\w-]+$/.test(id)) throw new ToolError("invalid trash id");
    const dir = join(this.trashDir(), id);
    const meta: TrashMeta = JSON.parse(await fs.readFile(join(dir, "meta.json"), "utf8").catch(() => {
      throw new ToolError(`no trash entry ${id}`);
    }));
    const dest = this.resolve(to ?? meta.originalPath);
    if (await exists(dest)) throw new ToolError(`${dest} already exists; restore it somewhere else with "to".`);
    await fs.mkdir(dirname(dest), { recursive: true });
    await moveAcross(join(dir, "item"), dest);
    await fs.rm(dir, { recursive: true, force: true });
    return describe(dest);
  }

  @tool({ description: "Permanently delete everything in the Nexora trash.", output: s.object({ removed: s.number() }) })
  async emptyTrash() {
    const ids = await fs.readdir(this.trashDir()).catch(() => [] as string[]);
    for (const id of ids) await fs.rm(join(this.trashDir(), id), { recursive: true, force: true });
    return { removed: ids.length };
  }

  /* ------------------------------------------------------------ helpers */

  private folders(): string[] {
    const f = this.settings.folders ?? [];
    if (!f.length) {
      throw new ToolError("Files has no trusted folders yet. Ask the user to add one in Nexora (Files → Settings).");
    }
    return f;
  }

  /** Resolves a user path and makes sure it is inside a trusted folder. */
  private resolve(p: string): string {
    const roots = this.folders();
    if (typeof p !== "string" || !p.trim()) throw new ToolError("path is required");
    const full = isAbsolute(p) ? resolve(p) : resolve(roots[0], p);
    if (!insideFolders(full, roots)) {
      throw new ToolError(`${p} is outside the trusted folders (${roots.join(", ")}). Ask the user to add it in Nexora (Files → Settings).`);
    }
    return full;
  }

  private notRoot(full: string, verb: string) {
    if (this.folders().some((r) => resolve(r) === full)) {
      throw new ToolError(`Won't ${verb} a trusted folder itself (${full}).`);
    }
  }

  private visible(name: string) {
    return this.settings.showHidden || !name.startsWith(".");
  }

  /** Where `to` points: inside it if it is an existing folder. Clears an
   *  existing destination into the trash when overwrite is set. */
  private async destination(src: string, to: string, overwrite: boolean): Promise<string> {
    let dest = this.resolve(to);
    const st = await fs.stat(dest).catch(() => null);
    if (st?.isDirectory() && resolve(dest) !== resolve(src)) dest = join(dest, basename(src));
    dest = this.resolve(dest);
    if (resolve(dest) === resolve(src)) throw new ToolError("Source and destination are the same.");
    if (await exists(dest)) {
      if (!overwrite) throw new ToolError(`${dest} already exists; pass overwrite: true to replace it.`);
      this.notRoot(dest, "replace");
      await this.toTrash(dest, "overwritten");
    }
    return dest;
  }

  private trashDir() {
    return join(this.dataDir, "trash");
  }

  private async toTrash(full: string, reason: TrashMeta["reason"]): Promise<string> {
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const dir = join(this.trashDir(), id);
    await fs.mkdir(dir, { recursive: true });
    const meta: TrashMeta = {
      id, name: basename(full), originalPath: full, deletedAt: new Date().toISOString(),
      type: (await describe(full)).type, reason,
    };
    await moveAcross(full, join(dir, "item"));
    await fs.writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return id;
  }
}

async function describe(full: string) {
  const st = await fs.lstat(full);
  const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  return { name: basename(full), path: full, type, size: st.size, modified: st.mtime.toISOString() } as const;
}

async function exists(p: string) {
  return fs.lstat(p).then(() => true, () => false);
}

function within(child: string, parent: string) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** rename, falling back to copy + delete across filesystems. */
async function moveAcross(src: string, dest: string) {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyTree(src, dest);
    await fs.rm(src, { recursive: true, force: true });
  }
}

/** Recursive copy that never overwrites. (fs.cp is unavailable under the
 *  Node permission model, so this uses the basic calls it allows.) Symlinks
 *  are copied as links, not followed. */
async function copyTree(src: string, dest: string): Promise<void> {
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(src), dest);
  } else if (st.isDirectory()) {
    await fs.mkdir(dest);
    for (const name of await fs.readdir(src)) await copyTree(join(src, name), join(dest, name));
  } else if (st.isFile()) {
    await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
  } else {
    return; // sockets, devices: skip
  }
  if (!st.isSymbolicLink()) await fs.utimes(dest, st.atime, st.mtime).catch(() => {});
}

/** Up to 3 matching lines from a small text file. */
async function grep(full: string, needle: string): Promise<string[]> {
  try {
    const st = await fs.stat(full);
    if (st.size > 2 * 1024 * 1024) return [];
    const buf = await fs.readFile(full);
    if (buf.subarray(0, 8192).includes(0)) return []; // binary
    const out: string[] = [];
    for (const [i, line] of buf.toString("utf8").split("\n").entries()) {
      if (line.toLowerCase().includes(needle)) {
        out.push(`${i + 1}: ${line.trim().slice(0, 200)}`);
        if (out.length === 3) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

function human(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

Files.run();
