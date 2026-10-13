// A Run's stop of a Codex agent, at the Agents service: the agent's work runs in the App
// Server Collie started for it, so the stop is only a stop once that server's turns have
// ended and it is gone. The server here is a stand-in run as a real process in place of
// `codex app-server`, behind the real Codex port; herdr is the fake one.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { until } from "./support/host";
import { Agents, agentWork, agentsLayer, type AgentAsk, type AgentHost } from "../src/agents";
import { asRun, enveloped } from "./support/enveloped";
import { PARKED, STOP, controlPath, foundationLayer } from "../src/engine";
import { readLaunches } from "../src/launches";
import { stoppedServer } from "./support/stopped-server";
import { agentName } from "../src/naming";
import { controlDir, readControl, unlistedServers, type ControlRecord } from "../src/compaction";
import { compactionSweeper, sweep } from "../src/cleanup";
import { codexPort } from "../src/compactors";
import type { StandInConfig } from "./support/codex-app-server";

let rig: Rig;
let dir: string;
let fs: FileSystem.FileSystem;
let path: Path.Path;

const STAND_IN = new URL("./support/codex-app-server.ts", import.meta.url).pathname;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      // Whatever a failing test left of the stand-in and its children.
      const pids = (yield* recorded()).map((entry) => entry.child);
      pids.push((yield* readControl(rig.pluginEnv().stateDir, agent))?.pid ?? undefined);
      for (const pid of pids)
        if (pid !== undefined) yield* Effect.ignore(Effect.try(() => process.kill(pid, "SIGKILL")));
      yield* rig.close();
    }),
  ),
);

const Verdict = Schema.Struct({ verdict: Schema.String });
const work = enveloped({ name: "codex-work", input: {}, success: Verdict });
const body = work.toLayer((payload) =>
  agentWork({
    operation: "build",
    role: "implementer",
    workflow: "codex-work",
    cwd: rig.projectDir,
    instructions: "Build it.",
    input: {},
    output: Verdict,
  }).pipe(asRun(payload)),
);

const agent = agentName("r1", "build", null, 1);
const writes = () => path.join(rig.projectDir, "edits.txt");
const recordFile = () => path.join(rig.root, "stand-in.jsonl");

/** The host, with Codex's controls over the stand-in started with `config`. */
const hostWith = (
  config: Partial<StandInConfig>,
  name = "stand-in",
): Effect.Effect<AgentHost, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const file = path.join(rig.root, `${name}.json`);
    const full: StandInConfig = {
      cwd: rig.projectDir,
      record: recordFile(),
      writes: writes(),
      ...config,
    };
    yield* fs.writeFileString(file, encodeJson(full));
    const codex = codexPort(`bun ${STAND_IN} ${file}`, { stopMs: 1_500 });
    return {
      dir,
      env: rig.pluginEnv(),
      herdr: new FakeHerdr(rig.pluginEnv()),
      harness: "codex",
      model: "default",
      permissions: "auto",
      compactAtTokens: 1000,
      pollMs: 20,
      collectMs: 5_000,
      ports: { codex: { ...codex, gate: () => Effect.void } },
    };
  });

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    WorkflowEngine.WorkflowEngine | Agents | FileSystem.FileSystem | Path.Path
  >,
  host: AgentHost,
) =>
  run.pipe(
    Effect.provide(body),
    Effect.provide(agentsLayer(host)),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const halted = Agents.pipe(Effect.flatMap((agents) => agents.halt("r1")));

/** A Codex agent that has done its step and whose turn is still writing in the checkout. */
const writing = (config: Partial<StandInConfig> = {}) =>
  Effect.gen(function* () {
    const host = yield* hostWith(config);
    yield* rig.queueOutputs([{ verdict: "done" }]);
    const result = yield* session(
      work.execute({ runId: "r1", input: {} }).pipe(Effect.result),
      host,
    );
    expect(result._tag).toBe("Success");
    yield* until(size, (written) => written > 0);
    return host;
  });

const size = () =>
  fs.exists(writes()).pipe(
    Effect.flatMap((there) => (there ? fs.readFileString(writes()) : Effect.succeed(""))),
    Effect.map((text) => text.length),
  );

/** One line the stand-in records: a request, a signal, a turn or child it started, its exit. */
const StandInEntry = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(
    Schema.Struct({
      threadId: Schema.optionalKey(Schema.String),
      turnId: Schema.optionalKey(Schema.String),
    }),
  ),
  signal: Schema.optionalKey(Schema.String),
  started: Schema.optionalKey(Schema.String),
  child: Schema.optionalKey(Schema.Number),
  exit: Schema.optionalKey(Schema.Boolean),
});
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(StandInEntry));

