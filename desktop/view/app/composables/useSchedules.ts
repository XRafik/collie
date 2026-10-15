// Each connected Machine's Schedules, asked whenever the Machines page opens and after each
// change made from it. What came of a change is said in a toast.

import { useAtomSet } from "@effect/atom-vue";
import { Cause, Exit } from "effect";
import { type Failed, failureOf } from "../../../src/shared/actions";
import type { MachineSchedules, ScheduleAsk } from "../../../src/shared/schedules";
import { FlockClient } from "../flock";

const schedulesAtom = FlockClient.mutation("schedules");
const changeAtom = FlockClient.mutation("changeSchedule");
const moveAtom = FlockClient.mutation("moveSchedule");
const machines = ref<ReadonlyArray<MachineSchedules>>([]);
let asks = 0;

export const useSchedules = () => {
  const toast = useToast();
  const ask = useAtomSet(() => schedulesAtom, { mode: "promiseExit" });
  const change = useAtomSet(() => changeAtom, { mode: "promiseExit" });
  const move = useAtomSet(() => moveAtom, { mode: "promiseExit" });
  const refresh = () => {
    const asked = ++asks;
    return ask({ payload: undefined }).then((exit) => {
      // An answer to an older ask never replaces a newer one's.
      if (asked === asks && Exit.isSuccess(exit)) machines.value = exit.value;
    });
  };
  const said = (exit: Exit.Exit<string, Failed>) => {
    if (Exit.isSuccess(exit)) toast.add({ title: exit.value, color: "success" });
    else if (!Cause.hasInterruptsOnly(exit.cause))
      toast.add({ title: failureOf(exit.cause).reason, color: "error" });
    return refresh();
  };
  return {
    machines: readonly(machines),
    refresh,
    change: (payload: Extract<ScheduleAsk, { kind: "change" }>["payload"]) =>
      change({ payload }).then(said),
    move: (from: string, to: string, name: string, checkout: string) =>
      move({ payload: { from, to, name, checkout } }).then(said),
  };
};
