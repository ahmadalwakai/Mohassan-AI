import type { ReactNode } from "react";
import styles from "./markdown-table.module.css";

interface MarkdownTableData {
  columns: string[];
  rows: string[][];
  next: number;
}

const maxColumns = 12;
const maxRows = 60;
const maxRowLength = 16_384;
const separator = /^:?-{3,}:?$/;
const escape = /\\[\\`*_[\]<>|#~!]/;

function tableRow(raw: string | undefined): string[] | null {
  if (!raw || raw.length > maxRowLength) return null;
  const line = raw.trim();
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < line.length; index++) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "\\" && line[index + 1] === "\\") {
      cell += "\\\\";
      index++;
    } else if (char === "|") {
      cells.push(cell.trim());
      if (cells.length > maxColumns) return null;
      cell = "";
    } else {
      cell += char;
    }
  }
  return !cell && cells.length >= 2 ? cells : null;
}

/** An explicit delimiter row distinguishes Markdown tables from ordinary text containing pipes. */
export function markdownTableAt(lines: readonly string[], start: number): MarkdownTableData | null {
  const columns = tableRow(lines[start]);
  if (!columns?.every(Boolean)) return null;
  const divider = tableRow(lines[start + 1]);
  if (divider?.length !== columns.length || !divider.every(cell => separator.test(cell))) return null;
  const rows: string[][] = [];
  let next = start + 2;
  while (rows.length < maxRows) {
    const row = tableRow(lines[next]);
    if (row?.length !== columns.length) break;
    rows.push(row);
    next++;
  }
  return rows.length ? { columns, rows, next } : null;
}

/** Recognize escaped punctuation before inline markup so literal quotations stay literal. */
export function renderEscapedInline(text: string, markup: RegExp, render: (part: string, index: number) => ReactNode): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(`${escape.source}|${markup.source}`, markup.flags))) {
    if (match.index > cursor) nodes.push(render(text.slice(cursor, match.index), nodes.length));
    const token = match[0];
    nodes.push(token.length === 2 && escape.test(token) ? token[1] : render(token, nodes.length));
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(render(text.slice(cursor), nodes.length));
  return nodes;
}

export function MarkdownTable({ table, inline }: { table: MarkdownTableData; inline: (text: string) => ReactNode }) {
  return <div className={styles.scroll} tabIndex={0}>
    <table className={styles.table} dir="auto">
      <thead>
        <tr>{table.columns.map((column, index) => <th key={index} scope="col"><bdi>{inline(column)}</bdi></th>)}</tr>
      </thead>
      <tbody>
        {table.rows.map(([first, ...cells], row) => <tr key={row}>
          <th scope="row"><bdi>{inline(first)}</bdi></th>
          {cells.map((cell, column) => <td key={column}><bdi>{inline(cell)}</bdi></td>)}
        </tr>)}
      </tbody>
    </table>
  </div>;
}
