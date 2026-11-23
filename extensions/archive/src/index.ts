import * as fs from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Extension, ToolError, s, tool, trustedPath, type Infer } from "@nexora/extension-sdk";
import { Unzip, UnzipInflate, zipSync, type UnzipFile, type Zippable } from "fflate";

interface ArchiveSettings {
  [key: string]: unknown;
  folders: string[];
  maxExtractMB: number;
}

const zipPath = s.string("Absolute path to a .zip, or relative to the first trusted folder");
const ListInput = s.object({ path: zipPath });
const ExtractInput = s.object({
  path: zipPath,
  to: s.optional(s.string("Folder to extract into (default: a new folder named after the archive, next to it)")),
  overwrite: s.optional(s.boolean("Allow extracting into an existing folder, replacing files with the same names. Default false")),
});
const CreateInput = s.object({
  files: s.array(s.string(), "Files and folders to include (folders are added recursively)"),
  to: s.string("Path of the .zip to create"),
  overwrite: s.optional(s.boolean("Replace an existing archive. Default false")),
});

const MAX_ENTRIES = 20_000;
const MAX_CREATE_BYTES = 1024 ** 3;

class Archive extends Extension<ArchiveSettings> {
  @tool({ description: "List the contents of a .zip without extracting it.", input: ListInput, readOnly: true })
  async list({ path: p }: Infer<typeof ListInput>) {
    const files = parse(await this.readZip(p));
    const entries = files.map((f) => ({
      name: f.name, dir: f.name.endsWith("/"), size: f.originalSize ?? null, compressed: f.size ?? null,
    }));
    return { entries: entries.slice(0, 2000), count: entries.length, totalSize: entries.reduce((a, e) => a + (e.size ?? 0), 0) };
  }

  @tool({
    description: "Extract a .zip into a folder. Refuses entries that would land outside it and archives that unpack beyond the size limit.",
    input: ExtractInput, output: s.object({ to: s.string(), files: s.integer(), bytes: s.integer() }),
  })
  async extract({ path: p, to, overwrite = false }: Infer<typeof ExtractInput>) {
    const zip = trustedPath(p, this.settings.folders, "Archive");
    const dest = this.path(to ?? join(dirname(zip), basename(zip, extname(zip))));
    const existed = !!(await fs.stat(dest).catch(() => null));
    if (existed && !overwrite) throw new ToolError(`${dest} already exists; pass overwrite: true to extract into it.`);

    const files = parse(await this.readZip(p));
    if (files.length > MAX_ENTRIES) throw new ToolError(`The archive has ${files.length} entries (limit ${MAX_ENTRIES}).`);
    // Validate every path before writing anything (zip-slip).
    const targets = files.map((f) => ({ f, target: safeTarget(dest, f.name) }));

    const limit = Math.max(1, this.settings.maxExtractMB || 1024) * 1024 * 1024;
    let total = 0;
    let written = 0;
    try {
      await fs.mkdir(dest, { recursive: true });
      for (const { f, target } of targets) {
        if (f.name.endsWith("/")) {
          await fs.mkdir(target, { recursive: true });
          continue;
        }
        // Count real output bytes: headers can lie (zip bombs).
        const data = await inflate(f, (n) => {
          total += n;
          if (total > limit) throw new ToolError(`The archive unpacks to more than ${this.settings.maxExtractMB || 1024} MB; refused.`);
        });
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.writeFile(target, data);
        written++;
      }
    } catch (err) {
      if (!existed) await fs.rm(dest, { recursive: true, force: true }); // don't leave half an archive behind
      throw err instanceof ToolError ? err : new ToolError(`Extraction failed: ${(err as Error).message}`);
    }
    return { to: dest, files: written, bytes: total };
  }

  @tool({ description: "Create a .zip from files and folders.", input: CreateInput,
    output: s.object({ path: s.string(), files: s.integer(), bytes: s.integer() }) })
  async create({ files, to, overwrite = false }: Infer<typeof CreateInput>) {
    if (!files?.length) throw new ToolError("files must list at least one path");
    const out = this.path(to);
    if (!out.toLowerCase().endsWith(".zip")) throw new ToolError("to must end in .zip");
    if (!overwrite && (await fs.stat(out).catch(() => null))) throw new ToolError(`${to} already exists; pass overwrite: true to replace it.`);

    const tree: Zippable = {};
    let count = 0;
    let bytes = 0;
    const add = async (full: string, name: string) => {
      const st = await fs.lstat(full);
      if (st.isSymbolicLink()) return; // never follow links out of the trusted folders
      if (st.isDirectory()) {
        tree[name + "/"] = new Uint8Array(0);
        for (const child of await fs.readdir(full)) await add(join(full, child), `${name}/${child}`);
      } else if (st.isFile()) {
        if (resolve(full) === resolve(out)) return; // don't zip the archive into itself
        bytes += st.size;
        if (bytes > MAX_CREATE_BYTES) throw new ToolError("The files add up to more than 1 GB.");
        tree[name] = [new Uint8Array(await fs.readFile(full)), { mtime: st.mtime }];
        count++;
      }
    };
    for (const f of files) {
      const full = this.path(f);
      await add(full, basename(full));
    }
    await fs.mkdir(dirname(out), { recursive: true });
    await fs.writeFile(out, zipSync(tree, { level: 6 }));
    return { path: out, files: count, bytes };
  }

  private path(p: string) {
    return trustedPath(p, this.settings.folders, "Archive");
  }

  private async readZip(p: string) {
    const file = this.path(p);
    const data = await fs.readFile(file).catch((err) => {
      throw new ToolError(err.code === "ENOENT" ? `${p} doesn't exist` : err.message);
    });
    return new Uint8Array(data);
  }
}

/** Parses the central structure without decompressing anything. */
function parse(data: Uint8Array): UnzipFile[] {
  const files: UnzipFile[] = [];
  const uz = new Unzip((f) => files.push(f));
  uz.register(UnzipInflate);
  try {
    uz.push(data, true);
  } catch (err) {
    throw new ToolError(`Not a valid .zip: ${(err as Error).message}`);
  }
  return files;
}

/** Decompresses one entry, reporting each chunk's size so the caller can
 *  stop a zip bomb mid-way. */
function inflate(f: UnzipFile, onBytes: (n: number) => void): Promise<Uint8Array> {
  return new Promise((ok, fail) => {
    const chunks: Uint8Array[] = [];
    let done = false;
    f.ondata = (err, chunk, final) => {
      if (done) return;
      try {
        if (err) throw err;
        onBytes(chunk.length);
        chunks.push(chunk);
      } catch (e) {
        done = true;
        f.terminate();
        return fail(e);
      }
      if (final) {
        done = true;
        const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        ok(out);
      }
    };
    try {
      f.start();
    } catch (e) {
      fail(e);
    }
  });
}

/** The path an entry extracts to, refusing anything that escapes dest. */
function safeTarget(dest: string, name: string): string {
  const clean = name.replace(/\\/g, "/");
  if (!clean || clean.includes("\0") || isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) {
    throw new ToolError(`Unsafe entry "${name}" in the archive; refused.`);
  }
  const target = resolve(dest, clean);
  const rel = relative(resolve(dest), target);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new ToolError(`Entry "${name}" would be written outside ${dest}; refused.`);
  }
  return target;
}

Archive.run();
