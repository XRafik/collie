// The host's merge: the landing attempt written before the forge is asked, its outcome after,
// and an attempt an earlier host left settled on the forge's word.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Result, Schema } from "effect";
import { foundationLayer, Registry, registryLayer } from "../src/engine";
import { agentsLayer } from "../src/agents";
import { land, readLanding, writeLanding, type Landing } from "../src/landing";
import type { Runner } from "../src/mr";
import { WorkflowError } from "../src/sdk";
import { FakeBin } from "./support/bin";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
  forgeOnPath,
  type FakeMr,
  type ForgeModel,
} from "./support/forge";
import { FakeHerdr, Rig } from "./support/recorder";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const MERGED = "35ae2cea5e5848602729dbc0e8a87ed0d9049c46";
const URL_OF = {
  gitlab: `https://${PROJECT.gitlab}/-/merge_requests/30`,
  github: `https://${PROJECT.github}/pull/30`,
} as const;

const model = (forge: "gitlab" | "github", over: Partial<FakeMr> = {}): ForgeModel => ({
  installed: true,
  loggedIn: [FORGE_HOST[forge]],
  login: "me",
  now: "2026-10-20T12:00:00Z",
  mrs: [
    {
      project: PROJECT[forge],
      iid: "30",
      state: "open",
      head: HEAD,
      targetBranch: "main",
      mergedSha: MERGED,
      ...over,
    },
  ],
});

const isMerge = (args: ReadonlyArray<string>) =>
  args.includes("PUT") && args.some((arg) => arg.endsWith("/merge"));

/** A Run's directory, and a forge whose merge also reads what the Run had recorded by then. */
const landing = Effect.fn("landing.landing")(function* (
  forge: "gitlab" | "github",
  over: Partial<FakeMr> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-landing-" });
  const fake = fakeForge(forge, model(forge, over));
  const seen: Array<Landing | null> = [];
  const run: Runner<FileSystem.FileSystem> = (cmd, args, cwd) =>
    Effect.gen(function* () {
      if (isMerge(args)) seen.push(yield* readLanding(runDir));
      return yield* fake.run(cmd, args, cwd);
    });
  const merge = (head = HEAD, mr: string | null = URL_OF[forge]) =>
    land({ runDir, mr, head, cwd: "/w", run });
  return { runDir, fake, seen, merge };
});

const attempt = (forge: "gitlab" | "github", over: Partial<Landing> = {}): Landing => ({
  state: "attempt",
  mr: URL_OF[forge],
  head: HEAD,
  at: "2026-10-20T11:00:00Z",
  ...over,
});

for (const forge of ["gitlab", "github"] as const) {
  test(`${forge}: the attempt is written before the forge is asked, and landed on its merge`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { runDir, seen, merge } = yield* landing(forge);
        expect(yield* merge()).toEqual({ _tag: "Merged", sha: MERGED });
        expect(seen).toEqual([
          { state: "attempt", mr: URL_OF[forge], head: HEAD, at: expect.any(String) },
        ]);
        expect(yield* readLanding(runDir)).toEqual({ ...seen[0]!, state: "landed", sha: MERGED });
        expect((yield* fs.readFileString(`${runDir}/log.txt`)).split("\n")).toEqual([
          `landing: attempting to merge ${URL_OF[forge]} at ${HEAD}`,
          `landing: merged ${URL_OF[forge]} at ${HEAD} as ${MERGED}`,
          "",
        ]);
      }),
    ));

  test(`${forge}: a refusal and a moved head withdraw the attempt`, () =>
    runEffect(
      Effect.gen(function* () {
        const refused = yield* landing(forge, { mergeable: "conflict" });
        const answer = yield* refused.merge();
        expect(answer._tag).toBe("Refused");
        expect(yield* readLanding(refused.runDir)).toMatchObject({
          state: "withdrawn",
          why: answer._tag === "Refused" ? answer.reason : "",
        });

        const moved = yield* landing(forge);
        expect(yield* moved.merge("0ld")).toEqual({ _tag: "HeadMoved", head: HEAD });
        expect(yield* readLanding(moved.runDir)).toMatchObject({
          state: "withdrawn",
          head: "0ld",
          why: `the head moved to ${HEAD}`,
        });
      }),
    ));

  test(`${forge}: a merge request someone else merged first answers merged outside this Run`, () =>
    runEffect(
      Effect.gen(function* () {
        const { runDir, merge } = yield* landing(forge, {
          state: "merged",
          mergedBy: "alice",
          mergedAt: "2026-10-20T11:30:00Z",
        });
        expect(yield* merge()).toEqual({
          _tag: "MergedOutside",
          sha: MERGED,
          by: "alice",
          at: "2026-10-20T11:30:00Z",
        });
        expect(yield* readLanding(runDir)).toMatchObject({
          state: "withdrawn",
          why: "merged outside this Run by alice",
        });
      }),
    ));

  test(`${forge}: a replay after a restart settles the attempt it left by the rule, merging only an open one`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const mine = yield* landing(forge, {
          state: "merged",
          mergedBy: "me",
          mergedAt: "2026-10-20T11:01:00Z",
        });
        yield* writeLanding(mine.runDir, attempt(forge));
        expect(yield* mine.merge()).toEqual({ _tag: "Merged", sha: MERGED });
        expect(yield* readLanding(mine.runDir)).toEqual(
          attempt(forge, { state: "landed", sha: MERGED }),
        );
        expect(mine.seen).toEqual([]);

        const theirs = yield* landing(forge, {
          state: "merged",
          mergedBy: "alice",
          mergedAt: "2026-10-20T11:01:00Z",
        });
        yield* writeLanding(theirs.runDir, attempt(forge));
        expect((yield* theirs.merge())._tag).toBe("MergedOutside");
        expect((yield* readLanding(theirs.runDir))?.state).toBe("withdrawn");
        expect(theirs.seen).toEqual([]);

        const open = yield* landing(forge);
        yield* writeLanding(open.runDir, attempt(forge));
        expect(yield* open.merge()).toEqual({ _tag: "Merged", sha: MERGED });
        expect(open.seen).toEqual([attempt(forge, { at: expect.any(String) })]);
        expect((yield* readLanding(open.runDir))?.state).toBe("landed");
        expect(
          (yield* fs.readFileString(`${open.runDir}/log.txt`)).split("\n").slice(1, 3),
        ).toEqual([
          `landing: withdrew the merge of ${URL_OF[forge]} at ${HEAD}: left unanswered by an earlier host`,
          `landing: attempting to merge ${URL_OF[forge]} at ${HEAD}`,
        ]);
      }),
    ));
}

