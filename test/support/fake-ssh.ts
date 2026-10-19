// The fake `ssh` every test shares (`fake-ssh-main.ts`), and the network fault a blocked
// port is: a resetter that drops each connection at its first bytes, as Cloudflare WARP
// resets the TLS ClientHello on a peer's port.

import { createConnection, createServer, type Server } from "node:net";
import { Effect, FileSystem, Schema, type Scope } from "effect";
import { root } from "./host";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A fake `ssh` written to `bin`, and what a test does to it. */
export interface FakeSsh {
  /** Every call, one line each: `master`, `mux <verb>`, `ride` or `login`. */
  readonly log: string;
  /** The log's lines now. */
  readonly calls: Effect.Effect<ReadonlyArray<string>>;
  /** Where a forward to the far `127.0.0.1:<far>` really goes. */
  readonly maps: (ports: Readonly<Record<number, number>>) => Effect.Effect<void>;
  /** Whether a master the fake opens waits forever on its login. */
  readonly hangs: (hanging: boolean) => Effect.Effect<void>;
  /** Ends every master, as a sleep or a dropped network does, logging nothing. */
  readonly drop: Effect.Effect<void>;
}

const Bound = Schema.Struct({ port: Schema.Number });

/** The port a server listens on. */
export const portOf = (server: Server) => {
  const address = server.address();
  return Schema.is(Bound)(address) ? address.port : 0;
};

/** A port of 127.0.0.1 nothing listens on now. */
export const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = portOf(server);
    server.close(() => resume(Effect.succeed(port)));
  });
});

/** A request on a master's control path, as `fake-ssh-main.ts` reads one. */
const tell = (path: string, op: string) =>
  Effect.callback<void>((resume) => {
    const conn = createConnection(path);
    conn.once("connect", () => conn.write(`${encode({ op })}\n`));
    conn.resume();
    conn.once("error", () => resume(Effect.void));
    conn.once("close", () => resume(Effect.void));
  });

/**
 * Writes `bin` as a fake `ssh` keeping its state in `dir`. A session runs with `env` where
 * one is given, as a login on the far Machine would.
 */
export const writeFakeSsh = Effect.fn("FakeSsh.write")(function* (
  bin: string,
  dir: string,
  env: Readonly<Record<string, string>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const log = `${dir}/ssh-calls.log`;
  const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
  yield* fs.writeFileString(
    bin,
    `#!/bin/sh\nFAKE_SSH_LOG=${quote(log)} FAKE_SSH_DIR=${quote(dir)} FAKE_SSH_ENV=${quote(encode(env))} exec ${quote(process.execPath)} ${quote(`${root}test/support/fake-ssh-main.ts`)} "$@"\n`,
    { mode: 0o755 },
  );
  yield* fs.writeFileString(log, "");
  const drop = fs.readFileString(`${dir}/masters`).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((paths) =>
      Effect.forEach(
        paths.split("\n").filter((path) => path !== ""),
        (path) => tell(path, "drop"),
        { discard: true },
      ),
    ),
  );
  yield* Effect.addFinalizer(() => drop);
  const fake: FakeSsh = {
    log,
    calls: fs.readFileString(log).pipe(
      Effect.map((text) => text.split("\n").filter((line) => line !== "")),
      Effect.orDie,
    ),
    maps: (ports) => fs.writeFileString(`${dir}/ports.json`, encode(ports)).pipe(Effect.orDie),
    hangs: (hanging) =>
      (hanging
        ? fs.writeFileString(`${dir}/master-hangs`, "")
        : fs.remove(`${dir}/master-hangs`, { force: true })
      ).pipe(Effect.orDie),
    drop,
  };
  return fake;
});

/** A TCP server on `port` of 127.0.0.1 that destroys each connection at its first bytes. */
export const resetter = (port: number): Effect.Effect<Server, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((conn) => {
        conn.once("data", () => conn.destroy());
        conn.once("error", () => {});
      });
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );
