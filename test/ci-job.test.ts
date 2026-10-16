// A check left to CI waits on its job through the forge, and says what it waits on while it
// does (ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job).

import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Schedule } from "effect";
import { ciJob } from "../src/ci-job";
import type { Runner } from "../src/mr";
import { readVerifications, verifyingIn, type CheckCommand } from "../src/verify";
import type { VerifySpec } from "../src/verify-spec";
import { exec } from "./support/command";
import { fastForward, runEffect } from "./support/effect";
import { FORGE_HOST, PROJECT, fakeForge, type FakeJob } from "./support/forge";

const NUXI: VerifySpec = {
  name: "nuxi",
  executable: "bunx",
  argv: ["nuxi", "typecheck"],
  cwd: ".",
  ci: "nuxi-typecheck",
};
const MR = `https://${PROJECT.gitlab}/-/merge_requests/31`;

/** A Run's directories, a checkout at one commit, and a forge whose merge request is on `head`. */
const waiting = Effect.fn("ciJob.waiting")(function* (
  state: FakeJob["state"],
  mr: string | null = MR,
  head?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ci-job-" });
  const cwd = `${root}/checkout`;
  yield* fs.makeDirectory(cwd);
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "one",
      "--allow-empty",
    ],
  ])
    yield* exec(["git", ...args], { cwd });
  const at = (yield* exec(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
  const forge = fakeForge("gitlab", {
    installed: true,
    loggedIn: [FORGE_HOST.gitlab],
    login: "me",
    mrs: [
      {
        project: PROJECT.gitlab,
        iid: "31",
        state: "open",
        head: head ?? at,
        jobs: [{ name: "nuxi-typecheck", state }],
      },
    ],
  });
  const run: Runner = (cmd, args, where) =>
    cmd === "git" && args.join(" ") === "rev-parse HEAD"
      ? Effect.succeed({ code: 0, stdout: `${at}\n` })
      : forge.run(cmd, args, where);
  const command: CheckCommand = { ...NUXI, executable: "/usr/bin/bunx", cwd };
  const asked = {
    runId: "r1",
    runDir: `${root}/run`,
    journal: `${root}/evidence`,
    cwd,
    spec: NUXI,
    command,
    mr,
    wait: true,
    run,
  };
  return { asked, at, root, forge };
});

test("a job still running is waited on, saying which check, job and commit, and a stop records nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { asked, at } = yield* waiting("running");
      const fiber = yield* Effect.forkChild(ciJob(asked));
      const marker = yield* Effect.retry(
        verifyingIn(asked.runDir).pipe(Effect.filterOrFail((one) => one !== null)),
        { schedule: Schedule.spaced("20 millis"), times: 250 },
      );
      expect(marker).toMatchObject({
        name: "nuxi",
        pass: "ci",
        job: "nuxi-typecheck",
        revision: at,
      });
      expect(yield* fs.readFileString(`${asked.runDir}/log.txt`)).toContain(
        `ci: waiting on job nuxi-typecheck for nuxi on ${at}`,
      );
      // As a merge stops the Run while it waits.
      yield* Fiber.interrupt(fiber);
      expect(yield* verifyingIn(asked.runDir)).toBeNull();
      expect(yield* readVerifications(asked.journal).pipe(Effect.orElseSucceed(() => []))).toEqual(
        [],
      );
    }),
  ));

test("a job not finished after 2 hours leaves its check unproved, saying so", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const { asked, at, forge } = yield* waiting("pending");
        expect(yield* ciJob(asked)).toEqual({
          unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${at.slice(0, 12)} is still pending after 2 hours`,
          state: "pending",
          url: `https://${PROJECT.gitlab}/-/jobs/1`,
        });
        // Every 30 s, so about 240 reads.
        expect(forge.calls.filter((call) => call.includes("/jobs")).length).toBeGreaterThan(200);
        expect(yield* verifyingIn(asked.runDir)).toBeNull();
      }),
      60_000,
    ),
  ));

test("a merge request whose head is not yet this checkout's is waited on, and its pass then recorded once", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked } = yield* waiting("passed", MR, "an-older-head");
      expect(yield* ciJob({ ...asked, wait: false })).toMatchObject({ state: "pending" });
      const { asked: here } = yield* waiting("passed");
      const proved = yield* ciJob(here);
      expect(proved).toMatchObject({ proved: { pass: "ci", name: "nuxi" } });
      expect(yield* ciJob(here)).toEqual(proved);
      expect(yield* readVerifications(here.journal)).toHaveLength(1);
    }),
  ));

test("a Run with no merge request has its check left to CI unproved, and the forge is not asked", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting("passed", null);
      expect(yield* ciJob(asked)).toEqual({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${at.slice(0, 12)} was never read: this Run has no merge request`,
        state: null,
        url: null,
      });
      expect(forge.calls).toEqual([]);
    }),
  ));
