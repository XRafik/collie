// `collie upgrade` on a release: the runner places the release it carries into the Collie
// directory's `release/`, keeping any edit it finds there, and never writes `user/`.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { upgrade } from "../src/operations";
import type { Ran } from "../src/mr";
import manifest from "../herdr-plugin.toml";

let rig: Rig;
let collieDir: string;
let tree: string;
let runner: string;
let prepared: string[];

const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text));
const read = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).readFileString(file);
  });
const exists = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(file);
  });

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      collieDir = `${rig.root}/collie-dir`;
      tree = `${rig.root}/carried/release`;
      runner = `${rig.root}/carried/collie`;
      prepared = [];
      yield* write(`${tree}/herdr-plugin.toml`, `version = "${manifest.version}"\n`);
      yield* write(`${tree}/prepare.sh`, `echo "prepare: runner: already in place"\n`);
      yield* write(`${tree}/personas/planner.md`, "the shipped planner\n");
      yield* write(`${tree}/workflows/plan.workflow.ts`, "export default 1;\n");
      yield* write(runner, "#!/bin/sh\necho runner\n");
      yield* write(`${collieDir}/user/config.json`, `{"mine":true}\n`);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** Not a checkout to git, and a `prepare.sh` whose directory is recorded. */
const run = (cmd: string, args: string[], cwd: string) =>
  Effect.sync((): Ran => {
    if (cmd === "git") return { code: 128, stdout: "", stderr: "not a git repository" };
    prepared.push(`${cmd} ${args.join(" ")} in ${cwd}`);
    return { code: 0, stdout: "prepare: runner: already in place\n" };
  });

/** The files an upgrade said it kept, relative to their `kept/<when>/`. */
const keptOf = (result: Effect.Success<ReturnType<typeof upgrade>>) =>
  result.ok && "kept" in result.data ? result.data.kept : [];
const shipped = (file: string) => file.replace(/^kept\/[^/]+\//, "");

const place = () =>
  upgrade(
    {
      ...rig.pluginEnv(),
      pluginRoot: `${collieDir}/release`,
      collieDir,
      userDir: `${collieDir}/user`,
    },
    { carried: { tree, runner } },
    run,
  );

test("a release is placed into an empty Collie directory, and prepared from there", () =>
  runEffect(
    Effect.gen(function* () {
      const placed = yield* place();

      expect(placed).toMatchObject({ ok: true, data: { release: manifest.version, kept: [] } });
      expect(yield* read(`${collieDir}/release/personas/planner.md`)).toBe("the shipped planner\n");
      expect(yield* read(`${collieDir}/release/bin/collie`)).toBe("#!/bin/sh\necho runner\n");
      const mode = (yield* (yield* FileSystem.FileSystem).stat(`${collieDir}/release/bin/collie`))
        .mode;
      expect(mode & 0o111).toBe(0o111);
      expect(prepared).toEqual([`sh prepare.sh in ${collieDir}/release`]);
      expect(yield* read(`${collieDir}/user/config.json`)).toBe(`{"mine":true}\n`);
      expect(yield* exists(`${collieDir}/kept`)).toBe(false);
    }),
  ));

test("an edit in a release is kept and named, and a deleted file is restored", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* place();
      yield* write(`${collieDir}/release/personas/planner.md`, "my planner\n");
      yield* write(`${collieDir}/release/personas/mine.md`, "a persona of my own\n");
      yield* fs.remove(`${collieDir}/release/workflows/plan.workflow.ts`);

      const placed = yield* place();

      expect(placed.ok).toBe(true);
      const kept = keptOf(placed);
      expect(kept.map(shipped).sort()).toEqual(["personas/mine.md", "personas/planner.md"]);
      for (const file of kept) {
        expect(placed.ok && placed.human).toContain(file);
        expect(
          [`my planner\n`, `a persona of my own\n`].includes(yield* read(`${collieDir}/${file}`)),
        ).toBe(true);
      }
      expect(placed.ok && placed.human).toContain("collie persona fork");
      expect(yield* read(`${collieDir}/release/personas/planner.md`)).toBe("the shipped planner\n");
      expect(yield* exists(`${collieDir}/release/personas/mine.md`)).toBe(false);
      expect(yield* read(`${collieDir}/release/workflows/plan.workflow.ts`)).toBe(
        "export default 1;\n",
      );
      expect(yield* read(`${collieDir}/user/config.json`)).toBe(`{"mine":true}\n`);
    }),
  ));

test("every file of a release placed before records existed is kept", () =>
  runEffect(
    Effect.gen(function* () {
      yield* write(`${collieDir}/release/personas/planner.md`, "from before\n");

      const placed = yield* place();

      expect(keptOf(placed).map(shipped)).toEqual(["personas/planner.md"]);
    }),
  ));

test("placing the same version twice changes nothing and keeps nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* place();
      const before = yield* read(`${collieDir}/release/personas/planner.md`);

      const again = yield* place();

      expect(again).toMatchObject({ ok: true, data: { release: manifest.version, kept: [] } });
      expect(yield* read(`${collieDir}/release/personas/planner.md`)).toBe(before);
      expect(yield* exists(`${collieDir}/kept`)).toBe(false);
    }),
  ));

test("a runner that carries no release places nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const refused = yield* upgrade(
        { ...rig.pluginEnv(), pluginRoot: `${collieDir}/release`, collieDir },
        { carried: null },
        run,
      );

      expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
      expect(yield* exists(`${collieDir}/release`)).toBe(false);
      expect(prepared).toEqual([]);
    }),
  ));
