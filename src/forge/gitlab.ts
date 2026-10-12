// The GitLab adapter: everything Collie asks GitLab, through `glab`.

import { Effect, Option, Schema } from "effect";
import type { ForgeChecks, MrDetails, MrPanel, MrRef, MrUnavailable } from "../board-model";
import { epochMs } from "../time";
import type { Runner } from "../mr";
import type { DeployTier, Forge, Readiness } from "./forge";

const UserJson = Schema.fromJsonString(Schema.Struct({ username: Schema.String }));

/** The glab arguments that point a command at a project rather than at the cwd. */
export function repoArgs(project: string | null): string[] {
  return project ? ["--repo", project] : [];
}

/** `group/project!42`, with its host, as a note's message names it. */
const whereOf = (ref: MrRef) => (ref.project ? `${ref.project}!${ref.iid}` : `!${ref.iid}`);

/** The host part of `host/group/project`, which is what glab authenticates against. */
export function hostOf(project: string | null): string | null {
  const host = project?.split("/")[0];
  return host && host.includes(".") ? host : null;
}

/**
 * Absent and `null` are the same answer here, and GitLab gives both: a merge request with
 * no second pipeline sends `"pipeline": null`, not a missing key. A schema that allowed
 * the key to be omitted but not null rejected real merge requests outright, and the panel
 * reported one it had just read successfully as "not a merge request" — then cached that
 * for the whole TTL. Every field a GitLab version or a token might not answer is optional
 * *and* nullable for that reason.
 */
const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const optionalFlag = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
const optionalCount = Schema.optionalKey(Schema.NullOr(Schema.Number));
const optionalStatus = Schema.optionalKey(Schema.NullOr(Schema.Struct({ status: optionalText })));

const MrDetailsJson = Schema.fromJsonString(
  Schema.Struct({
    iid: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
    title: optionalText,
    state: optionalText,
    draft: optionalFlag,
    work_in_progress: optionalFlag,
    author: Schema.optionalKey(Schema.NullOr(Schema.Struct({ username: optionalText }))),
    assignees: Schema.optionalKey(
      Schema.NullOr(Schema.Array(Schema.Struct({ username: optionalText }))),
    ),
    source_branch: optionalText,
    target_branch: optionalText,
    sha: optionalText,
    merge_commit_sha: optionalText,
    squash_commit_sha: optionalText,
    updated_at: optionalText,
    web_url: optionalText,
    head_pipeline: optionalStatus,
    pipeline: optionalStatus,
    blocking_discussions_resolved: optionalFlag,
    merge_when_pipeline_succeeds: optionalFlag,
    user_notes_count: optionalCount,
    approvals_required: optionalCount,
    approvals_left: optionalCount,
  }),
);

/**
 * One merge request, in one `glab mr view` call. `gitlabForProject` first, because "no
 * glab" and "not logged in to that host" are answers a panel can state rather than
 * failures a fetch should discover.
 *
 * Never called from a render path and never for a list: the app fetches this when a Run
 * with a merge-request target becomes the Selection, and caches it per ref.
 */
