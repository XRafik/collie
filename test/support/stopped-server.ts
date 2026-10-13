// A control record naming a server that is still running, as a stop that did not reach
// Quiet leaves one behind: the agent herdr no longer lists, its server working in `cwd`.

import { Effect, FileSystem, Schema } from "effect";
import { CONTROL_DIR } from "../../src/compaction";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const stoppedServer = (stateDir: string, agent: string, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const server = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });
    yield* Effect.addFinalizer(() => Effect.sync(() => server.kill("SIGKILL")));
    const dir = `${stateDir}/${CONTROL_DIR}/${agent}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      `${dir}/control.json`,
      encodeJson({
        agent,
        harness: "codex",
        cwd,
        dir,
        endpoint: "ws://127.0.0.1:1",
        pid: server.pid,
        command: "sleep 600",
        started: null,
        stop: {
          state: "acknowledged",
          at: 0,
          turns: [],
          reason: "the server was still up after 30s",
          signalled: true,
          noted: true,
        },
        attempt: null,
      }),
    );
    return server.pid;
  });
