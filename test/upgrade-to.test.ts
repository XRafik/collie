// Checkouts of Collie. A development checkout is pulled with its work riding through and never
// moved; onboarding moves a clone only when it is at a release. Real git, because what counts
// is git's answer.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { shell } from "../src/mr";
import { moveToRelease, upgrade } from "../src/operations";
import { installation } from "../src/release";

let rig: Rig;
let origin: string;
let clone: string;

const git = (cwd: string, ...args: string[]) =>
  exec(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: rig.root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).pipe(
    Effect.flatMap((done) =>
      done.exitCode === 0
        ? Effect.succeed(done.stdout.trim())
        : Effect.die(new Error(`git ${args.join(" ")}: ${done.stderr}`)),
    ),
  );

const release = Effect.fn("test.release")(function* (version: string) {
  yield* exec(
    ["sh", "-c", `echo 'echo "prepare: runner: done"' > prepare.sh; echo ${version} > version`],
    { cwd: origin },
  );
  yield* git(origin, "add", ".");
  yield* git(origin, "commit", "--quiet", "-m", version);
  yield* git(origin, "tag", version);
});

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      origin = `${rig.root}/origin`;
      clone = `${rig.root}/collie`;
      yield* exec(["mkdir", "-p", origin]);
      yield* git(origin, "init", "--quiet", "-b", "master");
      yield* release("0.1.0");
      yield* release("0.2.0");
      yield* git(rig.root, "clone", "--quiet", origin, clone);
      yield* git(clone, "reset", "--quiet", "--hard", "0.1.0");
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const development = () => ({
  ...rig.pluginEnv(),
  pluginRoot: clone,
  collieDir: `${rig.root}/elsewhere`,
});

const at = () => git(clone, "describe", "--exact-match", "--tags", "HEAD");

test("a released clone moves to the exact version", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* moveToRelease(clone, "0.2.0", shell)).toBeNull();
      expect(yield* at()).toBe("0.2.0");
    }),
  ));

test("a clone detached on a release tag is a release, whatever else is tagged there", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "checkout", "--quiet", "--detach", "0.1.0");
      yield* git(clone, "tag", "zzz-local");

      expect(yield* moveToRelease(clone, "0.2.0", shell)).toBeNull();
    }),
  ));

test("a version with no release is refused and nothing moves", () =>
  runEffect(
    Effect.gen(function* () {
      const refused = yield* moveToRelease(clone, "9.9.9", shell);

      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(yield* at()).toBe("0.1.0");
    }),
  ));

const refusedAsDevelopment = (reason: RegExp, run = shell) =>
  Effect.gen(function* () {
    const head = yield* git(clone, "rev-parse", "HEAD");

    const refused = yield* moveToRelease(clone, "0.2.0", run);

    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(refused?.ok === false && refused.error.message).toMatch(reason);
    expect(yield* git(clone, "rev-parse", "HEAD")).toBe(head);
  });

test("a clone with uncommitted changes is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.promise(() => Bun.write(`${clone}/version`, "work in progress"));
      yield* refusedAsDevelopment(/uncommitted changes/);
      expect(yield* Effect.promise(() => Bun.file(`${clone}/version`).text())).toBe(
        "work in progress",
      );
    }),
  ));

test("a clone on a branch of its own is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "checkout", "--quiet", "-b", "feature");
      yield* refusedAsDevelopment(/branch feature/);
    }),
  ));

test("a clone ahead of its remote is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "reset", "--quiet", "--hard", "origin/master");
      yield* git(clone, "commit", "--quiet", "--allow-empty", "-m", "local");
      yield* refusedAsDevelopment(/ahead of its remote/);
    }),
  ));

test("a clone detached on a commit that is not a release is never moved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "commit", "--quiet", "--allow-empty", "-m", "local");
      yield* git(clone, "checkout", "--quiet", "--detach", "HEAD");
      yield* refusedAsDevelopment(/not a release/);
    }),
  ));

