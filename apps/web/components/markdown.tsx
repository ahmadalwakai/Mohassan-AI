import type { ReactNode } from "react";
import styles from "./assistant-app.module.css";

/** Renders the assistant's replies. It builds React elements only, so a reply can never inject HTML. */

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,،])/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noopener noreferrer" dir="ltr">{part}</a>;
    return part;
  });
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
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(<h3 key={blocks.length} className={styles.replyHeading}>{inline(heading[2])}</h3>);
      index++;
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+/;
    const bullet = /^\s*[-*•]\s+/;
    if (ordered.test(line) || bullet.test(line)) {
      const pattern = ordered.test(line) ? ordered : bullet;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index])) items.push(lines[index++].replace(pattern, ""));
      const content = items.map((item, position) => <li key={position}>{inline(item)}</li>);
      blocks.push(pattern === ordered ? <ol key={blocks.length}>{content}</ol> : <ul key={blocks.length}>{content}</ul>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !lines[index].trimStart().startsWith("```") && !/^#{1,3}\s/.test(lines[index]) && !ordered.test(lines[index]) && !bullet.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={blocks.length} dir="auto">{inline(paragraph.join("\n"))}</p>);
  }
  return <div className={styles.reply}>{blocks}</div>;
}
