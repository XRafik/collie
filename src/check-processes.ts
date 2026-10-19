// A check's processes, from spawn to gone (ADR-draft-a-check-ends-with-the-host-that-runs-it).
//
// A host's adapter marks every process of a check with this state directory's
// installation and the check's id, records the check under `running-checks/`, and keeps
// the checks it is collecting so that its end can end them. Nothing is signalled that is
// not proved the check's: its recorded leader by pid and start token, or a process
// carrying both bindings. A check this host ended reports no exit, so nothing records it.

import { Context, Effect, FileSystem, Random, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Scope } from "effect";
import { bindingsOf, groupOf, startedOf, stillRunning } from "./processes";
import { epochMs, nowIso } from "./time";

export const CHECK_INSTALLATION = "COLLIE_CHECK_INSTALLATION";
export const CHECK_ID = "COLLIE_CHECK_ID";
const KILL_AFTER = "2 seconds";

/** Which check of which Run, as its record and the host's log name it. */
export interface CheckOf {
  readonly run: string;
  readonly name: string;
  readonly pass?: { readonly pass: string; readonly round?: number };
  readonly by: "agent" | "collie";
}

export interface CheckCommand {
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
}

export interface RunningCheck {
  readonly stdout: Stream.Stream<Uint8Array, PlatformError>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError>;
  /** Never resolves for a check this host ended. */
  readonly exit: Effect.Effect<number, PlatformError>;
}

export interface CheckProcessesApi {
  /** Starts the check in the caller's Scope, whose close ends its processes for good. */
  readonly run: (
    check: CheckOf,
    command: CheckCommand,
  ) => Effect.Effect<
    RunningCheck,
    PlatformError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
  /** Marks every check this host is collecting ended, then sends each SIGTERM. */
  readonly endAll: Effect.Effect<ReadonlyArray<CheckOf>>;
  /** SIGKILL to whatever of an ended check is left, and its record gone once it is. */
  readonly killEnded: Effect.Effect<void>;
}

const RecordSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  name: Schema.String,
  pass: Schema.optionalKey(Schema.String),
  round: Schema.optionalKey(Schema.Number),
  by: Schema.String,
  leader: Schema.Struct({ pid: Schema.Number, started: Schema.String, group: Schema.Number }),
  host: Schema.Struct({ pid: Schema.Number, started: Schema.String }),
  started: Schema.String,
});
export type CheckRecord = Schema.Schema.Type<typeof RecordSchema>;
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(RecordSchema));

export const runningChecksDir = (stateDir: string) => `${stateDir}/running-checks`;
const recordPath = (stateDir: string, id: string) => `${runningChecksDir(stateDir)}/${id}.json`;

const spawnCheck = (command: CheckCommand, env?: Readonly<Record<string, string>>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.spawn(
      ChildProcess.make(command.executable, [...command.argv], {
        cwd: command.cwd,
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
        ...(env !== undefined && { env }),
        forceKillAfter: KILL_AFTER,
      }),
    ),
  );

/** Outside a host: its own group, ended with its Scope, and nothing recorded. */
const unrecorded: CheckProcessesApi = {
  run: (_check, command) =>
    Effect.map(spawnCheck(command), (handle) => ({
      stdout: handle.stdout,
      stderr: handle.stderr,
      exit: Effect.map(handle.exitCode, Number),
    })),
  endAll: Effect.succeed([]),
  killEnded: Effect.void,
};

export const CheckProcesses = Context.Reference<CheckProcessesApi>("collie/CheckProcesses", {
  defaultValue: () => unrecorded,
});

/** Every running process carrying this installation's and this check's bindings. */
const markedWith = (installation: string, id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found: number[] = [];
    for (const name of yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []))) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      const bound = yield* bindingsOf(pid, [CHECK_INSTALLATION, CHECK_ID]);
      if (bound?.[CHECK_INSTALLATION] !== installation || bound[CHECK_ID] !== id) continue;
      if ((yield* groupOf(pid)) !== null) found.push(pid);
    }
    return found;
  });

/** What of a check is proved still running: its group, while its leader is the recorded one, and each marked process. */
const provedOf = (record: Pick<CheckRecord, "id" | "leader">, installation: string) =>
  Effect.gen(function* () {
    const { leader } = record;
    const group =
      leader.started !== "" &&
      (yield* stillRunning(leader)) &&
      (yield* groupOf(leader.pid)) === leader.group
        ? leader.group
        : null;
    return { group, marked: yield* markedWith(installation, record.id) };
  });
type Proved = Effect.Success<ReturnType<typeof provedOf>>;

const isGone = (proved: Proved) => proved.group === null && proved.marked.length === 0;

const signal = (proved: Proved, name: NodeJS.Signals) =>
  Effect.sync(() => {
    const send = (target: number) => {
      try {
        process.kill(target, name);
      } catch {
        // Gone already.
      }
    };
    if (proved.group !== null) send(-proved.group);
    for (const pid of proved.marked) send(pid);
  });

