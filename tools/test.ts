// `bun run test`: the suite, against executables built from this tree.
//
// A test that starts a host, runs a command or answers as herdr starts a process, and the
// suite starts well over a thousand. From the sources each one spends most of a second
// loading modules; compiled to bytecode it is a fraction of that. So this builds `collie`
// the way a release does and both CLI fakes the same way, then runs the suite with
// `COLLIE_TEST_BINARY`, `COLLIE_TEST_FAKE_HERDR` and `COLLIE_TEST_FAKE_FORGE` naming them.
// `bun test <file>` on its own still runs the sources, which is the quicker loop for one file.
//
// A suite that was killed left its files' roots, and maybe processes carrying their marker:
// those whose pid is dead are removed before this one starts.
//
// One suite runs at a time on a machine; the next waits for its turn. Several Runs each
// running the whole suite at once loaded vm-mk past 50 on 16 cores, and every one of them
// took longer than it would have in a queue.
//
// One worker per available core. Load averages include this suite's previous run and IO
// waits, so subtracting them makes a repeat needlessly slower even after the CPU is free.
// The per-user lock keeps whole suites from competing for those cores.

import { availableParallelism, tmpdir } from "node:os";
import { resolve } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import solidPlugin from "@opentui/solid/bun-plugin";
import { Effect } from "effect";
import { inTurn } from "./suite-lock";
import { sweepDeadRoots } from "../test/support/sweep";
import { LIVE_HARNESSES } from "../test/support/live-switch";

const out = resolve(".scratch/test-bin");
const collie = `${out}/collie`;
const herdr = `${out}/fake-herdr`;
const forge = `${out}/fake-forge`;

/** This environment, less the switch for live-harness tests, which only `test:live` sets. */
const suiteEnv = () => {
  const { [LIVE_HARNESSES]: _, ...rest } = process.env;
  return rest;
};

const suite = Effect.promise(async () => {
  const started = performance.now();
  sweepDeadRoots(tmpdir());
  const built = await Promise.all([
    Bun.spawn(["bun", "run", "tools/build.ts", `${process.platform}-${process.arch}`, collie], {
      stdout: "ignore",
      stderr: "inherit",
    }).exited,
    Bun.build({
      entrypoints: ["test/support/fake-herdr.ts"],
      target: "bun",
      plugins: [solidPlugin],
      bytecode: true,
      format: "esm",
      compile: { outfile: herdr },
    }).then((result) => (result.success ? 0 : 1)),
    Bun.build({
      entrypoints: ["test/support/forge-bin.ts"],
      target: "bun",
      bytecode: true,
      format: "esm",
      compile: { outfile: forge },
    }).then((result) => (result.success ? 0 : 1)),
  ]);
  if (built.some((code) => code !== 0)) {
    console.error("test: could not build the executables the suite runs");
    return 1;
  }
  // A fresh checkout must start its longest files first too. These are durations, never
  // results: Bun still discovers every test, and replaces the estimates after this run.
  const timings = ".scratch/test-timings.json";
  if (!(await Bun.file(timings).exists())) {
    await Bun.write(timings, Bun.file(new URL("./test-timings.json", import.meta.url)));
  }
  const workers = availableParallelism();
  const exit = await Bun.spawn(
    [
      "bun",
      "test",
      `--parallel=${workers}`,
      "--timeout=30000",
      `--timings=${timings}`,
      "--update-timings",
      ...Bun.argv.slice(2),
    ],
    {
      env: {
        ...suiteEnv(),
        COLLIE_TEST_BINARY: collie,
        COLLIE_TEST_FAKE_HERDR: herdr,
        COLLIE_TEST_FAKE_FORGE: forge,
      },
      stdio: ["inherit", "inherit", "inherit"],
    },
  ).exited;
  console.error(`test: ${((performance.now() - started) / 1_000).toFixed(2)} s including builds`);
  return exit;
});

// Per user, so one user's suite never waits on a lock it cannot break.
const lock = `${tmpdir()}/collie-test-suite-${process.getuid?.() ?? "user"}.lock`;

BunRuntime.runMain(
  inTurn(lock, suite, (line) => Effect.sync(() => console.error(line))).pipe(
    Effect.flatMap((code) => Effect.sync(() => process.exit(code))),
    Effect.provide(BunServices.layer),
  ),
);