export function mrDetails<R>(
  ref: MrRef,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<MrPanel, never, R> {
  return Effect.gen(function* () {
    const ready = yield* gitlabForProject(ref.project, cwd, run);
    if (!ready.ok) return { _tag: "Unavailable", reason: ready.reason } satisfies MrUnavailable;

    const where = whereOf(ref);
    const view = yield* run(
      "glab",
      ["mr", "view", ref.iid, ...repoArgs(ref.project), "-F", "json"],
      cwd,
    );
    if (view.code !== 0) {
      return {
        _tag: "Unavailable",
        reason: `glab could not read ${where}`,
      } satisfies MrUnavailable;
    }
    const decoded = Schema.decodeUnknownOption(MrDetailsJson)(view.stdout);
    if (Option.isNone(decoded)) {
      return {
        _tag: "Unavailable",
        reason: `what glab said about ${where} is not a merge request`,
      } satisfies MrUnavailable;
    }
    const mr = decoded.value;
    const draft = mr.draft === true || mr.work_in_progress === true;
    const pipeline = mr.head_pipeline?.status ?? mr.pipeline?.status ?? "";
    const updated = mr.updated_at ? epochMs(mr.updated_at) : Number.NaN;
    return {
      _tag: "Details",
      iid: mr.iid === undefined || mr.iid === null ? ref.iid : String(mr.iid),
      project: ref.project,
      title: mr.title ?? "",
      state: draft ? "draft" : (mr.state ?? ""),
      author: mr.author?.username ?? "",
      assignees: (mr.assignees ?? [])
        .map((one) => one.username ?? "")
        .filter((name) => name !== ""),
      sourceBranch: mr.source_branch ?? "",
      targetBranch: mr.target_branch ?? "",
      pipeline,
      checks: pipelineChecks(pipeline),
      approvals: approvalsLine(mr.approvals_required, mr.approvals_left),
      unresolved: mr.blocking_discussions_resolved === false,
      notes: mr.user_notes_count ?? 0,
      headSha: (mr.sha ?? "").slice(0, 7),
      head: mr.sha ?? "",
      mergedSha:
        mr.state === "merged" ? (mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha ?? "") : "",
      updatedAt: Number.isFinite(updated) ? updated : 0,
      url: mr.web_url ?? "",
      autoMerge: mr.merge_when_pipeline_succeeds === true,
    } satisfies MrDetails;
  });
}

/**
 * Approvals are not on the merge-request object on every GitLab; where neither field is
 * answered the panel says nothing about them rather than guessing at zero.
 */
function approvalsLine(
  requiredOrNull: number | null | undefined,
  leftOrNull: number | null | undefined,
): string {
  const required = requiredOrNull ?? undefined;
  const left = leftOrNull ?? undefined;
  if (required === undefined && left === undefined) return "";
  if (left === 0) return "approved";
  if (required === undefined) return `${left} still needed`;
  // How many are still needed is the fact this GitLab did not answer, and standing the
  // requirement in for it would claim nobody has approved yet.
  if (left === undefined) return `${required} approval(s) required`;
  return `${left} of ${required} still needed`;
}

/** GitLab's head pipeline status, as the card reads it. */
export function pipelineChecks(status: string): ForgeChecks {
  if (status === "success" || status === "passed") return { state: "passed" };
  if (status === "failed") return { state: "failed", name: "pipeline" };
  if (
    ["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"].includes(
      status,
    )
  )
    return { state: "running" };
  return { state: "unknown" };
}

/**
 * What a step pointed at a merge request needs: glab, and glab logged in to that host.
 * The cwd's remotes are none of its business — which forge a checkout is on is decided
 * before an adapter is asked.
 */
export function gitlabForProject<R>(
  project: string | null,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  return Effect.gen(function* () {
    const glab = yield* run("glab", ["--version"], cwd);
    if (glab.code !== 0) return { ok: false, reason: "glab is not installed" };

    const host = hostOf(project);
    if (!host) return { ok: true, reason: "" };
    const auth = yield* run("glab", ["auth", "status", "--hostname", host], cwd);
    return auth.code === 0
      ? { ok: true, reason: "" }
      : { ok: false, reason: `glab is not logged in to ${host}` };
  });
}

/**
 * Whoever glab is logged in as for this checkout's host, and null where it will not
 * say. The authenticated user, not a configured assignee: a branch belongs to whoever
 * is pushing it, and the two are different people whenever an assignee is set at all.
 */
export function glabLogin<R>(cwd: string, run: Runner<R>): Effect.Effect<string | null, never, R> {
  return Effect.gen(function* () {
    const me = yield* run("glab", ["api", "user"], cwd);
    if (me.code !== 0) return null;
    return Option.match(Schema.decodeUnknownOption(UserJson)(me.stdout), {
      onNone: () => null,
      onSome: (user) => (user.username === "" ? null : user.username),
    });
  });
}

const EnvironmentsJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, tier: optionalText })),
);
const DeploymentsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ sha: Schema.String, environment: Schema.Struct({ name: Schema.String }) }),
  ),
);
const MergeBaseJson = Schema.fromJsonString(Schema.Struct({ id: optionalText }));

/**
 * The furthest a merged commit has got: live in production, live on staging, or neither.
 * "Live" is what the newest successful deployment of each environment has on it, which is
 * the commit itself or one descending from it — GitLab's merge-base says which. A project
 * with no staging or production environment answers null, and so does GitLab not
 * answering: the board then says "merged", which is true, rather than guessing further.
 */
export function liveTier<R>(
  ref: MrRef,
  mergedSha: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<DeployTier | null, never, R> {
  return Effect.gen(function* () {
    const host = hostOf(ref.project);
    if (!host || !ref.project || mergedSha === "") return null;
    const path = encodeURIComponent(ref.project.slice(host.length + 1));
    const api = (route: string) =>
      run("glab", ["api", "--hostname", host, `projects/${path}/${route}`], cwd);
    const environments = yield* api("environments");
    const tiers = new Map<string, DeployTier>();
    for (const env of Option.getOrElse(
      Schema.decodeUnknownOption(EnvironmentsJson)(environments.stdout),
      () => [],
    )) {
      if (env.tier === "production" || env.tier === "staging") tiers.set(env.name, env.tier);
    }
    if (tiers.size === 0) return null;
    const deployments = yield* api(
      "deployments?status=success&order_by=created_at&sort=desc&per_page=50",
    );
    // Newest first, so the first deployment seen per environment is what is live there.
    const live = new Map<string, string>();
    for (const deployment of Option.getOrElse(
      Schema.decodeUnknownOption(DeploymentsJson)(deployments.stdout),
      () => [],
    )) {
      if (tiers.has(deployment.environment.name) && !live.has(deployment.environment.name))
        live.set(deployment.environment.name, deployment.sha);
    }
    const carries = (sha: string) =>
      Effect.gen(function* () {
        if (sha === mergedSha) return true;
        const base = yield* api(`repository/merge_base?refs[]=${mergedSha}&refs[]=${sha}`);
        const decoded = Schema.decodeUnknownOption(MergeBaseJson)(base.stdout);
        return Option.isSome(decoded) && decoded.value.id === mergedSha;
      });
    for (const tier of ["production", "staging"] as const) {
      for (const [name, sha] of live) {
        if (tiers.get(name) === tier && (yield* carries(sha))) return tier;
      }
    }
    return null;
  });
}

export const gitlab: Forge = {
  name: "gitlab",
  ready: gitlabForProject,
  login: glabLogin,
  details: mrDetails,
  liveTier,
  note: (ref, body, cwd, run) =>
    Effect.map(
      // `--repo` is what lets this work from a directory that is not that checkout.
      run("glab", ["mr", "note", ref.iid, ...repoArgs(ref.project), "--message", body], cwd),
      (note) =>
        note.code === 0
          ? { ok: true, message: `posted the review to ${whereOf(ref)}` }
          : { ok: false, message: `glab mr note ${whereOf(ref)} failed (exit ${note.code})` },
    ),
};
