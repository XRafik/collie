import { describe, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import type { MrForge } from "../src/board-model";
import { FORGES } from "../src/forge/forge";
import { rollupChecks } from "../src/forge/github";
import { shell } from "../src/mr";
import { FakeBin } from "./support/bin";
import { runEffect } from "./support/effect";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
  forgeOnPath,
  CLI,
  type FakeMr,
  type ForgeModel,
} from "./support/forge";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const MERGED = "35ae2cea5e5848602729dbc0e8a87ed0d9049c46";

const mr = (forge: MrForge, over: Partial<FakeMr> = {}): FakeMr => ({
  project: PROJECT[forge],
  iid: "30",
  state: "open",
  head: HEAD,
  ...over,
});

const model = (forge: MrForge, over: Partial<ForgeModel> = {}): ForgeModel => ({
  installed: true,
  loggedIn: [FORGE_HOST[forge]],
  login: "me",
  mrs: [mr(forge)],
  ...over,
});

const ref = (forge: MrForge) => ({ project: PROJECT[forge], iid: "30" });

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];
  const host = FORGE_HOST[name];

  describe(`the ${name} forge`, () => {
    test("is ready only with its CLI installed and logged in to the host", () =>
      runEffect(
        Effect.gen(function* () {
          const ask = (over: Partial<ForgeModel>) =>
            forge.ready(PROJECT[name], "/w", fakeForge(name, model(name, over)).run);
          expect(yield* ask({})).toEqual({ ok: true, reason: "" });
          expect(yield* ask({ installed: false })).toEqual({
            ok: false,
            reason: `${CLI[name]} is not installed`,
          });
          expect(yield* ask({ loggedIn: [] })).toEqual({
            ok: false,
            reason: `${CLI[name]} is not logged in to ${host}`,
          });
        }),
      ));

    test("says who its CLI is logged in as, and null where it will not", () =>
      runEffect(
        Effect.gen(function* () {
          expect(yield* forge.login("/w", fakeForge(name, model(name)).run)).toBe("me");
          expect(yield* forge.login("/w", fakeForge(name, model(name, { login: null })).run)).toBe(
            null,
          );
        }),
      ));

    test("reads a merge request open, merged or closed, with its head and merge commit", () =>
      runEffect(
        Effect.gen(function* () {
          const read = (over: Partial<FakeMr>) =>
            forge.details(
              ref(name),
              "/w",
              fakeForge(name, model(name, { mrs: [mr(name, over)] })).run,
            );
          const open = yield* read({});
          expect(open).toMatchObject({
            _tag: "Details",
            iid: "30",
            project: PROJECT[name],
            state: name === "gitlab" ? "opened" : "open",
            head: HEAD,
            headSha: "1a2b3c4",
            mergedSha: "",
          });
          expect(yield* read({ state: "merged", mergedSha: MERGED })).toMatchObject({
            state: "merged",
            mergedSha: MERGED,
          });
          expect(yield* read({ state: "closed" })).toMatchObject({ state: "closed" });
        }),
      ));

    test("reads its checks passed, failed or running", () =>
      runEffect(
        Effect.gen(function* () {
          const checksOf = (checks: FakeMr["checks"]) =>
            Effect.map(
              forge.details(
                ref(name),
                "/w",
                fakeForge(name, model(name, { mrs: [mr(name, { checks })] })).run,
              ),
              (panel) => (panel._tag === "Details" ? panel.checks : undefined),
            );
          expect(yield* checksOf([{ name: "test", state: "passed" }])).toEqual({ state: "passed" });
          expect(
            yield* checksOf([
              { name: "test", state: "passed" },
              { name: "lint", state: "failed" },
            ]),
          ).toEqual({ state: "failed", name: name === "gitlab" ? "pipeline" : "lint" });
          expect(yield* checksOf([{ name: "e2e", state: "running" }])).toEqual({
            state: "running",
          });
          expect(yield* checksOf([])).toEqual({ state: "unknown" });
        }),
      ));

    test("says why a merge request it cannot read is unavailable", () =>
      runEffect(
        Effect.gen(function* () {
          const gone = yield* forge.details(
            { project: PROJECT[name], iid: "99" },
            "/w",
            fakeForge(name, model(name)).run,
          );
          expect(gone._tag).toBe("Unavailable");
        }),
      ));

    test("puts one note on a merge request, and says when it could not", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name));
          const posted = yield* forge.note(ref(name), "LGTM", "/w", fake.run);
          expect(posted.ok).toBe(true);
          expect(Object.values(fake.model().notes ?? {})).toEqual([["LGTM"]]);
          const missed = yield* forge.note(
            { project: PROJECT[name], iid: "99" },
            "LGTM",
            "/w",
            fake.run,
          );
          expect(missed.ok).toBe(false);
        }),
      ));
  });
}

describe("the gitlab forge's deploys", () => {
  const tierOf = (over: Partial<ForgeModel>) =>
    FORGES.gitlab.liveTier(
      ref("gitlab"),
      MERGED,
      "/w",
      fakeForge("gitlab", model("gitlab", over)).run,
    );
  const environments = (stage: string, prod: string) => [
    { name: "stage", tier: "staging", deployed: stage },
    { name: "prod", tier: "production", deployed: prod },
  ];

  test("say production, then stage, then nothing, and nothing where GitLab does not answer", () =>
    runEffect(
      Effect.gen(function* () {
        const ancestry = { child: [MERGED] };
        expect(yield* tierOf({ environments: environments("child", MERGED), ancestry })).toBe(
          "production",
        );
        expect(yield* tierOf({ environments: environments("child", "0ld"), ancestry })).toBe(
          "staging",
        );
        expect(yield* tierOf({ environments: environments("0ld", "0ld"), ancestry })).toBe(null);
        expect(yield* tierOf({ environments: [] })).toBe(null);
        expect(
          yield* tierOf({ environments: environments(MERGED, MERGED), deploysDown: true }),
        ).toBe(null);
      }),
    ));
});

test("the github forge's deploys are not read yet", () =>
  runEffect(
    Effect.gen(function* () {
      expect(
        yield* FORGES.github.liveTier(
          ref("github"),
          MERGED,
          "/w",
          fakeForge("github", model("github")).run,
        ),
      ).toBe(null);
    }),
  ));

test("a status context's state counts as a check run's conclusion does", () => {
  expect(rollupChecks([{ context: "ci/build", state: "PENDING" }])).toEqual({ state: "running" });
  expect(rollupChecks([{ context: "ci/build", state: "SUCCESS" }])).toEqual({ state: "passed" });
  expect(rollupChecks([{ context: "ci/build", state: "ERROR" }])).toEqual({
    state: "failed",
    name: "ci/build",
  });
});

test("each fake answers the same on PATH, logs what it got, and keeps what was posted", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* FakeBin.make(yield* fs.makeTempDirectoryScoped({ prefix: "forge-bin-" }));
      try {
        for (const name of ["gitlab", "github"] as const) {
          const onPath = yield* forgeOnPath(bin, name, model(name));
          expect(yield* FORGES[name].details(ref(name), "/", shell)).toMatchObject({
            _tag: "Details",
            head: HEAD,
          });
          expect((yield* FORGES[name].note(ref(name), "LGTM", "/", shell)).ok).toBe(true);
          expect(Object.values((yield* onPath.model()).notes ?? {})).toEqual([["LGTM"]]);
          expect((yield* onPath.calls()).length).toBeGreaterThan(0);
        }
      } finally {
        yield* bin.restore();
      }
    }),
  ));
