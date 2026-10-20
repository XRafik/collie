// A merge request's review as a Release Run waits on it: one read of the forge, judged
// against the head the Run's Checks were proved on.

import { Schema } from "effect";
import type { ReviewRead } from "./forge/review";

/** An external comment nobody has answered yet. */
export const OpenCommentSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  author: Schema.String,
  at: Schema.String,
  body: Schema.String,
  thread: Schema.NullOr(Schema.String),
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Number),
});
export type OpenComment = typeof OpenCommentSchema.Type;

/**
 * Where the review stands. A wait returns every one but `Waiting` and `Unreadable`, which it
 * waits through; `Held` is a Hold or a Stop that ended the wait.
 */
export const ReviewStandingSchema = Schema.Union([
  Schema.TaggedStruct("Ready", { head: Schema.String, approvers: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Unanswered", {
    head: Schema.String,
    comments: Schema.Array(OpenCommentSchema),
  }),
  Schema.TaggedStruct("Moved", { head: Schema.String }),
  Schema.TaggedStruct("Merged", { sha: Schema.String, by: Schema.String, at: Schema.String }),
  Schema.TaggedStruct("Closed", {}),
  Schema.TaggedStruct("Held", {}),
  Schema.TaggedStruct("Waiting", { why: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Unreadable", { reason: Schema.String }),
]);
export type ReviewStanding = typeof ReviewStandingSchema.Type;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/**
 * Ready means approved, nothing external unanswered, the pipeline passed, mergeable, all at
 * `proved`. A moved head is checked first, so a new head that is ready still moved; a
 * comment already in `seen` keeps the wait waiting rather than returning it again.
 */
export function standingOf(
  read: ReviewRead,
  against: { readonly proved: string; readonly seen: ReadonlyArray<string> },
): ReviewStanding {
  if (!read.ok) return { _tag: "Unreadable", reason: read.reason };
  if (read.state === "merged")
    return {
      _tag: "Merged",
      sha: read.merged?.sha ?? "",
      by: read.merged?.by ?? "",
      at: read.merged?.at ?? "",
    };
  if (read.state === "closed") return { _tag: "Closed" };
  if (read.head !== against.proved) return { _tag: "Moved", head: read.head };
  const open = read.comments.filter((one) => one.external && !one.answered);
  const fresh = open.filter((one) => !against.seen.includes(one.id));
  if (fresh.length > 0)
    return {
      _tag: "Unanswered",
      head: read.head,
      comments: fresh.map(({ id, url, author, at, body, thread, file, line }) => ({
        id,
        url,
        author,
        at,
        body,
        thread,
        file,
        line,
      })),
    };
  const short = read.head.slice(0, 8);
  const why = [
    ...(read.approved ? [] : [`the approval (${read.unapproved || "none yet"})`]),
    ...(open.length === 0 ? [] : [plural(open.length, "unanswered comment")]),
    ...(read.pipeline.state === "passed" || read.pipeline.state === "none"
      ? []
      : read.pipeline.state === "failed"
        ? [`the pipeline at ${short}, whose ${read.pipeline.name} failed`]
        : [`the pipeline at ${short}`]),
    ...(read.mergeable?.state === "mergeable"
      ? []
      : [`mergeability (${read.mergeable?.said || "the forge has not said"})`]),
  ];
  return why.length === 0
    ? { _tag: "Ready", head: read.head, approvers: read.approvers }
    : { _tag: "Waiting", why };
}

/** The merge request's head, which of a round's commits it carries, and its open external comments. */
export const ReviewHeadSchema = Schema.Struct({
  head: Schema.String,
  carries: Schema.Array(Schema.String),
  open: Schema.Array(Schema.String),
});
export type ReviewHead = typeof ReviewHeadSchema.Type;

/** One comment a comment round answered: `fixed` in `commit`, or `disputed`. */
export const AnswerSchema = Schema.Struct({
  id: Schema.String.annotate({ description: "the comment's id, as given" }),
  answer: Schema.Literals(["fixed", "disputed"]),
  commit: Schema.optionalKey(Schema.String).annotate({
    description: "the pushed commit that fixes it, where fixed",
  }),
  note: Schema.String.annotate({
    description: "what the fix changed, or why nothing changed",
  }),
});
export type Answer = typeof AnswerSchema.Type;

/** The replies a round's answers earn, and the comments handed to the next round. */
export const SettledAnswersSchema = Schema.Struct({
  replies: Schema.Array(Schema.Struct({ id: Schema.String, body: Schema.String })),
  carried: Schema.Array(OpenCommentSchema),
});
export type SettledAnswers = typeof SettledAnswersSchema.Type;

/**
 * A `fixed` answer counts only where its commit is in `onHead`, the commits the merge
 * request's head carries by the forge's word; a comment no longer in `open` was answered on
 * the forge meanwhile. Everything else given is carried.
 */
export function settleAnswers(round: {
  readonly given: ReadonlyArray<OpenComment>;
  readonly answers: ReadonlyArray<Answer>;
  readonly onHead: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
}): SettledAnswers {
  const replies: Array<{ id: string; body: string }> = [];
  const carried: OpenComment[] = [];
  for (const comment of round.given.filter((one) => round.open.includes(one.id))) {
    const answer = round.answers.find((one) => one.id === comment.id);
    const says =
      answer?.answer === "disputed"
        ? `Not changed: ${answer.note}`
        : answer?.commit !== undefined && round.onHead.includes(answer.commit)
          ? `Fixed in \`${answer.commit.slice(0, 8)}\`: ${answer.note}`
          : null;
    if (says === null) carried.push(comment);
    else replies.push({ id: comment.id, body: `${comment.url}\n\n${says}` });
  }
  return { replies, carried };
}

/** The card's parked line while the wait waits. */
export const waitingLine = (mr: string, why: ReadonlyArray<string>) =>
  `Waiting for review of ${mr}: ${why.join("; ")}.`;
