import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { buildBoard } from "../src/board";
import { sectionOf } from "../src/board-model";
import { readDispositions } from "../src/disposition";
import { readForge, readMrStates, settleMerges } from "../src/merges";
import { appendVerification } from "../src/verify";
import type { Runner } from "../src/mr";
import { readEnv } from "../src/env";
import { madeRun } from "./support/records";
import { task } from "./support/task";
import { runEffect } from "./support/effect";
import { epochMs } from "../src/time";
import { fakeForge, type Check, type FakeMr, type ForgeModel } from "./support/forge";

const GITLAB = "gitlab.cego.dk/mk/collie";

/** The shared fake of a forge, with its calls also kept in `log`. */
function forge(name: "gitlab" | "github", over: Partial<ForgeModel>, log: string[] = []): Runner {
  const fake = fakeForge(name, {
    installed: true,
    loggedIn: [name === "gitlab" ? "gitlab.cego.dk" : "github.com"],
    login: "mk",
    mrs: [],
    ...over,
  });
  return (cmd, args, cwd) =>
    Effect.tap(fake.run(cmd, args, cwd), () => Effect.sync(() => log.push(fake.calls.at(-1)!)));
}

const mr65 = (over: Partial<FakeMr>): FakeMr => ({
  project: GITLAB,
  iid: "65",
  state: "open",
  title: "Cards",
  ...over,
});

/** A GitLab that answers every readiness check and says one thing about its MR. */
const gitlab = (state: FakeMr["state"], log: string[] = []) =>
  forge("gitlab", { mrs: [mr65({ state })] }, log);

const MR = "https://gitlab.cego.dk/mk/collie/-/merge_requests/65";

const seeded = Effect.fn("merges.seeded")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-merges-" });
  const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
  const run = yield* madeRun(stateDir, {
    state: "succeeded",
    mr: MR,
    created: "2026-09-17T09:00:00Z",
  });
  return {
    stateDir,
    run,
    board: (over: Omit<Parameters<typeof buildBoard>[0], "env" | "runs"> = {}) =>
      buildBoard({ env, runs: [run], ...over }),
  };
});

test("a merge GitLab reports lands the work: a disposition by gitlab, and the card moves", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, run, board: boardOf } = yield* seeded();
      const before = yield* boardOf({ mrStates: new Map() });
      expect(before[0]!.sentence).toBe("mk/collie!65 is open; nothing has checked it.");

      const states = new Map();
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("merged"),
        views: before,
        now: epochMs("2026-09-17T10:00:00Z"),
        checked: new Map(),
        states,
        panels: new Map(),
      });

      const recorded = yield* readDispositions(run.dir);
      expect(recorded.map((line) => [line.by, line.kind, line.ref])).toEqual([
        ["gitlab", "merged", "mk/collie!65"],
      ]);
      expect(yield* readMrStates(stateDir)).toEqual(new Map([["mk/collie!65", "merged"]]));
      // Nothing passed in: the CLI's board reads what the pane's watch wrote.
      const after = yield* boardOf({ now: epochMs("2026-09-17T11:00:00Z") });
      expect(after[0]!.landed).toBe(true);
      expect(after[0]!.sentence).toBe("Merged as mk/collie!65.");
    }),
  ));

test("a closed merge request is news, not a verdict, and a fresh answer is not asked for again", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, run, board: boardOf } = yield* seeded();
      const views = yield* boardOf({ mrStates: new Map() });
      const log: string[] = [];
      const checked = new Map<string, number>();
      const states = new Map();
      const now = epochMs("2026-09-17T10:00:00Z");
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("closed", log),
        views,
        now,
        checked,
        states,
        panels: new Map(),
      });
      expect(yield* readDispositions(run.dir)).toEqual([]);
      const again = yield* boardOf({ mrStates: states, now });
      expect(again[0]!.sentence).toBe("Merge request mk/collie!65 closed without merging.");
      expect(again[0]!.landed).toBe(false);

      // Two minutes on: nothing is asked, the last answer stands.
      const asked = log.length;
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("closed", log),
        views,
        now: now + 120_000,
        checked,
        states,
        panels: new Map(),
      });
      expect(log.length).toBe(asked);
    }),
  ));

/** A GitLab whose merge landed and whose deploy jobs have taken it as far as `live` says. */
function deployed(live: { stage: string; prod: string | null }, log: string[] = []): Runner {
  const merged = "35ae2cea5e5848602729dbc0e8a87ed0d9049c46";
  return forge(
    "gitlab",
    {
      mrs: [mr65({ state: "merged", mergedSha: merged })],
      environments: [
        { name: "stage", tier: "staging", deployed: live.stage },
        { name: "prod", tier: "production", deployed: live.prod ?? "0000000" },
        { name: "review/x", tier: "development", deployed: merged },
      ],
      // Only a descendant of the merge commit has it as the merge-base.
      ancestry: { child: [merged] },
    },
    log,
  );
}

