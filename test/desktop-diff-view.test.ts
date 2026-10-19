import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../src/board-model";
import {
  activeFile,
  choiceForEvery,
  type DiffTreeNode,
  diffTree,
  filterTree,
  fileBeside,
  fileOpen,
  foldersOn,
  reachBy,
  readingHeight,
  rowFacts,
  tickViewed,
  untickViewed,
  viewedCount,
  viewedFiles,
} from "../desktop/src/shared/diff-view";

const file = (path: string): DiffFile => ({ path, status: "modified", added: 1, removed: 0 });

const depthFirst = (nodes: ReadonlyArray<DiffTreeNode>): ReadonlyArray<string> =>
  nodes.flatMap((node) => (node.kind === "file" ? [node.key] : depthFirst(node.children)));

describe("the diff's tree", () => {
  test("lists its files in the order the tree reads, around a folder sharing their prefix", () => {
    const { tree, files } = diffTree(
      ["a/b.ts", "a/b/c.ts", "a/b-c.ts", "a/b/d.ts", "a/b0.ts"].map(file),
    );
    expect(files.map(({ path }) => path)).toEqual([
      "a/b.ts",
      "a/b/c.ts",
      "a/b/d.ts",
      "a/b-c.ts",
      "a/b0.ts",
    ]);
    expect(depthFirst(tree)).toEqual(files.map(({ path }) => path));
    expect(tree.map(({ key }) => key)).toEqual(["a/"]);
  });
});

describe("the folders on a path", () => {
  test("are every folder above the file, outermost first", () => {
    expect(foldersOn("desktop/view/app/DiffTab.vue")).toEqual([
      "desktop/",
      "desktop/view/",
      "desktop/view/app/",
    ]);
  });

  test("are none for a file at the root", () => {
    expect(foldersOn("README.md")).toEqual([]);
  });
});

describe("the active file", () => {
  const LINE = 40;
  const drawn = [
    { path: "a.ts", top: -300, bottom: -20 },
    { path: "b.ts", top: -8, bottom: 500 },
    { path: "c.ts", top: 512, bottom: 900 },
  ];

  test("is the file whose section spans the reading line", () => {
    expect(activeFile({ sections: drawn, readingLine: LINE, atEnd: false, held: null })).toBe(
      "b.ts",
    );
  });

  const at = (over: Partial<Parameters<typeof activeFile>[0]>) =>
    activeFile({ sections: drawn, readingLine: LINE, atEnd: false, held: null, ...over });

  test("is the file above when the reading line falls in the gap between two", () => {
    expect(at({ readingLine: 505 })).toBe("b.ts");
  });

  test("is the first file while the reading line is above it", () => {
    expect(
      at({
        sections: drawn.map((section) => ({
          ...section,
          top: section.top + 400,
          bottom: section.bottom + 400,
        })),
      }),
    ).toBe("a.ts");
  });

  test("is the last file at the end of the scroll, though too short to reach the line", () => {
    const end = [...drawn, { path: "d.ts", top: 912, bottom: 950 }];
    expect(at({ sections: end, readingLine: 600 })).toBe("c.ts");
    expect(at({ sections: end, readingLine: 600, atEnd: true })).toBe("d.ts");
  });

  test("counts a collapsed file by its header", () => {
    const collapsed = [
      { path: "a.ts", top: -60, bottom: -20 },
      { path: "b.ts", top: -8, bottom: 32 },
      { path: "c.ts", top: 44, bottom: 84 },
    ];
    expect(at({ sections: collapsed, readingLine: 20 })).toBe("b.ts");
    expect(at({ sections: collapsed, readingLine: LINE })).toBe("b.ts");
    expect(at({ sections: collapsed, readingLine: 50 })).toBe("c.ts");
  });

  test("is the file a jump holds, whatever the geometry says", () => {
    expect(at({ held: "a.ts" })).toBe("a.ts");
    expect(at({ held: "a.ts", atEnd: true })).toBe("a.ts");
  });

  test("ignores a held file that is no longer drawn", () => {
    expect(at({ held: "gone.ts" })).toBe("b.ts");
  });

  test("is none when no file is drawn", () => {
    expect(at({ sections: [] })).toBeNull();
    expect(at({ sections: [], atEnd: true, held: "a.ts" })).toBeNull();
  });
});

