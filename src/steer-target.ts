// Which of a Run's agents a steer or a correction reaches. Pure, so the host and its tests
// decide the same way.

import { agentName } from "./naming";

/** One launch, and whether the work it was given has its Output yet. */
export interface Candidate {
  readonly agent: string;
  readonly operation: string;
  readonly role: string;
  readonly done: boolean;
  /** With its sequence, what names the agent by the name it was launched under, as `build`. */
  readonly runId?: string;
  readonly sequence?: number;
}

const BUILDER_ROLES: ReadonlyArray<string> = ["implementer"];

/** The names `--to` takes for a role, and the launch roles each covers. */
export const ROLES = {
  builder: BUILDER_ROLES,
  reviewer: ["reviewer"],
  planner: ["planner"],
} satisfies Record<string, ReadonlyArray<string>>;

const rolesFor = (to: string): ReadonlyArray<string> | undefined =>
  Object.entries(ROLES).find(([name]) => name === to)?.[1];

export interface Asked {
  readonly to?: string | undefined;
  readonly operation?: string | undefined;
  readonly agent?: string | undefined;
}

/**
 * The launch a message reaches. Named, it is that agent, operation or role. Otherwise it is
 * the agent whose step is active, then the builder, then whoever was launched last.
 */
export function steerTarget<C extends Candidate>(
  launches: ReadonlyArray<C>,
  asked: Asked,
): C | undefined {
  const { agent, operation, to } = asked;
  if (agent !== undefined)
    return launches.findLast((one) => one.agent === agent || launchedAs(one, agent));
  if (operation !== undefined) return launches.findLast((one) => named(one, operation));
  const roles = to === undefined ? undefined : rolesFor(to);
  if (to !== undefined && roles === undefined) return launches.findLast((one) => named(one, to));
  const newest = launches.filter(
    (one, at) => !launches.slice(at + 1).some((later) => later.agent === one.agent),
  );
  const among = roles === undefined ? newest : newest.filter((one) => roles.includes(one.role));
  const active = among.findLast((one) => !one.done);
  if (active !== undefined || roles !== undefined) return active ?? among.at(-1);
  return among.findLast((one) => BUILDER_ROLES.includes(one.role)) ?? launches.at(-1);
}

const launchedAs = (one: Candidate, name: string) =>
  one.runId !== undefined && one.agent === agentName(one.runId, name, null, one.sequence ?? 1);

const named = (one: Candidate, name: string) =>
  one.operation === name || one.agent === name || launchedAs(one, name);
