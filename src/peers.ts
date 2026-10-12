// This Machine's peers (ADR-0054): the pairing each side keeps, the listener a peer that
// dials in reaches, and one relay socket per peer that speaks what `host.sock` speaks.
// Every client reaches another Machine by opening `relayOf(stateDir, name)`, and nothing
// above that path knows there is a WebSocket behind it.

import { createServer, type Server, type Socket } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { Config, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FrontDoor, HostRefused, type Declaration } from "./board-model";
import { channelInto } from "./channel";
import { shell } from "./mr";
import {
  Invited,
  MachineUnreachable,
  PEER_PORT,
  PeersFile,
  RelayHeaderJson,
  type HerdrMachine,
  type Peer,
  type PeerView,
} from "./peers-model";
import { reason } from "./naming";

export const relayOf = (stateDir: string, name: string) => `${stateDir}/peers/${name}.sock`;
const fileOf = (stateDir: string) => `${stateDir}/peers.json`;
export const certOf = (stateDir: string) => `${stateDir}/peer-cert.pem`;
export const keyOf = (stateDir: string) => `${stateDir}/peer-key.pem`;

/** The longest unix socket path macOS binds. */
const SOCKET_PATH_MAX = 104;

/** This Machine as a peer names it, where nothing better is known. */
export const machineName = () => hostname();

const decodePeers = Schema.decodeUnknownEffect(PeersFile);
const encodePeers = Schema.encodeSync(PeersFile);

/** Every pairing this Machine keeps; none where it has never paired. */
export const peersOf = (stateDir: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(fileOf(stateDir))),
    Effect.flatMap(decodePeers),
    Effect.orElseSucceed((): ReadonlyArray<Peer> => []),
  );

const writePeers = Effect.fn("Peers.write")(function* (
  stateDir: string,
  peers: ReadonlyArray<Peer>,
) {
  const fs = yield* FileSystem.FileSystem;
  const tmp = `${fileOf(stateDir)}.${process.pid}.tmp`;
  yield* fs.writeFileString(tmp, `${encodePeers(peers)}\n`, { mode: 0o600 });
  yield* fs.chmod(tmp, 0o600);
  yield* fs.rename(tmp, fileOf(stateDir));
});

const port = Config.Int("COLLIE_PEER_PORT").pipe(Config.withDefault(PEER_PORT), Effect.orDie);

/** Whether a secret is this one, without saying how much of it matched. */
const sameSecret = (given: string, kept: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(kept);
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let at = 0; at < a.length; at++) differ |= a[at]! ^ b[at]!;
  return differ === 0;
};

/** The names and addresses this Machine may be dialled by, and the one the asker will use. */
const namesFor = (address: string | null) => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .flatMap((one) => (one === undefined ? [] : [one.address]));
  const names = [hostname(), "localhost", ...(address === null ? [] : [address])];
  const ip = /^[\d.]+$|:/;
  return [...new Set([...names, ...ips, "127.0.0.1"])].map((one) =>
    ip.test(one) ? `IP:${one}` : `DNS:${one}`,
  );
};

/**
 * This Machine's certificate, made with `openssl` the first time it is invited, and made
 * again only where the address an asker dials is not on it.
 */
export const certificateFor = Effect.fn("Peers.certificateFor")(function* (
  stateDir: string,
  address: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const kept = yield* fs.readFileString(certOf(stateDir)).pipe(Effect.option);
  if (Option.isSome(kept) && (address === null || (yield* sanOf(stateDir)).includes(address)))
    return kept.value;
  const made = yield* shell(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyOf(stateDir),
      "-out",
      certOf(stateDir),
      "-days",
      "3650",
      "-subj",
      "/CN=collie",
      "-addext",
      `subjectAltName=${namesFor(address).join(",")}`,
    ],
    stateDir,
  );
  if (made.code !== 0)
    return yield* new HostRefused({
      reason: `openssl could not make this Machine's certificate: ${(made.stderr ?? "").trim() || `exit ${made.code}`}`,
    });
  yield* fs.chmod(keyOf(stateDir), 0o600);
  yield* fs.chmod(certOf(stateDir), 0o600);
  return yield* fs.readFileString(certOf(stateDir));
});