test("a merged card follows its deploy jobs: on stage, then in production, then asked no more", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, run, board: boardOf } = yield* seeded();
      const states = new Map();
      const checked = new Map<string, number>();
      let now = epochMs("2026-09-17T10:00:00Z");
      const settle = (gitlab: Runner, log: string[] = []) =>
        Effect.gen(function* () {
          const current = yield* boardOf({ mrStates: states, now });
          yield* settleMerges({
            stateDir,
            cwd: "/project",
            run: gitlab,
            views: current,
            now,
            checked,
            states,
            panels: new Map(),
          });
          return log;
        });

      // Stage has a child of the merge commit; prod still runs something older.
      yield* settle(deployed({ stage: "child", prod: "0000000" }));
      expect(states.get("mk/collie!65")).toBe("on-stage");
      expect((yield* readDispositions(run.dir)).map((line) => line.kind)).toEqual(["merged"]);
      let board = yield* boardOf({ now });
      expect(board[0]!.landed).toBe(true);
      expect(board[0]!.sentence).toBe("Merged as mk/collie!65. On stage.");

      // Disposed of, and still followed: production now has the merge commit itself.
      now += 6 * 60_000;
      yield* settle(deployed({ stage: "child", prod: "35ae2cea5e5848602729dbc0e8a87ed0d9049c46" }));
      expect(states.get("mk/collie!65")).toBe("in-prod");
      board = yield* boardOf({ now });
      expect(board[0]!.sentence).toBe("Merged as mk/collie!65. In production.");
      // One merged disposition, not one per round.
      expect((yield* readDispositions(run.dir)).map((line) => line.kind)).toEqual(["merged"]);

      // In production is as far as it goes: GitLab is not asked about it again.
      now += 6 * 60_000;
      const log: string[] = [];
      yield* settle(deployed({ stage: "child", prod: "child" }, log), log);
      expect(log).toEqual([]);
    }),
  ));

test("what is working, or already disposed of, is not asked about", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-merges-" });
      const log: string[] = [];
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("merged", log),
        views: [
          task({ id: "working", state: "active", mr: MR }),
          task({
            id: "landed",
            state: "done",
            landed: true,
            mr: MR,
            disposition: "superseded mk/collie!66",
          }),
          task({ id: "no-mr", state: "failed" }),
        ],
        now: epochMs("2026-09-17T10:00:00Z"),
        checked: new Map(),
        states: new Map(),
        panels: new Map(),
      });
      expect(log).toEqual([]);
    }),
  ));

// The forge's own checks, beside the state: what the card says about whether it is ready.

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

/** A GitLab whose merge request is open with its head pipeline `state`. */
const piped = (state: Check["state"]): Runner =>
  forge("gitlab", { mrs: [mr65({ head: HEAD, checks: [{ name: "build", state }] })] });

const PR = "https://github.com/cego/collie/pull/30";

/** A GitHub whose pull request #30 is `state`, with `checks`. */
const github = (
  state: FakeMr["state"],
  checks: ReadonlyArray<Check>,
  over: Partial<ForgeModel> = {},
): Runner =>
  forge("github", {
    mrs: [
      {
        project: "github.com/cego/collie",
        iid: "30",
        state,
        head: HEAD,
        mergedSha: state === "merged" ? HEAD : "",
        checks,
      },
    ],
    ...over,
  });

/** The card after one round of the watch, read back the way the CLI's board reads it. */
const cardAfter = Effect.fn("merges.cardAfter")(function* (mr: string, run: Runner) {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-forge-" });
  const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
  const made = yield* madeRun(stateDir, {
    state: "succeeded",
    mr,
    created: "2026-09-17T09:00:00Z",
  });
  const now = epochMs("2026-09-17T10:00:00Z");
  const views = yield* buildBoard({ env, runs: [made], now });
  yield* settleMerges({
    stateDir,
    cwd: "/project",
    run,
    views,
    now,
    checked: new Map(),
    states: new Map(),
    panels: new Map(),
  });
  const [card] = yield* buildBoard({ env, runs: [made], now });
  return { card: card!, run: made, stateDir };
});

