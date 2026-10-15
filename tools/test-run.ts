// What a `bun run test` invocation is. One that names files or `--changed` is targeted: it
// needs few cores and, built into a directory of its own, shares nothing with a whole suite,
// so it takes no turn. Anything else is the whole suite.

import { type Duration, Effect, FileSystem, Path } from "effect";
import { inTurn } from "./suite-lock";

const exists = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(
    Effect.orElseSucceed(() => false),
  );

// ponytail: any word after an option is taken as its value, so `--bail <file>` waits its turn too.
const isOptionValue = (before: string | undefined) =>
  before !== undefined && before.startsWith("-") && !before.includes("=");

export const isTargeted = (args: ReadonlyArray<string>) =>
  Effect.forEach(args, (arg, at) =>
    arg === "--changed" || arg.startsWith("--changed=")
      ? Effect.succeed(true)
      : arg.startsWith("-") || isOptionValue(args[at - 1])
        ? Effect.succeed(false)
        : exists(arg),
  ).pipe(Effect.map((each) => each.includes(true)));

/** Runs `run` at once when targeted, and in the suite's turn otherwise. */
export const turnFor = <A, E, R>(
  targeted: boolean,
  lock: string,
  run: Effect.Effect<A, E, R>,
  say: (line: string) => Effect.Effect<void>,
  every?: Duration.Input,
) => (targeted ? run : inTurn(lock, run, say, every));

/** Where the executables are built: a targeted run's own, removed with its scope. */
export const binDirectory = (targeted: boolean) =>
  targeted
    ? Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.makeTempDirectoryScoped({ prefix: "collie-test-bin-" }),
      )
    : Effect.map(Path.Path, (path) => path.resolve(".scratch/test-bin"));

export const timingFlags = (targeted: boolean, timings: string, seed: string) =>
  targeted
    ? Effect.map(exists(timings), (there) => [`--timings=${there ? timings : seed}`])
    : Effect.succeed([`--timings=${timings}`, "--update-timings"]);