const recorded = () =>
  fs.exists(recordFile()).pipe(
    Effect.flatMap((there) => (there ? fs.readFileString(recordFile()) : Effect.succeed(""))),
    Effect.map((text) =>
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeEntry(line)),
    ),
  );

const signals = () => recorded().pipe(Effect.map((all) => all.filter((entry) => entry.signal)));

const interrupts = () =>
  recorded().pipe(
    Effect.map((all) =>
      all.filter((entry) => entry.method === "turn/interrupt").map((entry) => entry.params),
    ),
  );

const log = () => fs.readFileString(`${dir}/agents/r1/agents.log`);

const controlFile = () =>
  controlDir(rig.pluginEnv().stateDir, agent).pipe(
    Effect.map((at) => path.join(at, "control.json")),
  );

/** Whether the agent's file is still growing, over a stretch longer than its writes' spacing. */
const stillWriting = () =>
  Effect.gen(function* () {
    const before = yield* size();
    yield* Effect.sleep(Duration.millis(300));
    return (yield* size()) > before;
  });

test(
  "a stop ends the Codex agent's running turn before it says the agent stopped",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();

        const halt = yield* session(halted, host);

        expect(halt).toEqual({ stopped: [agent], left: [] });
        expect(yield* stillWriting()).toBe(false);
        expect((yield* signals()).map((entry) => entry.signal)).toEqual(["SIGTERM"]);
        expect(yield* interrupts()).toEqual([
          {
            threadId: "019a0001-0000-7000-8000-000000000001",
            turnId: "019a0002-0000-7000-8000-00000000000a",
          },
        ]);
        expect((yield* recorded()).some((entry) => entry.exit)).toBe(true);
      }),
    ),
  30_000,
);

const MAIN = {
  thread: "019a0001-0000-7000-8000-000000000001",
  turn: "019a0002-0000-7000-8000-00000000000a",
};
const SUB = {
  thread: "019a0001-0000-7000-8000-000000000002",
  turn: "019a0002-0000-7000-8000-00000000000b",
};

const paneClosed = () => rig.cmds().pipe(Effect.map((cmds) => cmds.includes("pane close")));

const control = () =>
  readControl(rig.pluginEnv().stateDir, agent).pipe(
    Effect.flatMap((record) =>
      record === null
        ? Effect.die(new Error(`${agent} has no control record`))
        : Effect.succeed(record),
    ),
  );

