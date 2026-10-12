// A fake of each forge, from one model: a Runner answering the argv its adapter uses, and
// a FakeBin executable answering from the same model for host-driven tests. Both log
// every call they get.

import { Effect, FileSystem, Path, Schema } from "effect";
import type { MrForge } from "../../src/board-model";
import type { Ran, Runner } from "../../src/mr";
import type { FakeBin } from "./bin";

export const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["passed", "failed", "running"]),
});
export type Check = typeof Check.Type;

export const FakeMr = Schema.Struct({
  /** `host/path`, as an `MrRef`'s project. */
  project: Schema.String,
  iid: Schema.String,
  state: Schema.Literals(["open", "merged", "closed"]),
  draft: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  head: Schema.optionalKey(Schema.String),
  mergedSha: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.Array(Check)),
  sourceBranch: Schema.optionalKey(Schema.String),
  targetBranch: Schema.optionalKey(Schema.String),
  autoMerge: Schema.optionalKey(Schema.Boolean),
  approved: Schema.optionalKey(Schema.Boolean),
  updatedAt: Schema.optionalKey(Schema.String),
});
export type FakeMr = typeof FakeMr.Type;

export const ForgeModel = Schema.Struct({
  installed: Schema.Boolean,
  /** Hosts the CLI is logged in to. */
  loggedIn: Schema.Array(Schema.String),
  login: Schema.NullOr(Schema.String),
  mrs: Schema.Array(FakeMr),
  /** The checkout's `origin` and `upstream` remote URLs, and the branch it is on. */
  origin: Schema.optionalKey(Schema.String),
  upstream: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  /** Each environment, and the sha its newest successful deployment has. */
  environments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        tier: Schema.String,
        deployed: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  /** The shas each sha descends from. */
  ancestry: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** Repositories gh cannot read, by `owner/repo`. */
  unreadable: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The deploy API does not answer. */
  deploysDown: Schema.optionalKey(Schema.Boolean),
  /** Notes posted, by `project!iid` or `project#iid`. */
  notes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});
export type ForgeModel = typeof ForgeModel.Type;
const ModelJson = Schema.fromJsonString(ForgeModel);

export const FORGE_HOST = { gitlab: "gitlab.example.com", github: "github.com" } as const;
export const PROJECT = {
  gitlab: "gitlab.example.com/group/app",
  github: "github.com/owner/repo",
} as const;

export const CLI = { gitlab: "glab", github: "gh" } as const;

/** One answer, and the note it posted where it posted one. */
interface Answer {
  readonly ran: Ran;
  readonly noted?: { readonly key: string; readonly body: string };
}

const Json = Schema.fromJsonString(Schema.Json);
const ok = (stdout = ""): Answer => ({ ran: { code: 0, stdout } });
const json = (value: Schema.Json): Answer => ok(Schema.encodeSync(Json)(value));
const no = (code = 1): Answer => ({ ran: { code, stdout: "" } });

