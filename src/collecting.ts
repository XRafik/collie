// The agents Collie is collecting an Output from now, by Run and herdr agent name.

import { Context, Effect, Layer } from "effect";

export interface CollectingApi {
  /** Runs `collection` with this agent, and its `launch` where named, on the list for exactly as long as it runs. */
  readonly during: <A, E, R>(
    run: string,
    agent: string,
    collection: Effect.Effect<A, E, R>,
    launch?: string,
  ) => Effect.Effect<A, E, R>;
  /** Whether this agent is collected from, or, with `launch`, that launch of it. */
  readonly has: (run: string, agent: string, launch?: string) => Effect.Effect<boolean>;
}

export class Collecting extends Context.Service<Collecting, CollectingApi>()("collie/Collecting") {}

export const collectingLayer = Layer.effect(Collecting)(
  Effect.sync(() => {
    // Counted, so one collection ending never takes another of the same agent off.
    const now = new Map<string, number>();
    const keysOf = (run: string, agent: string, launch?: string) =>
      launch === undefined
        ? [`${run}\n${agent}`]
        : [`${run}\n${agent}`, `${run}\n${agent}\n${launch}`];
    const add = (keys: ReadonlyArray<string>, by: number) =>
      Effect.sync(() => {
        for (const key of keys) {
          const count = (now.get(key) ?? 0) + by;
          if (count > 0) now.set(key, count);
          else now.delete(key);
        }
      });
    return Collecting.of({
      during: (run, agent, collection, launch) =>
        Effect.acquireUseRelease(
          add(keysOf(run, agent, launch), 1),
          () => collection,
          () => add(keysOf(run, agent, launch), -1),
        ),
      has: (run, agent, launch) => Effect.sync(() => now.has(keysOf(run, agent, launch).at(-1)!)),
    });
  }),
);