test(
  "the agents log says submitted, acknowledged and quiet, each with every id",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();
        const { endpoint, pid } = yield* control();

        yield* session(halted, host);

        const lines = (yield* log()).split("\n");
        const transcript = `/rollouts/${MAIN.thread}.jsonl`;
        for (const state of ["interrupt submitted", "interrupt acknowledged"])
          expect(lines).toContain(
            `${agent}: ${state}: thread ${MAIN.thread} turn ${MAIN.turn} on ${endpoint} pid ${pid}, transcript ${transcript}`,
          );
        expect(lines).toContain(
          `${agent} is quiet: thread ${MAIN.thread} turn ${MAIN.turn} (transcript ${transcript}) on codex server ${endpoint} pid ${pid}`,
        );
        expect(lines).toContain(`stopped ${agent}`);
        expect(yield* fs.exists(yield* controlFile())).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a sub-agent's running turn on the same server is interrupted too",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ subagent: true });

        expect((yield* session(halted, host)).stopped).toEqual([agent]);

        expect(yield* interrupts()).toEqual(
          expect.arrayContaining([
            { threadId: MAIN.thread, turnId: MAIN.turn },
            { threadId: SUB.thread, turnId: SUB.turn },
          ]),
        );
        expect(yield* stillWriting()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a queued continuation never starts a turn after the stop",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ queued: true });

        expect((yield* session(halted, host)).stopped).toEqual([agent]);

        expect((yield* recorded()).filter((entry) => entry.started)).toHaveLength(1);
        expect(yield* stillWriting()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a child left in the server's session gets one SIGTERM and ends",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ child: "plain" });
        const child = (yield* recorded()).find((entry) => entry.child !== undefined)?.child;

        expect(yield* session(halted, host)).toEqual({
          stopped: [agent],
          left: [],
        });

        expect(alive(child)).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a child that ignores SIGTERM fails the stop by its pid, and gets nothing more",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ child: "stubborn" });
        const child = (yield* recorded()).find((entry) => entry.child !== undefined)?.child;

        const halt = yield* session(halted, host);

        expect(halt.stopped).toEqual([]);
        expect(halt.left.join("\n")).toContain(`pid ${child}`);
        // One SIGTERM it ignored, and no SIGKILL: it is still there.
        expect(alive(child)).toBe(true);
        expect(yield* signals()).toHaveLength(1);
        expect(yield* paneClosed()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "an agent whose pane herdr no longer lists still has its server stopped",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();

        const halt = yield* session(halted, {
          ...host,
          herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_AGENTS_GONE: agent })),
        });

        expect(halt).toEqual({ stopped: [agent], left: [] });
        expect(yield* stillWriting()).toBe(false);
        expect(yield* paneClosed()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a server that takes the interrupt and never exits is left acknowledged, pane open, record kept",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ neverExit: true });
        const before = yield* control();

        const halt = yield* session(halted, host);

        expect(halt.stopped).toEqual([]);
        const said = halt.left.join("\n");
        expect(said).toContain(`${agent} is not stopped, only acknowledged`);
        for (const id of [MAIN.thread, MAIN.turn, `${before.endpoint} pid ${before.pid}`])
          expect(said).toContain(id);
        expect(yield* paneClosed()).toBe(false);
        const kept = yield* control();
        expect(kept).toMatchObject({
          endpoint: before.endpoint,
          pid: before.pid,
          started: before.started,
          stop: {
            state: "acknowledged",
            turns: [{ thread: MAIN.thread, turn: MAIN.turn }],
          },
        });
        expect(kept.started).toEqual(expect.any(String));
      }),
    ),
  30_000,
);

const refused = (config: Partial<StandInConfig>, tamper?: (record: ControlRecord) => object) =>
  Effect.gen(function* () {
    const host = yield* writing(config);
    if (tamper)
      yield* fs.writeFileString(yield* controlFile(), encodeJson(tamper(yield* control())));

    const halt = yield* session(halted, host);

    expect(halt.stopped).toEqual([]);
    expect(halt.left.join("\n")).toContain(`${agent} is not stopped, only failed`);
    expect(yield* signals()).toEqual([]);
    expect(yield* paneClosed()).toBe(false);
    expect((yield* control()).stop?.state).toBe("failed");
    return halt.left.join("\n");
  });

test(
  "a connection that drops mid-stop is refused, and nothing is signalled",
  () =>
    runEffect(
      Effect.map(refused({ dropConnection: true }), (said) =>
        expect(said).toContain("did not answer"),
      ),
    ),
  30_000,
);