test("a clone at the Collie directory is the installation, whatever its state", () =>
  runEffect(
    Effect.gen(function* () {
      yield* git(clone, "checkout", "--quiet", "-b", "feature");
      expect(yield* installation(clone, clone, "0.1.0")).toEqual({ release: true });
    }),
  ));

// What Collie Desktop's launcher made every child of it write to stderr.
const LD_SO_NOISE = ["./libcef.so", "./libvk_swiftshader.so"].map(
  (lib) =>
    `ERROR: ld.so: object '${lib}' from LD_PRELOAD cannot be preloaded (cannot open shared object file): ignored.`,
);

const noisy = (cmd: string, args: string[], cwd: string) =>
  shell(
    "sh",
    ["-c", `printf '%s\\n' "$0" "$1" >&2; shift; exec "$@"`, ...LD_SO_NOISE, cmd, ...args],
    cwd,
  );

test("a clean released clone moves however noisy its tools' stderr", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* moveToRelease(clone, "0.2.0", noisy)).toBeNull();
      expect(yield* at()).toBe("0.2.0");
    }),
  ));

test("a noisy development build is named by its version and commit alone", () =>
  runEffect(
    Effect.gen(function* () {
      const sha = yield* git(clone, "rev-parse", "--short", "HEAD");

      expect(yield* installation(clone, `${rig.root}/elsewhere`, "0.1.0", noisy)).toEqual({
        release: false,
        build: `0.1.0+${sha}`,
        reason: "it is a development checkout",
      });
    }),
  ));

test("a noisy clone with a real change is still refused for it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.promise(() => Bun.write(`${clone}/version`, "work in progress"));
      yield* refusedAsDevelopment(/uncommitted changes/, noisy);
    }),
  ));

test("a failed fetch still says git's own reason", () =>
  runEffect(
    Effect.gen(function* () {
      yield* exec(["rm", "-rf", origin]);

      const refused = yield* moveToRelease(clone, "0.2.0", noisy);

      expect(refused).toMatchObject({
        ok: false,
        error: { code: "operation_failed", details: { output: expect.stringContaining("fatal:") } },
      });
    }),
  ));

test("a development checkout pulls, and its uncommitted work rides through", () =>
  runEffect(
    Effect.gen(function* () {
      // A file of the clone's own that the next release does not touch, edited and uncommitted.
      yield* exec(["sh", "-c", "echo shipped > notes.md"], { cwd: origin });
      yield* git(origin, "add", "notes.md");
      yield* git(origin, "commit", "--quiet", "-m", "notes");
      yield* release("0.3.0");
      yield* git(clone, "fetch", "--quiet");
      yield* git(clone, "reset", "--quiet", "--hard", "origin/master~1");
      yield* Effect.promise(() => Bun.write(`${clone}/notes.md`, "work in progress\n"));
      // As many developers pull: a rebase refuses a dirty tree unless the work is stashed.
      yield* git(clone, "config", "pull.rebase", "true");

      const pulled = yield* upgrade(development());

      expect(pulled).toMatchObject({ ok: true, data: { updated: true } });
      expect(yield* git(clone, "describe", "--exact-match", "--tags", "HEAD")).toBe("0.3.0");
      expect(yield* Effect.promise(() => Bun.file(`${clone}/notes.md`).text())).toBe(
        "work in progress\n",
      );
    }),
  ));

test("a development checkout is never moved to a release", () =>
  runEffect(
    Effect.gen(function* () {
      const head = yield* git(clone, "rev-parse", "HEAD");

      const refused = yield* upgrade(development(), { to: "0.2.0" });

      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(yield* git(clone, "rev-parse", "HEAD")).toBe(head);
    }),
  ));

test("a checkout other than the Collie directory is development, whatever its state", () =>
  runEffect(
    Effect.gen(function* () {
      const sha = yield* git(clone, "rev-parse", "--short", "HEAD");
      expect(yield* installation(clone, `${rig.root}/elsewhere`, "0.1.0")).toEqual({
        release: false,
        build: `0.1.0+${sha}`,
        reason: "it is a development checkout",
      });
    }),
  ));
