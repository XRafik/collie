// One read of a merge request's review, judged against the head a Release Run proved.

import { expect, test } from "bun:test";
import type { ReviewComment, ReviewRead } from "../src/forge/review";
import { standingOf, waitingLine } from "../src/review-wait";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const MOVED = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const read = (over: Partial<Extract<ReviewRead, { ok: true }>> = {}): ReviewRead => ({
  ok: true,
  login: "collie",
  state: "open",
  head: HEAD,
  merged: null,
  approved: true,
  unapproved: "",
  approvers: ["alice"],
  changesRequested: false,
  mergeable: { state: "mergeable", said: "mergeable" },
  pipeline: { state: "passed" },
  comments: [],
  ...over,
});

const comment = (id: string, over: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  url: `https://gitlab.example.com/group/app/-/merge_requests/30#note_${id}`,
  thread: null,
  author: "bob",
  kind: "person",
  at: "2026-10-20T11:00:00Z",
  body: "rename this",
  file: null,
  line: null,
  external: true,
  answered: false,
  ...over,
});

const at = { proved: HEAD, seen: [] };

test("an approved, answered, green and mergeable merge request at the proved head is ready", () => {
  expect(standingOf(read(), at)).toEqual({ _tag: "Ready", head: HEAD, approvers: ["alice"] });
});

test("a moved head is moved before it is anything else, even approved and green", () => {
  expect(standingOf(read({ head: MOVED }), at)).toEqual({ _tag: "Moved", head: MOVED });
  expect(standingOf(read({ head: MOVED, comments: [comment("1")] }), at)._tag).toBe("Moved");
});

test("merged and closed are said whatever the head", () => {
  const merged = { sha: "35ae2cea", by: "alice", at: "2026-10-20T11:30:00Z" };
  expect(standingOf(read({ state: "merged", head: MOVED, merged }), at)).toEqual({
    _tag: "Merged",
    ...merged,
  });
  expect(standingOf(read({ state: "closed" }), at)).toEqual({ _tag: "Closed" });
});

test("only an unanswered external comment not seen before is returned", () => {
  const comments = [
    comment("1"),
    comment("2", { answered: true }),
    comment("3", { external: false }),
  ];
  expect(standingOf(read({ comments }), at)).toEqual({
    _tag: "Unanswered",
    head: HEAD,
    comments: [
      {
        id: "1",
        url: comments[0]!.url,
        author: "bob",
        at: "2026-10-20T11:00:00Z",
        body: "rename this",
        thread: null,
        file: null,
        line: null,
      },
    ],
  });
  expect(standingOf(read({ comments }), { proved: HEAD, seen: ["1"] })).toEqual({
    _tag: "Waiting",
    why: ["1 unanswered comment"],
  });
});

test("what is missing is said, every piece of it", () => {
  expect(
    standingOf(
      read({
        approved: false,
        unapproved: "1 of 2 approvals",
        pipeline: { state: "failed", name: "lint" },
        mergeable: { state: "blocked", said: "conflict" },
      }),
      at,
    ),
  ).toEqual({
    _tag: "Waiting",
    why: [
      "the approval (1 of 2 approvals)",
      "the pipeline at 1a2b3c4d, whose lint failed",
      "mergeability (conflict)",
    ],
  });
  expect(standingOf(read({ pipeline: { state: "running" }, mergeable: null }), at)).toEqual({
    _tag: "Waiting",
    why: ["the pipeline at 1a2b3c4d", "mergeability (the forge has not said)"],
  });
});

test("a repository with no pipeline has none to wait for", () => {
  expect(standingOf(read({ pipeline: { state: "none" } }), at)._tag).toBe("Ready");
});

test("a forge that cannot be read is said, and the line names the merge request", () => {
  expect(standingOf({ ok: false, reason: "glab is not logged in" }, at)).toEqual({
    _tag: "Unreadable",
    reason: "glab is not logged in",
  });
  expect(waitingLine("https://x/-/merge_requests/30", ["the approval (none yet)"])).toBe(
    "Waiting for review of https://x/-/merge_requests/30: the approval (none yet).",
  );
});
