// The one wait an agent's launch, a Check pass and `collie verify` make while their Machine
// is Short of memory (ADR-draft-new-work-waits-while-its-machine-is-short-of-memory, D2–D7).
// Each wait is a file in its Run's directory, so every door reads it the one way.

import { Clock, Config, Duration, Effect, FileSystem, Option, Path, Random, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { PluginEnv } from "./env";
import { launchDir } from "./launches";
import { machineMemory, PRESSURE_SHORT, type Memory } from "./memory";
import { machineName } from "./peers";
import { took } from "./time";

/** How often a wait reads again; a test of the shipped host names a shorter one. */
const every = Config.Duration("COLLIE_MEMORY_EVERY").pipe(
  Config.withDefault(Duration.seconds(15)),
  Effect.orElseSucceed(() => Duration.seconds(15)),
);
const WAITS_DIR = "memory-waits";

const GB = 1024 ** 3;

const MemoryWaitJson = Schema.fromJsonString(
  Schema.Struct({
    what: Schema.String,
    sentence: Schema.String,
    since: Schema.Number,
    /** The agent whose Output budget this wait pauses: the one that asked for it. */
    asker: Schema.NullOr(Schema.String),
  }),
);
export type MemoryWait = typeof MemoryWaitJson.Type;

/** `waiting for memory on vm-mk: 2.1 of 62.0 GB available`, naming pressure where it is high. */
export const memorySentence = (memory: Memory & { known: true }) =>
  `waiting for memory on ${machineName()}: ${(memory.available / GB).toFixed(1)} of ${(memory.total / GB).toFixed(1)} GB available${memory.pressure !== null && memory.pressure >= PRESSURE_SHORT ? `, pressure ${memory.pressure.toFixed(1)}` : ""}`;

const waitsOf = (runDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${runDir}/${WAITS_DIR}`;
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const waits: MemoryWait[] = [];
    for (const name of names) {
      const text = yield* fs.readFileString(`${dir}/${name}`).pipe(Effect.orElseSucceed(() => ""));
      const decoded = Schema.decodeUnknownOption(MemoryWaitJson)(text);
      if (Option.isSome(decoded)) waits.push(decoded.value);
    }
    return waits.sort((a, b) => a.since - b.since);
  });

/** A wait as every door says it: `Waiting for memory on vm-mk: 2.1 of 62.0 GB available.` */
export const waitLine = (wait: MemoryWait) =>
  `${wait.sentence[0]!.toUpperCase()}${wait.sentence.slice(1)}.`;

/** What of this Run waits for memory longest, or null where nothing does. */
export const memoryWaitOf = (runDir: string) =>
  Effect.map(waitsOf(runDir), (waits) => waits[0] ?? null);

const waitsDir = (stateDir: string, runId: string) => `${stateDir}/runs/${runId}/${WAITS_DIR}`;

/** Whether a `collie verify` `agent` asked for waits for memory, which pauses its Output budget. */
export const holdsBudgetOf = (stateDir: string, runId: string, agent: string) =>
  Effect.map(waitsOf(`${stateDir}/runs/${runId}`), (waits) =>
    waits.some((one) => one.asker === agent),
  );

/**
 * Returns once this Machine is not short of memory, reading it and `memory_hold` again every
 * 15 seconds, and whether it waited. Never fails and reserves nothing; a stop interrupts it.
 */
export const waitForMemory = (opts: {
  readonly env: PluginEnv;
  readonly stateDir: string;
  readonly runId: string;
  readonly what: string;
  readonly asker?: string | null;
  /** Told the sentence once, as the wait begins. */
  readonly say?: (sentence: string) => Effect.Effect<void>;
}): Effect.Effect<
  boolean,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const read = machineMemory(opts.env).pipe(
      Effect.orElseSucceed(() => ({ memory: null, short: false })),
    );
    const first = yield* read;
    if (!first.short || first.memory === null || !first.memory.known) return false;
    const reading = first.memory;
    const fs = yield* FileSystem.FileSystem;
    const dir = waitsDir(opts.stateDir, opts.runId);
    const since = yield* Clock.currentTimeMillis;
    const file = `${dir}/${since}-${yield* Random.nextInt}.json`;
    const runLog = launchDir(opts.stateDir, opts.runId);
    const log = (line: string) =>
      fs
        .makeDirectory(runLog, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(`${runLog}/agents.log`, `${line}\n`, { flag: "a" })),
          Effect.ignore,
        );
    const mark = (memory: Memory & { known: true }) =>
      fs
        .writeFileString(
          file,
          Schema.encodeSync(MemoryWaitJson)({
            what: opts.what,
            sentence: memorySentence(memory),
            since,
            asker: opts.asker ?? null,
          }),
        )
        .pipe(Effect.ignore);
    const period = yield* every;
    yield* Effect.gen(function* () {
      const sentence = memorySentence(reading);
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
      yield* mark(reading);
      yield* log(`${opts.what}: ${sentence}`);
      if (opts.say !== undefined) yield* opts.say(sentence);
      for (;;) {
        yield* Effect.sleep(period);
        const now = yield* read;
        if (!now.short || now.memory === null || !now.memory.known) return;
        yield* mark(now.memory);
      }
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* fs.remove(file).pipe(Effect.ignore);
          const waited = took((yield* Clock.currentTimeMillis) - since);
          yield* log(
            exit._tag === "Success"
              ? `${opts.what}: waited ${waited} for memory`
              : `${opts.what}: stopped after waiting ${waited} for memory`,
          );
        }),
      ),
    );
    return true;
  });