test("a GitLab pipeline that failed, is running or passed is what the card's checks say", () =>
  runEffect(
    Effect.gen(function* () {
      const red = (yield* cardAfter(MR, piped("failed"))).card;
      expect(red.checks).toEqual({ state: "failed", name: "pipeline", at: HEAD });
      expect(red.sentence).toBe(
        "mk/collie!65 is open, but pipeline failed at 1a2b3c4. Next: fix pipeline.",
      );
      const going = (yield* cardAfter(MR, piped("running"))).card;
      expect(going.checks).toEqual({ state: "running" });
      expect(going.sentence).toBe("mk/collie!65 is open; its pipeline is still running.");
      const green = (yield* cardAfter(MR, piped("passed"))).card;
      expect(green.ready).toBe(true);
      expect(green.sentence).toBe(
        "Ready to release: mk/collie!65 is open and its checks passed at 1a2b3c4. Next: merge it.",
      );
    }),
  ));

test("a GitHub check rollup that is red, pending or green is what the card's checks say", () =>
  runEffect(
    Effect.gen(function* () {
      const lint = { name: "lint", state: "failed" } as const;
      const tests = { name: "test", state: "passed" } as const;
      const queued = { name: "e2e", state: "running" } as const;

      const red = (yield* cardAfter(PR, github("open", [tests, lint]))).card;
      expect(red.checks).toEqual({ state: "failed", name: "lint", at: HEAD });
      expect(red.sentence).toBe(
        "cego/collie#30 is open, but lint failed at 1a2b3c4. Next: fix lint.",
      );
      expect((yield* cardAfter(PR, github("open", [tests, queued]))).card.checks).toEqual({
        state: "running",
      });
      const green = (yield* cardAfter(PR, github("open", [tests]))).card;
      expect(green.ready).toBe(true);
      expect(green.sentence).toBe(
        "Ready to release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: merge it.",
      );
    }),
  ));

test("a merged GitHub pull request lands its card, by github's word", () =>
  runEffect(
    Effect.gen(function* () {
      const { card, run } = yield* cardAfter(PR, github("merged", []));
      const recorded = yield* readDispositions(run.dir);
      expect(recorded.map((line) => [line.by, line.kind, line.ref])).toEqual([
        ["github", "merged", "cego/collie#30"],
      ]);
      expect(sectionOf(card)).toBe("finished");
      expect(card.sentence).toBe("Merged as cego/collie#30.");
    }),
  ));

test("no gh, or a gh nobody logged in to, leaves the card unchecked and says nothing of it", () =>
  runEffect(
    Effect.gen(function* () {
      for (const over of [{ installed: false }, { loggedIn: [] }]) {
        const { card } = yield* cardAfter(PR, github("open", [], over));
        expect(card.checks).toEqual({ state: "unchecked" });
        expect(card.sentence).toBe("cego/collie#30 is open; nothing has checked it.");
      }
    }),
  ));

test("a board file in the old shape still reads, with nothing known of the forge's checks", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, board: boardOf } = yield* seeded();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/board`, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/board/mr-states.json`, '{"mk/collie!65":"open"}\n');
      expect(yield* readMrStates(stateDir)).toEqual(new Map([["mk/collie!65", "open"]]));
      expect(yield* readForge(stateDir)).toEqual(new Map());
      const [card] = yield* boardOf({ now: epochMs("2026-09-17T10:00:00Z") });
      expect(card!.mrState).toBe("open");
      expect(card!.checks).toEqual({ state: "unchecked" });
    }),
  ));

test("green forge checks with Collie's evidence at an older head pass on the forge's word, at its head", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-forge-older-" });
      const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
      const made = yield* madeRun(stateDir, { state: "succeeded", mr: PR });
      // Red, but on a tree the pull request has moved past.
      yield* appendVerification(made.evidence, {
        id: "v-old",
        run: made.id,
        name: "test",
        executable: "/usr/bin/false",
        argv: [],
        cwd: "/project",
        start: { head_sha: "0ld0ld0", fingerprint: "f" },
        end: { head_sha: "0ld0ld0", fingerprint: "f" },
        exit: 1,
        seconds: 1,
        expect: "pass",
        tail: { stdout: "", stderr: "" },
        result: "fail",
        at: "2026-09-17T09:00:00Z",
        by: "collie",
      });
      const now = epochMs("2026-09-17T10:00:00Z");
      const tests = { name: "test", state: "passed" } as const;
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: github("open", [tests]),
        views: yield* buildBoard({ env, runs: [made], now }),
        now,
        checked: new Map(),
        states: new Map(),
        panels: new Map(),
      });
      const [card] = yield* buildBoard({ env, runs: [made], now });
      expect(card!.checks).toEqual({ state: "passed", at: HEAD });
      expect(card!.sentence).toContain("passed at 1a2b3c4.");
    }),
  ));
