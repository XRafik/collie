// Times the forge interface's `job` read over the CLI, as the adapters asked it before
// ADR-draft-a-forge-is-asked-over-http-with-its-clis-login, and over the `forges` library,
// as they ask it now, against a live pull request and merge request. Manual, not a test:
//
//   bun run tools/forges-benchmark.ts \
//     --github https://github.com/cego/collie/pull/181 --github-job check \
//     --gitlab https://gitlab.example.com/group/app/-/merge_requests/7 --gitlab-job test \
//     [--reads 20]
//
// The reads alternate between the transports, so both see the same network. The library's
// reads share one ForgeHttp, as a host's poll does: its first read pays the credential
// read and the connection.

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { parseArgs } from "node:util";
import { Clock, Console, Effect, Option, Schema } from "effect";
import { mrRefOf, type MrRef } from "../src/board-model";
import { forgeOf } from "../src/forge/forge";
import { forgeHttpLayer } from "../src/forge/http";
import { shell } from "../src/mr";

const { values } = parseArgs({
  options: {
    github: { type: "string" },
    "github-job": { type: "string" },
    gitlab: { type: "string" },
    "gitlab-job": { type: "string" },
    reads: { type: "string", default: "20" },
  },
});
const reads = Number(values.reads);

const run = (cmd: string, args: string[]) => shell(cmd, args, process.cwd());
const decoded = <S extends Schema.Decoder<unknown>>(schema: S, text: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text));

/** The CLI's `job` before the move: the commands `src/forge/github.ts` ran. */
const githubCli = Effect.fn("benchmark.githubCli")(function* (ref: MrRef, name: string) {
  const repo = ref.project!.slice("github.com/".length);
  const view = yield* run("gh", ["pr", "view", ref.iid, "--repo", repo, "--json", "headRefOid"]);
  const head = decoded(Schema.Struct({ headRefOid: Schema.String }), view.stdout)?.headRefOid;
  if (head === undefined) return yield* Effect.die(`gh could not read ${repo}#${ref.iid}`);
  const query = `check_name=${encodeURIComponent(name)}`;
  const listed = yield* run("gh", ["api", `repos/${repo}/commits/${head}/check-runs?${query}`]);
  if (listed.code !== 0) return yield* Effect.die(`gh could not list the check runs on ${head}`);
});

const GitlabMr = Schema.Struct({
  sha: Schema.optionalKey(Schema.NullOr(Schema.String)),
  head_pipeline: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ id: Schema.Number, sha: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
const GitlabJobs = Schema.Array(Schema.Struct({ name: Schema.String }));

/** The CLI's `job` before the move: the commands `src/forge/gitlab.ts` ran. */
const gitlabCli = Effect.fn("benchmark.gitlabCli")(function* (ref: MrRef, name: string) {
  const project = ref.project!;
  const host = project.split("/")[0]!;
  const path = encodeURIComponent(project.slice(host.length + 1));
  yield* run("glab", ["--version"]);
  if ((yield* run("glab", ["auth", "status", "--hostname", host])).code !== 0)
    return yield* Effect.die(`glab is not logged in to ${host}`);
  const api = (route: string) =>
    run("glab", ["api", "--hostname", host, "-X", "GET", `projects/${path}/${route}`]);
  const view = yield* run("glab", ["mr", "view", ref.iid, "--repo", project, "-F", "json"]);
  const mr = decoded(GitlabMr, view.stdout);
  if (mr === undefined) return yield* Effect.die(`glab could not read ${project}!${ref.iid}`);
  const pipeline = mr.head_pipeline;
  if (pipeline == null) return;
  if (pipeline.sha && pipeline.sha !== mr.sha) yield* api(`repository/commits/${pipeline.sha}`);
  for (let page = 1; ; page++) {
    const listed = yield* api(`pipelines/${pipeline.id}/jobs?per_page=100&page=${page}`);
    const jobs = decoded(GitlabJobs, listed.stdout);
    if (jobs === undefined)
      return yield* Effect.die(`glab could not list the jobs of ${pipeline.id}`);
    if (jobs.some((one) => one.name === name) || jobs.length < 100) return;
  }
});

/** How long `read` took, in ms. */
const timed = <R>(read: Effect.Effect<void, never, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    yield* read;
    return Number((yield* Clock.currentTimeNanos) - start) / 1e6;
  });

const quantile = (times: ReadonlyArray<number>, q: number) => {
  const sorted = times.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};

interface Measured {
  readonly url: string | undefined;
  readonly name: string | undefined;
  readonly cli: (ref: MrRef, name: string) => Effect.Effect<void, never, BunServices.BunServices>;
}

const forgesProgram = Effect.gen(function* () {
  const rows: string[] = [];
  const medians: { cli: number; library: number }[] = [];
  const measured: Measured[] = [
    { url: values.github, name: values["github-job"], cli: githubCli },
    { url: values.gitlab, name: values["gitlab-job"], cli: gitlabCli },
  ];
  for (const { url, name, cli } of measured) {
    if (url === undefined || name === undefined) continue;
    const ref = mrRefOf(url);
    if (ref === null) return yield* Effect.die(`${url} is not a merge request`);
    const forge = forgeOf(ref);
    const library = Effect.flatMap(forge.job(ref, name, process.cwd(), shell), (read) =>
      read.ok ? Effect.void : Effect.die(read.reason),
    );
    const cliTimes: number[] = [];
    const libraryTimes: number[] = [];
    for (let n = 0; n < reads; n++) {
      cliTimes.push(yield* timed(cli(ref, name)));
      libraryTimes.push(yield* timed(library));
    }
    medians.push({ cli: quantile(cliTimes, 0.5), library: quantile(libraryTimes, 0.5) });
    for (const [transport, times] of [
      [forge.cli, cliTimes],
      ["forges", libraryTimes],
    ] satisfies [string, number[]][])
      rows.push(
        `| ${forge.display} | ${url} | ${transport} | ${reads} | ${quantile(times, 0.5).toFixed(0)} ms | ${quantile(times, 0.9).toFixed(0)} ms |`,
      );
  }
  const go = medians.every((one) => one.library <= one.cli);
  yield* Console.log(
    [
      "| Forge | Merge request | Transport | Reads | Median | p90 |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
      `${go ? "Go" : "No-go"}: the library's median \`job\` is ${go ? "no slower than" : "slower than"} the CLI's on ${go ? "every forge measured" : "a forge measured"}.`,
    ].join("\n"),
  );
});

BunRuntime.runMain(
  forgesProgram.pipe(Effect.provide(forgeHttpLayer), Effect.provide(BunServices.layer)),
);