/** The names on this Machine's certificate. */
const sanOf = (stateDir: string) =>
  shell(
    "openssl",
    ["x509", "-in", certOf(stateDir), "-noout", "-ext", "subjectAltName"],
    stateDir,
  ).pipe(
    Effect.map(({ stdout }) =>
      stdout
        .split(/[\s,]+/)
        .map((one) => one.replace(/^(DNS|IP Address):/, ""))
        .filter((one) => one !== ""),
    ),
  );

/** What a peer link reaches its own host with, which only it may declare `from.machine` with. */
export interface Link {
  readonly dir: string;
  readonly installation: string;
  /** This host's own, which a front door cannot know. */
  readonly stamp: string;
  /** This host's socket, which a channel from a peer is declared on. */
  readonly socket: string;
  /** Tells a peer this Machine has forgotten it, over its relay. */
  readonly tell: (peer: Peer) => Effect.Effect<void>;
  /** herdr's machines, or null where herdr could not say. */
  readonly machines: Effect.Effect<ReadonlyArray<{ readonly label: string }> | null>;
}

/** What this host's peers module answers. */
export interface Peers {
  readonly invite: (asker: {
    readonly installation: string;
    readonly name: string;
    readonly address: string | null;
  }) => Effect.Effect<Invited, HostRefused>;
  readonly add: (peer: Peer) => Effect.Effect<void, HostRefused>;
  readonly forget: (installation: string) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<PeerView>>;
}

/** One line answering a relay connection's header: open, or why not. */
export const RelayAnswer = Schema.Struct({
  ok: Schema.Boolean,
  refused: Schema.optionalKey(Schema.String),
  unreachable: Schema.optionalKey(Schema.String),
});
export type RelayAnswer = typeof RelayAnswer.Type;
const encodeAnswer = Schema.encodeSync(Schema.fromJsonString(RelayAnswer));
export const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(RelayAnswer));

/** Reads a connection's first line, handing on whatever followed it. */
const firstLine = (conn: Socket, then: (line: string, rest: Buffer) => void) => {
  let seen = Buffer.alloc(0);
  const take = (chunk: Buffer) => {
    seen = Buffer.concat([seen, chunk]);
    const end = seen.indexOf(10);
    if (end === -1) {
      if (seen.length > 64 * 1024) conn.destroy();
      return;
    }
    conn.off("data", take);
    conn.pause();
    then(seen.subarray(0, end).toString("utf8"), seen.subarray(end + 1));
  };
  conn.on("data", take);
};

/** How long a relay waits for its peer to answer before it says the Machine is away. */
const REACH_BOUND = "5 seconds";

// SAFETY: Bun's WebSocket takes these options; where DOM's declaration of the global wins, its type does not say so.
const BunWebSocket = WebSocket as new (
  url: string,
  options?:
    | string
    | Array<string>
    | { readonly headers: Record<string, string>; readonly tls: { readonly ca?: string } },
) => WebSocket;

/** A WebSocket to a peer this Machine dials, trusting only its certificate. */
const pinnedSocket = (peer: Peer, url: string) =>
  new BunWebSocket(url, {
    headers: { Authorization: `Bearer ${peer.secret}` },
    tls: { ca: peer.certificate },
  });

/** The far end of a channel to a peer, however it was opened. */
interface Far {
  readonly send: (chunk: Uint8Array) => void;
  readonly close: () => void;
  readonly listen: (deliver: (chunk: Uint8Array) => void, done: () => void) => void;
}

/**
 * The peers module, for as long as the host's scope: the records, a relay socket for each
 * peer this Machine dials, and the listener while any peer dials in.
 */