test("a Run that recorded no merge request is refused, and the forge is not asked", () =>
  runEffect(
    Effect.gen(function* () {
      const { runDir, fake, merge } = yield* landing("github");
      const answer = yield* merge(HEAD, null).pipe(Effect.result);
      expect(Result.isFailure(answer)).toBe(true);
      if (Result.isFailure(answer)) {
        expect(Schema.is(WorkflowError)(answer.failure)).toBe(true);
        expect(answer.failure.reason).toBe("this Run has recorded no merge request to merge");
      }
      expect(fake.calls).toEqual([]);
      expect(yield* readLanding(runDir)).toBeNull();
    }),
  ));

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const withMachine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(registryLayer(rig.stateDir, { userDir: rig.userDir })),
    Effect.provide(
      agentsLayer({
        dir: rig.stateDir,
        env: rig.pluginEnv(),
        herdr: new FakeHerdr(rig.pluginEnv()),
        harness: "claude",
        model: "opus",
        permissions: "auto",
        compactAtTokens: 0,
        help: () => Effect.succeed("--autocompact"),
      }),
    ),
    Effect.provide(foundationLayer({ dir: rig.stateDir, userDir: rig.userDir })),
    Effect.scoped,
  );

test(
  "the host merges the merge request a Run recorded, and its landing is a fact of the Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        expect((yield* exec(["git", "init", "--quiet", rig.projectDir])).exitCode).toBe(0);
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        try {
          const fake = yield* forgeOnPath(bin, "github", model("github"));
          yield* Effect.gen(function* () {
            const registry = yield* Registry;
            const generation = yield* registry.load(
              new URL("./fixtures/workflows/merges.workflow.ts", import.meta.url).pathname,
            );
            const landed = yield* registry.start({
              generation,
              request: "lands",
              project: rig.projectDir,
              input: { mr: URL_OF.github, head: HEAD },
              handsOver: true,
            });
            expect(yield* registry.result(landed.runId)).toEqual({ _tag: "Merged", sha: MERGED });
            expect((yield* registry.view(landed.runId))?.landing).toMatchObject({
              state: "landed",
              mr: URL_OF.github,
              head: HEAD,
              sha: MERGED,
            });

            const none = yield* registry.start({
              generation,
              request: "none",
              project: rig.projectDir,
              input: { mr: "", head: HEAD },
              handsOver: true,
            });
            const refused = yield* registry.result(none.runId).pipe(Effect.result);
            expect(Result.isFailure(refused)).toBe(true);
            if (Result.isFailure(refused))
              expect(refused.failure.reason).toContain("no merge request");
            expect((yield* registry.view(none.runId))?.landing).toBeNull();
          }).pipe(withMachine);
          expect((yield* fake.model()).merges).toHaveLength(1);
        } finally {
          yield* bin.restore();
        }
      }),
    ),
  30_000,
);
