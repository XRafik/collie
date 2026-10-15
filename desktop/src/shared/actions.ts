import { Cause, Crypto, Effect, Exit, Result } from "effect";
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

// The view's own: Desktop's channel to it carries no Crypto service.
const viewCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: () => Effect.die("the view digests nothing"),
});

export interface ActionNotice {
  readonly title: string;
  readonly color: "success" | "error";
  readonly actions?: Array<{ label: string; onClick: () => Promise<boolean> }>;
}

export const actionRunner = (
  act: (input: {
    payload: {
      installation: string;
      action: DesktopAction;
      request: string | undefined;
      unsent?: string;
    };
  }) => Promise<Exit.Exit<string, Failed>>,
  tell: (notice: ActionNotice) => void,
) => {
  /**
   * One gesture is one request, minted here so every Try again sends it again, whatever
   * failed: the host takes it once. `unsent` says, at each try, why not to send it.
   */
  const run = (
    installation: string,
    action: DesktopAction,
    again?: string,
    applied?: () => void,
    unsent?: () => string | undefined,
  ): Promise<boolean> => {
    const request = again ?? Effect.runSync(viewCrypto.randomUUIDv4);
    const why = unsent?.();
    return act({
      payload:
        why === undefined
          ? { installation, action, request }
          : { installation, action, request, unsent: why },
    }).then((exit) => {
      if (Exit.isSuccess(exit)) {
        applied?.();
        tell({ title: exit.value, color: "success" });
        return true;
      }
      tell({
        title: failureOf(exit.cause).reason,
        color: "error",
        actions: [
          {
            label: "Try again",
            onClick: () => run(installation, action, request, applied, unsent),
          },
        ],
      });
      return false;
    });
  };

  return run;
};