test(
  "an endpoint holding a thread of another directory is refused, and nothing is signalled",
  () =>
    runEffect(
      Effect.map(refused({ foreignThread: true }), (said) =>
        expect(said).toContain("/somewhere/else"),
      ),
    ),
  30_000,
);

test(
  "a pid whose start time is not the recorded one is refused, and nothing is signalled",
  () =>
    runEffect(
      Effect.map(
        refused({}, (record) => ({ ...record, started: "1" })),
        (said) => expect(said).toContain("ambiguous identity"),
      ),
    ),
  30_000,
);

test(
  "a record an older build wrote, with no start time, is still stopped",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();
        const { started: _, stop: __, ...older } = yield* control();
        yield* fs.writeFileString(yield* controlFile(), encodeJson(older));

        expect(yield* session(halted, host)).toEqual({
          stopped: [agent],
          left: [],
        });
        expect(yield* stillWriting()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a stop repeated after the agent is quiet sends nothing and changes nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();
        yield* session(halted, host);
        const seen = (yield* recorded()).length;
        const cmds = (yield* rig.cmds()).length;

        expect(yield* session(halted, host)).toEqual({ stopped: [], left: [] });

        expect((yield* recorded()).length).toBe(seen);
        expect(
          (yield* rig.cmds())
            .slice(cmds)
            .filter((cmd) => cmd !== "agent list" && cmd !== "pane list"),
        ).toEqual([]);
      }),
    ),
  30_000,
);

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const payload = { runId: "r1", input: {} };

const parkedNow = () => fs.exists(controlPath(dir, PARKED, "r1"));

/** A Codex agent that wrote nothing in its budget, parked, its turn still writing. */
const midWork = (host: AgentHost) =>
  session(
    Effect.gen(function* () {
      yield* work.execute(payload, { discard: true });
      yield* until(parkedNow, (parked) => parked);
    }),
    host,
  );

/** The work picked up again, as a host's resume does it: whether it parked again. */
const resumed = (host: AgentHost) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      yield* fs.remove(controlPath(dir, PARKED, "r1"), { force: true });
      yield* engine.resume(work, yield* work.executionId(payload));
      yield* work.execute(payload, { discard: true });
      const done = Effect.map(
        work.poll(yield* work.executionId(payload)),
        (one) => Option.isSome(one) && one.value._tag === "Complete",
      );
      return yield* until(
        () => Effect.all([parkedNow(), done]),
        ([parked, finished]) => parked || finished,
      ).pipe(Effect.map(([parked]) => parked));
    }),
    host,
  );

/** The agent's pane closed by a human, as herdr then has it. */
const closedByHand = Effect.gen(function* () {
  const herdr = new FakeHerdr(rig.pluginEnv());
  for (const one of yield* herdr.agentList()) yield* herdr.paneClose(one.paneId);
});

const starts = () =>
  rig.cmds().pipe(Effect.map((cmds) => cmds.filter((cmd) => cmd === "agent start").length));

