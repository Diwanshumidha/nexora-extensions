import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Extension, ToolError, s, tool, trustedPath, type Infer } from "@nexora/extension-sdk";
import { extractText, getDocumentProxy, getMeta } from "unpdf";

interface PdfSettings {
  [key: string]: unknown;
  folders: string[];
  maxChars: number;
}

const path = s.string("Absolute path to a .pdf, or relative to the first trusted folder");
const InfoInput = s.object({ path });
const ReadInput = s.object({
  path,
  pages: s.optional(s.string('Pages to read, e.g. "1-3,7" (default: all, within the size limit)')),
});
const SearchInput = s.object({
  query: s.string("Text to find (case-insensitive)"),
  path: s.optional(s.string("A PDF or a folder of PDFs (default: every trusted folder)")),
  maxResults: s.optional(s.integer("Default 50")),
});

const MAX_FILE = 100 * 1024 * 1024;
const MAX_SEARCH_FILES = 300;

class Pdf extends Extension<PdfSettings> {
  @tool({ description: "Details of a PDF: page count, title, author, dates, producer.", input: InfoInput, readOnly: true })
  async info({ path: p }: Infer<typeof InfoInput>) {
    const { doc } = await this.open(p);
    const { info } = await getMeta(doc);
    const i = (info ?? {}) as unknown as Record<string, unknown>;
    return {
      pages: doc.numPages,
      title: str(i.Title), author: str(i.Author), subject: str(i.Subject),
      creator: str(i.Creator), producer: str(i.Producer),
      created: pdfDate(i.CreationDate), modified: pdfDate(i.ModDate),
    };
  }

  @tool({
    description: "Extract the text of a PDF, page by page. Use pages to read a long document in parts.",
    input: ReadInput, readOnly: true,
    output: s.object({ pages: s.array(s.object({ page: s.integer(), text: s.string() })), totalPages: s.integer(), truncated: s.boolean() }),
  })
  async readText({ path: p, pages }: Infer<typeof ReadInput>) {
    const { doc } = await this.open(p);
    const { text } = await extractText(doc, { mergePages: false });
    const wanted = pages ? parsePages(pages, doc.numPages) : text.map((_, i) => i + 1);
    const limit = this.settings.maxChars || 100_000;
    const out: { page: number; text: string }[] = [];
    let used = 0;
    let truncated = false;
    for (const n of wanted) {
      const t = (text[n - 1] ?? "").replace(/[ \t]+\n/g, "\n").trim();
      if (used + t.length > limit) {
        truncated = true;
        if (!out.length) out.push({ page: n, text: t.slice(0, limit) });
        break;
      }
      out.push({ page: n, text: t });
      used += t.length;
    }
    return { pages: out, totalPages: doc.numPages, truncated };
  }

  @tool({ description: "Search for text in one PDF or every PDF in a folder (recursively). Returns page numbers and snippets.",
    input: SearchInput, readOnly: true })
  async search({ query, path: p, maxResults = 50 }: Infer<typeof SearchInput>) {
    const q = query.trim().toLowerCase();
    if (!q) throw new ToolError("query is required");
    const roots = p ? [trustedPath(p, this.settings.folders, "PDF")] : this.settings.folders ?? [];
    if (!roots.length) trustedPath("", this.settings.folders, "PDF"); // explains the missing setting
    const files: string[] = [];
    for (const r of roots) await collectPdfs(r, files);
    const hits: { file: string; page: number; snippet: string }[] = [];
    for (const file of files) {
      if (hits.length >= maxResults) break;
      try {
        const { doc } = await this.load(file);
        const { text } = await extractText(doc, { mergePages: false });
        text.forEach((pageText, i) => {
          const lower = pageText.toLowerCase();
          let at = lower.indexOf(q);
          while (at >= 0 && hits.length < maxResults) {
            hits.push({ file, page: i + 1, snippet: pageText.slice(Math.max(0, at - 80), at + q.length + 80).replace(/\s+/g, " ").trim() });
            at = lower.indexOf(q, at + q.length);
          }
        });
      } catch {
        // unreadable or encrypted PDF: skip
      }
    }
    return { results: hits, filesSearched: files.length, truncated: hits.length >= maxResults || files.length >= MAX_SEARCH_FILES };
  }

  private open(p: string) {
    return this.load(trustedPath(p, this.settings.folders, "PDF"));
  }

  private async load(file: string) {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new ToolError(`${file} is not a file`);
    if (st.size > MAX_FILE) throw new ToolError(`${file} is larger than 100 MB`);
    try {
      return { doc: await getDocumentProxy(new Uint8Array(await fs.readFile(file))) };
    } catch (err) {
      throw new ToolError(`Can't read ${file} as a PDF: ${(err as Error).message}`);
    }
  }
}

async function collectPdfs(target: string, out: string[]) {
  if (out.length >= MAX_SEARCH_FILES) return;
  const st = await fs.stat(target).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    if (target.toLowerCase().endsWith(".pdf")) out.push(target);
    return;
  }
  if (!st.isDirectory()) return;
  for (const d of await fs.readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (d.name.startsWith(".") || d.name === "node_modules" || d.isSymbolicLink()) continue;
    await collectPdfs(join(target, d.name), out);
  }
}

/** "1-3,7" -> [1,2,3,7], clamped to the document. */
function parsePages(spec: string, total: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new ToolError(`Invalid pages "${spec}"; use a form like "1-3,7".`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b) && n <= total; n++) if (n >= 1) out.add(n);
  }
  if (!out.size) throw new ToolError(`No pages in range; the document has ${total}.`);
  return [...out].sort((x, y) => x - y);
}

function str(v: unknown) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** PDF dates look like D:20240131120000+05'30'. */
function pdfDate(v: unknown) {
  const m = typeof v === "string" && v.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return undefined;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", sec = "00"] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${sec}`;
}

Pdf.run();
