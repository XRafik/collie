// The board's model is imported by a browser bundle as well as by the host, so it must
// bundle for a browser and load in a context that has no runtime to reach.

import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Effect, Schema } from "effect";
import {
  cardActions,
  mrUrlOf,
  mrWords,
  openMrLabel,
  primaryAction,
  readMrRef,
  RunDetail,
  TaskView,
} from "../src/board-model";
import { task } from "./support/task";

const MODULE = new URL("../src/board-model.ts", import.meta.url).pathname;
const RUNTIME_ONLY = /^(bun(:|$)|node:|@effect\/platform-bun|@opentui\/)/;

/** The module bundled for a browser, and every runtime-only import the bundle reached. */
const bundled = Effect.gen(function* () {
  const reached: string[] = [];
  const built = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [MODULE],
      target: "browser",
      format: "iife",
      plugins: [
        {
          name: "runtime-only",
          setup(build) {
            build.onResolve({ filter: RUNTIME_ONLY }, (args) => {
              reached.push(`${args.importer} imports ${args.path}`);
              return undefined;
            });
          },
        },
      ],
    }),
  );
  const errors = built.logs.filter((log) => log.level === "error");
  const code = built.success ? yield* Effect.promise(() => built.outputs[0]!.text()) : "";
  return { errors, reached, code };
});

test("the board model bundles for a browser without a Bun-only import", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { errors, reached, code } = yield* bundled;
      expect(errors).toEqual([]);
      expect(reached).toEqual([]);
      expect(code).not.toMatch(/\bBun\./);
    }),
  ));

test("loading the board model does nothing but define it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { code } = yield* bundled;
      // Only what a browser has that reaches nothing: process, timers, fetch or console at
      // load throws here. Bun's contexts carry a console of their own, so it is blanked.
      const sandbox = { TextEncoder, TextDecoder, console: undefined };
      expect(() => runInNewContext(code, sandbox)).not.toThrow();
      expect(Object.keys(sandbox)).toEqual(["TextEncoder", "TextDecoder", "console"]);
    }),
  ));

test("a TaskView and a RunDetail survive a round trip through JSON", () => {
  const view: TaskView = {
    id: "task-1",
    name: "Pure board module",
    project: "/work/collie",
    state: "blocked",
    steps: [{ name: "build", state: "blocked" }],
    sentence: "Waiting on your answer about the branch.",
    age: "2m",
    drift: null,
    held: null,
    heldBy: null,
    decision: {
      kind: "question",
      run: "run-1",
      id: "c-1",
      step: "build",
      topic: "the branch",
      text: "Which branch?",
      options: [{ id: "main", title: "main", subtitle: null }],
    },
    agents: [{ name: "implementer", status: "working", now: null, run: "run-1" }],
    children: [{ repo: "api", run: null, state: "todo", mr: null }],
    mr: null,
    branch: "mk/board",
    disposition: null,
    landed: false,
    ended: null,
    mrState: "on-stage",
    planReady: false,
    offer: { id: "implement", title: "Implement it" },
    run: "run-1",
    runs: ["run-1"],
    at: 1_700_000_000_000,
  };
  const json = Schema.toCodecJson(TaskView);
  expect(Schema.decodeUnknownSync(json)(JSON.parse(JSON.stringify(view)))).toEqual(view);

  const detail: RunDetail = {
    id: "run-1",
    dir: "/state/runs/run-1",
    title: "Pure board module",
    status: "running",
    inputs: [{ name: "plan", value: "/plans/x", source: "flag" }],
    steps: [{ id: "build", status: "running", note: "", took: null, agents: ["implementer"] }],
    handoffs: [],
    intent: { goal: "One module", constraints: [] },
    review: { _tag: "None", reason: "no review yet" },
    plan: {
      spec: { _tag: "Text", text: "# Spec", truncated: false },
      tickets: [{ file: "01-a.md", title: "A", done: false }],
    },
    outputs: [{ step: "build", where: "out.json", state: "missing", text: "" }],
    tail: null,
    attention: { category: "none", reason: "running", explanation: "", actions: [] },
    outcome: {
      kind: null,
      gaps: [],
      obstacle: null,
      next: null,
      delivered: null,
      metrics: {
        timeToFirstEvidence: null,
        verifications: { pass: 0, fail: 0, unstable: 0, byCollie: 0 },
        slices: { done: 0, total: 1 },
        rework: 0,
        peakContext: null,
        halts: [],
        obstacles: [],
      },
    },
    finishedAt: 0,
    mr: { _tag: "Unavailable", reason: "no glab" },
    findings: [{ severity: "major", title: "Off by one", file: "a.ts", line: 3, detail: null }],
    verifications: [
      { id: "v1", name: "test", result: "pass", expect: "pass", exit: 0, at: "t", by: "collie" },
    ],
    steering: [],
    evidence: [{ name: "shot.png", bytes: 3 }],
    diff: {
      base: "abc",
      live: true,
      files: [{ path: "a.ts", status: "modified", added: 1, removed: null }],
    },
  };
  expect(
    Schema.decodeUnknownSync(Schema.toCodecJson(RunDetail))(JSON.parse(JSON.stringify(detail))),
  ).toEqual(detail);
});

