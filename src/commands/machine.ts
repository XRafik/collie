// `collie machine`: the Machines this one is paired with (ADR-0054). Pairing happens by
// itself on first reach and forgetting follows herdr's list, so `list` is the only one a
// human has a use for; `invite` is what pairing runs on the other Machine over SSH.

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { inviteFrom, machineList } from "../lifecycle";
import { answering } from "./shared";

const list = Command.make("list", {}, () =>
  answering((env) =>
    machineList(env).pipe(
      Effect.map((read) => {
        if (!read.ok) return read;
        const peers = read.value;
        return {
          ok: true as const,
          data: { machines: peers },
          human:
            peers.length === 0
              ? "No Machine is paired with this one."
              : peers
                  .map((peer) =>
                    [
                      peer.name,
                      peer.dials === "out" ? "dialled from here" : "dials in",
                      peer.state === "away" && peer.since !== null
                        ? `away since ${peer.since}`
                        : peer.state,
                      ...(peer.failure === null ? [] : [peer.failure]),
                    ].join("\t"),
                  )
                  .join("\n"),
        };
      }),
    ),
  ),
).pipe(Command.withDescription("The Machines paired with this one, and whether each is live"));

const invite = Command.make(
  "invite",
  {
    for: Flag.String("for").pipe(Flag.withDescription("The installation asking to pair")),
    name: Flag.String("name").pipe(Flag.withDescription("What this Machine calls the asker")),
    address: Flag.String("address").pipe(
      Flag.withDescription("The address the asker dials this Machine at"),
      Flag.optional,
    ),
  },
  (flags) =>
    answering((env) =>
      inviteFrom(env, {
        installation: flags.for,
        name: flags.name,
        address: Option.getOrNull(flags.address),
      }).pipe(
        Effect.map((read) =>
          read.ok
            ? {
                ok: true as const,
                data: read.value,
                human: `Paired with ${flags.name}; it dials port ${read.value.port}.`,
              }
            : read,
        ),
      ),
    ),
).pipe(
  Command.withDescription("Plumbing: pair with the installation asking, as pairing runs over SSH"),
);

export const machine = Command.make("machine").pipe(
  Command.withDescription("The Machines paired with this one"),
  Command.withSubcommands([list, invite]),
);
