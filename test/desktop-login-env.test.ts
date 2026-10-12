// What Desktop takes of the login shell's environment, and that every child it starts is given it.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { childEnv, parseLoginEnv, readLoginEnv, which } from "../desktop/src/bun/login-env";
import { runEffect } from "./support/effect";

const BEGIN = "<<collie-env-begin-7f3a9c>>";
const END = "<<collie-env-end-7f3a9c>>";

test("variables are read NUL-separated, a value keeping its '=' and newlines", () => {
  const out = `${BEGIN}PATH=/a:/b\0GITTE_CWD=/w\0X=a=b\nc\0${END}`;
  expect(Object.fromEntries(parseLoginEnv(out))).toEqual({
    PATH: "/a:/b",
    GITTE_CWD: "/w",
    X: "a=b\nc",
  });
});

test("what an rc file prints before and after is ignored", () => {
  const out = `Welcome\nPATH=nope\0${BEGIN}A=1\0${END}bye\0B=2\0`;
  expect(Object.fromEntries(parseLoginEnv(out))).toEqual({ A: "1" });
});

test("no markers, or an unclosed one, takes nothing", () => {
  expect(parseLoginEnv("A=1\0").size).toBe(0);
  expect(parseLoginEnv(`${BEGIN}A=1\0`).size).toBe(0);
});

/** Sets `name` in the environment until the scope closes. */
const setFor = (name: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const was = Bun.env[name];
      Bun.env[name] = value;
      return was;
    }),
    (was) =>
      Effect.sync(() => {
        if (was === undefined) delete Bun.env[name];
        else Bun.env[name] = was;
      }),
  );

test("a child is given what the environment says now, not what Bun started with", () =>
  runEffect(
    Effect.gen(function* () {
      yield* setFor("COLLIE_LATER", "merged");
      const child = Bun.spawn(["/bin/sh", "-c", 'printf %s "$COLLIE_LATER"'], {
        env: childEnv(),
        stdout: "pipe",
      });
      expect(yield* Effect.promise(() => new Response(child.stdout).text())).toBe("merged");
    }),
  ));

test("a child has no launcher LD_PRELOAD or ld.so errors", () =>
  runEffect(
    Effect.gen(function* () {
      yield* setFor("LD_PRELOAD", "./libcef.so:./libvk_swiftshader.so");
      const child = Bun.spawn(["/bin/sh", "-c", 'printf %s "${LD_PRELOAD-unset}"'], {
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]),
      );
      expect(out).toBe("unset");
      expect(err).toBe("");
      expect(yield* Effect.promise(() => child.exited)).toBe(0);
    }),
  ));

test("Desktop keeps the launcher's environment after building a child's", () =>
  runEffect(
    Effect.gen(function* () {
      yield* setFor("LD_PRELOAD", "./libcef.so");
      yield* setFor("ELECTROBUN_LAUNCHER_PID", "4242");
      expect(childEnv().ELECTROBUN_LAUNCHER_PID).toBeUndefined();
      expect(Bun.env.LD_PRELOAD).toBe("./libcef.so");
      expect(Bun.env.ELECTROBUN_LAUNCHER_PID).toBe("4242");
    }),
  ));

test("a bare command is found on the PATH the environment has now", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-which-" });
      const tool = `${dir}/collie-which-probe`;
      yield* fs.writeFileString(tool, "#!/bin/sh\n");
      yield* fs.chmod(tool, 0o755);
      yield* setFor("PATH", `${dir}:${childEnv().PATH}`);
      expect(Bun.which("collie-which-probe")).toBeNull();
      expect(which("collie-which-probe")).toBe(tool);
    }),
  ));

/** A shell that runs `body` instead of its `-ilc` command. */
const fakeShell = (body: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-login-env-" });
    yield* fs.writeFileString(`${dir}/sh`, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return `${dir}/sh`;
  });

test("the interactive login shell's variables are read past what its rc files print", () =>
  runEffect(
    Effect.gen(function* () {
      const shell = yield* fakeShell(
        `echo 'mise: activated'; [ "$1" = -ilc ] && sh -c "$2"; echo bye`,
      );
      const read = yield* readLoginEnv(shell);
      expect(read.get("PATH")).toBe(Bun.env.PATH);
    }),
  ));

test("a shell that fails, or does not answer in time, gives nothing to take", () =>
  runEffect(
    Effect.gen(function* () {
      expect((yield* readLoginEnv(yield* fakeShell("exit 1"))).size).toBe(0);
      expect((yield* readLoginEnv(yield* fakeShell("exec sleep 5"), "200 millis")).size).toBe(0);
      expect((yield* readLoginEnv("/nonexistent/shell")).size).toBe(0);
    }),
  ));
