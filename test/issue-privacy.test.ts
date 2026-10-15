import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
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

      const inventory = yield* publicationCheckouts(root);

      expect(inventory.checkouts).toEqual([`${root}/own`, `${root}/service`, `${tmp}/service`]);
    }),
  ));
