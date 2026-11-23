import type { ReactNode } from "react";
import styles from "./assistant-app.module.css";

/** Renders the assistant's replies. It builds React elements only, so a reply can never inject HTML. */

/**
 * A link's address may hold balanced brackets, as Wikipedia's do («…/wiki/القصير_(مصر)»): the link ends at the bracket that
 * closes it, not at the first «)». Until 2026-11-23 such a link lost its «)» and left a stray one in the text.
 */
const ADDRESS = String.raw`https?:\/\/(?:[^\s()]|\([^\s()]*\)|\()+`;
/** A bare address: the same brackets, and never the sentence's closing bracket or punctuation. */
const BARE_ADDRESS = String.raw`https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))*(?:[^\s<>().,،]|\([^\s<>()]*\))`;
const INLINE = new RegExp(String.raw`(\*\*[^*\n]+\*\*|` + "`[^`\\n]+`" + String.raw`|\[[^\]\n]+\]\(${ADDRESS}\)|${BARE_ADDRESS})`, "g");
const LINK = new RegExp(String.raw`^\[([^\]]+)\]\((${ADDRESS})\)$`);
const LINKS = new RegExp(String.raw`\[([^\]\n]+)\]\((${ADDRESS})\)`, "g");
/** «---», «***» or «___» alone on a line: a dividing line. The planner, letter and PDF replies put one before their note. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = LINK.exec(part);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noopener noreferrer" title={part}>{shortLink(part)}</a>;
    return part;
  });
}

/** A bare address as people can read it: the site and the decoded page name, never %D8%A7… */
export function shortLink(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (!last) return host;
    const name = decodeURIComponent(last).replace(/[_+]/g, " ").replace(/\.(html?|php|aspx?)$/i, "");
    return `${host} › ${name.length > 40 ? `${name.slice(0, 39)}…` : name}`;
  } catch { return url.length > 50 ? `${url.slice(0, 49)}…` : url; }
}

/** The reply as plain text for the clipboard: no ** or >, no dividing lines, links as «title (address)». */
export function plainText(text: string): string {
  return text.split("\n").map(line => RULE.test(line) ? "" : line.replace(/^\s*>\s?/, "")).join("\n")
    .replace(LINKS, (_, title: string, url: string) => `${title} (${url})`)
    .replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/\n{3,}/g, "\n\n").trim();
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) code.push(lines[index++]);
      index++;
      blocks.push(<pre key={blocks.length} dir="ltr"><code>{code.join("\n")}</code></pre>);
      continue;
    }
    if (RULE.test(line)) {
      blocks.push(<hr key={blocks.length} />);
      index++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(<h3 key={blocks.length} className={styles.replyHeading}>{inline(heading[2])}</h3>);
      index++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/, ""));
      const parts = quoted.join("\n").split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
      blocks.push(<blockquote key={blocks.length} className={styles.replyQuote}>{parts.map((part, position) => <p key={position} dir="auto">{inline(part)}</p>)}</blockquote>);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+/;
    const bullet = /^\s*[-*•]\s+/;
    if (ordered.test(line) || bullet.test(line)) {
      const pattern = ordered.test(line) ? ordered : bullet;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index])) items.push(lines[index++].replace(pattern, ""));
      // <bdi>: each item finds its own direction, so "24 hour tyre fitting" is not read right to left in an Arabic reply.
      const content = items.map((item, position) => <li key={position}><bdi>{inline(item)}</bdi></li>);
      blocks.push(pattern === ordered ? <ol key={blocks.length}>{content}</ol> : <ul key={blocks.length}>{content}</ul>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !lines[index].trimStart().startsWith("```") && !/^#{1,3}\s/.test(lines[index]) && !ordered.test(lines[index]) && !bullet.test(lines[index]) && !/^\s*>/.test(lines[index]) && !RULE.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={blocks.length} dir="auto">{inline(paragraph.join("\n"))}</p>);
  }
  return <div className={styles.reply}>{blocks}</div>;
}
