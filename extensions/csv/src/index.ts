import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { Extension, ToolError, s, tool, trustedPath, type Infer } from "@nexora/extension-sdk";
import Papa from "papaparse";

interface CsvSettings {
  [key: string]: unknown;
  folders: string[];
  maxRows: number;
}

type Row = Record<string, string>;

const path = s.string("Absolute path to a .csv/.tsv file, or relative to the first trusted folder");
const delimiter = s.optional(s.string('Field separator (default: detected, e.g. "," or "\\t")'));
const ReadInput = s.object({
  path, delimiter,
  offset: s.optional(s.integer("First row to return (default 0)")),
  limit: s.optional(s.integer("Rows to return (default 100, max 5000)")),
});
const condition = s.object({
  column: s.string(),
  op: s.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "startsWith", "empty", "notEmpty"]),
  value: s.optional(s.any("Compared as a number when both sides are numeric, otherwise as text (case-insensitive)")),
});
const QueryInput = s.object({
  path, delimiter,
  where: s.optional(s.array(condition, "All conditions must match")),
  select: s.optional(s.array(s.string(), "Columns to return (default all)")),
  groupBy: s.optional(s.array(s.string(), "Group rows by these columns")),
  aggregate: s.optional(s.array(s.object({
    column: s.optional(s.string("Column to aggregate (not needed for count)")),
    fn: s.enum(["count", "sum", "avg", "min", "max", "distinct"]),
    as: s.optional(s.string("Name of the result column")),
  }), "Computed per group (or over all rows without groupBy)")),
  sort: s.optional(s.array(s.object({ column: s.string(), desc: s.optional(s.boolean()) }))),
  limit: s.optional(s.integer("Rows to return (default 100, max 5000)")),
});
const StatsInput = s.object({ path, delimiter });
const WriteInput = s.object({
  path,
  rows: s.array(s.any(), "Objects (keys become columns) or arrays (use columns for the header)"),
  columns: s.optional(s.array(s.string(), "Header row / column order")),
  delimiter,
  overwrite: s.optional(s.boolean("Replace an existing file. Default false")),
});

class Csv extends Extension<CsvSettings> {
  @tool({ description: "Read rows from a CSV/TSV file (first row is the header). Returns the columns, a page of rows, and the total.",
    input: ReadInput, readOnly: true })
  async read({ path: p, delimiter: d, offset = 0, limit = 100 }: Infer<typeof ReadInput>) {
    const { columns, rows, truncated } = await this.load(p, d);
    const n = clamp(limit, 1, 5000);
    return { columns, rows: rows.slice(offset, offset + n), totalRows: rows.length, truncated };
  }

  @tool({
    description: "Filter, group, aggregate and sort a CSV in one step, like a small SQL query. " +
      "Example: where [{column:'region',op:'eq',value:'EMEA'}], groupBy ['product'], aggregate [{column:'revenue',fn:'sum'}], sort [{column:'sum_revenue',desc:true}].",
    input: QueryInput, readOnly: true,
  })
  async query({ path: p, delimiter: d, where = [], select, groupBy, aggregate, sort = [], limit = 100 }: Infer<typeof QueryInput>) {
    const { columns, rows } = await this.load(p, d);
    for (const c of [...where.map((w) => w.column), ...(select ?? []), ...(groupBy ?? []),
      ...(aggregate ?? []).flatMap((a) => (a.column ? [a.column] : []))]) {
      if (!columns.includes(c)) throw new ToolError(`Unknown column "${c}". Columns: ${columns.join(", ")}`);
    }
    let out: Record<string, unknown>[] = rows.filter((r) => where.every((w) => matches(r[w.column], w.op, w.value)));
    const matched = out.length;

    if (groupBy?.length || aggregate?.length) {
      const keys = groupBy ?? [];
      const groups = new Map<string, Row[]>();
      for (const r of out as Row[]) {
        const k = JSON.stringify(keys.map((c) => r[c]));
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      const aggs = aggregate?.length ? aggregate : [{ fn: "count" as const }];
      out = [...groups.entries()].map(([k, rs]) => {
        const row: Record<string, unknown> = {};
        keys.forEach((c, i) => (row[c] = JSON.parse(k)[i]));
        for (const a of aggs) row[a.as ?? (a.column ? `${a.fn}_${a.column}` : a.fn)] = aggregateOf(rs, a.fn, a.column);
        return row;
      });
    } else if (select?.length) {
      out = out.map((r) => Object.fromEntries(select.map((c) => [c, (r as Row)[c]])));
    }

    for (const { column, desc } of [...sort].reverse()) {
      out.sort((a, b) => compare(a[column], b[column]) * (desc ? -1 : 1));
    }
    const n = clamp(limit, 1, 5000);
    return { rows: out.slice(0, n), matchedRows: matched, resultRows: out.length, truncated: out.length > n };
  }

  @tool({ description: "Profile each column: inferred type, filled/empty counts, distinct values, and min/max/mean for numbers.",
    input: StatsInput, readOnly: true })
  async stats({ path: p, delimiter: d }: Infer<typeof StatsInput>) {
    const { columns, rows } = await this.load(p, d);
    return {
      rows: rows.length,
      columns: columns.map((c) => {
        const values = rows.map((r) => r[c] ?? "").filter((v) => v.trim() !== "");
        const nums = values.map(num).filter((n): n is number => n !== null);
        const numeric = values.length > 0 && nums.length === values.length;
        const distinct = new Set(values);
        return {
          name: c,
          type: numeric ? "number" : values.every((v) => !Number.isNaN(Date.parse(v))) && values.length ? "date" : "text",
          filled: values.length,
          empty: rows.length - values.length,
          distinct: distinct.size,
          ...(numeric && nums.length
            ? { min: Math.min(...nums), max: Math.max(...nums), mean: round(nums.reduce((a, b) => a + b, 0) / nums.length) }
            : { examples: [...distinct].slice(0, 5) }),
        };
      }),
    };
  }

  @tool({ description: "Write rows to a new CSV file (or replace one with overwrite: true).", input: WriteInput,
    output: s.object({ path: s.string(), rows: s.integer() }) })
  async write({ path: p, rows, columns, delimiter: d = ",", overwrite = false }: Infer<typeof WriteInput>) {
    const file = trustedPath(p, this.settings.folders, "CSV");
    if (!overwrite && (await fs.stat(file).catch(() => null))) {
      throw new ToolError(`${p} already exists; pass overwrite: true to replace it.`);
    }
    if (!Array.isArray(rows)) throw new ToolError("rows must be an array");
    const csv = Array.isArray(rows[0])
      ? Papa.unparse({ fields: columns ?? [], data: rows as unknown[][] }, { delimiter: d, header: !!columns })
      : Papa.unparse(rows as object[], { delimiter: d, columns });
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, csv + "\n", "utf8");
    return { path: file, rows: rows.length };
  }

