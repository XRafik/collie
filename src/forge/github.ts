// The GitHub adapter: everything Collie asks GitHub, through `gh`. Only github.com.

import { Effect, Option, Schema } from "effect";
import {
  mrPath,
  mrWords,
  type ForgeChecks,
  type MrDetails,
  type MrPanel,
  type MrRef,
} from "../board-model";
import type { Runner } from "../mr";
import type { Forge, Readiness } from "./forge";

const HOST = "github.com";

const PullJson = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    headRefOid: Schema.optionalKey(Schema.NullOr(Schema.String)),
    mergeCommit: Schema.optionalKey(Schema.NullOr(Schema.Struct({ oid: Schema.String }))),
    statusCheckRollup: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            name: Schema.optionalKey(Schema.NullOr(Schema.String)),
            context: Schema.optionalKey(Schema.NullOr(Schema.String)),
            status: Schema.optionalKey(Schema.NullOr(Schema.String)),
            conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
            state: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    ),
  }),
);
type Pull = typeof PullJson.Type;

const RED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** A pull request's check rollup: a check run's conclusion, or a status context's state. */
export function rollupChecks(rollup: Pull["statusCheckRollup"]): ForgeChecks {
  const checks = rollup ?? [];
  if (checks.length === 0) return { state: "unknown" };
  const verdicts = checks.map((one) => ({
    name: one.name ?? one.context ?? "a check",
    // A check run has a conclusion once it completes; a status context has only a state.
    said:
      one.conclusion ??
      (one.status != null && one.status !== "COMPLETED" ? "PENDING" : (one.state ?? "PENDING")),
  }));
  const red = verdicts.find((one) => RED.has(one.said));
  if (red !== undefined) return { state: "failed", name: red.name };
  if (verdicts.some((one) => !GREEN.has(one.said))) return { state: "running" };
  return { state: "passed" };
}

/**
 * One pull request, in one `gh pr view` call. Only what the merge watch reads is asked:
 * state, checks, head and merged commit; the rest of the panel is empty.
 */
function details<R>(ref: MrRef, cwd: string, run: Runner<R>): Effect.Effect<MrPanel, never, R> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const view = yield* run(
      "gh",
      [
        "pr",
        "view",
        ref.iid,
        "--repo",
        mrPath(ref),
        "--json",
        "state,mergeCommit,headRefOid,statusCheckRollup",
      ],
      cwd,
    );
    if (view.code !== 0) return { _tag: "Unavailable", reason: `gh could not read ${where}` };
    const decoded = Schema.decodeUnknownOption(PullJson)(view.stdout);
    if (Option.isNone(decoded))
      return { _tag: "Unavailable", reason: `what gh said about ${where} is not a pull request` };
    const pull = decoded.value;
    const checks = rollupChecks(pull.statusCheckRollup);
    const head = pull.headRefOid ?? "";
    return {
      _tag: "Details",
      iid: ref.iid,
      project: ref.project,
      title: "",
      state: pull.state.toLowerCase(),
      author: "",
      assignees: [],
      sourceBranch: "",
      targetBranch: "",
      pipeline: checks.state === "unknown" ? "" : checks.state,
      checks,
      approvals: "",
      unresolved: false,
      notes: 0,
      headSha: head.slice(0, 7),
      head,
      mergedSha: pull.mergeCommit?.oid ?? "",
      updatedAt: 0,
      url: mrWords(ref).url ?? "",
    } satisfies MrDetails;
  });
}

const RepoJson = Schema.fromJsonString(Schema.Struct({ nameWithOwner: Schema.String }));
const UserJson = Schema.fromJsonString(Schema.Struct({ login: Schema.String }));

/** gh installed, logged in to github.com, and — where a repository is named — able to read it. */
function ready<R>(
  project: string | null,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  return Effect.gen(function* () {
    const no = (reason: string) => ({ ok: false, reason });
    if ((yield* run("gh", ["--version"], cwd)).code !== 0) return no("gh is not installed");
    if ((yield* run("gh", ["auth", "status", "--hostname", HOST], cwd)).code !== 0)
      return no(`gh is not logged in to ${HOST}`);
    const repository = project === null ? "" : mrPath({ project, iid: "" });
    if (repository === "" || repository === project) return { ok: true, reason: "" };
    const repo = yield* run("gh", ["repo", "view", repository, "--json", "nameWithOwner"], cwd);
    const decoded = Schema.decodeUnknownOption(RepoJson)(repo.stdout);
    if (
      repo.code !== 0 ||
      Option.isNone(decoded) ||
      decoded.value.nameWithOwner.toLowerCase() !== repository.toLowerCase()
    )
      return no(`gh cannot read ${repository}`);
    return { ok: true, reason: "" };
  });
}

function login<R>(cwd: string, run: Runner<R>): Effect.Effect<string | null, never, R> {
  return Effect.gen(function* () {
    const me = yield* run("gh", ["api", "user", "--hostname", HOST], cwd);
    if (me.code !== 0) return null;
    return Option.match(Schema.decodeUnknownOption(UserJson)(me.stdout), {
      onNone: () => null,
      onSome: (user) => (user.login.trim() === "" ? null : user.login),
    });
  });
}

export const github: Forge = {
  name: "github",
  ready,
  login,
  details,
  liveTier: () => Effect.succeed(null),
  note: (ref, body, cwd, run) =>
    Effect.map(
      run("gh", ["pr", "comment", ref.iid, "--repo", mrPath(ref), "--body", body], cwd),
      (note) =>
        note.code === 0
          ? { ok: true, message: `posted the review to ${mrWords(ref).label}` }
          : {
              ok: false,
              message: `gh pr comment ${mrWords(ref).label} failed (exit ${note.code})`,
            },
    ),
};
