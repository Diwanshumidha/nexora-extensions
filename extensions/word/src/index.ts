import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Extension, ToolError, insideFolders, s, tool, type Infer } from "@nexora/extension-sdk";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";

const headings = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;

const CreateDocumentInput = s.object({
  path: s.string("File name (saved in the user's save folder) or an absolute path inside it, ending in .docx"),
  title: s.optional(s.string("Document title")),
  blocks: s.array(
    s.object({
      text: s.string(),
      heading: s.optional(s.enum([1, 2, 3], "Heading level; omit for body text")),
    }),
  ),
});

interface WordSettings {
  [key: string]: unknown;
  outputFolder: string;
}

class Word extends Extension<WordSettings> {
  @tool({
    description: "Create a .docx file from a list of paragraphs and headings",
    input: CreateDocumentInput,
    output: s.object({ path: s.string() }),
  })
  async createDocument({ path: requested, title, blocks }: Infer<typeof CreateDocumentInput>) {
    const folder = this.settings.outputFolder;
    if (!folder) {
      throw new ToolError("Word has no save folder yet. Ask the user to choose one in Nexora (Word → Settings).");
    }
    const path = isAbsolute(requested) ? requested : join(folder, requested);
    if (!insideFolders(path, [folder])) {
      throw new ToolError(`${requested} is outside Word's save folder (${folder}).`);
    }
    const children = [
      ...(title ? [new Paragraph({ text: title, heading: HeadingLevel.TITLE })] : []),
      ...blocks.map((b) => new Paragraph({ text: b.text, heading: b.heading ? headings[b.heading] : undefined })),
    ];
    const doc = new Document({ sections: [{ children }] });
    await writeFile(path, await Packer.toBuffer(doc));
    return { path };
  }
}

Word.run();
