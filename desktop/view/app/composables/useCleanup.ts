// What a sweep would remove on each connected Machine, and each chosen Machine's sweep. Kept
// here, not in the dialog, so a sweep outlives it; each one's end is also told in a toast.

import { AtomRegistry, injectRegistry, useAtomSet } from "@effect/atom-vue";
import { Effect, Exit } from "effect";
import { failureOf, newRequest } from "../../../src/shared/actions";
import {
  type CleanupSweep,
  type CleanupView,
  type MachineCleanup,
  sweptToast,
} from "../../../src/shared/machine-cleanup";
import { FlockClient } from "../flock";

const cleanupAtom = FlockClient.mutation("cleanup");
/** Null while the read is out. */
const read = ref<ReadonlyArray<MachineCleanup> | null>(null);
/** Null chooses every Machine that can be. */
const chosen = ref<ReadonlySet<string> | null>(null);
/** By profile, from the first press until the dialog reads again. */
const sweeps = ref<ReadonlyMap<string, CleanupSweep>>(new Map());
let asks = 0;

export const useCleanup = () => {
  const toast = useToast();
  const registry = injectRegistry();
  const ask = useAtomSet(() => cleanupAtom, { mode: "promiseExit" });
  const refresh = () => {
    const asked = ++asks;
    read.value = null;
    chosen.value = null;
    sweeps.value = new Map();
    return ask({ payload: undefined }).then((exit) => {
      // An answer to an older ask never replaces a newer one's.
      if (asked === asks) read.value = Exit.isSuccess(exit) ? exit.value : [];
    });
  };
  const running = () => [...sweeps.value.values()].some(({ state }) => state === "running");
  const set = (profile: string, sweep: CleanupSweep) => {
    sweeps.value = new Map(sweeps.value).set(profile, sweep);
  };
  const send = ({ installation, profile, name }: MachineCleanup, request: string) => {
    set(profile, { state: "running", request });
    return Effect.runPromiseExit(
      AtomRegistry.getResult(registry, FlockClient.runtime).pipe(
        Effect.flatMap((context) =>
          FlockClient.use((client) =>
            client("sweep", { installation, machine: name, request }),
          ).pipe(Effect.provideContext(context)),
        ),
      ),
    ).then((exit) => {
      const ended: Exclude<CleanupSweep, { state: "running" }> = Exit.isSuccess(exit)
        ? { state: "done", report: exit.value }
        : { state: "failed", request, reason: failureOf(exit.cause).reason };
      set(profile, ended);
      toast.add(sweptToast(name, ended));
    });
  };
  const listing = (profile: string) => read.value?.find((one) => one.profile === profile);
  return {
    read: readonly(read),
    chosen,
    sweeps: readonly(sweeps),
    /** Shows the sweeps while any runs; otherwise reads afresh. */
    opened: () => (running() ? Promise.resolve() : refresh()),
    clean: (view: CleanupView) =>
      Promise.all(
        view.rows
          .filter((row) => row.chosen)
          .flatMap((row) => listing(row.profile) ?? [])
          .map((machine) => send(machine, newRequest())),
      ),
    tryAgain: (profile: string) => {
      const failed = sweeps.value.get(profile);
      const machine = listing(profile);
      return failed?.state === "failed" && machine !== undefined
        ? send(machine, failed.request)
        : Promise.resolve();
    },
  };
};
