import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../src/board-model";
import {
  activeFile,
  type DiffTreeNode,
  diffTree,
  foldersOn,
  reachBy,
  readingHeight,
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