/** Polls until nothing of it is proved running, or `within` is up; true where it is gone. */
const goneWithin = (
  record: Pick<CheckRecord, "id" | "leader">,
  installation: string,
  within: number,
) =>
  Effect.gen(function* () {
    for (let waited = 0; ; waited += 100) {
      if (isGone(yield* provedOf(record, installation))) return true;
      if (waited >= within) return false;
      yield* Effect.sleep("100 millis");
    }
  });

/**
 * Ends one check for good: SIGTERM, up to two seconds, SIGKILL, and a last look, where a
 * zombie counts as gone. True where nothing of it is left.
 */
export const endCheck = Effect.fn("CheckProcesses.endCheck")(function* (
  record: Pick<CheckRecord, "id" | "leader">,
  installation: string,
) {
  const proved = yield* provedOf(record, installation);
  if (isGone(proved)) return true;
  yield* signal(proved, "SIGTERM");
  if (yield* goneWithin(record, installation, 2_000)) return true;
  yield* signal(yield* provedOf(record, installation), "SIGKILL");
  return yield* goneWithin(record, installation, 1_000);
});

interface Collecting {
  readonly check: CheckOf;
  readonly record: CheckRecord;
  ended: boolean;
}

/** The host's adapter for the state directory `dir`, whose installation id is `installation`. */
export const hostCheckProcesses = Effect.fn("CheckProcesses.host")(function* (options: {
  readonly dir: string;
  readonly installation: string;
}) {
  const { dir, installation } = options;
  const fs = yield* FileSystem.FileSystem;
  // Only these, so a check's spawn and finalizer stay in its caller's Scope.
  const services = Context.make(FileSystem.FileSystem, fs).pipe(
    Context.add(
      ChildProcessSpawner.ChildProcessSpawner,
      yield* ChildProcessSpawner.ChildProcessSpawner,
    ),
  );
  const collecting = new Map<string, Collecting>();
  const host = { pid: process.pid, started: (yield* startedOf(process.pid)) ?? "" };

  const forget = (id: string) =>
    fs
      .remove(recordPath(dir, id), { force: true })
      .pipe(Effect.ignore, Effect.andThen(Effect.sync(() => collecting.delete(id))));

  const run: CheckProcessesApi["run"] = (check, command) =>
    Effect.gen(function* () {
      const began = yield* nowIso();
      const salt = (yield* Random.next).toString(16).slice(2);
      const id = `${check.run}@${epochMs(began)}-${salt}`;
      const handle = yield* spawnCheck(command, {
        [CHECK_INSTALLATION]: installation,
        [CHECK_ID]: id,
      });
      const record: CheckRecord = {
        id,
        run: check.run,
        name: check.name,
        ...(check.pass !== undefined && { pass: check.pass.pass }),
        ...(check.pass?.round !== undefined && { round: check.pass.round }),
        by: check.by,
        leader: {
          pid: handle.pid,
          started: (yield* startedOf(handle.pid)) ?? "",
          group: (yield* groupOf(handle.pid)) ?? handle.pid,
        },
        host,
        started: began,
      };
      const entry: Collecting = { check, record, ended: false };
      collecting.set(id, entry);
      yield* Effect.addFinalizer(() =>
        endCheck(record, installation).pipe(Effect.andThen(forget(id)), Effect.ignore),
      );
      yield* fs.makeDirectory(runningChecksDir(dir), { recursive: true }).pipe(Effect.ignore);
      yield* fs
        .writeFileString(`${recordPath(dir, id)}.new`, encodeRecord(record))
        .pipe(Effect.andThen(fs.rename(`${recordPath(dir, id)}.new`, recordPath(dir, id))))
        .pipe(Effect.ignore);
      return {
        stdout: handle.stdout,
        stderr: handle.stderr,
        exit: handle.exitCode.pipe(
          Effect.exit,
          Effect.flatMap((exit) => (entry.ended ? Effect.never : exit)),
          Effect.map(Number),
        ),
      };
    }).pipe(Effect.provideContext(services));

  const endAll = Effect.gen(function* () {
    const ended: CheckOf[] = [];
    for (const entry of collecting.values()) {
      if (entry.ended) continue;
      entry.ended = true;
      ended.push(entry.check);
    }
    for (const entry of collecting.values())
      yield* signal(yield* provedOf(entry.record, installation), "SIGTERM");
    return ended;
  }).pipe(Effect.provideContext(services));

  const killEnded = Effect.gen(function* () {
    const ended = [...collecting.values()].filter((entry) => entry.ended);
    for (const entry of ended)
      yield* signal(yield* provedOf(entry.record, installation), "SIGKILL");
    for (const entry of ended)
      if (yield* goneWithin(entry.record, installation, 1_000)) yield* forget(entry.record.id);
  }).pipe(Effect.provideContext(services));

  return { run, endAll, killEnded } satisfies CheckProcessesApi;
});
