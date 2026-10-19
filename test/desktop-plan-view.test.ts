import { describe, expect, test } from "bun:test";
import { planProgress, specHeadings } from "../desktop/src/shared/plan-view";

describe("the plan's progress", () => {
  test("is nothing without tickets", () => {
    expect(planProgress([])).toBeNull();
  });

  test("counts the tickets done", () => {
    expect(planProgress([{ done: true }, { done: false }, { done: false }])).toBe(
      "1 of 3 tickets done",
    );
  });

  test("counts every ticket when all are done", () => {
    expect(planProgress([{ done: true }, { done: true }])).toBe("2 of 2 tickets done");
  });
});

const texts = (spec: string) => specHeadings(spec).map(({ text }) => text);

describe("the spec's headings", () => {
  test("are ATX headings at each level, trailing #s trimmed", () => {
    expect(
      specHeadings(
        [
          "# One #",
          "## Two ##",
          "   ### Three",
          "#### Four ####   ",
          "##### Five",
          "###### Six #",
          "####### Seven",
          "#Not",
          "# a # b #",
        ].join("\n"),
      ),
    ).toEqual([
      { level: 1, text: "One", position: 0 },
      { level: 2, text: "Two", position: 1 },
      { level: 3, text: "Three", position: 2 },
      { level: 4, text: "Four", position: 3 },
      { level: 5, text: "Five", position: 4 },
      { level: 6, text: "Six", position: 5 },
      { level: 1, text: "a # b", position: 6 },
    ]);
  });

  test("are setext headings, = for level 1 and - for level 2", () => {
    expect(specHeadings("Title\n=====\n\nSome\nlines\n---\n\n---\n- item\n---\n")).toEqual([
      { level: 1, text: "Title", position: 0 },
      { level: 2, text: "Some lines", position: 1 },
    ]);
  });

  test("skip heading-like lines inside fenced code and indented four spaces", () => {
    expect(
      texts(
        [
          "# Before",
          "```md",
          "# In backticks",
          "~~~",
          "# Still in backticks",
          "```",
          "~~~~",
          "## In tildes",
          "```",
          "~~~~",
          "    # Indented",
          "Para",
          "    ---",
          "# After",
        ].join("\n"),
      ),
    ).toEqual(["Before", "After"]);
  });

  test("drop the marks of inline code, emphasis and links", () => {
    expect(
      texts(
        "## The `plan-view` **module** and _its_ [tests](test/x.ts)\n# ~~Old~~ *new* ![logo](a.png) snake_case_name",
      ),
    ).toEqual(["The plan-view module and its tests", "Old new logo snake_case_name"]);
  });

  test("are counted across all levels", () => {
    expect(
      specHeadings("# A\n#### deep\n## B\n###### deeper\n### C").map(({ level, position }) => [
        level,
        position,
      ]),
    ).toEqual([
      [1, 0],
      [4, 1],
      [2, 2],
      [6, 3],
      [3, 4],
    ]);
  });

  test("leave out front matter, which is not rendered", () => {
    expect(texts("---\ntitle: x\n---\n\n# A\n")).toEqual(["A"]);
  });
});
