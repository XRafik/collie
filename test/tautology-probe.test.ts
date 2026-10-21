// The live probe's verdict is only as good as how it reads a reviewer's findings against
// the fixture's key: these pin that reading, so the probe can be trusted when it is red.

import { expect, test } from "bun:test";
import { scored, type KeyItem } from "../tools/tautology-probe";

const restated: KeyItem = {
  id: "test-restates",
  kind: "test that restates the implementation",
  tautology: true,
  file: "repo/test/duration.test.ts",
  lines: [10, 14],
};
const honest: KeyItem = {
  id: "honest-test",
  kind: "honest test",
  tautology: false,
  file: "repo/test/duration.test.ts",
  lines: [20, 24],
};
const key = [restated, honest];

test("a finding on a Tautology's lines counts it raised", () => {
  const run = [{ file: "test/duration.test.ts", line: 12 }];
  expect(scored([run, run, run], key)).toEqual({ missed: [], falselyRaised: [] });
});

test("a finding on an honest item's lines is a false raise", () => {
  const run = [
    { file: "test/duration.test.ts", line: 11 },
    { file: "test/duration.test.ts", line: 20 },
  ];
  expect(scored([run, run, run], key)).toEqual({ missed: [], falselyRaised: [honest] });
});

test("a finding on another file or another line counts for neither", () => {
  const run = [
    { file: "test/timeout.test.ts", line: 12 },
    { file: "test/duration.test.ts", line: 17 },
    { file: "test/duration.test.ts" },
    { line: 21 },
  ];
  expect(scored([run, run, run], key)).toEqual({ missed: [restated], falselyRaised: [] });
});

test("an item raised in one run out of three is not raised", () => {
  const raisedBoth = [
    { file: "test/duration.test.ts", line: 12 },
    { file: "test/duration.test.ts", line: 22 },
  ];
  expect(scored([raisedBoth, [], []], key)).toEqual({ missed: [restated], falselyRaised: [] });
});
