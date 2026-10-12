import { Effect, Option, Schema, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { err } from "../operations";
import { verifyRun } from "../lifecycle";
import { REFUSED_INPUT } from "../engine";
import { HostRefused } from "../board-model";
import { type Echo } from "../verify";
import { printResult } from "../envelope";
import { answering, cliDoor, root } from "./shared";

/**
 * The command's own output, shown as it runs: a failure says why the first time, rather
 * than after running it again outside Collie. Under `--json` both streams go to stderr,
 * since stdout is the one envelope.
 */
const echoed = Effect.fn("collie.verify.echoed")(function* () {
  const stdio = yield* Stdio.Stdio;
  const json = (yield* root).json;
  const to = (stream: "stdout" | "stderr") => (text: string) =>
    Stream.make(text).pipe(Stream.run(stdio[stream]({ endOnDone: false })), Effect.ignore);
  return {
    stdout: to(json ? "stderr" : "stdout"),
    stderr: to("stderr"),
  } satisfies Echo;
});

/**
 * A command whose result Collie watched, bound to the tree it ran on. Not a mutation:
 * running the tests twice is running the tests twice, and a request id that replayed the
 * receipt would hand back a result about a tree that has since moved.
 *
 * The exit status is the command's own, so anything wrapping `collie verify -- bun test`
 * behaves as it would around `bun test`.
 */
export const verify = Command.make(
  "verify",
  {
    runId: Flag.String("run").pipe(
      Flag.withDescription("The Run this is a verification of; its tree is what is fingerprinted"),
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("Where to run it; must be inside that Run's own checkout"),
      Flag.optional,
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription("What to call it on a card; the executable by default"),
      Flag.optional,
    ),
    expect: Flag.String("expect").pipe(
      Flag.withDescription(
        "What a pass looks like: `pass` (default), or `fail` for a reproduction that must fail",
      ),
      Flag.optional,
    ),
    command: Argument.String("command").pipe(
      Argument.withDescription("The executable and its arguments, after `--`"),
      Argument.variadic({ min: 1 }),
    ),
  },
  ({ runId, cwd, name, expect, command }) => {
    const [executable, ...argv] = command;
    if (executable === undefined)
      return printResult(err("invalid_input", "verify needs a command to run."), true);
    const wanted = Option.getOrElse(expect, () => "pass");
    if (wanted !== "pass" && wanted !== "fail")
      return printResult(
        err("invalid_input", `--expect is "pass" or "fail", not "${wanted}".`),
        true,
      );
    return answering((env) =>
      Effect.scoped(
        Effect.gen(function* () {
          const request = {
            runId,
            name: Option.getOrElse(name, () => executable),
            executable,
            argv,
            expect: wanted,
          } satisfies Parameters<typeof verifyRun>[1];
          const where = Option.getOrUndefined(cwd);
          const opened = yield* verifyRun(
            env,
            where === undefined ? request : { ...request, cwd: where },
            yield* cliDoor(env),
          );
          if (!opened.ok) return opened;
          const echo = yield* echoed();
          const record = yield* Stream.runFoldEffect(
            opened.events,
            (): import("../verify-model").Verification | null => null,
            (last, event) =>
              event._tag === "Output"
                ? echo[event.stream](event.text).pipe(Effect.as(last))
                : Effect.succeed(event.verification),
          ).pipe(
            Effect.catch((cause) =>
              Effect.succeed(
                Schema.is(HostRefused)(cause) && cause.reason.startsWith(`${REFUSED_INPUT}:`)
                  ? err("invalid_input", cause.reason.slice(REFUSED_INPUT.length + 1).trim())
                  : err("operation_failed", String(cause)),
              ),
            ),
          );
          if (record === null)
            return err("operation_failed", "The verification ended without a record.");
          if ("ok" in record) return record;
          process.exitCode = record.exit;
          return {
            ok: true as const,
            data: { verification: record },
            human: `${record.name}: ${record.result} (exit ${record.exit})`,
          };
        }),
      ),
    );
  },
).pipe(
  Command.withDescription("Run a command and record its result against this Run's tree"),
  Command.withExamples([
    {
      command: "collie --json verify --run implement-picker-20260909-101112 -- bun test",
      description: "Record a test run against that Run's own checkout",
    },
    {
      command: "collie verify --run <id> --name typecheck -- bun run typecheck",
      description: "Name it, so a card can say which verification passed",
    },
    {
      command:
        "collie verify --run <id> --name regression --expect fail -- bun test test/bug.test.ts",
      description: "Prove a bug exists: the record passes because the command failed",
    },
  ]),
);
