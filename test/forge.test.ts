import { describe, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import type { MrForge } from "../src/board-model";
import { FORGES } from "../src/forge/forge";
import { rollupChecks } from "../src/forge/github";
import { shell } from "../src/mr";
import { FakeBin } from "./support/bin";
import { epochMs } from "../src/time";
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

    test("reads the whole panel: draft, people, branches, approval, auto-merge and when it moved", () =>
      runEffect(
        Effect.gen(function* () {
          const read = (over: Partial<FakeMr>) =>
            forge.details(
              ref(name),
              "/w",
              fakeForge(name, model(name, { mrs: [mr(name, over)] })).run,
            );
          expect(
            yield* read({
              title: "Cards",
              author: "ann",
              assignees: ["me"],
              sourceBranch: "me/cards",
              targetBranch: "main",
              approved: true,
              autoMerge: true,
              updatedAt: "2026-10-01T12:00:00Z",
            }),
          ).toMatchObject({
            title: "Cards",
            author: "ann",
            assignees: ["me"],
            sourceBranch: "me/cards",
            targetBranch: "main",
            approvals: "approved",
            autoMerge: true,
            updatedAt: epochMs("2026-10-01T12:00:00Z"),
          });
          expect(yield* read({ draft: true })).toMatchObject({ state: "draft", autoMerge: false });
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

    test("posts one note, and approves only where asked, saying what landed", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name));
          const noted = yield* forge.post(ref(name), "LGTM", false, "/w", fake.run);
          expect(noted.ok).toBe(true);
          expect(noted.message).not.toContain("approved");
          expect(fake.model().approved ?? []).toEqual([]);
          const approved = yield* forge.post(ref(name), "Clean", true, "/w", fake.run);
          expect(approved.message).toContain("and approved it");
          expect(Object.values(fake.model().notes ?? {})).toEqual([["LGTM", "Clean"]]);
          expect(fake.model().approved?.length).toBe(1);
          const missed = yield* forge.post(
            { project: PROJECT[name], iid: "99" },
            "LGTM",
            false,
            "/w",
            fake.run,
          );
          expect(missed.ok).toBe(false);
        }),
      ));

    test("reports an approval the forge refuses, with the note still posted", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name, { refusesApproval: true }));
          const posted = yield* forge.post(ref(name), "Clean", true, "/w", fake.run);
          expect(posted.ok).toBe(true);
          expect(posted.message).toContain("and did not approve it");
          expect(Object.values(fake.model().notes ?? {})).toEqual([["Clean"]]);
        }),
      ));

    test("lists my open merge requests, as assignee or author, once each", () =>
      runEffect(
        Effect.gen(function* () {
          const mrs = [
            mr(name, { iid: "31", assignees: ["me"], title: "Mine" }),
            mr(name, { iid: "32", author: "me", assignees: ["me"], title: "Both" }),
            mr(name, { iid: "33", author: "ann" }),
            mr(name, { iid: "34", author: "me", state: "merged" }),
          ];
          expect(
            yield* forge.mine(PROJECT[name], "/w", fakeForge(name, model(name, { mrs })).run),
          ).toEqual([
            { iid: "31", title: "Mine" },
            { iid: "32", title: "Both" },
          ]);
        }),
      ));

    test("opens one in a browser", () =>
      runEffect(
        Effect.gen(function* () {
          const fake = fakeForge(name, model(name));
          expect((yield* forge.open(ref(name), "/w", fake.run)).code).toBe(0);
          expect(fake.calls.at(-1)).toContain("--web");
        }),
      ));

    test("writes the commands a reviewer reads and checks one out with, for its own CLI", () => {
      const said = forge.review(ref(name));
      for (const line of [said.diff, said.view, said.checkout]) {
        expect(line.startsWith(`${CLI[name]} `)).toBe(true);
        expect(line).toContain("30");
      }
    });
  });
}

