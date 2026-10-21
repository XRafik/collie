// What a Release Run has the host prove: its checkout at the merge request's head, its tag
// on origin and the tag's pipeline, read from git and the forge rather than an Output.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import type { Runner } from "../src/mr";
import { fastForward } from "../src/releasing";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const ran = yield* exec(["git", ...args], { cwd });
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);
    return ran.stdout.trim();
  });

/** git for real; any other command is the forge's, answered by `forge`. */
const runner =
  (forge: Runner<never> = () => Effect.succeed({ code: 1, stdout: "" })): Runner<never> =>
  (cmd, args, cwd) =>
    cmd === "git"
      ? Effect.map(exec([cmd, ...args], { cwd }), (ran) => ({
          code: ran.exitCode,
          stdout: ran.stdout,
          stderr: ran.stderr,
        }))
      : forge(cmd, args, cwd);

/** A bare origin and a checkout of it with one commit pushed. */
const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-releasing-" });
  const origin = `${root}/origin.git`;
  const cwd = `${root}/checkout`;
  yield* git(root, "init", "-q", "--bare", "-b", "main", origin);
  yield* git(root, "clone", "-q", origin, cwd);
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ] as const)
    yield* git(cwd, "config", key, value);
  const commit = (file: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(`${cwd}/${file}`, file);
      yield* git(cwd, "add", file);
      yield* git(cwd, "commit", "-q", "-m", file);
      yield* git(cwd, "push", "-q", "origin", "HEAD:main");
      return yield* git(cwd, "rev-parse", "HEAD");
    });
  const first = yield* commit("one.ts");
  return { fs, root, cwd, commit, first };
});

test("a checkout with uncommitted changes is refused even where it is already at the head", () =>
  runEffect(
    Effect.gen(function* () {
      const { fs, root, cwd, first } = yield* repository;
      yield* fs.writeFileString(`${cwd}/one.ts`, "an uncommitted fix");
      const moved = yield* fastForward({ runDir: `${root}/run`, cwd, head: first, run: runner() });
      expect(moved._tag).toBe("Refused");
    }).pipe(Effect.scoped),
  ));
