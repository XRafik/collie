// What a Release Run has the host do to its checkout and read of its tag: bring the
// checkout to the merge request's head without discarding anything, and prove a tag, stage
// and production from origin and the forge rather than from an Output.

import { Effect, Schema } from "effect";
import type { MrRef } from "./board-model";
import { forgeOf, forgeOfUrl, type DeployTier } from "./forge/forge";
import { whatItSaid, type Ran, type Runner } from "./mr";
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

/** Which of `commits` `head` carries, once origin is fetched. */
export const carried = Effect.fn("Releasing.carried")(function* <R>(opts: {
  readonly cwd: string;
  readonly head: string;
  readonly commits: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const git = (args: string[]) => opts.run("git", args, opts.cwd);
  if (opts.commits.length > 0) yield* git(["fetch", "--quiet", "origin"]);
  const carries: string[] = [];
  for (const commit of opts.commits)
    if ((yield* git(["merge-base", "--is-ancestor", commit, opts.head])).code === 0)
      carries.push(commit);
  return carries;
});

/**
 * What a tag must be shown to be: `finished` is a package's, its pipeline succeeded;
 * `staged` is an application's, on stage and ready for production.
 */
export const TagProofSchema = Schema.Literals(["finished", "staged"]);

/** A job of a tag's pipeline, at the address the forge gives it. */
export const JobLinkSchema = Schema.Struct({ name: Schema.String, url: Schema.String });
export type JobLink = typeof JobLinkSchema.Type;

/**
 * A tag proved, with the production jobs waiting on it; already in production; failed on
 * stage after the merge; or what it lacks.
 */
export const TagReadSchema = Schema.Union([
  Schema.TaggedStruct("Proved", { production: Schema.Array(JobLinkSchema) }),
  Schema.TaggedStruct("InProduction", {}),
  Schema.TaggedStruct("StageFailed", { why: Schema.String }),
  Schema.TaggedStruct("Unproved", { why: Schema.String }),
]);
export type TagRead = typeof TagReadSchema.Type;

/** Production already carries the merge, the jobs still to play, or why none may be. */
export const ProductionReadSchema = Schema.Union([
  Schema.TaggedStruct("Carried", {}),
  Schema.TaggedStruct("Play", { jobs: Schema.Array(JobLinkSchema) }),
  Schema.TaggedStruct("Unproved", { why: Schema.String }),
]);
export type ProductionRead = typeof ProductionReadSchema.Type;

/** A merge request's head proved on stage, with its stage jobs; its head moved; or why not. */
export const StageReadSchema = Schema.Union([
  Schema.TaggedStruct("Staged", { jobs: Schema.Array(JobLinkSchema) }),
  Schema.TaggedStruct("Moved", { head: Schema.String }),
  Schema.TaggedStruct("Failed", { why: Schema.String }),
]);
export type StageRead = typeof StageReadSchema.Type;

/** Stage shown back on what production carries, or why not. */
export const RollbackReadSchema = Schema.Union([
  Schema.TaggedStruct("Shown", {}),
  Schema.TaggedStruct("Unshown", { why: Schema.String }),
]);
export type RollbackRead = typeof RollbackReadSchema.Type;

const failing = new Set(["failed", "cancelled"]);

const gitOf =
  <R>(opts: { readonly cwd: string; readonly run: Runner<R> }) =>
  (args: string[]) =>
    opts.run("git", args, opts.cwd);

/** Whether `sha` carries `ancestor`, or null where git does not have one of them. */
const carries = <R>(
  git: (args: string[]) => Effect.Effect<Ran, never, R>,
  sha: string,
  ancestor: string,
) =>
  Effect.gen(function* () {
    for (const one of [sha, ancestor])
      if ((yield* git(["cat-file", "-e", `${one}^{commit}`])).code !== 0) return null;
    return (yield* git(["merge-base", "--is-ancestor", ancestor, sha])).code === 0;
  });

/** Why `tag` on origin is not a tag of `merged`, or null where it is. */
const tagLacks = <R>(
  git: (args: string[]) => Effect.Effect<Ran, never, R>,
  tag: string,
  merged: string,
) =>
  Effect.gen(function* () {
    const ref = `refs/tags/${tag}`;
    const listed = yield* git(["ls-remote", "--tags", "origin", ref]);
    if (listed.code !== 0) return `origin could not be read: ${whatItSaid(listed)}`;
    if (listed.stdout.trim() === "") return `${tag} is not on origin`;
    yield* git(["fetch", "--quiet", "--force", "origin", `${ref}:${ref}`]);
    yield* git(["fetch", "--quiet", "origin"]);
    if ((yield* git(["merge-base", "--is-ancestor", merged, ref])).code !== 0)
      return `${tag} on origin does not carry the merged commit ${short(merged)}`;
    return null;
  });

/** What `tier` runs, by the commit its newest successful deployment has, or why not. */
const deployedOn = <R>(ref: MrRef, tier: DeployTier, cwd: string, run: Runner<R>) =>
  forgeOf(ref).deployed(ref, tier, cwd, run);

/** Whether production carries `merged`; null where the forge or git cannot say. */
const inProduction = <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly merged: string;
  readonly run: Runner<R>;
}) =>
  Effect.gen(function* () {
    const read = yield* deployedOn(opts.ref, "production", opts.cwd, opts.run);
    if (!read.ok || read.sha === null) return false;
    return (yield* carries(gitOf(opts), read.sha, opts.merged)) === true;
  });

