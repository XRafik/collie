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

export interface Folders {
  /** Every folder in the diff, and those the filter leaves. */
  readonly all: ReadonlyArray<string>;
  readonly listed: ReadonlyArray<string>;
  readonly closed: ReadonlySet<string>;
  readonly filtering: boolean;
}

/** Every folder the filter leaves while it is in effect; else all but those the human closed. */
export const openFolders = ({ all, listed, closed, filtering }: Folders): ReadonlyArray<string> =>
  filtering ? listed : all.filter((folder) => !closed.has(folder));

/** The folders the human has closed once the tree says which are open; none close while filtering. */
export const closedFolders = (
  folders: Folders,
  open: ReadonlyArray<string>,
): ReadonlySet<string> =>
  folders.filtering
    ? folders.closed
    : new Set(folders.all.filter((folder) => !open.includes(folder)));

/** A row's click selects nothing itself, so the active file stays the only selection. */
export const fileSelected = (event: { preventDefault(): void }, key: string): string | null => {
  event.preventDefault();
  return key.endsWith("/") ? null : key;
};

export interface RowFacts {
  readonly status: DiffFile["status"];
  readonly lines: { readonly added: number; readonly removed: number } | "binary";
  readonly drafts: number;
}

/** `drafts` is the path of each Diff-anchored Review comment draft. */
export const rowFacts = (file: DiffFile, drafts: ReadonlyArray<string>): RowFacts => ({
  status: file.status,
  lines: file.added === null ? "binary" : { added: file.added, removed: file.removed ?? 0 },
  drafts: drafts.filter((path) => path === file.path).length,
});

/** The rows whose file's path contains the text, ignoring case, and the folders above them. */
export const filterTree = (
  tree: ReadonlyArray<DiffTreeNode>,
  text: string,
): ReadonlyArray<DiffTreeNode> => {
  const wanted = text.trim().toLowerCase();
  if (wanted === "") return tree;
  const kept = (nodes: ReadonlyArray<DiffTreeNode>): ReadonlyArray<DiffTreeNode> =>
    nodes.flatMap((node): ReadonlyArray<DiffTreeNode> => {
      if (node.kind === "file") return node.key.toLowerCase().includes(wanted) ? [node] : [];
      const children = kept(node.children);
      return children.length === 0 ? [] : [{ ...node, children }];
    });
  return kept(tree);
};

/** What a viewed tick saw, so a file the Run changes again loses it. */
interface ViewedTick {
  readonly status: DiffFile["status"];
  readonly added: number | null;
  readonly removed: number | null;
  readonly base: string;
}

/** Each viewed tick by its file's path. */
export type ViewedTicks = ReadonlyMap<string, ViewedTick>;

export const tickViewed = (ticks: ViewedTicks, file: DiffFile, base: string): ViewedTicks =>
  new Map(ticks).set(file.path, {
    status: file.status,
    added: file.added,
    removed: file.removed,
    base,
  });

export const untickViewed = (ticks: ViewedTicks, path: string): ViewedTicks => {
  const kept = new Map(ticks);
  kept.delete(path);
  return kept;
};

export const viewedFiles = (
  ticks: ViewedTicks,
  files: ReadonlyArray<DiffFile>,
  base: string,
): ReadonlySet<string> =>
  new Set(
    files.flatMap((file) => {
      const seen = ticks.get(file.path);
      const same =
        seen !== undefined &&
        seen.status === file.status &&
        seen.added === file.added &&
        seen.removed === file.removed &&
        seen.base === base;
      return same ? [file.path] : [];
    }),
  );

export const viewedCount = (
  ticks: ViewedTicks,
  files: ReadonlyArray<DiffFile>,
  base: string,
): string => `${viewedFiles(ticks, files, base).size} of ${files.length} viewed`;

const BIG_FILE_LINES = 500;

/** The human's choice for the file, else open for a text file of at most 500 changed lines. */
export const fileOpen = (file: DiffFile, choices: ReadonlyMap<string, boolean>): boolean =>
  choices.get(file.path) ??
  (file.added !== null && file.added + (file.removed ?? 0) <= BIG_FILE_LINES);

/** Expand all or Collapse all: one choice for each file in the diff now. */
export const choiceForEvery = (
  files: ReadonlyArray<DiffFile>,
  open: boolean,
): ReadonlyMap<string, boolean> => new Map(files.map(({ path }) => [path, open]));

/** The file one step from the active one in drawn order; the first while none is active. */
export const fileBeside = (
  files: ReadonlyArray<DiffFile>,
  active: string | null,
  step: 1 | -1,
): string | null => {
  const at = files.findIndex(({ path }) => path === active);
  return (at === -1 ? files[0] : files[at + step])?.path ?? null;
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

/** `@pierre/diffs`' default line height. */
const DIFF_LINE = 20;

/** The placeholder a file holds while it is read, so the page does not jump when it is drawn. */
export const readingHeight = ({ added, removed }: DiffFile, visible: number): number =>
  Math.min(Math.max(1, (added ?? 0) + (removed ?? 0)) * DIFF_LINE, visible);