describe("bringing the active row into the tree's reach", () => {
  const box = { top: 100, bottom: 400 };

  test("does not move a row already in view", () => {
    expect(reachBy(box, { top: 100, bottom: 128 })).toBe(0);
    expect(reachBy(box, { top: 372, bottom: 400 })).toBe(0);
  });

  test("scrolls just enough to the nearest edge", () => {
    expect(reachBy(box, { top: 60, bottom: 88 })).toBe(-40);
    expect(reachBy(box, { top: 450, bottom: 478 })).toBe(78);
  });
});

describe("a file being read", () => {
  test("holds about the height its changed lines draw", () => {
    expect(readingHeight({ ...file("a.ts"), added: 3, removed: 2 }, 1000)).toBe(100);
  });

  test("holds at most the record's visible area", () => {
    expect(readingHeight({ ...file("a.ts"), added: 400, removed: 0 }, 600)).toBe(600);
  });

  test("holds one line where nothing is counted", () => {
    expect(readingHeight({ ...file("empty.ts"), added: 0, removed: 0 }, 600)).toBe(20);
    expect(readingHeight({ ...file("logo.png"), added: null, removed: null }, 600)).toBe(20);
  });
});

describe("a file row's facts", () => {
  test("say an added, a deleted and a modified file's status and counts", () => {
    expect(rowFacts({ path: "new.ts", status: "added", added: 12, removed: 0 }, [])).toEqual({
      status: "added",
      lines: { added: 12, removed: 0 },
      drafts: 0,
    });
    expect(rowFacts({ path: "old.ts", status: "deleted", added: 0, removed: 7 }, [])).toEqual({
      status: "deleted",
      lines: { added: 0, removed: 7 },
      drafts: 0,
    });
    expect(rowFacts({ path: "a.ts", status: "modified", added: 3, removed: 2 }, [])).toEqual({
      status: "modified",
      lines: { added: 3, removed: 2 },
      drafts: 0,
    });
  });

  test("say binary for a file without counts", () => {
    expect(
      rowFacts({ path: "logo.png", status: "modified", added: null, removed: null }, []).lines,
    ).toBe("binary");
  });

  test("count the drafts on the file", () => {
    const drafts = ["a.ts", "b.ts", "a.ts"];
    expect(rowFacts(file("a.ts"), drafts).drafts).toBe(2);
    expect(rowFacts(file("c.ts"), drafts).drafts).toBe(0);
  });
});

describe("the tree filtered by a path", () => {
  const { tree } = diffTree(
    ["src/ui/Board.tsx", "src/ui/Drawer.tsx", "src/host.ts", "docs/using.md"].map(file),
  );
  const kept = (text: string) => depthFirst(filterTree(tree, text));

  test("keeps every file under a matching folder, and their folders", () => {
    const narrowed = filterTree(tree, "ui/");
    expect(depthFirst(narrowed)).toEqual(["src/ui/Board.tsx", "src/ui/Drawer.tsx"]);
    expect(narrowed.map(({ key }) => key)).toEqual(["src/"]);
  });

  test("keeps a matching file's folders", () => {
    const narrowed = filterTree(tree, "host");
    expect(depthFirst(narrowed)).toEqual(["src/host.ts"]);
    expect(narrowed).toEqual([
      expect.objectContaining({
        key: "src/",
        children: [expect.objectContaining({ key: "src/host.ts" })],
      }),
    ]);
  });

  test("ignores case", () => {
    expect(kept("BOARD")).toEqual(["src/ui/Board.tsx"]);
  });

  test("keeps nothing when nothing matches", () => {
    expect(filterTree(tree, "nowhere")).toEqual([]);
  });

  test("keeps everything when empty", () => {
    expect(filterTree(tree, "")).toEqual(tree);
    expect(filterTree(tree, "  ")).toEqual(tree);
  });
});

