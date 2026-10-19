import { describe, expect, test } from "bun:test";
import {
  recordTabs,
  type SummaryFacts,
  summaryOf,
  type TabFacts,
  tabShown,
} from "../desktop/src/shared/record";

const everything: TabFacts = {
  loaded: true,
  plan: true,
  reviewText: true,
  findings: true,
  target: false,
  diff: true,
  terminal: true,
  mr: "MR !12",
};

const values = (facts: Partial<TabFacts>) =>
  recordTabs({ ...everything, ...facts }).map(({ value }) => value);

describe("the record's tabs", () => {
  test("for a Run with everything start with Summary and end with Facts", () => {
    expect(recordTabs(everything)).toEqual([
      { label: "Summary", value: "summary" },
      { label: "Plan", value: "plan" },
      { label: "Review", value: "review" },
      { label: "Diff", value: "diff" },
      { label: "Evidence", value: "evidence" },
      { label: "Log", value: "log" },
      { label: "Terminal", value: "terminal" },
      { label: "MR !12", value: "mr" },
      { label: "Facts", value: "facts" },
    ]);
  });

  test("leave out Plan and Diff where there are none", () => {
    expect(values({ plan: false, diff: false })).toEqual([
      "summary",
      "review",
      "evidence",
      "log",
      "terminal",
      "mr",
      "facts",
    ]);
  });

  test("keep Review for a followed target alone", () => {
    expect(values({ reviewText: false, findings: false })).not.toContain("review");
    expect(values({ reviewText: false, findings: false, target: true })).toContain("review");
  });

  test("are only Log, Terminal and Facts without the Run's details", () => {
    expect(
      values({
        loaded: false,
        plan: false,
        reviewText: false,
        findings: false,
        diff: false,
        mr: null,
      }),
    ).toEqual(["log", "terminal", "facts"]);
    expect(values({ loaded: false, target: true, terminal: false, mr: null })).toEqual([
      "log",
      "facts",
    ]);
  });
});

describe("the tab shown", () => {
  const tabs = recordTabs(everything);

  test("is Summary when none is chosen", () => {
    expect(tabShown(tabs, undefined)).toBe("summary");
  });

  test("is the chosen tab while it is present", () => {
    expect(tabShown(tabs, "diff")).toBe("diff");
  });

  test("falls back to the first tab when the chosen one goes", () => {
    expect(tabShown(recordTabs({ ...everything, diff: false }), "diff")).toBe("summary");
    expect(tabShown(recordTabs({ ...everything, loaded: false }), "plan")).toBe("log");
  });
});

describe("what the Summary shows", () => {
  const bare: SummaryFacts = {
    status: "running",
    attention: { category: "none", reason: "working", explanation: "It is working.", actions: [] },
    outcome: { kind: null, gaps: [], obstacle: null, next: null, delivered: null },
    steps: [],
    inputs: [],
  };
  const full: SummaryFacts = {
    status: "waiting",
    attention: {
      category: "question",
      reason: "decision",
      explanation: "The implementer asks which `base` to use.",
      actions: ["answer"],
    },
    outcome: {
      kind: "feature",
      gaps: ["check: bun run check"],
      obstacle: "A question is open.",
      next: "Answer it with `collie run answer`.",
      delivered: "Nothing yet.",
    },
    steps: [
      { id: "plan", status: "done", note: "3 tickets", took: "4m", agents: ["planner-r1"] },
      { id: "build", status: "running", note: "", took: null, agents: [] },
    ],
    inputs: [
      { name: "plan-dir", value: "/runs/r/plan", source: "given" },
      { name: "outcome", value: "feature", source: "inferred" },
    ],
  };

  test("for a full Run are status, attention, outcome, steps and Inputs, in order", () => {
    expect(summaryOf(full)).toEqual([
      { section: "status", status: "waiting" },
      {
        section: "attention",
        category: "question",
        explanation: "The implementer asks which `base` to use.",
      },
      {
        section: "outcome",
        kind: "feature",
        gaps: ["check: bun run check"],
        obstacle: "A question is open.",
        next: "Answer it with `collie run answer`.",
        delivered: "Nothing yet.",
      },
      {
        section: "steps",
        steps: [
          { id: "plan", status: "done", note: "3 tickets", took: "4m", agents: ["planner-r1"] },
          { id: "build", status: "running", note: "", took: null, agents: [] },
        ],
      },
      {
        section: "inputs",
        inputs: [
          { name: "plan-dir", value: "/runs/r/plan", source: "given" },
          { name: "outcome", value: "feature", source: "inferred" },
        ],
      },
    ]);
  });

  test("leave out attention whose category is none", () => {
    expect(summaryOf({ ...full, attention: bare.attention }).map(({ section }) => section)).toEqual(
      ["status", "outcome", "steps", "inputs"],
    );
  });

  test("keep an outcome with no gaps, with nothing to list", () => {
    const outcome = summaryOf({ ...full, outcome: { ...full.outcome, gaps: [] } }).find(
      ({ section }) => section === "outcome",
    );
    expect(outcome).toEqual({
      section: "outcome",
      kind: "feature",
      gaps: [],
      obstacle: "A question is open.",
      next: "Answer it with `collie run answer`.",
      delivered: "Nothing yet.",
    });
  });

  test("for a Run with only a status are its status", () => {
    expect(summaryOf(bare)).toEqual([{ section: "status", status: "running" }]);
  });
});
