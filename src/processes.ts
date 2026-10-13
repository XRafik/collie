// The processes on this computer, as far as a stop needs them: who a pid is, when it
// started, and which session it is in. `/proc` where there is one; `ps` elsewhere, which
// cannot say a session, so a caller there follows parents instead.

import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface Process {
  readonly pid: number;
  readonly ppid: number;
  /** Null where the platform cannot say. */
  readonly session: number | null;
  /** When it started, in the platform's own terms: equal means the same process. */
  readonly started: string;
  readonly command: string;
}

const PROC = "/proc";

/** One `/proc/<pid>/stat`, or null for a zombie: a process that has exited. */
const fromStat = (pid: number, stat: string, command: string): Process | null => {
  // The command in parentheses may hold spaces and parentheses of its own.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return null;
  return {
    pid,
    ppid: Number(fields[1]),
    session: Number(fields[3]),
    started: fields[19] ?? "",
    command,
  };
};

const fromProc = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.readFileString(`${PROC}/${pid}/stat`);
    const argv = yield* fs.readFileString(`${PROC}/${pid}/cmdline`);
    return fromStat(pid, stat, argv.replaceAll("\0", " ").trim());
  }).pipe(Effect.orElseSucceed(() => null));

const ps = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("ps", args, { stdout: "pipe", stderr: "ignore" }),
    );
    return yield* Stream.mkString(Stream.decodeText(handle.stdout));
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => ""),
  );

/** `pid ppid stat lstart(five words) command`, as `ps` prints them. */
const fromPs = (text: string): Process[] =>
  text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words.length >= 8 && !words[2]!.startsWith("Z"))
    .map((words) => ({
      pid: Number(words[0]),
      ppid: Number(words[1]),
      session: null,
      started: words.slice(3, 8).join(" "),
      command: words.slice(8).join(" "),
    }));

const PS_COLUMNS = ["-ww", "-o", "pid=,ppid=,stat=,lstart=,command="];

const hasProc = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.exists(`${PROC}/self/stat`)),
  Effect.orElseSucceed(() => false),
);

/** The live process under `pid`, or null where there is none. */
export const processOf = Effect.fn("Processes.processOf")(function* (pid: number) {
  if (yield* hasProc) return yield* fromProc(pid);
  return fromPs(yield* ps([...PS_COLUMNS, "-p", String(pid)]))[0] ?? null;
});

/** Every live process. */
export const allProcesses = Effect.fn("Processes.allProcesses")(function* () {
  if (!(yield* hasProc)) return fromPs(yield* ps([...PS_COLUMNS, "-A"]));
  const fs = yield* FileSystem.FileSystem;
  const pids = (yield* fs.readDirectory(PROC).pipe(Effect.orElseSucceed(() => [])))
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
  const found = yield* Effect.forEach(pids, fromProc, { concurrency: 32 });
  return found.filter((one): one is Process => one !== null);
});

/** Every process descended from `pid`. */
export const descendantsOf = (all: ReadonlyArray<Process>, pid: number): Process[] => {
  const found: Process[] = [];
  const parents = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const one of all) {
      if (parents.has(one.ppid) && !parents.has(one.pid)) {
        parents.add(one.pid);
        found.push(one);
        grew = true;
      }
    }
  }
  return found;
};