test(
  "a restart waits for the stopped Codex agent to be quiet, and then starts in its place",
  () =>
    runEffect(
      Effect.gen(function* () {
        const hold = path.join(rig.root, "hold");
        yield* fs.writeFileString(hold, "");
        yield* rig.queueOutputs([null, { verdict: "done" }]);
        const host = yield* hostWith({ holdWhile: hold });
        yield* midWork(host);

        // The turn will not end, so the stop cannot show it quiet; a human closes the pane.
        expect((yield* session(halted, host)).stopped).toEqual([]);
        yield* closedByHand;

        expect(yield* resumed(host)).toBe(true);
        const parked = yield* fs.readFileString(controlPath(dir, PARKED, "r1"));
        const { endpoint, pid } = yield* control();
        for (const id of [MAIN.thread, MAIN.turn, `${endpoint} pid ${pid}`])
          expect(parked).toContain(id);
        expect(yield* starts()).toBe(1);
        expect(yield* stillWriting()).toBe(true);
        expect((yield* control()).pid).toBe(pid);
        expect((yield* control()).stop?.state).toBe("acknowledged");

        yield* fs.remove(hold);
        const replacement = yield* hostWith(
          {
            writes: path.join(rig.projectDir, "replacement.txt"),
            record: path.join(rig.root, "replacement.jsonl"),
          },
          "replacement",
        );
        expect(yield* resumed(replacement)).toBe(false);
        expect(yield* starts()).toBe(2);
        expect(yield* stillWriting()).toBe(false);
        // Its server had exited, so nothing of the old turn could write after the start.
        expect((yield* recorded()).some((entry) => entry.exit)).toBe(true);
        const lines = (yield* log()).split("\n");
        const quiet = lines.findIndex((line) => line.startsWith(`${agent} is quiet:`));
        const restarted = lines.findLastIndex((line) => line.startsWith(`${agent}: codex in `));
        expect(quiet).toBeGreaterThan(-1);
        expect(restarted).toBeGreaterThan(quiet);
        // The server was signalled once, by the first stop; the second only interrupted.
        expect(yield* signals()).toHaveLength(1);
      }),
    ),
  60_000,
);

const retired = (host: AgentHost) =>
  session(
    Effect.gen(function* () {
      const [launched] = yield* readLaunches(dir, "r1");
      const agents = yield* Agents;
      return yield* agents.retire(launched!, "build: codex ran out").pipe(Effect.result);
    }),
    host,
  );

const successor: AgentAsk = {
  runId: "r1",
  operation: "build",
  role: "implementer",
  agent: null,
  workflow: "codex-work",
  task: null,
  cwd: "",
  prompt: "Build it.",
  output: "",
  skill: null,
  harness: "claude",
  model: null,
  effort: null,
  permissions: null,
  sequence: 2,
};

test(
  "an agent that ran out is quiet before the agent taking its work starts",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();

        expect((yield* retired(host))._tag).toBe("Success");
        yield* session(
          Agents.pipe(
            Effect.flatMap((agents) =>
              agents.launch({
                ...successor,
                cwd: rig.projectDir,
                output: `${dir}/agents/r1/build.json`,
              }),
            ),
          ),
          host,
        );

        const lines = (yield* log()).split("\n");
        const quiet = lines.findIndex((line) => line.startsWith(`${agent} is quiet:`));
        const next = lines.findIndex((line) => line.startsWith("r1-build-r2: claude in "));
        expect(quiet).toBeGreaterThan(-1);
        expect(next).toBeGreaterThan(quiet);
        expect(yield* stillWriting()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "an agent that ran out and is not quiet parks the work, and nothing takes it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const hold = path.join(rig.root, "hold");
        yield* fs.writeFileString(hold, "");
        const host = yield* writing({ holdWhile: hold });

        const result = yield* retired(host);

        if (result._tag === "Success") return yield* Effect.die(new Error("retired"));
        expect(result.failure.reason).toContain(`thread ${MAIN.thread} turn ${MAIN.turn}`);
        expect(result.failure.reason).toContain("Nothing takes its work until it is quiet");
        expect(yield* paneClosed()).toBe(false);
        expect(yield* stillWriting()).toBe(true);
      }),
    ),
  30_000,
);

const suspended = Effect.gen(function* () {
  const id = yield* work.executionId(payload);
  yield* until(
    () => work.poll(id),
    (one) => Option.isSome(one) && one.value._tag === "Suspended",
  );
});

test(
  "no agent starts once a stop is asked for",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* hostWith({});
        yield* fs.writeFileString(controlPath(dir, STOP, "r1"), "");

        yield* session(Effect.andThen(work.execute(payload, { discard: true }), suspended), host);

        expect(yield* starts()).toBe(0);
        expect(yield* recorded()).toEqual([]);
      }),
    ),
  30_000,
);

