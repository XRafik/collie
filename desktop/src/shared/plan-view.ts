// The Plan tab's logic: how far the plan is, and the spec's headings.

export const planProgress = (tickets: ReadonlyArray<{ readonly done: boolean }>): string | null =>
  tickets.length === 0
    ? null
    : `${tickets.filter(({ done }) => done).length} of ${tickets.length} tickets done`;

export interface SpecHeading {
  readonly level: number;
  readonly text: string;
  /** Its index among all the spec's headings, which is how its rendered heading is found. */
  readonly position: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING_HASHES = /(?:^|[ \t]+)#+[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^(?: {4}|\t)/;
/** A line that starts a block of its own, so a setext underline below it is not a heading. */
const OTHER_BLOCK = /^ {0,3}(?:>|<|\||(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$)/;

const CODE_SPAN = /(`+)(.+?)\1/g;
const unmarked = (text: string): string =>
  text
    .split(CODE_SPAN)
    .map((part, at) => {
      if (at % 3 === 1) return "";
      if (at % 3 === 2) return part.trim();
      let plain = part
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1");
      for (let was = ""; was !== plain;) {
        was = plain;
        plain = plain
          .replace(/(\*\*|\*|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
          .replace(/(?<!\w)(__|_)(?=\S)(.+?)(?<=\S)\1(?!\w)/g, "$2");
      }
      return plain;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

const withoutFrontMatter = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (lines[0]?.trimEnd() !== "---") return lines;
  const end = lines.findIndex((line, at) => at > 0 && line.trimEnd() === "---");
  return end === -1 ? lines : lines.slice(end + 1);
};

export const specHeadings = (spec: string): ReadonlyArray<SpecHeading> => {
  const found: Array<{ level: number; text: string }> = [];
  let fence: string | null = null;
  let paragraph: Array<string> = [];
  for (const line of withoutFrontMatter(spec.split(/\r?\n/))) {
    const opening = FENCE.exec(line)?.[1];
    if (fence !== null) {
      const closes =
        opening !== undefined &&
        opening[0] === fence[0] &&
        opening.length >= fence.length &&
        line.trim() === opening;
      if (closes) {
        fence = null;
      }
      continue;
    }
    if (opening !== undefined) {
      fence = opening;
      paragraph = [];
      continue;
    }
    if (INDENTED.test(line)) continue;
    const setext = SETEXT.exec(line)?.[1];
    if (setext !== undefined && paragraph.length > 0) {
      found.push({ level: setext.startsWith("=") ? 1 : 2, text: unmarked(paragraph.join(" ")) });
      paragraph = [];
      continue;
    }
    const atx = ATX.exec(line);
    if (atx !== null) {
      found.push({
        level: atx[1]!.length,
        text: unmarked((atx[2] ?? "").replace(CLOSING_HASHES, "")),
      });
      paragraph = [];
      continue;
    }
    paragraph = line.trim() === "" || OTHER_BLOCK.test(line) ? [] : [...paragraph, line];
  }
  return found.map((heading, position) => ({ ...heading, position }));
};
