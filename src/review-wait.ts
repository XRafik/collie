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

/** The card's parked line while the wait waits. */
export const waitingLine = (mr: string, why: ReadonlyArray<string>) =>
  `Waiting for review of ${mr}: ${why.join("; ")}.`;
