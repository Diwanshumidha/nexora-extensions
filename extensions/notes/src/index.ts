import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Extension, ToolError, s, tool, type Infer } from "@nexora/extension-sdk";

const title = s.string("Note title");
const CreateInput = s.object({ title, content: s.string("Markdown") });
const TitleInput = s.object({ title });
const AppendInput = s.object({ title, content: s.string("Markdown to add at the end") });
const UpdateInput = s.object({ title, content: s.string("New full Markdown content") });
const SearchInput = s.object({ query: s.string("Text to look for in titles and content") });

const summary = s.object({ title: s.string(), updated: s.string(), size: s.number() });

/** Notes live as Markdown files in the extension's private data folder, so it
 *  needs no access to the user's files. */
class Notes extends Extension {
  @tool({ description: "List all notes, most recently updated first.", output: s.array(summary), readOnly: true })
  async list() {
    const out = [];
    for (const f of await fs.readdir(this.dir()).catch(() => [] as string[])) {
      if (!f.endsWith(".md")) continue;
      const st = await fs.stat(join(this.dir(), f));
      out.push({ title: fromFile(f), updated: st.mtime.toISOString(), size: st.size });
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  @tool({ description: "Read a note.", input: TitleInput, output: s.string(), readOnly: true })
  async read({ title }: Infer<typeof TitleInput>) {
    return fs.readFile(this.file(title), "utf8").catch(() => {
      throw new ToolError(`No note called "${title}".`);
    });
  }

  @tool({ description: "Search notes by title and content; returns matching notes with matching lines.", input: SearchInput, readOnly: true })
  async search({ query }: Infer<typeof SearchInput>) {
    const q = query.toLowerCase();
    const out = [];
    for (const n of await this.list()) {
      const text = await fs.readFile(this.file(n.title), "utf8");
      const lines = text.split("\n").filter((l) => l.toLowerCase().includes(q)).slice(0, 3);
      if (n.title.toLowerCase().includes(q) || lines.length) out.push({ ...n, matches: lines });
    }
    return out;
  }

  @tool({ description: "Create a new note. Fails if one with that title exists (use update or append).", input: CreateInput, output: summary })
  async create({ title, content }: Infer<typeof CreateInput>) {
    await fs.mkdir(this.dir(), { recursive: true });
    await fs.writeFile(this.file(title), content, { encoding: "utf8", flag: "wx" }).catch((err) => {
      throw new ToolError(err.code === "EEXIST" ? `A note called "${title}" already exists.` : err.message);
    });
    return this.summary(title);
  }

  @tool({ description: "Add Markdown to the end of a note (creating it if needed).", input: AppendInput, output: summary })
  async append({ title, content }: Infer<typeof AppendInput>) {
    await fs.mkdir(this.dir(), { recursive: true });
    const prefix = (await fs.stat(this.file(title)).catch(() => null)) ? "\n" : "";
    await fs.appendFile(this.file(title), prefix + content, "utf8");
    return this.summary(title);
  }

  @tool({ description: "Replace a note's content.", input: UpdateInput, output: summary })
  async update({ title, content }: Infer<typeof UpdateInput>) {
    await this.read({ title }); // must exist
    await fs.writeFile(this.file(title), content, "utf8");
    return this.summary(title);
  }

  @tool({ description: "Delete a note.", input: TitleInput, output: s.object({ deleted: s.string() }) })
  async delete({ title }: Infer<typeof TitleInput>) {
    await fs.rm(this.file(title)).catch(() => {
      throw new ToolError(`No note called "${title}".`);
    });
    return { deleted: title };
  }

  private dir() {
    return join(this.dataDir, "notes");
  }

  private file(title: string) {
    const t = title?.trim();
    if (!t || t.length > 120) throw new ToolError("A title is required (up to 120 characters).");
    return join(this.dir(), toFile(t));
  }

  private async summary(title: string) {
    const st = await fs.stat(this.file(title));
    return { title, updated: st.mtime.toISOString(), size: st.size };
  }
}

/** Titles map to safe file names; percent-encoding keeps them reversible. */
function toFile(title: string) {
  return encodeURIComponent(title).replace(/\./g, "%2E") + ".md";
}

function fromFile(file: string) {
  return decodeURIComponent(file.slice(0, -3));
}

Notes.run();
