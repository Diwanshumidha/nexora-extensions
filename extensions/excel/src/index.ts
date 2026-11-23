import { Extension, ToolError, insideFolders, s, tool, type Infer } from "@nexora/extension-sdk";
import ExcelJS from "exceljs";

type Cell = string | number | boolean | null;

const path = s.string("Absolute path to the .xlsx file");
const rows = s.array(s.array(s.any()), "Rows of cell values");

const ListSheetsInput = s.object({ path });
const ReadSheetInput = s.object({ path, sheet: s.optional(s.string("Worksheet name (default: first sheet)")) });
const WriteSheetInput = s.object({ path, rows, sheet: s.optional(s.string("Worksheet name (default: Sheet1)")) });

interface ExcelSettings {
  [key: string]: unknown;
  folders: string[];
  maxRows: number;
}

class Excel extends Extension<ExcelSettings> {
  @tool({ description: "List the worksheet names in a workbook", input: ListSheetsInput, output: s.array(s.string()), readOnly: true })
  async listSheets({ path }: Infer<typeof ListSheetsInput>): Promise<string[]> {
    const wb = await this.open(path);
    return wb.worksheets.map((ws) => ws.name);
  }

  @tool({ description: "Read a worksheet as a 2D array of cell values", input: ReadSheetInput, output: rows, readOnly: true })
  async readSheet({ path, sheet }: Infer<typeof ReadSheetInput>): Promise<Cell[][]> {
    const wb = await this.open(path);
    const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
    if (!ws) throw new ToolError(`sheet not found: ${sheet}`);
    const out: Cell[][] = [];
    const max = this.settings.maxRows || Infinity;
    ws.eachRow({ includeEmpty: true }, (row) => {
      if (out.length >= max) return;
      out.push((row.values as ExcelJS.CellValue[]).slice(1).map(toCell)); // exceljs rows are 1-indexed
    });
    if (ws.rowCount > out.length) this.log.info(`readSheet returned the first ${out.length} of ${ws.rowCount} rows`);
    return out;
  }

  @tool({
    description: "Write rows to a worksheet, creating the workbook if needed. Replaces the sheet if it exists.",
    input: WriteSheetInput,
    output: s.object({ path: s.string() }),
  })
  async writeSheet({ path, sheet = "Sheet1", rows }: Infer<typeof WriteSheetInput>) {
    this.checkTrusted(path);
    const wb = await this.open(path).catch(() => new ExcelJS.Workbook());
    const existing = wb.getWorksheet(sheet);
    if (existing) wb.removeWorksheet(existing.id);
    wb.addWorksheet(sheet).addRows(rows as Cell[][]);
    await wb.xlsx.writeFile(path);
    return { path };
  }

  private async open(path: string): Promise<ExcelJS.Workbook> {
    this.checkTrusted(path);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    return wb;
  }

  /** A clear error before the sandbox would refuse access. */
  private checkTrusted(path: string) {
    if (!this.settings.folders?.length) {
      throw new ToolError("Excel has no trusted folders yet. Ask the user to add one in Nexora (Excel → Settings).");
    }
    if (!insideFolders(path, this.settings.folders)) {
      throw new ToolError(
        `${path} is outside Excel's trusted folders (${this.settings.folders.join(", ")}). ` +
          "Ask the user to add its folder in Nexora (Excel → Settings).",
      );
    }
  }
}

function toCell(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "result" in v) return toCell(v.result as ExcelJS.CellValue); // formula
  if (typeof v === "object" && "text" in v) return String(v.text); // hyperlink / rich text
  return String(v);
}

Excel.run();
