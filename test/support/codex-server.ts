// A stand-in `codex app-server`, run as a real process in its place: `bun codex-server.ts
// <config.json> --listen ws://127.0.0.1:0`. It answers the protocol shapes the installed
// release's schema declares (checked in `test/compaction-codex.test.ts`), drains on its
// first SIGTERM the way 0.162.0 does on a websocket, and records its own argv, every request
// and every signal it receives as a JSON line in `config.events`.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface StandIn {
  /** Where every request and signal is recorded, one JSON object per line. */
  events: string;
  threads: ReadonlyArray<{
    id: string;
    cwd: string;
    parent?: string;
    path?: string;
    /** A turn in progress from the start, appending to `writes` until it ends. */
    turn?: { id: string; writes?: string };
  }>;
  /** Answer `turn/interrupt` and keep the turn running. */
  ignoreInterrupt?: boolean;
  /** Stay up after a drain with nothing running. */
  neverExit?: boolean;
  /** Close the connection instead of answering this method. */
  dropOn?: string;
  /** Start a queued turn on a thread whose turn was interrupted, unless draining. */
  continuation?: boolean;
  /** A process of this server's session: one that ends on SIGTERM, or one that ignores it. */
  child?: "ends" | "ignores";
  /** Environment variables whose values it records when it starts. */
  env?: ReadonlyArray<string>;
}

const config: StandIn = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const record = (event: Record<string, unknown>) =>
  appendFileSync(config.events, `${JSON.stringify({ at: Date.now(), ...event })}\n`);

interface Turn {
  id: string;
  status: string;
  timer?: ReturnType<typeof setInterval>;
}
record({
  pid: process.pid,
  argv: process.argv.slice(2),
  env: Object.fromEntries((config.env ?? []).map((name) => [name, process.env[name] ?? null])),
});
const turns = new Map<string, Turn[]>();
const running = () => [...turns.values()].flat().filter((turn) => turn.status === "inProgress");
let draining = false;

const begin = (threadId: string, id: string, writes?: string) => {
  const turn: Turn = { id, status: "inProgress" };
  if (writes !== undefined)
    turn.timer = setInterval(() => appendFileSync(writes, `${id} ${Date.now()}\n`), 20);
  turns.set(threadId, [...(turns.get(threadId) ?? []), turn]);
  record({ turn: id, thread: threadId, started: true });
};
for (const thread of config.threads) {
  turns.set(thread.id, []);
  if (thread.turn) begin(thread.id, thread.turn.id, thread.turn.writes);
}

const exitWhenIdle = () => {
  if (draining && running().length === 0 && !config.neverExit)
    setTimeout(() => process.exit(0), 50);
};

// A test lets every running turn end by creating `<events>.release`.
setInterval(() => {
  if (!existsSync(`${config.events}.release`)) return;
  for (const turn of running()) {
    clearInterval(turn.timer);
    turn.status = "completed";
  }
  exitWhenIdle();
}, 50);

process.on("SIGTERM", () => {
  record({ signal: "SIGTERM" });
  draining = true;
  exitWhenIdle();
});

if (config.child !== undefined) {
  const trap =
    config.child === "ignores" ? `trap "echo TERM >> '${config.events}.child'" TERM; ` : "";
  const child = Bun.spawn(["sh", "-c", `${trap}while :; do sleep 0.05; done`], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  record({ child: child.pid });
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request, self) =>
    self.upgrade(request) ? undefined : new Response("no", { status: 400 }),
  websocket: {
    message: (ws, raw) => void answer(ws, raw),
  },
});

function answer(ws: import("bun").ServerWebSocket<undefined>, raw: string | Buffer) {
  const { id, method, params = {} } = JSON.parse(String(raw));
  record({ method, params });
  if (method === config.dropOn) return ws.close();
  const reply = (result: unknown) => ws.send(JSON.stringify({ id, result }));
  const refuse = (message: string) =>
    ws.send(JSON.stringify({ id, error: { code: -32600, message } }));
  const thread = config.threads.find((one) => one.id === params.threadId);
  switch (method) {
    case "initialize":
      return reply({ userAgent: "stand-in" });
    case "thread/loaded/list":
      return reply({
        data: config.threads.map((one) => one.id),
        nextCursor: null,
      });
    case "thread/read":
      return thread
        ? reply({
            thread: {
              id: thread.id,
              cwd: thread.cwd,
              ephemeral: false,
              parentThreadId: thread.parent ?? null,
              path: thread.path ?? null,
            },
          })
        : refuse("no such thread");
    case "thread/turns/list":
      return reply({
        data: [...(turns.get(params.threadId) ?? [])]
          .reverse()
          .map((turn) => ({ id: turn.id, status: turn.status })),
        nextCursor: null,
      });
    case "turn/interrupt": {
      const turn = running().find(
        (one) => (turns.get(params.threadId) ?? []).includes(one) && one.id === params.turnId,
      );
      if (!turn) return refuse("no active turn to interrupt");
      reply({});
      if (config.ignoreInterrupt) return;
      clearInterval(turn.timer);
      turn.status = "interrupted";
      if (config.continuation && !draining)
        begin(params.threadId, `${turn.id}-continued`, thread?.turn?.writes);
      return exitWhenIdle();
    }
    case "turn/start":
    case "thread/start":
      return draining ? refuse("serverShuttingDown") : reply({});
    default:
      return reply({});
  }
}
console.log(`codex app-server listening on ws://127.0.0.1:${server.port}`);
