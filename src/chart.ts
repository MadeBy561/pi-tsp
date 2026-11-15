/**
 * A bar chart for a markdown table of numbers.
 *
 * When a reply holds a table with a label column and a numeric one, the
 * chart follows the table as an SVG figure. The SVG uses the theme's own
 * colour variables, so Tern recolours it with the theme and nothing is
 * re-sent.
 */

export interface ChartTable {
  /** Where the table ends in the source, after its last row's newline. */
  end: number;
  title: string;
  unit: string;
  /** `text` is the cell as written, so "$1.20" is not redrawn as "$1.2". */
  rows: { label: string; value: number; text?: string }[];
}

const DELIMITER_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map(cell => cell.trim());

/** A cell's number and what surrounds it (`$1,200`, `45 ms`, `12%`), or null when it is not one. */
function numberOf(cell: string): { value: number; unit: string } | null {
  const match = cell.replace(/[*_`]/g, "").match(/^([^\d\-+.]*)([-+]?\d[\d,]*(?:\.\d+)?|\.\d+)\s*([^\d\s]*)$/);
  if (!match) return null;
  const value = Number(match[2]!.replace(/,/g, ""));
  return Number.isFinite(value) ? { value, unit: `${match[1]!.trim()}${match[3]!.trim()}` } : null;
}

/** The chartable tables of `source`, in order. A table still arriving at the very end is left out. */
export function chartTables(source: string, streaming: boolean): ChartTable[] {
  if (!source.includes("|")) return [];
  const out: ChartTable[] = [];
  const lines = source.split("\n");
  let offset = 0;
  const starts = lines.map(line => {
    const at = offset;
    offset += line.length + 1;
    return at;
  });
  for (let index = 1; index < lines.length; index += 1) {
    if (!DELIMITER_ROW.test(lines[index]!) || !lines[index - 1]!.includes("|")) continue;
    const head = cells(lines[index - 1]!);
    let last = index;
    while (last + 1 < lines.length && lines[last + 1]!.includes("|") && lines[last + 1]!.trim()) last += 1;
    const body = lines.slice(index + 1, last + 1).map(cells);
    const atEnd = last === lines.length - 1 || lines.slice(last + 1).every(line => !line.trim());
    index = last;
    if (body.length < 2 || body.length > 24 || (streaming && atEnd)) continue;
    // The first column that is a number in every row is charted against the first column.
    for (let column = 1; column < head.length; column += 1) {
      const values = body.map(row => numberOf(row[column] ?? ""));
      if (values.some(value => value === null) || values.every(value => value!.value === 0) || values.some(value => value!.value < 0)) continue;
      const unit = values.find(value => value!.unit)?.unit ?? "";
      out.push({
        end: Math.min(source.length, starts[last]! + lines[last]!.length + 1),
        title: `${head[column]} by ${head[0]}`.replace(/[*_`]/g, ""),
        unit,
        rows: body.map((row, at) => ({ label: (row[0] ?? "").replace(/[*_`]/g, ""), value: values[at]!.value, text: (row[column] ?? "").replace(/[*_`]/g, "").trim() })),
      });
      break;
    }
  }
  return out;
}

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const short = (value: number): string => (Math.abs(value) >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 1 }) : String(Math.round(value * 100) / 100));

/** A horizontal bar chart of `table` as SVG source. */
export function chartSvg(table: ChartTable): string {
  const rowHeight = 26;
  const labelWidth = Math.min(220, Math.max(60, ...table.rows.map(row => row.label.length * 7.2)));
  const width = 640;
  const barLeft = labelWidth + 12;
  const barWidth = width - barLeft - 90;
  const max = Math.max(...table.rows.map(row => row.value));
  const height = table.rows.length * rowHeight + 8;
  const bars = table.rows
    .map((row, index) => {
      const y = index * rowHeight + 4;
      const length = max > 0 ? Math.max(2, (row.value / max) * barWidth) : 2;
      const value = row.text ? row.text : table.unit === "$" ? `$${short(row.value)}` : `${short(row.value)}${table.unit ? (table.unit === "%" ? "%" : ` ${table.unit}`) : ""}`;
      return [
        `<text x="${labelWidth}" y="${y + 14}" text-anchor="end" font-size="12" fill="var(--fg)">${escape(row.label.length > 30 ? `${row.label.slice(0, 29)}…` : row.label)}</text>`,
        `<rect x="${barLeft}" y="${y + 2}" width="${length.toFixed(1)}" height="16" rx="3" fill="var(--accent)" fill-opacity="0.8"/>`,
        `<text x="${(barLeft + length + 6).toFixed(1)}" y="${y + 14}" font-size="12" fill="var(--fg)" fill-opacity="0.7">${escape(value)}</text>`,
      ].join("");
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(`bar chart of ${table.title}`)}">${bars}</svg>`;
}

/** `text` cut into prose and chart figures: each chart follows the table it draws. */
export function withCharts(text: string, streaming: boolean): { text: string; chart: boolean }[] {
  const tables = chartTables(text, streaming);
  if (!tables.length) return [{ text, chart: false }];
  const out: { text: string; chart: boolean }[] = [];
  let at = 0;
  for (const table of tables) {
    out.push({ text: text.slice(at, table.end).replace(/\n+$/, ""), chart: false });
    out.push({ text: `\`\`\`svg\n${chartSvg(table)}\n\`\`\``, chart: true });
    at = table.end;
  }
  const rest = text.slice(at);
  if (rest.trim()) out.push({ text: rest.replace(/^\n+/, ""), chart: false });
  return out;
}
