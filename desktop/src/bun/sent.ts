// Every write Desktop sends a host: done only on the host's reply, sent again under the same
// request when none comes, and each attempt's end kept in `actions.log` on this computer.

import { Cause, Data, Effect, FileSystem, Option, Schema } from "effect";
import { isString } from "../../../src/schema";
import { nowIso } from "../../../src/time";

/** How long an attempt waits for the host's reply, and how many are made. */
const WAIT = "30 seconds";
const TRIES = 3;
const LOG_BYTES = 1024 * 1024;

/** Only ids and kinds: never an answer's value, a message's text or a file. */
export const Attempted = Schema.Struct({
  door: Schema.Literals(["board", "chat"]),
  machine: Schema.String,
  request: Schema.String,
  kind: Schema.String,
  /** The Run or proposal it is about. */
  about: Schema.NullOr(Schema.String),
  attempt: Schema.Int,
  ended: Schema.Literals(["accepted", "repeat", "refused", "timed-out", "failed", "not-sent"]),
  reason: Schema.optionalKey(Schema.String),
});
export type Attempted = typeof Attempted.Type;

const lineOf = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ at: Schema.String, ...Attempted.fields })),
);

export type ActionsLog = (line: Attempted) => Effect.Effect<void>;

export const unlogged: ActionsLog = () => Effect.void;

/** `actions.log` in `dir`, kept once as `actions.log.1` past `maxBytes`; a write that fails is dropped. */
export const actionsLog = (dir: string, maxBytes = LOG_BYTES) =>
  Effect.map(FileSystem.FileSystem, (fs): ActionsLog => {
    const file = `${dir}/actions.log`;
    return (line) =>
      Effect.gen(function* () {
        const at = yield* nowIso();
        const bytes = new TextEncoder().encode(`${lineOf({ at, ...line })}\n`);
        const size = yield* fs.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        if (size > 0 && size + bytes.length > maxBytes) yield* fs.rename(file, `${file}.1`);
        yield* fs.writeFile(file, bytes, { flag: "a" });
      }).pipe(Effect.ignoreCause);
  });

/** Why a host said no, in its own words. */
export const reasonOf = (error: { readonly message: string }) =>
  "reason" in error && isString(error.reason)
    ? error.reason
    : "detail" in error && isString(error.detail)
      ? error.detail
      : error.message;

/** A write no reply confirmed, after every attempt. */
export class Unconfirmed extends Data.TaggedError("Unconfirmed")<{
  readonly request: string;
  readonly reason: string;
}> {}

export interface Sending extends Omit<Attempted, "attempt" | "ended" | "reason"> {
  readonly log: ActionsLog;
  /** The write as a sentence names it, as "the answer to r-1". */
  readonly what: string;
}

/**
 * `call` until its host replies: a reply is done, `repeat` saying whether it was one already
 * taken; a refusal or a failed connection ends it at once; no reply within `WAIT` sends it
 * again, `TRIES` times in all, which the host takes once by its request.
 */
export const confirmed = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  { log, what, ...sending }: Sending,
  call: Effect.Effect<A, E, R>,
  repeat: (reply: A) => boolean = () => false,
): Effect.Effect<A, E | Unconfirmed, R> => {
  const note = (attempt: number, ended: Attempted["ended"], reason?: string) =>
    log(
      reason === undefined
        ? { ...sending, attempt, ended }
        : { ...sending, attempt, ended, reason },
    );
  const tried = (attempt: number): Effect.Effect<A, E | Unconfirmed, R> =>
    call.pipe(
      Effect.timeoutOption(WAIT),
      Effect.tapError((error) =>
        note(attempt, error._tag === "RpcClientError" ? "failed" : "refused", reasonOf(error)),
      ),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? note(attempt, "failed", "the connection was renewed before this finished")
          : Effect.void,
      ),
      Effect.flatMap(
        Option.match({
          onSome: (reply) =>
            note(attempt, repeat(reply) ? "repeat" : "accepted").pipe(Effect.as(reply)),
          onNone: () =>
            note(attempt, "timed-out").pipe(
              Effect.andThen(
                attempt < TRIES
                  ? tried(attempt + 1)
                  : Effect.fail(
                      new Unconfirmed({
                        request: sending.request,
                        reason: `${sending.machine} did not confirm ${what} within 30 s, ${TRIES} times. It may still land; Try again sends the same request, which ${sending.machine} takes at most once.`,
                      }),
                    ),
              ),
            ),
        }),
      ),
    );
  return tried(1);
};
