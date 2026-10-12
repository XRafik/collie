import { Cause, Exit, Result } from "effect";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type { ActionFailed, DesktopAction } from "./flock";
import { saidOf } from "./said";

export type Failed = ActionFailed | RpcClientError.RpcClientError;

export const failureOf = (cause: Cause.Cause<Failed>) => {
  const found = Cause.findError(cause);
  return Result.isSuccess(found) && found.success._tag === "ActionFailed"
    ? found.success
    : { reason: saidOf(cause), request: undefined };
};

export interface ActionNotice {
  readonly title: string;
  readonly color: "success" | "error";
  readonly actions?: Array<{ label: string; onClick: () => Promise<boolean> }>;
}

export const actionRunner = (
  act: (input: {
    payload: { installation: string; action: DesktopAction; request: string | undefined };
  }) => Promise<Exit.Exit<string, Failed>>,
  tell: (notice: ActionNotice) => void,
) => {
  /**
   * A failure offers to try again under the same request id, so a request the host did
   * take before the reply was lost is not done twice.
   */
  const run = (
    installation: string,
    action: DesktopAction,
    again?: string,
    applied?: () => void,
  ): Promise<boolean> =>
    act({
      payload: { installation, action, request: again },
    }).then((exit) => {
      if (Exit.isSuccess(exit)) {
        applied?.();
        tell({ title: exit.value, color: "success" });
        return true;
      }
      const { reason, request } = failureOf(exit.cause);
      tell({
        title: reason,
        color: "error",
        actions:
          request === undefined
            ? []
            : [{ label: "Try again", onClick: () => run(installation, action, request, applied) }],
      });
      return false;
    });

  return run;
};
