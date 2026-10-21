// What a sweep would remove on each connected Machine, asked whenever the Cleanup dialog opens.

import { useAtomSet } from "@effect/atom-vue";
import { Exit } from "effect";
import type { MachineCleanup } from "../../../src/shared/machine-cleanup";
import { FlockClient } from "../flock";

const cleanupAtom = FlockClient.mutation("cleanup");
/** Null while the read is out. */
const read = ref<ReadonlyArray<MachineCleanup> | null>(null);
/** Null chooses every Machine that can be. */
const chosen = ref<ReadonlySet<string> | null>(null);
let asks = 0;

export const useCleanup = () => {
  const ask = useAtomSet(() => cleanupAtom, { mode: "promiseExit" });
  const refresh = () => {
    const asked = ++asks;
    read.value = null;
    chosen.value = null;
    return ask({ payload: undefined }).then((exit) => {
      // An answer to an older ask never replaces a newer one's.
      if (asked === asks) read.value = Exit.isSuccess(exit) ? exit.value : [];
    });
  };
  return { read: readonly(read), chosen, refresh };
};