test(
  "an agent started as a stop lands is stopped, and a resume goes on with one agent",
  () =>
    runEffect(
      Effect.gen(function* () {
        // The stop lands while its launch is starting the agent.
        const host = yield* hostWith({ touch: controlPath(dir, STOP, "r1") });
        yield* rig.queueOutputs([null, { verdict: "done" }]);

        yield* session(Effect.andThen(work.execute(payload, { discard: true }), suspended), host);

        expect(yield* paneClosed()).toBe(true);
        expect((yield* recorded()).some((entry) => entry.exit)).toBe(true);
        expect(yield* stillWriting()).toBe(false);

        yield* fs.remove(controlPath(dir, STOP, "r1"));
        const again = yield* hostWith(
          {
            writes: path.join(rig.projectDir, "replacement.txt"),
            record: path.join(rig.root, "replacement.jsonl"),
          },
          "replacement",
        );
        expect(yield* resumed(again)).toBe(false);
        const listed = yield* new FakeHerdr(rig.pluginEnv()).agentList();
        expect(listed.map((one) => one.name)).toEqual([agent]);
        expect(yield* starts()).toBe(2);
      }),
    ),
  30_000,
);

test(
  "a launch keeps another agent's record whose server is not quiet, and starts anyway",
  () =>
    runEffect(
      Effect.gen(function* () {
        const other = "r0-build-r1";
        yield* stoppedServer(rig.pluginEnv().stateDir, other, rig.projectDir);

        yield* writing();

        const kept = yield* readControl(rig.pluginEnv().stateDir, other);
        expect(kept?.stop?.state).toBe("failed");
        expect(kept?.stop?.reason).toContain("did not answer, so nothing was signalled");
      }).pipe(Effect.scoped),
    ),
  30_000,
);

/** How many SIGTERMs the stubborn child has ignored. */
const childTerms = () =>
  fs.readFileString(`${recordFile()}.child`).pipe(
    Effect.map((text) => text.split("\n").filter(Boolean).length),
    Effect.orElseSucceed(() => 0),
  );

test(
  "a child left after the server exits holds the checkout, and a later stop never signals it again",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ child: "stubborn" });
        const child = (yield* recorded()).find((entry) => entry.child !== undefined)?.child;
        yield* session(halted, host);
        yield* until(childTerms, (terms) => terms === 1);

        const held = yield* unlistedServers(rig.pluginEnv().stateDir, new Set());
        expect(held.map((one) => one.cwd)).toEqual([rig.projectDir]);
        expect(held[0]?.why).toContain(`pid ${child}`);

        const again = yield* session(halted, host);
        expect(again.left.join("\n")).toContain(`pid ${child}`);
        expect(yield* childTerms()).toBe(1);
        expect(alive(child)).toBe(true);
      }),
    ),
  30_000,
);

test(
  "a record from an older build whose server has exited is not called quiet",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ child: "stubborn" });
        yield* session(halted, host);
        yield* fs.writeFileString(
          yield* controlFile(),
          encodeJson({ ...(yield* control()), started: null, stop: null }),
        );

        const halt = yield* session(halted, host);

        expect(halt.left.join("\n")).toContain("nothing proves what it started is gone");
        expect(yield* fs.exists(yield* controlFile())).toBe(true);
      }),
    ),
  30_000,
);

test(
  "cleanup stops a held agent again, and removes its record once it is quiet",
  () =>
    runEffect(
      Effect.gen(function* () {
        const hold = path.join(rig.root, "hold");
        yield* fs.writeFileString(hold, "");
        const host = yield* writing({ holdWhile: hold });
        expect((yield* session(halted, host)).stopped).toEqual([]);
        yield* closedByHand;
        yield* fs.remove(hold);

        const stateDir = rig.pluginEnv().stateDir;
        yield* sweep(
          [compactionSweeper(stateDir, [new FakeHerdr(rig.pluginEnv())])],
          stateDir,
          "host",
        );

        expect(yield* interrupts()).toHaveLength(2);
        expect(yield* fs.exists(yield* controlFile())).toBe(false);
        expect(yield* stillWriting()).toBe(false);
      }),
    ),
  60_000,
);

