// The Plan tab's logic: how far the plan is, and the spec's headings.

import { type Node, parseMarkdown } from "comark";
import { SAFE_PLUGINS } from "./markdown";

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

const HEADING = /^h([1-6])$/;

const textOf = (node: Node): string => {
  if (!Array.isArray(node)) return node;
  const [tag, , ...children] = node;
  return tag === null ? "" : children.map(textOf).join("");
};

/** Parsed as it is drawn, so each heading's position is the one the drawn page has. */
export const specHeadings = (spec: string): Promise<ReadonlyArray<SpecHeading>> =>
  parseMarkdown(spec, { plugins: SAFE_PLUGINS }).then(({ nodes }) => {
    const found: Array<{ level: number; text: string }> = [];
    const visit = (node: Node): void => {
      if (!Array.isArray(node) || node[0] === null) return;
      const [tag, , ...children] = node;
      const level = HEADING.exec(tag)?.[1];
      if (level !== undefined)
        found.push({ level: Number(level), text: textOf(node).replace(/\s+/g, " ").trim() });
      else children.forEach(visit);
    };
    nodes.forEach(visit);
    return found.map((heading, position) => ({ ...heading, position }));
  });