/**
 * Reads `tag` back: on origin and carrying `merged`, then against what it `proves`.
 * `finished`: where `pipeline` names one, it finished and succeeded by the forge's word, and a
 * job waiting to be started by hand has not finished. `staged`: production carrying `merged`
 * already is `InProduction`; otherwise, where `stage` names jobs, each passed and stage carries
 * `merged`, or else it is `StageFailed`; every other finished job passed; and each
 * `production` job, at least one, waits on the pipeline to be started by hand. The
 * pipeline's own state is not read.
 */
export const readTag = Effect.fn("Releasing.readTag")(function* <R>(opts: {
  readonly cwd: string;
  readonly tag: string;
  readonly merged: string;
  readonly pipeline: string | null;
  readonly proves: typeof TagProofSchema.Type;
  readonly ref: MrRef | null;
  readonly stage: ReadonlyArray<string>;
  readonly production: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const git = gitOf(opts);
  const unproved = (why: string): TagRead => ({ _tag: "Unproved", why });
  const lacks = yield* tagLacks(git, opts.tag, opts.merged);
  if (lacks !== null) return unproved(lacks);
  if (opts.proves === "finished") {
    if (opts.pipeline === null) return { _tag: "Proved", production: [] } satisfies TagRead;
    const read = yield* forgeOfUrl(opts.pipeline).pipeline(opts.pipeline, opts.cwd, opts.run);
    if (!read.ok) return unproved(`${opts.tag}'s pipeline could not be read: ${read.reason}`);
    const manual = read.jobs
      .filter((job) => job.state === "manual")
      .map((job) => `\`${job.name}\``);
    if (manual.length > 0)
      return unproved(
        `${opts.tag}'s pipeline at ${opts.pipeline} has not finished: ${manual.join(", ")} waits for somebody to start it by hand`,
      );
    if (!read.succeeded)
      return unproved(`${opts.tag}'s pipeline at ${opts.pipeline} has not finished and succeeded`);
    return { _tag: "Proved", production: [] } satisfies TagRead;
  }

  if (opts.ref === null)
    return unproved("this Run recorded no merge request to read deployments of");
  if (yield* inProduction({ ...opts, ref: opts.ref }))
    return { _tag: "InProduction" } satisfies TagRead;
  if (opts.pipeline === null)
    return unproved(`no pipeline of ${opts.tag} was named to prove stage from`);
  const pipeline = opts.pipeline;
  const read = yield* forgeOfUrl(pipeline).pipeline(pipeline, opts.cwd, opts.run);
  if (!read.ok) return unproved(`${opts.tag}'s pipeline could not be read: ${read.reason}`);
  const on = `on ${opts.tag}'s pipeline at ${pipeline}`;
  const jobNamed = (name: string) => read.jobs.find((job) => job.name === name);
  if (opts.stage.length > 0) {
    for (const name of opts.stage) {
      const job = jobNamed(name);
      if (job !== undefined && failing.has(job.state))
        return { _tag: "StageFailed", why: `\`${name}\` failed ${on}` } satisfies TagRead;
    }
    for (const name of opts.stage) {
      const job = jobNamed(name);
      if (job === undefined) return unproved(`\`${name}\` is not a job ${on}`);
      if (job.state !== "passed")
        return unproved(`\`${name}\` has not passed ${on}: it is ${job.state}`);
    }
    const staging = yield* deployedOn(opts.ref, "staging", opts.cwd, opts.run);
    if (!staging.ok) return unproved(`stage could not be read: ${staging.reason}`);
    const staged = staging.sha === null ? false : yield* carries(git, staging.sha, opts.merged);
    if (staged === null)
      return unproved(
        `stage's ${short(staging.sha ?? "")} could not be compared with the merged commit`,
      );
    if (!staged)
      return {
        _tag: "StageFailed",
        why: `stage does not carry the merged commit ${short(opts.merged)}`,
      } satisfies TagRead;
  }
  const failed = read.jobs
    .filter((job) => failing.has(job.state) && !opts.production.includes(job.name))
    .map((job) => `\`${job.name}\``);
  if (failed.length > 0) return unproved(`${failed.join(", ")} failed ${on}`);
  if (opts.production.length === 0) return unproved(`no production job ${on} was named`);
  const production: JobLink[] = [];
  for (const name of opts.production) {
    const job = jobNamed(name);
    if (job === undefined) return unproved(`\`${name}\` is not a job ${on}`);
    if (job.state !== "manual")
      return unproved(
        `\`${name}\` does not wait ${on} for somebody to start it: it is ${job.state}`,
      );
    production.push({ name, url: job.url ?? pipeline });
  }
  return { _tag: "Proved", production } satisfies TagRead;
});

/**
 * Reads, before production jobs are played, what is left to play: nothing where production
 * already carries `merged`, the `jobs` still waiting to be started by hand, and none at all
 * where the tag no longer carries `merged` or a job is gone or failed.
 */
export const readProduction = Effect.fn("Releasing.readProduction")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly tag: string;
  readonly merged: string;
  readonly pipeline: string;
  readonly jobs: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const unproved = (why: string): ProductionRead => ({ _tag: "Unproved", why });
  if (yield* inProduction(opts)) return { _tag: "Carried" } satisfies ProductionRead;
  const lacks = yield* tagLacks(gitOf(opts), opts.tag, opts.merged);
  if (lacks !== null) return unproved(lacks);
  const read = yield* forgeOfUrl(opts.pipeline).pipeline(opts.pipeline, opts.cwd, opts.run);
  if (!read.ok) return unproved(`${opts.tag}'s pipeline could not be read: ${read.reason}`);
  const on = `on ${opts.tag}'s pipeline at ${opts.pipeline}`;
  const jobs: JobLink[] = [];
  for (const name of opts.jobs) {
    const job = read.jobs.find((one) => one.name === name);
    if (job === undefined) return unproved(`\`${name}\` is no longer a job ${on}`);
    if (failing.has(job.state)) return unproved(`\`${name}\` failed ${on}`);
    if (job.state === "manual") jobs.push({ name, url: job.url ?? opts.pipeline });
  }
  return { _tag: "Play", jobs } satisfies ProductionRead;
});

