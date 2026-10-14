// One placement in a process of its own: `bun place-release.ts <tree> <runner> <collieDir> <version>`.
import { Effect } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { placeRelease } from "../../src/release";

const [tree, runner, collieDir, version] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
await Effect.runPromise(
  placeRelease({ tree, runner }, collieDir, version).pipe(Effect.provide(BunServices.layer)),
);