const URLS = {
  gitlab: {
    run: "https://gitlab.example.com/group/app/-/pipelines/7",
    other: "https://github.com/owner/repo/actions/runs/7",
  },
  github: {
    run: "https://github.com/owner/repo/actions/runs/7",
    other: "https://gitlab.example.com/group/app/-/pipelines/7",
  },
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];

  describe(`the ${name} forge's deploys`, () => {
    const tierOf = (over: Partial<ForgeModel>) =>
      forge.liveTier(ref(name), MERGED, "/w", fakeForge(name, model(name, over)).run);
    const environments = (stage: string, prod: string, failed = "") => [
      { name: "stage", tier: "staging", deployed: stage },
      { name: "production", tier: "production", deployed: prod, failed },
    ];
    const ancestry = { child: [MERGED] };

    test("say production, then stage, then nothing, and nothing where the forge does not answer", () =>
      runEffect(
        Effect.gen(function* () {
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

    test("go by what is live, not by a newer deployment that failed", () =>
      runEffect(
        Effect.gen(function* () {
          expect(
            yield* tierOf({ environments: environments("0ld", "0ld", MERGED), ancestry }),
          ).toBe(null);
        }),
      ));
  });

  test(`the ${name} forge says how its own pipeline or Actions run went, and nothing of the other's`, () =>
    runEffect(
      Effect.gen(function* () {
        const status = (url: string, runs: ForgeModel["runs"]) =>
          forge.runStatus(url, "/w", fakeForge(name, model(name, { runs })).run);
        expect(
          yield* status(URLS[name].run, { "7": { status: "completed", conclusion: "success" } }),
        ).toBe(name === "gitlab" ? "completed" : "success");
        expect(yield* status(URLS[name].run, { "7": { status: "running" } })).toBe("running");
        expect(yield* status(URLS[name].other, { "7": { status: "running" } })).toBe(null);
        expect(yield* status(URLS[name].run, {})).toBe(null);
      }),
    ));
}

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
          expect((yield* FORGES[name].post(ref(name), "LGTM", false, "/", shell)).ok).toBe(true);
          expect(Object.values((yield* onPath.model()).notes ?? {})).toEqual([["LGTM"]]);
          expect((yield* onPath.calls()).length).toBeGreaterThan(0);
        }
      } finally {
        yield* bin.restore();
      }
    }),
  ));

const TEMPLATES = {
  gitlab: [".gitlab/merge_request_templates/default.md"],
  github: [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
  ],
} as const;

for (const name of ["gitlab", "github"] as const) {
  const forge = FORGES[name];

  test(`the ${name} forge finds a branch's open merge request, none, and auto-merge`, () =>
    runEffect(
      Effect.gen(function* () {
        const open = mr(name, { iid: "31", sourceBranch: "me/x" });
        const ask = (mrs: ReadonlyArray<FakeMr>) =>
          forge.forBranch(PROJECT[name], "me/x", "/w", fakeForge(name, model(name, { mrs })).run);
        expect(yield* ask([mr(name, { sourceBranch: "other" })])).toEqual({ ok: true, open: null });
        expect(yield* ask([open])).toMatchObject({
          ok: true,
          open: { iid: "31", autoMerge: false },
        });
        expect(yield* ask([{ ...open, autoMerge: true }])).toMatchObject({
          open: { autoMerge: true },
        });
        expect(
          (yield* forge.forBranch(
            PROJECT[name],
            "me/x",
            "/w",
            fakeForge(name, model(name, { installed: false })).run,
          )).ok,
        ).toBe(false);
      }),
    ));

  test(`the ${name} forge finds the repository's template wherever it keeps one, and none`, () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const where of TEMPLATES[name]) {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "forge-template-" });
          expect(yield* forge.template(dir)).toBe(null);
          const parent = where.split("/").slice(0, -1).join("/");
          if (parent !== "") yield* fs.makeDirectory(`${dir}/${parent}`, { recursive: true });
          yield* fs.writeFileString(`${dir}/${where}`, "## Description\n");
          expect(yield* forge.template(dir)).toBe(where);
        }
      }),
    ));
}
