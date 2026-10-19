// The Diff tab's logic: the tree of changed files and which file is being read.

import type { DiffFile } from "../../../src/board-model";

export type DiffTreeNode =
  | {
      readonly kind: "folder";
      /** The folder's path ending in `/`. */
      readonly key: string;
      readonly label: string;
      readonly children: ReadonlyArray<DiffTreeNode>;
    }
  | {
      readonly kind: "file";
      readonly key: string;
      readonly label: string;
      readonly file: DiffFile;
    };

export interface DiffTree {
  readonly tree: ReadonlyArray<DiffTreeNode>;
  /** The files depth-first, the order the tree reads and the diffs are drawn. */
  readonly files: ReadonlyArray<DiffFile>;
}

interface Building {
  readonly kind: "folder";
  readonly key: string;
  readonly label: string;
  readonly children: Array<DiffTreeNode>;
}

/** Every folder key above a file, outermost first. */
export const foldersOn = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, at) => `${parts.slice(0, at + 1).join("/")}/`);
};

export const diffTree = (changed: ReadonlyArray<DiffFile>): DiffTree => {
  const root: Array<DiffTreeNode> = [];
  for (const file of changed) {
    const parts = file.path.split("/");
    let level = root;
    foldersOn(file.path).forEach((key, at) => {
      let folder = level.find((node): node is Building => node.key === key);
      if (folder === undefined) {
        folder = { kind: "folder", key, label: parts[at]!, children: [] };
        level.push(folder);
      }
      level = folder.children;
    });
    level.push({ kind: "file", key: file.path, label: parts.at(-1)!, file });
  }
  const filesOf = (nodes: ReadonlyArray<DiffTreeNode>): ReadonlyArray<DiffFile> =>
    nodes.flatMap((node) => (node.kind === "file" ? [node.file] : filesOf(node.children)));
  return { tree: root, files: filesOf(root) };
};

interface Span {
  readonly top: number;
  readonly bottom: number;
}

/** A drawn file's section, measured from the top of the record's visible area. */
export interface FileSection extends Span {
  readonly path: string;
}

/** How far below the top of the visible area a file counts as read: about a file header. */
export const READING_LINE = 40;

export interface Reading {
  /** In drawn order; a collapsed file's section is its header. */
  readonly sections: ReadonlyArray<FileSection>;
  readonly readingLine: number;
  readonly atEnd: boolean;
  /** The file a jump holds until the human next scrolls. */
  readonly held: string | null;
}

export const activeFile = ({ sections, readingLine, atEnd, held }: Reading): string | null => {
  if (sections.some(({ path }) => path === held)) return held;
  if (atEnd) return sections.at(-1)?.path ?? null;
  const spanning = sections.find(({ top, bottom }) => top <= readingLine && readingLine < bottom);
  const above = sections.findLast(({ top }) => top <= readingLine);
  return (spanning ?? above ?? sections[0])?.path ?? null;
};

/** How far a box scrolls to show a row inside it, to the nearest edge; 0 when it shows. */
export const reachBy = (box: Span, row: Span): number =>
  row.top < box.top ? row.top - box.top : row.bottom > box.bottom ? row.bottom - box.bottom : 0;
