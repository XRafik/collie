import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { collie, proves } from "./support/world";

test("an isolated world runs the suite's executable and carries its process lifetime and stop grace", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-world-command-" });
      const binary = `${dir}/collie`;
      yield* fs.writeFileString(
        binary,
        `#!/bin/sh
printf '{"ok":true,"data":{"root":"%s","pid":"%s","grace":"%s"}}\\n' "$COLLIE_TEST_ROOT" "$COLLIE_HOST_WATCH_PID" "$COLLIE_HOST_STOP_GRACE"
`,
        { mode: 0o755 },
      );
      const before = Bun.env.COLLIE_TEST_BINARY;
      Bun.env.COLLIE_TEST_BINARY = binary;
      try {
        yield* Effect.promise(() =>
          proves(
            "collie-world-",
            (world) =>
              Effect.gen(function* () {
                const ran = yield* collie(world, ["test-fixture"]);
                expect(ran.exit).toBe(0);
                expect(ran.envelope).toEqual({
                  ok: true,
                  data: {
                    root: Bun.env.COLLIE_TEST_ROOT,
                    pid: Bun.env.COLLIE_HOST_WATCH_PID,
                    grace: Bun.env.COLLIE_HOST_STOP_GRACE,
                  },
                });
              }),
            [],
          ),
        );
      } finally {
        if (before === undefined) delete Bun.env.COLLIE_TEST_BINARY;
        else Bun.env.COLLIE_TEST_BINARY = before;
      }
    }).pipe(Effect.scoped),
  ));
