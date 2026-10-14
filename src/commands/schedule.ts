// `collie schedule`: this Machine's Schedules, added, listed, paused, resumed and removed
// through its host (ADR-0052). Every line names the Machine it is about.

import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { agentStartRefusal, asOptionText, insideCheckout } from "../agent-start";
import { mutation } from "../envelope";
import type { PluginEnv } from "../env";
import { Herdr } from "../herdr";
import { changeSchedule, moduleFor, scheduleListing } from "../lifecycle";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { err, type OpResult } from "../operations";
import {
  SCHEDULE_PROJECTS_ROOT,
  type ScheduleChange,
  changedLine,
  lastLine,
  machineOf,
  type ScheduleEntry,
} from "../schedule-model";
import { givenVerifications } from "../verify-spec";
import { answering, cliDoor, parseInput, requestIdFlag, root } from "./shared";

const SCHEDULE_CHECKOUT_FIX = `Name the checkout with --workspace <absolute path>, a workspace's id or label, or ${SCHEDULE_PROJECTS_ROOT}.`;

export const scheduleLine = (entry: ScheduleEntry) =>
  [
    entry.name,
    `${entry.cron} ${entry.tz}`,
    entry.workflow,
    entry.checkout,
    entry.paused ? "paused" : `next ${entry.next ?? "when its Run ends"}`,
    `last ${lastLine(entry.last)}`,
  ].join("\t");

/**
 * The checkout a Schedule's start names, as a path or `projects-root`: given, or the
 * checkout the command runs in. A workspace's id or label is its checkout's path, since
 * the workspace may be gone by the time the Schedule fires.
 */
const checkoutOf = Effect.fn("schedule.checkoutOf")(function* (
  env: PluginEnv,
  given: string,
): Effect.fn.Return<
  { readonly path: string | null } | { readonly error: OpResult },
  never,
  BunServices
> {
  const named = given.trim();
  if (named === SCHEDULE_PROJECTS_ROOT || named.startsWith("/")) return { path: named };
  if (named === "") return { path: (yield* insideCheckout(env.cwd)) ? env.cwd : null };
  const all = yield* new Herdr(env).workspaceList().pipe(Effect.orElseSucceed(() => []));
  const byId = all.filter((one) => one.workspaceId === named);
  const matched =
    byId.length > 0 ? byId : all.filter((one) => one.label.toLowerCase() === named.toLowerCase());
  const found = matched.length === 1 ? matched[0] : undefined;
  if (found === undefined || found.cwd === "")
    return {
      error: err(
        "invalid_input",
        matched.length > 1
          ? `"${named}" names ${matched.length} workspaces (${matched.map((one) => one.workspaceId).join(", ")}); say which`
          : `no workspace id or label is "${named}"; workspaces: ${all.map((one) => one.label).join(", ") || "none"}. ${SCHEDULE_CHECKOUT_FIX}`,
      ),
    };
  return { path: found.cwd };
});

const nameArg = Argument.String("name").pipe(
  Argument.withDescription(
    "The Schedule's name: lowercase letters, digits and hyphens, at most 40",
  ),
);

/** A change through the host, with its receipt. */
const changing = (
  operation: string,
  requestId: Option.Option<string>,
  change: (
    env: PluginEnv,
  ) => Effect.Effect<ScheduleChange | { readonly refused: OpResult }, never, BunServices>,
) =>
  answering((env) =>
    mutation(env, operation, requestId, (request) =>
      Effect.gen(function* () {
        const asked = yield* change(env);
        if ("refused" in asked) return asked.refused;
        const changed = yield* changeSchedule(env, {
          door: yield* cliDoor(env),
          change: asked,
          request,
        });
        if (!changed.ok) return changed;
        return { ok: true as const, data: changed.value, human: changedLine(changed.value) };
      }),
    ),
  );