test(
  "a stop whose server answers slowly ends within its budget",
  () =>
    runEffect(
      Effect.gen(function* () {
        const slow = path.join(rig.root, "slow");
        const host = yield* writing({ slowWhile: slow });
        yield* fs.writeFileString(slow, "");

        const before = yield* Clock.currentTimeMillis;
        const halt = yield* session(halted, host);

        expect((yield* Clock.currentTimeMillis) - before).toBeLessThan(2_500);
        expect(halt.left.join("\n")).toContain("ran out of its");
      }),
    ),
  30_000,
);

test(
  "a server that exits after a stop refused it is not called quiet where nothing identifies what it started",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ foreignThread: true, child: "stubborn" });
        expect((yield* session(halted, host)).left.join("\n")).toContain("ambiguous identity");
        process.kill((yield* control()).pid!, "SIGKILL");
        // With no start time, its session cannot be told from a reused one.
        yield* fs.writeFileString(
          yield* controlFile(),
          encodeJson({ ...(yield* control()), started: null }),
        );

        const halt = yield* session(halted, host);

        expect(halt.left.join("\n")).toContain("nothing proves what it started is gone");
        expect(yield* fs.exists(yield* controlFile())).toBe(true);
      }),
    ),
  30_000,
);

test(
  "a stop cut short while it waits on a child leaves its SIGTERM on the record",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ child: "stubborn" });
        yield* session(halted.pipe(Effect.timeoutOption(Duration.millis(900))), host);
        yield* until(childTerms, (terms) => terms === 1);

        yield* session(halted, host);

        expect(yield* childTerms()).toBe(1);
      }),
    ),
  30_000,
);

test(
  "a SIGTERM the record cannot be written for is not sent, and is sent once when it can",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ child: "stubborn" });
        process.kill((yield* control()).pid!, "SIGKILL");
        const record = path.dirname(yield* controlFile());
        yield* fs.chmod(record, 0o555);

        yield* session(halted, host);
        expect(yield* childTerms()).toBe(0);

        yield* fs.chmod(record, 0o755);
        yield* session(halted, host);
        yield* until(childTerms, (terms) => terms === 1);
        yield* session(halted, host);
        expect(yield* childTerms()).toBe(1);
      }),
    ),
  30_000,
);

/** The record as a write cut short after `keep` characters would leave it. */
const torn = (keep: number) =>
  Effect.gen(function* () {
    const file = yield* controlFile();
    yield* fs.writeFileString(file, (yield* fs.readFileString(file)).slice(0, keep));
  });

test(
  "a torn control record is never read as no record: the stop fails, the restart parks and the checkout stays held",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null, { verdict: "done" }]);
        const host = yield* hostWith({});
        yield* midWork(host);
        yield* closedByHand;
        const whole = yield* fs.readFileString(yield* controlFile());
        yield* torn(whole.indexOf('"dir"'));

        const halt = yield* session(halted, host);
        expect(halt.left.join("\n")).toContain("control record cannot be read");

        const held = yield* unlistedServers(rig.pluginEnv().stateDir, new Set());
        expect(held.map((one) => one.cwd)).toEqual([rig.projectDir]);

        expect(yield* resumed(host)).toBe(true);
        expect(yield* fs.readFileString(controlPath(dir, PARKED, "r1"))).toContain(
          "control record cannot be read",
        );
        expect(yield* starts()).toBe(1);
        expect(yield* stillWriting()).toBe(true);

        yield* torn(10);
        const blind = yield* unlistedServers(rig.pluginEnv().stateDir, new Set());
        expect(blind.map((one) => one.cwd)).toEqual([null]);
      }),
    ),
  30_000,
);
