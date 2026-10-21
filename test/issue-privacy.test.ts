import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { publicationCheckouts } from "../src/issue-privacy";

test("the checkout inventory stays under the Projects root, though a link leads out of it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/projects`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${tmp}/elsewhere/deeper/.git`, { recursive: true });
      yield* fs.makeDirectory(`${tmp}/service/.git`, { recursive: true });
      yield* fs.symlink(`${tmp}/elsewhere`, `${root}/elsewhere`);
      yield* fs.symlink(`${tmp}/service`, `${root}/service`);

      const inventory = yield* publicationCheckouts([root]);

      expect(inventory.checkouts).toEqual([`${root}/own`, `${root}/service`, `${tmp}/service`]);
    }),
  ));

test("a link to nothing under the Projects root, like a closed login's agent socket, is skipped", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/.ssh`, { recursive: true });
      yield* fs.symlink(`${tmp}/gone/agent.12345`, `${root}/.ssh/agent.sock`);

      const inventory = yield* publicationCheckouts([root]);

      expect(inventory.checkouts).toEqual([`${root}/own`]);
    }),
  ));

test("a directory the user cannot read, or cannot look for a .git in, is skipped beside a real checkout", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/sealed/inner/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/unlisted/inner/.git`, { recursive: true });
      yield* fs.chmod(`${root}/sealed`, 0o000);
      yield* fs.chmod(`${root}/unlisted`, 0o300);
      yield* Effect.addFinalizer(() =>
        Effect.all([fs.chmod(`${root}/sealed`, 0o700), fs.chmod(`${root}/unlisted`, 0o700)]).pipe(
          Effect.ignore,
        ),
      );

      const inventory = yield* publicationCheckouts([root]);

      expect(inventory.checkouts).toEqual([`${root}/own`]);
    }),
  ));

test("the inventory skips dependencies, Git metadata, caches and tool directories, and stops six levels down", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/a/b/c/d/e/deep/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/a/b/c/d/e/f/deeper/.git`, { recursive: true });
      const skipped = [
        `${root}/own/node_modules/pkg`,
        `${root}/own/.git/modules/sub`,
        `${root}/.cache/tool/repo`,
        `${root}/.local/share/plugin`,
        `${root}/.claude/plugins/cache`,
        `${root}/.npm/_cacache/repo`,
        `${root}/.bun/install/cache/repo`,
      ];
      for (const dir of skipped) yield* fs.makeDirectory(`${dir}/.git`, { recursive: true });
      const wide = Array.from({ length: 40 }, (_, i) => `${root}/own/node_modules/p${i}`);
      yield* Effect.forEach(
        wide.flatMap((dir) => Array.from({ length: 40 }, (_, j) => `${dir}/node_modules/q${j}`)),
        (dir) => fs.makeDirectory(dir, { recursive: true }),
        { concurrency: 32 },
      );

      const started = yield* Clock.currentTimeMillis;
      const inventory = yield* publicationCheckouts([root]);

      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);
      expect(inventory.checkouts).toEqual([`${root}/a/b/c/d/e/deep`, `${root}/own`]);
    }),
  ));

test("a checkout Collie knows of is in the inventory wherever it is", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${tmp}/elsewhere/sibling/.git`, { recursive: true });
      yield* fs.makeDirectory(`${tmp}/elsewhere/plain`, { recursive: true });

      const inventory = yield* publicationCheckouts(
        [root],
        [`${tmp}/elsewhere/sibling`, `${tmp}/elsewhere/plain`, `${tmp}/gone`],
      );

      expect(inventory.checkouts).toEqual([`${tmp}/elsewhere/sibling`, `${root}/own`]);
    }),
  ));
