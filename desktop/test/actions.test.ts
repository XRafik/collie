import { expect, test } from "bun:test";
import { Exit } from "effect";
import { actionRunner, type ActionNotice } from "../src/shared/actions";
import { ActionFailed, type DesktopAction } from "../src/shared/flock";
import { clearSent, type Draft, editDraft } from "../src/shared/review-comments";

test("a successful toast retry clears the original sent drafts and preserves later edits", async () => {
  const sent: Draft[] = [
    { id: "a", anchor: { _tag: "Plan", file: "SPEC.md", quote: "one" }, text: "first" },
    { id: "b", anchor: { _tag: "Plan", file: "SPEC.md", quote: "two" }, text: "second" },
  ];
  let drafts = sent;
  const calls: Array<{ installation: string; action: DesktopAction; request: string | undefined }> =
    [];
  const notices: ActionNotice[] = [];
  const run = actionRunner(
    ({ payload }) => {
      calls.push(payload);
      return Promise.resolve(
        calls.length === 1
          ? Exit.fail(new ActionFailed({ reason: "connection lost", request: "same-request" }))
          : Exit.succeed("Delivered"),
      );
    },
    (notice) => notices.push(notice),
  );
  const action: DesktopAction = { _tag: "Deliver", runId: "r", agent: "planner", text: "comments" };
  expect(
    await run("local", action, undefined, () => {
      drafts = clearSent(drafts, sent);
    }),
  ).toBe(false);
  expect(drafts).toEqual(sent);
  drafts = [...editDraft(drafts, "b", "edited meanwhile"), { ...sent[0]!, id: "c" }];
  expect(await notices[0]?.actions?.[0]?.onClick()).toBe(true);
  expect(drafts.map((draft) => draft.id)).toEqual(["b", "c"]);
  expect(calls[1]).toEqual({ installation: "local", action, request: "same-request" });
});