/**
 * A merge request's head on stage: each of `jobs`, one at least, passed on the pipeline of its
 * head, that head is `head`, and stage's newest successful deployment carries it.
 */
export const readStage = Effect.fn("Releasing.readStage")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly head: string;
  readonly jobs: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const failed = (why: string): StageRead => ({ _tag: "Failed", why });
  if (opts.jobs.length === 0)
    return failed("no stage job of the merge request's pipeline was named");
  const on = `on the merge request's pipeline at ${short(opts.head)}`;
  const jobs: JobLink[] = [];
  for (const name of opts.jobs) {
    const job = yield* forgeOf(opts.ref).job(opts.ref, name, opts.cwd, opts.run);
    if (!job.ok) return failed(`\`${name}\` could not be read: ${job.reason}`);
    if (job.head !== opts.head) return { _tag: "Moved", head: job.head } satisfies StageRead;
    if (job.state !== "passed")
      return failed(`\`${name}\` has not passed ${on}: it is ${job.state}`);
    jobs.push({ name, url: job.url ?? "" });
  }
  const staging = yield* deployedOn(opts.ref, "staging", opts.cwd, opts.run);
  if (!staging.ok) return failed(`stage could not be read: ${staging.reason}`);
  const staged = staging.sha === null ? false : yield* carries(gitOf(opts), staging.sha, opts.head);
  if (staged === null)
    return failed(
      `stage's ${short(staging.sha ?? "")} could not be compared with ${short(opts.head)}`,
    );
  if (!staged) return failed(`stage does not carry ${short(opts.head)}`);
  return { _tag: "Staged", jobs } satisfies StageRead;
});

/** Whether stage is shown back on what production carries, and off `off`. */
export const readRollback = Effect.fn("Releasing.readRollback")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly off: string;
  readonly run: Runner<R>;
}) {
  const unshown = (why: string): RollbackRead => ({ _tag: "Unshown", why });
  const git = gitOf(opts);
  const staging = yield* deployedOn(opts.ref, "staging", opts.cwd, opts.run);
  if (!staging.ok) return unshown(`stage could not be read: ${staging.reason}`);
  const production = yield* deployedOn(opts.ref, "production", opts.cwd, opts.run);
  if (!production.ok) return unshown(`production could not be read: ${production.reason}`);
  if (staging.sha === null) return unshown("stage has no successful deployment");
  if (production.sha === null) return unshown("production has no successful deployment");
  const still = yield* carries(git, staging.sha, opts.off);
  if (still === null) return unshown(`stage's ${short(staging.sha)} could not be compared`);
  if (still) return unshown(`stage still carries ${short(opts.off)}`);
  if ((yield* carries(git, staging.sha, production.sha)) !== true)
    return unshown(
      `stage's ${short(staging.sha)} does not carry production's ${short(production.sha)}`,
    );
  return { _tag: "Shown" } satisfies RollbackRead;
});
