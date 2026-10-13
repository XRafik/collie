// A stand-in `codex app-server`, run as a real process in its place: `bun <this> <config>
// --listen ws://127.0.0.1:0`. It answers the shapes the installed release's own schema
// declares (the contract check in `compaction-codex.test.ts` holds that separately), and
// drains on its first SIGTERM as 0.162.0 does on a websocket: admission closes, a running
// turn is kept, and it exits once no turn is running.
//
// Everything it is sent, and every signal, is appended to `record`, one JSON line each.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** One line of `record`: a request it was sent, a signal, a turn or child it started, its exit. */
interface Entry {
  readonly method?: string;
  readonly params?: { readonly threadId?: string; readonly turnId?: string };
  readonly signal?: string;
  readonly started?: string;
  readonly child?: number;
  readonly exit?: boolean;
}

type Answer = string | number | boolean | null | Answer[] | { [key: string]: Answer };

export interface StandInConfig {
  /** The agent's own directory, which its threads report. */
  readonly cwd: string;
  readonly record: string;
  /** Where the agent's turn appends a line every few milliseconds until it ends. */
  readonly writes: string;
  /** A sub-agent thread with a turn of its own, writing to `writes` too. */
  readonly subagent?: boolean;
  /** A continuation that starts a new turn after an interrupt, unless it is draining. */
  readonly queued?: boolean;
  /** A child process in its session; `stubborn` ignores SIGTERM. */
  readonly child?: "plain" | "stubborn";
  /** While this file exists, an interrupt is answered and the turn carries on. */
  readonly holdWhile?: string;
  /** Never exits, drained or not. */
  readonly neverExit?: boolean;
  /** Drops the connection when it is asked for a thread's turns. */
  readonly dropConnection?: boolean;
  /** A thread of another directory loaded beside the agent's own. */
  readonly foreignThread?: boolean;
  /** A file it creates once it is up. */
  readonly touch?: string;
}

const config: StandInConfig = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const record = (entry: Entry) => appendFileSync(config.record, `${JSON.stringify(entry)}\n`);

interface Turn {
  id: string;
  status: "inProgress" | "completed" | "interrupted";
  timer?: ReturnType<typeof setInterval>;
}
interface Thread {
  id: string;
  cwd: string;
  parentThreadId: string | null;
  turns: Turn[];
}

const MAIN = "019a0001-0000-7000-8000-000000000001";
const SUB = "019a0001-0000-7000-8000-000000000002";
const FOREIGN = "019a0001-0000-7000-8000-000000000003";

let draining = false;
let line = 0;

const run = (thread: Thread, id: string) => {
  const turn: Turn = { id, status: "inProgress" };
  turn.timer = setInterval(
    () => appendFileSync(config.writes, `${thread.id} ${id} ${++line}\n`),
    10,
  );
  thread.turns.push(turn);
  record({ started: id });
};

const threads: Thread[] = [{ id: MAIN, cwd: config.cwd, parentThreadId: null, turns: [] }];
run(threads[0]!, "019a0002-0000-7000-8000-00000000000a");
if (config.subagent) {
  threads.push({ id: SUB, cwd: config.cwd, parentThreadId: MAIN, turns: [] });
  run(threads[1]!, "019a0002-0000-7000-8000-00000000000b");
}
if (config.foreignThread)
  threads.push({
    id: FOREIGN,
    cwd: "/somewhere/else",
    parentThreadId: null,
    turns: [],
  });

if (config.child) {
  const script =
    config.child === "stubborn" ? `trap '' TERM; while :; do sleep 0.05; done` : "exec sleep 600";
  const child = Bun.spawn(["sh", "-c", script], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  record({ child: child.pid });
}

const running = () => threads.some((t) => t.turns.some((turn) => turn.status === "inProgress"));
const exitIfDrained = () => {
  if (!draining || config.neverExit || running()) return;
  record({ exit: true });
  setTimeout(() => process.exit(0), 20);
};

process.on("SIGTERM", () => {
  record({ signal: "SIGTERM" });
  draining = true;
  exitIfDrained();
});

const status = (thread: Thread): Answer =>
  thread.turns.some((turn) => turn.status === "inProgress")
    ? { type: "active", activeFlags: [] }
    : { type: "idle" };

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request, self) =>
    self.upgrade(request) ? undefined : new Response("no", { status: 400 }),
  websocket: {
    message(ws, raw) {
      const { id, method, params = {} } = JSON.parse(String(raw));
      record({ method, params });
      const reply = (result: Answer) => void ws.send(JSON.stringify({ id, result }));
      const refuse = (message: string) =>
        void ws.send(JSON.stringify({ id, error: { code: -32600, message } }));
      const thread = threads.find((t) => t.id === params.threadId);
      switch (method) {
        case "initialize":
          return reply({ userAgent: "stand-in" });
        case "thread/loaded/list":
          return reply({ data: threads.map((t) => t.id), nextCursor: null });
        case "thread/read":
          if (!thread) return refuse("no such thread");
          return reply({
            thread: {
              id: thread.id,
              cwd: thread.cwd,
              ephemeral: false,
              parentThreadId: thread.parentThreadId,
              path: `/rollouts/${thread.id}.jsonl`,
              status: status(thread),
            },
          });
        case "thread/turns/list":
          if (config.dropConnection) return void ws.terminate();
          if (!thread) return refuse("no such thread");
          return reply({
            data: [...thread.turns].reverse().map(({ id, status }) => ({ id, status, items: [] })),
            nextCursor: null,
          });
        case "turn/interrupt": {
          const turn = thread?.turns.find((t) => t.id === params.turnId);
          if (!thread || turn?.status !== "inProgress")
            return refuse("no active turn to interrupt");
          reply({});
          if (config.holdWhile !== undefined && existsSync(config.holdWhile)) return;
          clearInterval(turn.timer);
          turn.status = "interrupted";
          if (config.queued && !draining) run(thread, "019a0002-0000-7000-8000-0000000000ff");
          return exitIfDrained();
        }
        default:
          return refuse(`unknown method ${method}`);
      }
    },
  },
});

if (config.touch !== undefined) writeFileSync(config.touch, "");
console.log(`listening on: ws://127.0.0.1:${server.port}`);
