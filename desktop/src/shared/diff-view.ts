// The Diff tab's logic: the tree of changed files and which file is being read.

import type { DiffFile } from "../../../src/board-model";

export type DiffTreeNode =
  | {
      readonly kind: "folder";
      /** The deepest merged folder's path ending in `/`. */
      readonly key: string;
      /** The merged folders' names joined with `/`. */
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
  /** Every folder row's key, the folders the open and closed state tracks. */
  readonly folders: ReadonlyArray<string>;
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
  const tree = merged(root);
  const filesOf = (nodes: ReadonlyArray<DiffTreeNode>): ReadonlyArray<DiffFile> =>
    nodes.flatMap((node) => (node.kind === "file" ? [node.file] : filesOf(node.children)));
  const foldersOf = (nodes: ReadonlyArray<DiffTreeNode>): ReadonlyArray<string> =>
    nodes.flatMap((node) => (node.kind === "file" ? [] : [node.key, ...foldersOf(node.children)]));
  return { tree, files: filesOf(tree), folders: foldersOf(tree) };
};

/** Each folder whose only child is a folder, merged with it down the chain. */
const merged = (nodes: ReadonlyArray<DiffTreeNode>): ReadonlyArray<DiffTreeNode> =>
  nodes.map((node) => {
    if (node.kind === "file") return node;
    const children = merged(node.children);
    const [only] = children;
    return children.length === 1 && only?.kind === "folder"
      ? { ...only, label: `${node.label}/${only.label}` }
      : { ...node, children };
  });

/** A folder's full path; a file's, then its status and counts. */
export const rowHover = (node: DiffTreeNode): string => {
  if (node.kind === "folder") return node.key;
  const { path, status, added, removed } = node.file;
  return `${path}\n${status}, ${added === null ? "binary" : `+${added} −${removed ?? 0}`}`;
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

/** The tree's row geometry in px; the view draws from these. */
export const TREE = {
  paneStart: 320,
  paneMin: 192,
  paneStep: 16,
  /** The most of the Diff tab the pane may take. */
  paneShare: 0.4,
  indent: 12,
  /** Where the guide line sits inside an indent. */
  guide: 8,
  padding: 6,
  icon: 16,
  gap: 6,
  chevron: 16,
  scrollbar: 12,
  nameMin: 120,
} as const;

/** The pane's drawn width: the chosen one within the least width and the tab's share. */
export const paneWidth = (chosen: number, tab: number): number =>
  Math.max(TREE.paneMin, Math.min(chosen, tab * TREE.paneShare));

/** The width ← or → chooses, stepped from the drawn width. */
export const paneStepped = (chosen: number, tab: number, by: 1 | -1): number =>
  paneWidth(paneWidth(chosen, tab) + by * TREE.paneStep, tab);

/** The row facts' own sizes, at their `text-xs`, on the generous side. */
const FACTS = { gap: 4, mark: 16, tick: 14, draftIcon: 14, char: 7 } as const;

const digits = (n: number) => String(n).length;

const countsWidth = (lines: RowFacts["lines"]) =>
  lines === "binary"
    ? "binary".length * FACTS.char
    : (1 + digits(lines.added) + 1 + digits(lines.removed)) * FACTS.char + FACTS.gap;

const factsWidth = ({ facts, viewed }: FileRow, counts: boolean) =>
  [
    FACTS.mark,
    viewed ? FACTS.tick : 0,
    facts.drafts > 0 ? FACTS.draftIcon + digits(facts.drafts) * FACTS.char : 0,
    counts ? countsWidth(facts.lines) : 0,
  ]
    .filter((width) => width > 0)
    .reduce((sum, width, at) => sum + width + (at === 0 ? 0 : FACTS.gap), 0);

export interface FileRow {
  readonly facts: RowFacts;
  readonly viewed: boolean;
}

export interface RowRoom {
  readonly counts: boolean;
  /** Negative when the row's fixed parts overflow the pane. */
  readonly name: number;
}

/** A row's name room at a depth from 0, and whether a file row's line counts show. */
export const rowRoom = ({
  depth,
  pane,
  file,
}: {
  readonly depth: number;
  readonly pane: number;
  readonly file?: FileRow;
}): RowRoom => {
  const left =
    pane - TREE.scrollbar - depth * TREE.indent - (2 * TREE.padding + TREE.icon + 2 * TREE.gap);
  if (file === undefined) return { counts: false, name: left - TREE.chevron };
  const withCounts = left - factsWidth(file, true);
  return withCounts >= TREE.nameMin
    ? { counts: true, name: withCounts }
    : { counts: false, name: left - factsWidth(file, false) };
};

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
  return merged(kept(tree));
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

const stillTrue = (seen: ViewedTick | undefined, file: DiffFile, base: string) =>
  seen !== undefined &&
  seen.status === file.status &&
  seen.added === file.added &&
  seen.removed === file.removed &&
  seen.base === base;

export const viewedFiles = (
  ticks: ViewedTicks,
  files: ReadonlyArray<DiffFile>,
  base: string,
): ReadonlySet<string> =>
  new Set(
    files.flatMap((file) => (stillTrue(ticks.get(file.path), file, base) ? [file.path] : [])),
  );

/** The ticks the diff now shown still bears out; the rest are gone even if it changes back. */
export const ticksStillTrue = (
  ticks: ViewedTicks,
  files: ReadonlyArray<DiffFile>,
  base: string,
): ViewedTicks =>
  new Map(
    files.flatMap((file) => {
      const seen = ticks.get(file.path);
      return seen !== undefined && stillTrue(seen, file, base) ? [[file.path, seen] as const] : [];
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