const flag = (args: ReadonlyArray<string>, name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const keyOf = (forge: MrForge, mr: FakeMr) =>
  `${mr.project}${forge === "github" ? "#" : "!"}${mr.iid}`;

function pipelineOf(checks: ReadonlyArray<Check> | undefined): string | null {
  if (checks === undefined || checks.length === 0) return null;
  if (checks.some((one) => one.state === "failed")) return "failed";
  if (checks.some((one) => one.state === "running")) return "running";
  return "success";
}

function glab(model: ForgeModel, args: ReadonlyArray<string>): Answer {
  if (!model.installed) return no(127);
  const [verb, sub] = args;
  if (verb === "--version") return ok("glab 1.0.0");
  if (verb === "auth" && sub === "status") {
    const host = flag(args, "--hostname");
    return host === undefined || model.loggedIn.includes(host) ? ok() : no();
  }
  if (verb === "api" && sub === "user")
    return model.login === null ? no() : json({ username: model.login });
  const mrAt = (iid: string | undefined) => {
    const repo = flag(args, "--repo");
    return model.mrs.find((one) => one.iid === iid && (repo === undefined || one.project === repo));
  };
  if (verb === "mr" && sub === "view") {
    const mr = mrAt(args[2]);
    if (mr === undefined) return no();
    const pipeline = pipelineOf(mr.checks);
    return json({
      iid: Number(mr.iid),
      title: mr.title ?? "",
      state: mr.state === "open" ? "opened" : mr.state,
      draft: mr.draft ?? false,
      author: { username: mr.author ?? "" },
      assignees: (mr.assignees ?? []).map((username) => ({ username })),
      sha: mr.head ?? null,
      merge_commit_sha: mr.mergedSha ?? null,
      head_pipeline: pipeline === null ? null : { status: pipeline },
      source_branch: mr.sourceBranch ?? null,
      target_branch: mr.targetBranch ?? null,
      merge_when_pipeline_succeeds: mr.autoMerge ?? false,
      approvals_left: mr.approved === true ? 0 : null,
      updated_at: mr.updatedAt ?? null,
      web_url: `https://${mr.project}/-/merge_requests/${mr.iid}`,
    });
  }
  if (verb === "mr" && sub === "list" && flag(args, "--source-branch") !== undefined) {
    const repo = flag(args, "--repo");
    return json(
      model.mrs
        .filter(
          (one) =>
            one.state === "open" &&
            one.sourceBranch === flag(args, "--source-branch") &&
            (repo === undefined || one.project === repo),
        )
        .map((one) => ({
          iid: Number(one.iid),
          web_url: `https://${one.project}/-/merge_requests/${one.iid}`,
          merge_when_pipeline_succeeds: one.autoMerge ?? false,
        })),
    );
  }
  if (verb === "mr" && sub === "note") {
    const mr = mrAt(args[2]);
    if (mr === undefined) return no();
    return { ...ok(), noted: { key: keyOf("gitlab", mr), body: flag(args, "--message") ?? "" } };
  }
  if (verb === "api" && flag(args, "--hostname") !== undefined) {
    if (model.deploysDown === true) return no();
    const route = args.at(-1) ?? "";
    const environments = model.environments ?? [];
    if (route.endsWith("/environments"))
      return json(environments.map(({ name, tier }) => ({ name, tier })));
    if (route.includes("/deployments?"))
      return json(
        environments.flatMap((env) =>
          env.deployed === undefined
            ? []
            : [{ sha: env.deployed, environment: { name: env.name } }],
        ),
      );
    const base = /merge_base\?refs\[\]=([^&]+)&refs\[\]=(.+)$/.exec(route);
    if (base) {
      const [, merged = "", live = ""] = base;
      const carries = live === merged || (model.ancestry?.[live] ?? []).includes(merged);
      return json({ id: carries ? merged : "0000000" });
    }
  }
  return no();
}

function gh(model: ForgeModel, args: ReadonlyArray<string>): Answer {
  if (!model.installed) return no(127);
  const [verb, sub] = args;
  if (verb === "--version") return ok("gh version 2.0.0");
  if (verb === "auth" && sub === "status")
    return model.loggedIn.includes(flag(args, "--hostname") ?? FORGE_HOST.github) ? ok() : no();
  if (!model.loggedIn.includes(FORGE_HOST.github)) return no(4);
  if (verb === "api" && sub === "user")
    return model.login === null ? no() : json({ login: model.login });
  if (verb === "repo" && sub === "view") {
    const repo = args[2] ?? "";
    return (model.unreadable ?? []).includes(repo) ? no() : json({ nameWithOwner: repo });
  }
  const pullAt = (number: string | undefined) =>
    model.mrs.find(
      (one) => one.iid === number && one.project === `github.com/${flag(args, "--repo")}`,
    );
  if (verb === "pr" && sub === "view") {
    const pull = pullAt(args[2]);
    if (pull === undefined) return no();
    return json({
      title: pull.title ?? "",
      state: pull.state.toUpperCase(),
      isDraft: pull.draft ?? false,
      author: { login: pull.author ?? "" },
      assignees: (pull.assignees ?? []).map((login) => ({ login })),
      headRefName: pull.sourceBranch ?? "",
      baseRefName: pull.targetBranch ?? "",
      reviewDecision: pull.approved === true ? "APPROVED" : "",
      comments: [],
      updatedAt: pull.updatedAt ?? null,
      url: `https://${pull.project}/pull/${pull.iid}`,
      autoMergeRequest: pull.autoMerge === true ? { enabledAt: "2026-10-01T00:00:00Z" } : null,
      headRefOid: pull.head ?? null,
      mergeCommit: pull.mergedSha === undefined ? null : { oid: pull.mergedSha },
      statusCheckRollup: (pull.checks ?? []).map((check) => ({
        __typename: "CheckRun",
        name: check.name,
        status: check.state === "running" ? "QUEUED" : "COMPLETED",
        conclusion:
          check.state === "running" ? null : check.state === "passed" ? "SUCCESS" : "FAILURE",
      })),
    });
  }
  if (verb === "pr" && sub === "list") {
    const repo = `github.com/${flag(args, "--repo")}`;
    return json(
      model.mrs
        .filter(
          (one) =>
            one.project === repo &&
            one.state === "open" &&
            one.sourceBranch === flag(args, "--head"),
        )
        .map((one) => ({
          number: Number(one.iid),
          url: `https://${one.project}/pull/${one.iid}`,
          autoMergeRequest: one.autoMerge === true ? { enabledAt: "2026-10-01T00:00:00Z" } : null,
        })),
    );
  }
  if (verb === "pr" && sub === "comment") {
    const pull = pullAt(args[2]);
    if (pull === undefined) return no();
    return { ...ok(), noted: { key: keyOf("github", pull), body: flag(args, "--body") ?? "" } };
  }
  return no();
}

interface Answered {
  readonly ran: Ran;
  readonly model: ForgeModel;
}

/**
 * What the fake forge answers to one command, and the model after it; git answers the
 * checkout's remotes.
 */
export function answer(
  forge: MrForge,
  model: ForgeModel,
  cmd: string,
  args: ReadonlyArray<string>,
): Answered {
  if (cmd === "git") {
    const said =
      args[0] === "remote" && args[1] === "get-url"
        ? args[2] === "origin"
          ? model.origin
          : args[2] === "upstream"
            ? model.upstream
            : undefined
        : args.join(" ") === "rev-parse --abbrev-ref HEAD"
          ? model.branch
          : undefined;
    return { ran: said === undefined ? no().ran : ok(`${said}\n`).ran, model };
  }
  if (cmd !== CLI[forge]) return { ran: no(127).ran, model };
  const said = forge === "gitlab" ? glab(model, args) : gh(model, args);
  if (said.noted === undefined) return { ran: said.ran, model };
  const { key, body } = said.noted;
  const notes = model.notes ?? {};
  return {
    ran: said.ran,
    model: { ...model, notes: { ...notes, [key]: [...(notes[key] ?? []), body] } },
  };
}

/** The Runner face: answers from the model, and logs `cmd args…` to `calls`. */
export function fakeForge(forge: MrForge, start: ForgeModel) {
  const calls: string[] = [];
  let model = start;
  const run: Runner = (cmd, args) =>
    Effect.sync(() => {
      calls.push([cmd, ...args].join(" "));
      const said = answer(forge, model, cmd, args);
      model = said.model;
      return said.ran;
    });
  return { run, calls, model: () => model };
}

/** The FakeBin face, run as `bun forge-bin.ts <forge> <model file> <args…>`. */
export const forgeBin = Effect.fn("forge.bin")(function* (
  forge: MrForge,
  file: string,
  args: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const model = Schema.decodeSync(ModelJson)(yield* fs.readFileString(file));
  yield* fs.writeFileString(`${file}.log`, `${[CLI[forge], ...args].join(" ")}\n`, { flag: "a" });
  const said = answer(forge, model, CLI[forge], args);
  yield* fs.writeFileString(file, Schema.encodeSync(ModelJson)(said.model));
  return said.ran;
});

/**
 * The forge's CLI on PATH, answering from `model` as kept beside it. The model is read back
 * with `model()`, so a note posted through the host can be seen.
 */
export const forgeOnPath = Effect.fn("forge.onPath")(function* (
  bin: FakeBin,
  forge: MrForge,
  model: ForgeModel,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(bin.dir, `${forge}.model.json`);
  yield* fs.writeFileString(file, Schema.encodeSync(ModelJson)(model));
  const script = yield* path.fromFileUrl(new URL("./forge-bin.ts", import.meta.url));
  yield* bin.add(CLI[forge], `exec bun '${script}' ${forge} '${file}' "$@"`);
  return {
    model: () => Effect.map(fs.readFileString(file), Schema.decodeSync(ModelJson)),
    calls: () =>
      Effect.map(
        fs.readFileString(`${file}.log`).pipe(Effect.catch(() => Effect.succeed(""))),
        (text) => text.split("\n").filter(Boolean),
      ),
  };
});
