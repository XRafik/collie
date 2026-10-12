// Review comments: a Run's drafts, where each is about, and the one message they become.

import { expect, test } from "bun:test";
import {
  addDraft,
  clearSent,
  compose,
  type Draft,
  editDraft,
  planAnchor,
  removeDraft,
} from "../src/shared/review-comments";

const plan = (id: string, file: string, quote: string, text: string): Draft => ({
  id,
  anchor: { _tag: "Plan", file, quote },
  text,
});

test("a selection that is empty or only whitespace is no anchor", () => {
  expect(planAnchor("SPEC.md", "")).toBeNull();
  expect(planAnchor("SPEC.md", " \n\t ")).toBeNull();
  expect(planAnchor("issues/01-a.md", "  the words  ")).toEqual({
    _tag: "Plan",
    file: "issues/01-a.md",
    quote: "  the words  ",
  });
});

test("drafts are added in order, edited and removed by id", () => {
  const one = plan("a", "SPEC.md", "x", "first");
  const two = plan("b", "SPEC.md", "y", "second");
  const drafts = addDraft(addDraft([], one), two);
  expect(drafts.map((draft) => draft.id)).toEqual(["a", "b"]);
  expect(editDraft(drafts, "b", "sharper")[1]!.text).toBe("sharper");
  expect(removeDraft(drafts, "a")).toEqual([two]);
});

test("a send clears only the drafts it carried", () => {
  const drafts = [plan("a", "SPEC.md", "x", "1"), plan("b", "SPEC.md", "y", "2")];
  const meanwhile = plan("c", "SPEC.md", "z", "3");
  expect(clearSent([...drafts, meanwhile], new Set(["a", "b"]))).toEqual([meanwhile]);
});

test("the message numbers each comment in the order written, with its place, quote and words", () => {
  const words = "Drop this.\n\n  Keep *that*, exactly as I typed it  ";
  expect(
    compose([
      plan("a", "SPEC.md", "The tab reads\nthe files again", "Is this true?"),
      plan("b", "issues/02-plan.md", "stamp", words),
    ]),
  ).toBe(
    [
      "2 review comments from the human in Desktop. Each names where it is, quotes what it is about, then says what they want.",
      "",
      "1. the plan's `SPEC.md`",
      "> The tab reads",
      "> the files again",
      "",
      "Is this true?",
      "",
      "2. the plan's `issues/02-plan.md`",
      "> stamp",
      "",
      words,
    ].join("\n"),
  );
});

test("one comment is said as one", () => {
  expect(compose([plan("a", "SPEC.md", "q", "c")]).split("\n")[0]).toBe(
    "1 review comment from the human in Desktop. Each names where it is, quotes what it is about, then says what they want.",
  );
});

test("a long quote keeps its start and end, 300 characters in all", () => {
  const quote = `${"a".repeat(200)}${"b".repeat(200)}`;
  const said = compose([plan("a", "SPEC.md", quote, "c")]).split("\n")[3]!;
  expect(said).toBe(`> ${"a".repeat(150)}…${"b".repeat(149)}`);
  const short = "c".repeat(300);
  expect(compose([plan("a", "SPEC.md", short, "c")]).split("\n")[3]).toBe(`> ${short}`);
});