const scheduleAdd = Command.make(
  "add",
  {
    name: nameArg,
    workflow: Argument.String("workflow").pipe(
      Argument.withDescription("Which Workflow it starts, as `workflow list` names it"),
    ),
    cron: Flag.String("cron").pipe(
      Flag.withDescription(
        'When, as five cron fields: minute hour day-of-month month weekday ("0 7 * * *")',
      ),
    ),
    tz: Flag.String("tz").pipe(
      Flag.withDescription(
        "The IANA time zone the cron expression is read in; this Machine's by default",
      ),
      Flag.optional,
    ),
    paused: Flag.Boolean("paused").pipe(
      Flag.withDescription("Add it paused, to fire only once it is resumed"),
      Flag.withDefault(false),
    ),
    input: Flag.String("input").pipe(
      Flag.withDescription(
        'key=value, repeatable; every Input the Workflow takes, an optional one as ""',
      ),
      Flag.atLeast(0),
    ),
    inputsJson: Flag.String("inputs-json").pipe(
      Flag.withDescription("Every Input at once, as one JSON object"),
      Flag.optional,
    ),
    verify: Flag.String("verify").pipe(
      Flag.withDescription(
        'A check Collie may run to prove its Runs, repeatable: one verify.json entry, {"name","executable","argv","cwd"}',
      ),
      Flag.atLeast(0),
    ),
    requestId: requestIdFlag,
  },
  ({ name, workflow, cron, tz, paused, input, inputsJson, verify, requestId }) =>
    Effect.flatMap(root, (global) =>
      changing("schedule-add", requestId, (env) =>
        Effect.gen(function* () {
          const refused = (failure: OpResult) => ({ refused: failure });
          const parsed = yield* parseInput(input, inputsJson);
          if (!parsed.ok) return refused(parsed.error);
          const given = Object.fromEntries([
            ...Object.entries(parsed.given.text),
            ...Object.entries(parsed.given.json).map(([key, value]): [string, string] => [
              key,
              asOptionText(value),
            ]),
          ]);
          // The shared `--workspace` names the checkout: a path, a workspace, or the Projects root.
          const where = Option.getOrUndefined(global.workspace) ?? given.workspace ?? "";
          const inputs = Object.fromEntries(
            Object.entries(given).filter(([key]) => key !== "workspace"),
          );
          const checks = givenVerifications(verify);
          if (!checks.ok) return refused(err("invalid_input", checks.error));
          const checkout = yield* checkoutOf(env, where);
          if ("error" in checkout) return refused(checkout.error);
          const at = checkout.path === SCHEDULE_PROJECTS_ROOT ? null : checkout.path;
          const saved = yield* moduleFor({ ...env, cwd: at ?? env.cwd }, workflow);
          if (saved === null)
            return refused(
              err(
                "workflow_not_found",
                `No workflow module is saved as "${workflow}". \`collie workflow list\` is what this installation has.`,
                { workflow },
              ),
            );
          if ("inputs" in saved) {
            const needed = yield* agentStartRefusal(
              { ...env, cwd: at ?? env.cwd },
              saved,
              { json: {}, text: inputs },
              { named: checkout.path, fix: SCHEDULE_CHECKOUT_FIX },
            );
            if (needed !== null) return refused(needed);
          }
          return {
            change: "add" as const,
            name,
            cron,
            paused,
            start: { workflow, inputs, workspace: checkout.path ?? "", verify: checks.specs },
            ...Option.match(tz, { onNone: () => ({}), onSome: (zone) => ({ tz: zone }) }),
          };
        }).pipe(Effect.orDie),
      ),
    ),
).pipe(
  Command.withDescription("Save a start to be made whenever a cron expression falls due"),
  Command.withExamples([
    {
      command:
        'collie schedule add self-improve-daily --cron "0 7 * * *" self-improve --input improvements=3 --workspace /home/me/collie',
      description: "Start self-improve in a Collie checkout every morning at seven",
    },
  ]),
);

const scheduleList = Command.make("list", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const listed = yield* scheduleListing(env, yield* cliDoor(env));
      if (!listed.ok) return listed;
      const { machine, schedules } = listed.value;
      return {
        ok: true as const,
        data: listed.value,
        human:
          schedules.length === 0
            ? `No Schedules on ${machineOf(machine)}.`
            : [`Schedules on ${machineOf(machine)}:`, ...schedules.map(scheduleLine)].join("\n"),
      };
    }),
  ),
).pipe(
  Command.withDescription("This Machine's Schedules, when each fires next and how its last went"),
);

const named = (change: "pause" | "resume" | "remove", description: string) =>
  Command.make(change, { name: nameArg, requestId: requestIdFlag }, ({ name, requestId }) =>
    changing(`schedule-${change}`, requestId, () => Effect.succeed({ change, name })),
  ).pipe(Command.withDescription(description));

export const schedule = Command.make("schedule").pipe(
  Command.withDescription("Workflows this Machine's host starts by itself, on a cron expression"),
  Command.withSubcommands([
    scheduleAdd,
    scheduleList,
    named("pause", "Stop a Schedule firing until it is resumed; its Run going now goes on"),
    named("resume", "Fire a paused Schedule again, from its next occurrence, with no catch-up"),
    named("remove", "Remove a Schedule; every Run it started stays"),
  ]),
);