export const startPeers = Effect.fn("Peers.start")(function* (link: Link) {
  const fs = yield* FileSystem.FileSystem;
  const services = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();
  const listenPort = yield* port;
  let peers = [...(yield* peersOf(link.dir))];
  const relays = new Map<string, Server>();
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let listening: string | null = null;
  /** The certificate the listener was started with. */
  let served: string | null = null;

  const keep = (next: ReadonlyArray<Peer>) =>
    Effect.gen(function* () {
      peers = [...next];
      yield* writePeers(link.dir, peers);
      yield* settle;
    }).pipe(
      Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
      Effect.provideContext(services),
    );

  /** A fresh `/channel` WebSocket to a peer this Machine dials, once it is open. */
  const dialOut = (peer: Peer, as: FrontDoor, client: string) =>
    Effect.gen(function* () {
      const url = `${peer.url}/channel?as=${encodeURIComponent(as)}&client=${encodeURIComponent(client)}`;
      const ws = pinnedSocket(peer, url);
      ws.binaryType = "arraybuffer";
      const opened = yield* Effect.callback<boolean>((resume) => {
        ws.onopen = () => resume(Effect.succeed(true));
        ws.onerror = () => resume(Effect.succeed(false));
      }).pipe(Effect.timeoutOption(REACH_BOUND));
      if (Option.isSome(opened) && opened.value) {
        const far: Far = {
          send: (chunk) => ws.send(new Uint8Array(chunk)),
          close: () => ws.close(),
          listen: (deliver, done) => {
            ws.onmessage = (event) => deliver(new Uint8Array(event.data));
            ws.onclose = done;
          },
        };
        return far;
      }
      ws.close();
      return yield* new MachineUnreachable({
        machine: peer.name,
        seen: Option.isNone(opened)
          ? `no answer from ${peer.url} within ${REACH_BOUND}`
          : `${peer.url} refused the connection`,
      });
    });

  /** A relay connection, once its header is read, piped to the far end of a fresh channel. */
  const relayed = (peer: Peer, conn: Socket, line: string, rest: Uint8Array) =>
    Effect.gen(function* () {
      const answer = (said: RelayAnswer) => `${encodeAnswer(said)}\n`;
      const header = Schema.decodeUnknownOption(RelayHeaderJson)(line);
      if (Option.isNone(header))
        return conn.end(answer({ ok: false, refused: `"${line}" is not a relay header` }));
      const { as, client } = header.value;
      if (as === "host" && header.value.stamp !== link.stamp)
        return conn.end(answer({ ok: false, refused: "only this Machine's host speaks as host" }));
      const far = yield* dialOut(peer, as, client).pipe(Effect.result);
      if (far._tag === "Failure")
        return conn.end(answer({ ok: false, unreachable: far.failure.seen }));
      const ws = far.success;
      conn.write(answer({ ok: true }));
      if (rest.length > 0) ws.send(rest);
      ws.listen(
        (chunk) => void conn.write(chunk),
        () => conn.end(),
      );
      conn.on("data", (chunk: Buffer) => ws.send(new Uint8Array(chunk)));
      conn.on("close", () => ws.close());
      conn.on("error", () => ws.close());
      conn.resume();
    });

  const relayTo = (peer: Peer) => (conn: Socket) =>
    firstLine(conn, (line, rest) => void Effect.runFork(relayed(peer, conn, line, rest)));

  const openRelay = (peer: Peer) =>
    Effect.gen(function* () {
      const path = relayOf(link.dir, peer.name);
      yield* fs.makeDirectory(`${link.dir}/peers`, { recursive: true });
      yield* fs.remove(path, { force: true });
      const server = createServer(relayTo(peer));
      yield* Effect.callback<void>((resume) => {
        server.once("error", () => resume(Effect.void));
        server.listen(path, () => resume(Effect.void));
      });
      relays.set(peer.installation, server);
    }).pipe(Effect.orDie);

  const closeRelay = (installation: string) =>
    Effect.sync(() => {
      relays.get(installation)?.close();
      relays.delete(installation);
    });

  /** Whom the listener lets in: the installation a bearer secret was minted for. */
  const bearerOf = (request: Request) => {
    const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (given === undefined) return undefined;
    return peers.find((peer) => peer.dials === "in" && sameSecret(given, peer.secret));
  };

  interface Channel {
    readonly peer: Peer;
    readonly as: FrontDoor;
    readonly client: string;
    /** What the peer sent before the host took the declaration. */
    readonly queued: Array<Uint8Array>;
    toHost: (chunk: Uint8Array) => void;
    hungUp: () => void;
  }

  const startListener = Effect.gen(function* () {
    const cert = yield* fs.readFileString(certOf(link.dir));
    const key = yield* fs.readFileString(keyOf(link.dir));
    served = cert;
    return Bun.serve<Channel>({
      hostname: "0.0.0.0",
      port: listenPort,
      tls: { cert, key },
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (url.pathname !== "/channel") return new Response("not found", { status: 404 });
        const peer = bearerOf(request);
        if (peer === undefined) return new Response("not paired", { status: 401 });
        const as = url.searchParams.get("as") ?? "";
        if (!Schema.is(FrontDoor)(as))
          return new Response(`"${as}" is not a front door`, { status: 400 });
        const queued: Array<Uint8Array> = [];
        const data: Channel = {
          peer,
          as,
          client: url.searchParams.get("client") ?? peer.name,
          queued,
          toHost: (chunk) => void queued.push(chunk),
          hungUp: () => {},
        };
        return server.upgrade(request, { data }) ? undefined : new Response("", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          const channel = ws.data;
          const declaration: Declaration = {
            frontDoor: channel.as,
            from: {
              machine: { installation: channel.peer.installation, name: channel.peer.name },
              client: channel.client,
            },
            stamp: link.stamp,
          };
          Effect.runFork(
            channelInto(link.socket, declaration, {
              write: (chunk) => void ws.sendBinary(chunk),
              end: (done) => {
                ws.close();
                done();
              },
              read: (deliver, done) => {
                for (const chunk of channel.queued.splice(0)) deliver(chunk);
                channel.toHost = deliver;
                channel.hungUp = done;
              },
            }).pipe(Effect.catch((refused) => Effect.sync(() => ws.close(1011, refused.reason)))),
          );
        },
        message: (ws, message) =>
          ws.data.toHost(Buffer.isBuffer(message) ? message : Buffer.from(message)),
        close: (ws) => ws.data.hungUp(),
      },
    });
  });

  /** Relays for every peer this Machine dials, and the listener while one dials in. */
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    for (const [installation] of relays)
      if (!peers.some((peer) => peer.installation === installation && peer.dials === "out"))
        yield* closeRelay(installation);
    for (const peer of peers)
      if (peer.dials === "out" && !relays.has(peer.installation)) yield* openRelay(peer);
    const wanted = peers.some((peer) => peer.dials === "in");
    if (wanted && listener === null) {
      const started = yield* startListener.pipe(Effect.result);
      if (started._tag === "Success") {
        listener = started.success;
        listening = null;
      } else {
        listening = `could not listen on port ${listenPort}: ${reason(started.failure)}`;
        yield* Effect.logWarning(listening);
      }
    }
    if (!wanted && listener !== null) {
      void listener.stop(true);
      listener = null;
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      void listener?.stop(true);
      for (const server of relays.values()) server.close();
    }),
  );
  yield* settle;

  const forget = (installation: string) =>
    keep(peers.filter((peer) => peer.installation !== installation)).pipe(Effect.ignore);

  // A peer herdr no longer lists is forgotten, on both sides.
  const listed = yield* link.machines;
  if (listed !== null) {
    const labels = new Set(listed.map((machine) => machine.label));
    for (const peer of peers.filter((one) => one.dials === "out" && !labels.has(one.name))) {
      yield* link.tell(peer);
      yield* forget(peer.installation);
      yield* Effect.logInfo(`forgot ${peer.name}: herdr no longer lists it`);
    }
  }

  const peersModule: Peers = {
    invite: (asker) =>
      Effect.gen(function* () {
        const certificate = yield* certificateFor(link.dir, asker.address).pipe(
          Effect.mapError((cause) =>
            Schema.is(HostRefused)(cause) ? cause : new HostRefused({ reason: reason(cause) }),
          ),
        );
        // A certificate made again for a new address is one the listener has to serve.
        if (listener !== null && served !== certificate) {
          void listener.stop(true);
          listener = null;
        }
        const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
          "base64url",
        );
        yield* keep([
          ...peers.filter((peer) => peer.installation !== asker.installation),
          { installation: asker.installation, name: asker.name, dials: "in", secret },
        ]);
        if (listener === null)
          return yield* new HostRefused({ reason: listening ?? "the listener did not start" });
        return { installation: link.installation, port: listenPort, certificate, secret };
      }).pipe(Effect.provideContext(services)),
    add: (peer) =>
      Effect.gen(function* () {
        const path = relayOf(link.dir, peer.name);
        if (Buffer.byteLength(path) > SOCKET_PATH_MAX)
          return yield* new HostRefused({
            reason: `${path} is longer than the ${SOCKET_PATH_MAX} bytes a unix socket path may be`,
          });
        if (/[/\\]/.test(peer.name) || peer.name === "" || peer.name.startsWith("."))
          return yield* new HostRefused({ reason: `"${peer.name}" cannot name a relay socket` });
        yield* keep([
          ...peers.filter(
            (one) => one.installation !== peer.installation && one.name !== peer.name,
          ),
          peer,
        ]);
      }),
    forget,
    list: Effect.sync(() =>
      peers.map((peer): PeerView => ({
        installation: peer.installation,
        name: peer.name,
        dials: peer.dials,
        url: peer.url ?? null,
        state: "live",
        since: null,
        failure: peer.dials === "in" ? listening : null,
      })),
    ),
  };
  return peersModule;
});

