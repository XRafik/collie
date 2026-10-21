// A fake `ssh`, run by the shim `writeFakeSsh` writes. It models what Collie relies on:
// a master that `ControlPersist` detaches, ssh's `-O` control commands against it, a
// session that rides it, and OpenSSH's fallback to a login of its own where the socket has
// gone. Every call is logged with its mode: `master`, `mux <verb>`, `ride` or `login`.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

const log = process.env.FAKE_SSH_LOG ?? "/dev/null";
const dir = process.env.FAKE_SSH_DIR ?? "/tmp";
/** The far Machine's environment, which a session there starts with. */
const far = JSON.parse(process.env.FAKE_SSH_ENV ?? "{}") as Record<string, string>;
const said = (line: string) => appendFileSync(log, `${line}\n`);

/** Where a far `127.0.0.1:<port>` really is, as the test maps it; else that port itself. */
const farPort = (port: number) => {
  try {
    const ports = JSON.parse(readFileSync(`${dir}/ports.json`, "utf8")) as Record<string, number>;
    return ports[String(port)] ?? port;
  } catch {
    return port;
  }
};

/** One request to a master over its control path, and its answer: null where none answers. */
const ask = (path: string, request: object) =>
  new Promise<string | null>((resolve) => {
    if (!existsSync(path)) return resolve(null);
    const conn = createConnection(path);
    let answer = "";
    conn.once("connect", () => conn.write(`${JSON.stringify(request)}\n`));
    conn.on("data", (chunk) => (answer += chunk.toString("utf8")));
    conn.once("error", () => resolve(null));
    conn.once("close", () => resolve(answer === "" ? null : answer.trim()));
  });

/** A master holding `path`, until `-O exit`, a drop, SIGTERM, or its path is removed. */
const master = (path: string) => {
  const forwards = new Map<string, Server>();
  const end = () => {
    for (const server of forwards.values()) server.close();
    rmSync(path, { force: true });
    process.exit(0);
  };
  const forward = (spec: string, reply: (said: string) => void) => {
    const parts = spec.split(":");
    const [bind, port, , hostPort] = parts.length === 4 ? parts : ["127.0.0.1", ...parts];
    const server = createServer((conn: Socket) => {
      const out = createConnection({ host: "127.0.0.1", port: farPort(Number(hostPort)) });
      conn.pipe(out).pipe(conn);
      conn.once("error", () => out.destroy());
      out.once("error", () => conn.destroy());
    });
    server.once("error", (error) =>
      reply(
        `bind [${bind}]:${port}: ${error.message}\nmux_client_forward: forwarding request failed: Port forwarding failed`,
      ),
    );
    server.listen(Number(port), bind, () => {
      forwards.set(spec, server);
      reply("ok");
    });
  };
  const control = createServer((conn) => {
    let line = "";
    conn.on("data", (chunk) => {
      line += chunk.toString("utf8");
      if (!line.includes("\n")) return;
      const asked = JSON.parse(line) as { op: string; spec?: string };
      const reply = (answer: string) => conn.end(`${answer}\n`);
      if (asked.op === "check") return reply("ok");
      if (asked.op === "forward") return forward(asked.spec!, reply);
      if (asked.op === "cancel") {
        forwards.get(asked.spec!)?.close();
        forwards.delete(asked.spec!);
        return reply("ok");
      }
      if (asked.op === "exit" || asked.op === "drop") {
        // Gone before it answers, so the asker may bind the path at once.
        rmSync(path, { force: true });
        conn.end("ok\n", end);
        return;
      }
      reply(`unknown request ${asked.op}`);
    });
  });
  process.on("SIGTERM", end);
  rmSync(path, { force: true });
  control.once("error", () => process.exit(255));
  control.listen(path);
  appendFileSync(`${dir}/masters`, `${path}\n`);
  setInterval(() => existsSync(path) || end(), 500);
};

const main = async (argv: ReadonlyArray<string>) => {
  if (argv[0] === "--master") return master(argv[1]!);
  if (argv[0] === "-G") {
    process.stdout.write("hostname 127.0.0.1\nport 22\n");
    return process.exit(0);
  }
  let path: string | undefined;
  let verb: string | undefined;
  let spec: string | undefined;
  let isMaster = false;
  const options = new Map<string, string>();
  let at = 0;
  for (; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "-S") path = argv[++at];
    else if (word === "-O") verb = argv[++at];
    else if (word === "-L") spec = argv[++at];
    else if (word === "-o") {
      const [key, value] = argv[++at]!.split("=");
      options.set(key!, value ?? "");
    } else if (word === "-M") isMaster = true;
    else if (word === "-T" || word === "-N") continue;
    else break;
  }
  const target = argv[at] ?? "";
  const command = argv.slice(at + 1).join(" ");

  if (isMaster) {
    said(`master ${target}`);
    if (existsSync(`${dir}/master-hangs`)) {
      process.stderr.write(`Waiting for SSO login for ${target}\n`);
      return setInterval(() => {}, 1_000);
    }
    process.stderr.write(`Authenticated to ${target}\n`);
    if (options.get("ControlPersist") !== "yes") return master(path!);
    // As ssh does with ControlPersist: the master goes to the background, and this exits.
    spawn(process.execPath, [import.meta.path, "--master", path!], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    }).unref();
    for (let tries = 0; tries < 250; tries++)
      if ((await ask(path!, { op: "check" })) === "ok") return process.exit(0);
      else await Bun.sleep(20);
    process.stderr.write(`ControlSocket ${path} could not be bound\n`);
    return process.exit(255);
  }

  if (verb !== undefined) {
    said(`mux ${verb}${spec === undefined ? "" : ` ${spec}`} ${target}`);
    const answer = await ask(path ?? "", { op: verb, spec });
    if (answer === "ok") {
      if (verb === "check") process.stderr.write("Master running\n");
      return process.exit(0);
    }
    process.stderr.write(answer ?? `Control socket connect(${path}): No such file or directory\n`);
    return process.exit(255);
  }

  if (path !== undefined && existsSync(`${dir}/drops-before-ride`)) await ask(path, { op: "drop" });
  const rides =
    path !== undefined && options.get("ControlMaster") === "no"
      ? (await ask(path, { op: "check" })) === "ok"
      : false;
  if (path !== undefined && !rides && options.get("ProxyCommand") === "false") {
    process.stderr.write("Connection closed by UNKNOWN port 65535\n");
    return process.exit(255);
  }
  said(`${rides ? "ride" : "login"} ${target} ${command}`);
  const session = Bun.spawn(["/bin/sh", "-c", command], {
    env: Object.keys(far).length === 0 ? process.env : far,
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await session.exited);
};

await main(process.argv.slice(2));