const LAB = "gitlab.cego.dk/cego/app";
const HUB = "github.com/cego/collie";
const GITLAB_42 = {
  ref: { project: LAB, iid: "42" },
  target: `mr:${LAB}!42`,
  label: "cego/app!42",
  short: "app!42",
  url: `https://${LAB}/-/merge_requests/42`,
  noun: "merge request",
  checks: "pipeline",
  sign: "!",
};
const GITHUB_30 = {
  ref: { project: HUB, iid: "30" },
  target: `mr:${HUB}#30`,
  label: "cego/collie#30",
  short: "collie#30",
  url: `https://${HUB}/pull/30`,
  noun: "pull request",
  checks: "checks",
  sign: "#",
};

test.each([
  ["a GitLab target", `mr:${LAB}!42`, undefined, GITLAB_42],
  ["a GitLab URL", `https://${LAB}/-/merge_requests/42/diffs?tab=x`, undefined, GITLAB_42],
  ["a GitLab URL without its scheme", `${LAB}/-/merge_requests/42`, undefined, GITLAB_42],
  ["a typed !iid", "!42", { project: LAB }, GITLAB_42],
  ["a typed iid", " 42 ", { project: LAB }, GITLAB_42],
  ["a typed #iid in a GitLab checkout", "#42", { project: LAB }, GITLAB_42],
  ["a GitHub target", `mr:${HUB}#30`, undefined, GITHUB_30],
  ["a GitHub URL", `https://${HUB}/pull/30/files`, undefined, GITHUB_30],
  ["a typed #number", "#30", { project: HUB }, GITHUB_30],
  ["a typed number", "30", { project: HUB }, GITHUB_30],
  [
    "the old bare target",
    "mr:42",
    undefined,
    {
      ref: { project: null, iid: "42" },
      target: "mr:42",
      label: "42",
      short: "!42",
      url: null,
      noun: "merge request",
      checks: "pipeline",
      sign: "!",
    },
  ],
  ["GitHub's owner/repo#n", "cego/collie#30", undefined, GITHUB_30],
])("%s reads as one merge request and writes back", (_, text, typedIn, want) => {
  const ref = readMrRef(text, typedIn);
  expect(ref).toEqual(want.ref);
  const { ref: _ref, ...words } = want;
  expect(mrWords(ref!)).toEqual(words);
});

test.each([
  ["a URL on neither forge", "https://bitbucket.org/cego/app/pull-requests/3"],
  ["a pull URL off github.com", "https://example.com/cego/app/pull/3"],
  ["a GitHub URL that is not a pull request", `https://${HUB}/issues/3`],
  ["a target with no number", `mr:${LAB}`],
  ["a GitHub target written as GitLab's", `mr:${HUB}!30`],
  ["a GitLab target written as GitHub's", `mr:${LAB}#42`],
  ["a typed number nobody said was typed", "42"],
  ["a branch", "branch:main...x"],
])("%s is not a merge request", (_, text) => {
  expect(readMrRef(text)).toBeNull();
});

test.each([
  {
    mr: "https://github.com/cego/collie/pull/30",
    url: "https://github.com/cego/collie/pull/30",
    open: ["Open PR", "Open pull request"],
    ref: "collie#30",
  },
  {
    mr: "https://gitlab.cego.dk/cego/collie/-/merge_requests/151",
    url: "https://gitlab.cego.dk/cego/collie/-/merge_requests/151",
    open: ["Open MR", "Open merge request"],
    ref: "collie!151",
  },
])("a card offers to open $mr, and disposing of it records $ref", ({ mr, url, open, ref }) => {
  const waiting = task({ state: "done", landed: false, mr });
  const action = primaryAction(waiting);
  expect(action?.kind).toBe("open-mr");
  if (action?.kind !== "open-mr") return;
  expect(mrUrlOf(action.mr)).toBe(url);
  expect([openMrLabel(action.mr, true), openMrLabel(action.mr, false)]).toEqual([...open]);
  expect(cardActions(waiting).some((one) => one.kind === "open-mr")).toBe(true);
  expect(primaryAction({ ...waiting, mrState: "closed" })).toEqual({
    kind: "dispose",
    disposition: "superseded",
    ref,
  });
});
