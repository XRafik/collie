// What a Release Run has the host do to its checkout and read of its tag: bring the
// checkout to the merge request's head without discarding anything, and prove a tag
// from origin and the forge rather than from an Output.

import { Effect, Schema } from "effect";
import { forgeOfUrl } from "./forge/forge";
import { whatItSaid, type Runner } from "./mr";
import { appendLog } from "./oversight";

const short = (sha: string) => sha.slice(0, 8);

/** Where a fast-forward left the checkout, or why it left it alone. */
export const FastForwardSchema = Schema.Union([
  Schema.TaggedStruct("At", { head: Schema.String, from: Schema.String }),
  Schema.TaggedStruct("Refused", { why: Schema.String }),
]);
export type FastForward = typeof FastForwardSchema.Type;

/**
 * Fetches origin and fast-forwards the checkout at `cwd` to `head`, recording the move in
 * the Run's log. Uncommitted changes, or a head that does not fast-forward, are refused:
 * nothing is reset or discarded.
 */
export const fastForward = Effect.fn("Releasing.fastForward")(function* <R>(opts: {
  readonly runDir: string;
  readonly cwd: string;
  readonly head: string;
  readonly run: Runner<R>;
}) {
  const git = (args: string[]) => opts.run("git", args, opts.cwd);
  const refused = (why: string): FastForward => ({ _tag: "Refused", why });
  const status = yield* git(["status", "--porcelain"]);
  const from = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
  if (status.code !== 0 || from === "")
    return refused(`git could not read the checkout at ${opts.cwd}`);
  if (from === opts.head) return { _tag: "At", head: opts.head, from } satisfies FastForward;
  if (status.stdout.trim() !== "")
    return refused(
      `the checkout at ${opts.cwd} has uncommitted changes, so it was not moved to ${short(opts.head)}`,
    );
  yield* git(["fetch", "--quiet", "origin"]);
  if ((yield* git(["cat-file", "-e", `${opts.head}^{commit}`])).code !== 0)
    return refused(`origin does not have ${short(opts.head)}`);
  if ((yield* git(["merge-base", "--is-ancestor", from, opts.head])).code !== 0)
    return refused(
      `${short(opts.head)} does not fast-forward ${short(from)} in ${opts.cwd}, as after a force push`,
    );
  const moved = yield* git(["merge", "--ff-only", "--quiet", opts.head]);
  if (moved.code !== 0)
    return refused(`git merge --ff-only ${short(opts.head)} failed: ${whatItSaid(moved)}`);
  yield* appendLog(opts.runDir, `moved the checkout from ${from} to ${opts.head}`);
  return { _tag: "At", head: opts.head, from } satisfies FastForward;
});

/** What a tag must be shown to be: `finished` is a package's, its pipeline succeeded. */
export const TagProofSchema = Schema.Literal("finished");

/** A tag proved, or what it lacks. */
export const TagReadSchema = Schema.Union([
  Schema.TaggedStruct("Proved", {}),
  Schema.TaggedStruct("Unproved", { why: Schema.String }),
]);
export type TagRead = typeof TagReadSchema.Type;

/**
 * Reads `tag` back: on origin, carrying `merged`, and where `pipeline` names one, finished
 * and succeeded by the forge's word. A job waiting to be started by hand has not finished.
 */
export const readTag = Effect.fn("Releasing.readTag")(function* <R>(opts: {
  readonly cwd: string;
  readonly tag: string;
  readonly merged: string;
  readonly pipeline: string | null;
  readonly proves: typeof TagProofSchema.Type;
  readonly run: Runner<R>;
}) {
  const git = (args: string[]) => opts.run("git", args, opts.cwd);
  const unproved = (why: string): TagRead => ({ _tag: "Unproved", why });
  const ref = `refs/tags/${opts.tag}`;
  const listed = yield* git(["ls-remote", "--tags", "origin", ref]);
  if (listed.code !== 0) return unproved(`origin could not be read: ${whatItSaid(listed)}`);
  if (listed.stdout.trim() === "") return unproved(`${opts.tag} is not on origin`);
  yield* git(["fetch", "--quiet", "--force", "origin", `${ref}:${ref}`]);
  yield* git(["fetch", "--quiet", "origin"]);
  if ((yield* git(["merge-base", "--is-ancestor", opts.merged, ref])).code !== 0)
    return unproved(`${opts.tag} on origin does not carry the merged commit ${short(opts.merged)}`);
  if (opts.pipeline === null) return { _tag: "Proved" } satisfies TagRead;
  const read = yield* forgeOfUrl(opts.pipeline).pipeline(opts.pipeline, opts.cwd, opts.run);
  if (!read.ok) return unproved(`${opts.tag}'s pipeline could not be read: ${read.reason}`);
  const manual = read.jobs.filter((job) => job.state === "manual").map((job) => `\`${job.name}\``);
  if (manual.length > 0)
    return unproved(
      `${opts.tag}'s pipeline at ${opts.pipeline} has not finished: ${manual.join(", ")} waits for somebody to start it by hand`,
    );
  if (!read.succeeded)
    return unproved(`${opts.tag}'s pipeline at ${opts.pipeline} has not finished and succeeded`);
  return { _tag: "Proved" } satisfies TagRead;
});