  private async load(p: string, delimiter?: string) {
    const file = trustedPath(p, this.settings.folders, "CSV");
    const text = await fs.readFile(file, "utf8").catch((err) => {
      throw new ToolError(err.code === "ENOENT" ? `${p} doesn't exist` : err.message);
    });
    const max = this.settings.maxRows || 200_000;
    const res = Papa.parse<Row>(text.replace(/^﻿/, ""), {
      header: true, skipEmptyLines: "greedy", delimiter: delimiter ?? "", preview: max + 1,
      transformHeader: (h) => h.trim(),
    });
    const columns = res.meta.fields ?? [];
    if (!columns.length) throw new ToolError(`${p} has no header row`);
    const truncated = res.data.length > max;
    return { columns, rows: truncated ? res.data.slice(0, max) : res.data, truncated };
  }
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/,(?=\d{3}\b)/g, "");
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  return Number(t);
}

function matches(cell: string | undefined, op: string, value: unknown): boolean {
  const v = cell ?? "";
  if (op === "empty") return v.trim() === "";
  if (op === "notEmpty") return v.trim() !== "";
  const a = num(v), b = num(value);
  const both = a !== null && b !== null;
  const text = String(value ?? "").toLowerCase();
  const cmp = both ? a - b : v.toLowerCase().localeCompare(text);
  switch (op) {
    case "eq": return cmp === 0;
    case "ne": return cmp !== 0;
    case "gt": return cmp > 0;
    case "gte": return cmp >= 0;
    case "lt": return cmp < 0;
    case "lte": return cmp <= 0;
    case "contains": return v.toLowerCase().includes(text);
    case "startsWith": return v.toLowerCase().startsWith(text);
  }
  throw new ToolError(`Unknown operator "${op}"`);
}

function aggregateOf(rows: Row[], fn: string, column?: string): number | null {
  if (fn === "count") return rows.length;
  if (!column) throw new ToolError(`${fn} needs a column`);
  const values = rows.map((r) => r[column]);
  if (fn === "distinct") return new Set(values).size;
  const nums = values.map(num).filter((n): n is number => n !== null);
  if (!nums.length) return null;
  switch (fn) {
    case "sum": return round(nums.reduce((a, b) => a + b, 0));
    case "avg": return round(nums.reduce((a, b) => a + b, 0) / nums.length);
    case "min": return Math.min(...nums);
    case "max": return Math.max(...nums);
  }
  throw new ToolError(`Unknown aggregate "${fn}"`);
}

function compare(a: unknown, b: unknown): number {
  const x = num(a), y = num(b);
  if (x !== null && y !== null) return x - y;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(Math.floor(n), lo), hi);
}

function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

Csv.run();
