// A board answer shows as pending, in place of the question's controls, until the host's
// board no longer has that question open.

import { expect, test } from "bun:test";
import type { Decision } from "../src/board-model";
import {
  answerShown,
  answerTried,
  pendingAnswers,
  type PendingAnswer,
} from "../desktop/src/shared/pending-answer";

const question = (id: string, run = "r-1"): Decision => ({
  kind: "question",
  run,
  id,
  step: "plan",
  topic: "next",
  text: "What next?",
  options: [],
});

const sending: PendingAnswer = {
  runId: "r-1",
  decision: "next-1",
  shown: "Ship it",
  machine: "vm-mk",
  confirmed: false,
};

test("an answer is sending, then waits for the board once confirmed, and clears when the question is gone", () => {
  expect(answerShown(sending, question("next-1"))).toBe("Sending Ship it to vm-mk…");
  expect(answerShown({ ...sending, confirmed: true }, question("next-1"))).toBe(
    "Answered Ship it; waiting for vm-mk's board",
  );
  expect(answerShown({ ...sending, confirmed: true }, null)).toBeNull();
});

test("no pending answer, as after a refusal, offers the question's controls", () => {
  expect(answerShown(null, question("next-1"))).toBeNull();
});

test("another question on the same Run, or the same id on another Run, clears it", () => {
  expect(answerShown(sending, question("next-2"))).toBeNull();
  expect(answerShown(sending, question("next-1", "r-2"))).toBeNull();
});

test("each try sends the answer again, a reply confirms it, and a failure gives the controls back", () => {
  expect(answerTried(sending, null)).toEqual(sending);
  expect(answerTried(sending, true)).toEqual({ ...sending, confirmed: true });
  expect(answerTried(sending, false)).toBeNull();
});

test("a try of an earlier answer, as its Try again after a newer one is sent, leaves the newer one shown", () => {
  const shown: Array<PendingAnswer | null> = [];
  const begin = pendingAnswers((pending) => shown.push(pending));
  const first = begin(sending);
  first(null);
  first(false);
  expect(shown.at(-1)).toBeNull();
  const newer = { ...sending, shown: "Hold it" };
  begin(newer)(null);
  first(null);
  first(true);
  expect(shown.at(-1)).toEqual(newer);
});