const decodeInvited = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), data: Invited })),
);
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })),
);

export const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** `collie` as a Machine's login shell runs it over SSH. */
const remoteCollie = (args: ReadonlyArray<string>) =>
  [`exec "\${SHELL:-/bin/sh}" -lc 'exec collie "$@"' collie`, ...args.map(quoted)].join(" ");

/**
 * Pairs with a herdr machine over its SSH login, the one approval its first reach asks
 * for, and answers the pairing for this Machine to keep. Whatever the login prints goes to
 * this process's stderr, where the human who has to approve it is. Only a front door that
 * can show that login calls this; a host's own jobs never do.
 */
export const pairWith = Effect.fn("Peers.pairWith")(function* (
  machine: HerdrMachine,
  asker: {
    readonly installation: string;
    readonly name: string;
    /** An SSH master already open to the machine, whose login is reused. */
    readonly control?: string;
  },
) {
  const ssh = "ssh";
  const resolved = yield* shell(ssh, ["-G", machine.target], ".");
  const address =
    /^hostname (.+)$/m.exec(resolved.stdout)?.[1]?.trim() ?? machine.target.replace(/^.*@/, "");
  const through =
    asker.control === undefined ? [] : ["-S", asker.control, "-o", "ControlMaster=no"];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const said = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          ssh,
          [
            ...through,
            "-T",
            machine.target,
            remoteCollie([
              "--json",
              "machine",
              "invite",
              "--for",
              asker.installation,
              "--name",
              asker.name,
              "--address",
              address,
            ]),
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "inherit", extendEnv: true },
        ),
      );
      return yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (all, chunk) => all + chunk,
        ),
      );
    }),
  ).pipe(Effect.orElseSucceed(() => ""));
  const last = said.trim().split("\n").at(-1) ?? "";
  const invited = decodeInvited(last);
  if (Option.isNone(invited))
    return yield* new HostRefused({
      reason: `${machine.label} did not pair: ${Option.match(decodeRefusal(last), {
        onNone: () => (last === "" ? "its collie answered nothing over ssh" : last),
        onSome: (refused) => refused.error.message,
      })}`,
    });
  const { installation, port: at, certificate, secret } = invited.value.data;
  const host = address.includes(":") ? `[${address}]` : address;
  const peer: Peer = {
    installation,
    name: machine.label,
    dials: "out",
    url: `wss://${host}:${at}`,
    certificate,
    secret,
  };
  return peer;
});