describe("whether a file is open", () => {
  const counted = (path: string, added: number, removed: number): DiffFile => ({
    path,
    status: "modified",
    added,
    removed,
  });
  const binary: DiffFile = { path: "logo.png", status: "modified", added: null, removed: null };
  const none = new Map<string, boolean>();

  test("is open by default for a text file of at most 500 changed lines", () => {
    expect(fileOpen(counted("a.ts", 300, 200), none)).toBe(true);
    expect(fileOpen(counted("a.ts", 0, 0), none)).toBe(true);
  });

  test("starts collapsed for a file of 501 changed lines, or a binary one", () => {
    expect(fileOpen(counted("a.ts", 301, 200), none)).toBe(false);
    expect(fileOpen(binary, none)).toBe(false);
  });

  test("is the human's own choice where there is one", () => {
    expect(fileOpen(counted("a.ts", 1, 0), new Map([["a.ts", false]]))).toBe(false);
    expect(fileOpen(counted("a.ts", 900, 0), new Map([["a.ts", true]]))).toBe(true);
    expect(fileOpen(binary, new Map([["logo.png", true]]))).toBe(true);
  });

  const files = [counted("small.ts", 1, 1), counted("big.ts", 600, 0), binary];
  const openAfter = (choices: ReadonlyMap<string, boolean>, shown = files) =>
    shown.map((shownFile) => fileOpen(shownFile, choices));

  test("is every file, big and binary ones too, after Expand all", () => {
    expect(openAfter(choiceForEvery(files, true))).toEqual([true, true, true]);
  });

  test("is no file after Collapse all", () => {
    expect(openAfter(choiceForEvery(files, false))).toEqual([false, false, false]);
  });

  test("is a single choice made after Expand all", () => {
    const choices = new Map(choiceForEvery(files, true)).set("big.ts", false);
    expect(openAfter(choices)).toEqual([true, false, true]);
  });

  test("follows the default rule for a file that arrives after Expand all", () => {
    const choices = choiceForEvery(files, true);
    const arrived = [counted("new.ts", 2, 0), counted("huge.ts", 501, 0)];
    expect(openAfter(choices, [...files, ...arrived])).toEqual([true, true, true, true, false]);
  });
});

describe("the file beside the active one", () => {
  const files = ["a.ts", "b.ts", "c.ts"].map(file);

  test("steps in drawn order", () => {
    expect(fileBeside(files, "a.ts", 1)).toBe("b.ts");
    expect(fileBeside(files, "c.ts", -1)).toBe("b.ts");
  });

  test("stops at the first and last file", () => {
    expect(fileBeside(files, "a.ts", -1)).toBeNull();
    expect(fileBeside(files, "c.ts", 1)).toBeNull();
  });

  test("is the first file while none is active", () => {
    expect(fileBeside(files, null, 1)).toBe("a.ts");
    expect(fileBeside(files, null, -1)).toBe("a.ts");
  });

  test("is nothing with no files", () => {
    expect(fileBeside([], null, 1)).toBeNull();
    expect(fileBeside([], "a.ts", -1)).toBeNull();
  });
});

describe("viewed ticks", () => {
  const base = "abc1234";
  const a: DiffFile = { path: "a.ts", status: "modified", added: 3, removed: 1 };
  const b: DiffFile = { path: "b.ts", status: "added", added: 9, removed: 0 };
  const logo: DiffFile = { path: "logo.png", status: "modified", added: null, removed: null };
  const none = new Map();
  const viewed = (
    ticks: Parameters<typeof viewedFiles>[0],
    files: ReadonlyArray<DiffFile>,
    at = base,
  ) => [...viewedFiles(ticks, files, at)];

  test("survive a refresh with the same values", () => {
    const ticks = tickViewed(none, a, base);
    expect(viewed(ticks, [{ ...a }, b])).toEqual(["a.ts"]);
  });

  test("are lost when the added or removed count, the status or the base changes", () => {
    const ticks = tickViewed(none, a, base);
    expect(viewed(ticks, [{ ...a, added: 4 }])).toEqual([]);
    expect(viewed(ticks, [{ ...a, removed: 2 }])).toEqual([]);
    expect(viewed(ticks, [{ ...a, status: "added" }])).toEqual([]);
    expect(viewed(ticks, [a], "def5678")).toEqual([]);
  });

  test("count N of M, ignoring ticks for files no longer in the diff", () => {
    const ticks = tickViewed(tickViewed(none, a, base), b, base);
    expect(viewedCount(ticks, [a, b, logo], base)).toBe("2 of 3 viewed");
    expect(viewedCount(ticks, [b, logo], base)).toBe("1 of 2 viewed");
  });

  test("tick a binary file like any other", () => {
    const ticks = tickViewed(none, logo, base);
    expect(viewed(ticks, [logo])).toEqual(["logo.png"]);
    expect(viewed(ticks, [{ ...logo, added: 2, removed: 0 }])).toEqual([]);
  });

  test("untick a file", () => {
    const ticks = untickViewed(tickViewed(tickViewed(none, a, base), b, base), "a.ts");
    expect(viewed(ticks, [a, b])).toEqual(["b.ts"]);
    expect(viewedCount(ticks, [a, b], base)).toBe("1 of 2 viewed");
  });
});
