// A Claude agent's `AskUserQuestion`, put on its Run by the hook Collie installs, is
// answered the way a Workflow's question is: from `collie run answer` and from the card,
// in any words. The host here is a real one over a fake herdr.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { connect } from "../src/host";
import { readEnv } from "../src/env";
import { resetExecutors } from "../src/executors";
import { isSettled } from "../src/lifecycle";
import { carryOutAsked } from "../src/run-actions";
import { controlDir } from "../src/compaction";
import { recordClaudeEvent } from "../src/compactors";
import { Launched } from "../src/launches";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeLaunched = Schema.decodeUnknownSync(Schema.fromJsonString(Launched));

const askedTwo = encode({
  session_id: "s-1",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_1",
  tool_input: {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        options: [{ label: "Postgres", description: "the one ops runs" }],
        multiSelect: false,
      },
      {
        question: "Which checks?",
        header: "Checks",
        options: [{ label: "lint", description: "oxlint" }],
        multiSelect: true,
      },
    ],
  },
});

test(
  "an agent's questions are answered from the CLI and the card, and the answers reach it together",
  () =>
    proves(
      "collie-agent-question-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encode([null])).pipe(Effect.orDie);
          const set = {
            FAKE_HERDR_OUTPUTS: outputs,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const before = Object.fromEntries(Object.keys(set).map((key) => [key, Bun.env[key]]));
              Object.assign(Bun.env, set);
              return before;
            }),
            (before) =>
              Effect.sync(() => {
                for (const [key, value] of Object.entries(before))
                  if (value === undefined) delete Bun.env[key];
                  else Bun.env[key] = value;
              }),
          );
          resetExecutors();
          const env = readEnv({
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            HOME: world.home,
            COLLIE_CWD: world.project,
          });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId } = yield* client
            .start({ project: world.project, id: "told", request: "start", input: { work: "it" } })
            .pipe(Effect.orDie);
          const record = `${world.state}/agents/${runId}/build.launch.json`;
          const text = yield* until(
            () => fs.readFileString(record).pipe(Effect.orElseSucceed(() => "")),
            (one) => one !== "",
          );
          const launched = decodeLaunched(text);
          yield* recordClaudeEvent(yield* controlDir(world.state, launched.agent), askedTwo).pipe(
            Effect.orDie,
          );
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => (view?.waiting.length ?? 0) === 2,
          );

          const answered = yield* collie(world, [
            "run",
            "answer",
            runId,
            "SQLite; it is only a demo",
            "--decision",
            "ask-build-1",
          ]);
          expect(answered.envelope).toMatchObject({
            ok: true,
            data: { decision: "ask-build-1", value: "SQLite; it is only a demo" },
          });
          const [carded] = yield* carryOutAsked(
            env,
            [{ kind: "answer", run: runId, choiceId: "ask-build-2", answer: "lint and typecheck" }],
            { origin: "board", requestId: "card-1" },
          );
          expect(carded).toMatchObject({ kind: "answer", state: "applied" });

          const log = Bun.env.FAKE_HERDR_LOG ?? "";
          const prompts = yield* until(
            () => fs.readFileString(log).pipe(Effect.orElseSucceed(() => "")),
            (all) => all.includes("Your question has been answered on your Run."),
          );
          expect(prompts).toContain("SQLite; it is only a demo");
          expect(prompts).toContain("lint and typecheck");

          // The run was collecting all along, and carries on to its end once the Output comes.
          yield* fs
            .writeFileString(launched.output, encode({ verdict: "built" }))
            .pipe(Effect.orDie);
          const view = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (one) => one !== null && isSettled(one),
          );
          expect(view?.status.status).toBe("complete");
        }).pipe(Effect.ensuring(stopHost(world.state))),
      ["told.workflow.ts"],
    ),
  120_000,
);
