// A Task's record: its tabs, the one shown, and what its Summary says.

import type { RunDetail } from "../../../src/board-model";

export interface TabFacts {
  /** Whether the Run's details are loaded; every tab but Log, Terminal and Facts needs them. */
  readonly loaded: boolean;
  readonly plan: boolean;
  readonly reviewText: boolean;
  readonly findings: boolean;
  /** A followed location, which Review shows read-only where there is no diff. */
  readonly target: boolean;
  readonly diff: boolean;
  readonly terminal: boolean;
  /** The merge request's tab label, where there is one. */
  readonly mr: string | null;
}

export interface Tab {
  readonly label: string;
  readonly value: string;
}

export const recordTabs = (facts: TabFacts): Array<Tab> => {
  const loaded = facts.loaded;
  const present: ReadonlyArray<readonly [boolean, Tab]> = [
    [loaded, { label: "Summary", value: "summary" }],
    [loaded && facts.plan, { label: "Plan", value: "plan" }],
    [
      loaded && (facts.reviewText || facts.findings || facts.target),
      { label: "Review", value: "review" },
    ],
    [loaded && facts.diff, { label: "Diff", value: "diff" }],
    [loaded, { label: "Evidence", value: "evidence" }],
    [true, { label: "Log", value: "log" }],
    [facts.terminal, { label: "Terminal", value: "terminal" }],
    [loaded && facts.mr !== null, { label: facts.mr ?? "", value: "mr" }],
    [true, { label: "Facts", value: "facts" }],
  ];
  return present.flatMap(([shown, tab]) => (shown ? [tab] : []));
};

/** The chosen tab while it is present, else the first. */
export const tabShown = (tabs: ReadonlyArray<Tab>, chosen: string | undefined): string =>
  (tabs.find(({ value }) => value === chosen) ?? tabs[0]!).value;

export type SummaryFacts = Pick<RunDetail, "status" | "attention" | "steps" | "inputs"> & {
  readonly outcome: Omit<RunDetail["outcome"], "metrics">;
};

type Outcome = SummaryFacts["outcome"];

export type SummarySection =
  | { readonly section: "status"; readonly status: string }
  | {
      readonly section: "attention";
      readonly category: RunDetail["attention"]["category"];
      readonly explanation: string;
    }
  | ({ readonly section: "outcome" } & Outcome)
  | { readonly section: "steps"; readonly steps: RunDetail["steps"] }
  | { readonly section: "inputs"; readonly inputs: RunDetail["inputs"] };

const saysSomething = ({ kind, gaps, obstacle, next, delivered }: Outcome) =>
  gaps.length > 0 || [kind, obstacle, next, delivered].some((said) => said !== null);

/** In order, each left out when it has nothing to say; the status always says something. */
export const summaryOf = (detail: SummaryFacts): ReadonlyArray<SummarySection> => {
  const { kind, gaps, obstacle, next, delivered } = detail.outcome;
  const { category, explanation } = detail.attention;
  return [
    { section: "status", status: detail.status },
    ...(category === "none" ? [] : [{ section: "attention", category, explanation } as const]),
    ...(saysSomething(detail.outcome)
      ? [{ section: "outcome", kind, gaps, obstacle, next, delivered } as const]
      : []),
    ...(detail.steps.length === 0 ? [] : [{ section: "steps", steps: detail.steps } as const]),
    ...(detail.inputs.length === 0 ? [] : [{ section: "inputs", inputs: detail.inputs } as const]),
  ];
};
