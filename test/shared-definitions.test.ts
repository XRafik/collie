// The user Layer's files as one host shares them: what it reads, and what it takes.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import { readAudit } from "../src/audit";
import { fileTime, nowIso } from "../src/time";
import { connect, frontDoor, socketOf } from "../src/host";
import { proves } from "./support/world";

const at = (hour: number) => `2099-10-14T${String(hour).padStart(2, "0")}:00:00.000Z`;

test(
  "a host reads its shared definitions with their edit times, and takes only later edits",
  () =>
    proves(
      "collie-shared-definitions-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const user = world.config;
          const put = (path: string, text: string, hour: number) =>
            fs
              .writeFileString(`${user}/${path}`, text)
              .pipe(
                Effect.andThen(
                  fs.utimes(`${user}/${path}`, fileTime(at(hour)), fileTime(at(hour))),
                ),
              );
          const mtime = (path: string) =>
            fs
              .stat(`${user}/${path}`)
              .pipe(Effect.map((info) => Option.getOrThrow(info.mtime).toISOString()));
          yield* fs.makeDirectory(`${user}/personas`, { recursive: true });
          yield* fs.makeDirectory(`${user}/workflows/node_modules/effect`, { recursive: true });
          yield* fs.makeDirectory(`${user}/workflows/nested`, { recursive: true });
          yield* put("workflows/mine.workflow.ts", "the module\n", 1);
          yield* put("workflows/mine.md", "the prompt\n", 2);
          yield* put("workflows/helper.ts", "the helper\n", 3);
          yield* put("personas/me.md", "the persona\n", 4);
          for (const toolchain of ["package.json", "tsconfig.json", "collie.d.ts", "bun.lock"])
            yield* put(`workflows/${toolchain}`, "this Machine's own\n", 5);
          yield* put("workflows/node_modules/effect/package.json", "{}\n", 5);
          yield* put("workflows/nested/deeper.ts", "not shared\n", 5);
          // Neither an editor's leftovers nor a link, which would reach outside the Layer.
          yield* put("workflows/.mine.workflow.ts.swp", "vim's\n", 5);
          yield* put("workflows/mine.md~", "a backup\n", 5);
          yield* put("outside.txt", "not the Layer's\n", 5);
          yield* fs.symlink(`${user}/outside.txt`, `${user}/workflows/linked.ts`);

          yield* connect(world.state);
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({ frontDoor: "desktop", from: { client: "test-desktop" } });
          expect(yield* door.sharedDefinitions()).toEqual([
            { path: "personas/me.md", text: "the persona\n", at: at(4) },
            { path: "workflows/helper.ts", text: "the helper\n", at: at(3) },
            { path: "workflows/mine.md", text: "the prompt\n", at: at(2) },
            { path: "workflows/mine.workflow.ts", text: "the module\n", at: at(1) },
          ]);

          // A file seen and gone since is a removal, from when it was first missed.
          const before = yield* nowIso();
          yield* fs.remove(`${user}/workflows/helper.ts`);
          const removed = (yield* door.sharedDefinitions()).find(
            (one) => one.path === "workflows/helper.ts",
          );
          expect(removed?.text).toBeNull();
          expect(removed!.at >= before).toBe(true);
          // And it keeps that time, rather than being removed again at every read.
          expect(
            (yield* door.sharedDefinitions()).find((one) => one.path === "workflows/helper.ts"),
          ).toEqual(removed);

          const held = yield* door.setSharedDefinitions({
            request: "share-1",
            definitions: [
              { path: "workflows/mine.md", text: "a later prompt\n", at: at(6) },
              { path: "workflows/mine.workflow.ts", text: "an older module\n", at: at(0) },
              { path: "personas/me.md", text: null, at: at(7) },
              { path: "personas/new.md", text: "a new persona\n", at: at(8) },
              { path: "workflows/linked.ts", text: "through the link\n", at: at(8) },
            ],
          });
          expect(held).toEqual([
            { path: "personas/me.md", text: null, at: at(7) },
            { path: "personas/new.md", text: "a new persona\n", at: at(8) },
            removed!,
            { path: "workflows/mine.md", text: "a later prompt\n", at: at(6) },
            { path: "workflows/mine.workflow.ts", text: "the module\n", at: at(1) },
          ]);
          expect(yield* mtime("workflows/mine.md")).toBe(at(6));
          expect(yield* mtime("personas/new.md")).toBe(at(8));
          expect(yield* fs.exists(`${user}/personas/me.md`)).toBe(false);
          expect(yield* fs.readFileString(`${user}/workflows/mine.workflow.ts`)).toBe(
            "the module\n",
          );
          // What a write replaced or removed is kept, by path and the time of its own edit.
          expect(yield* fs.readFileString(`${user}/replaced/${at(2)}/workflows/mine.md`)).toBe(
            "the prompt\n",
          );
          expect(yield* fs.readFileString(`${user}/replaced/${at(4)}/personas/me.md`)).toBe(
            "the persona\n",
          );
          expect(yield* fs.readFileString(`${user}/outside.txt`)).toBe("not the Layer's\n");
          expect(yield* fs.readFileString(`${user}/workflows/package.json`)).toBe(
            "this Machine's own\n",
          );

          // A path outside the two directories is refused, and nothing is written for it.
          const refused = yield* door
            .setSharedDefinitions({
              request: "share-2",
              definitions: [{ path: "workflows/../config.json", text: "{}", at: at(9) }],
            })
            .pipe(Effect.flip);
          expect(refused._tag).toBe("HostRefused");
          expect(yield* fs.exists(`${user}/config.json`)).toBe(false);

          // Both are recorded under the Actor that asked.
          const audited = yield* readAudit(`${world.state}/definitions`);
          expect(audited.map((line) => line.operation)).toContain("definitions");
          expect(audited.find((line) => line.request === "share-1")?.actor).toMatchObject({
            origin: "desktop",
            from: { client: "test-desktop" },
          });
        }).pipe(Effect.orDie),
      [],
    ),
  60_000,
);
