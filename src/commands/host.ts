// `collie host`: run the local workflow host for one state directory, or replace it.
//
// Nobody is expected to type the bare command. A client starts it when it needs one and
// leaves it running, and it is here as a command because that is how one program starts
// another copy of itself. Typing it is still the way to watch a host in a terminal.

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { serve } from "../host";
import { restartHostAt } from "../lifecycle";
import { err } from "../operations";
import { printResult } from "../envelope";
import { answering, root } from "./shared";

const restart = Command.make(
  "restart",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription("The state directory whose host to replace; this install's by default"),
      Flag.optional,
    ),
  },
  (flags) => answering((env) => restartHostAt(Option.getOrElse(flags.dir, () => env.stateDir))),
).pipe(
  Command.withDescription(
    "Stop the host that owns the state directory and start this install's, waiting until it answers",
  ),
);

export const host = Command.make(
  "host",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription("The state directory this host owns: its SQLite, socket and lock"),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.dir)) return yield* serve(flags.dir.value).pipe(Effect.scoped);
      const global = yield* root;
      yield* printResult(
        err("invalid_input", "collie host needs --dir, or `restart`."),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "Run the local workflow host for a state directory (started for you when a client needs one)",
  ),
  Command.withSubcommands([restart]),
);
