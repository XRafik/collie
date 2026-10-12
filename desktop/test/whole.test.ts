import { expect, test } from "bun:test";
import { effectScope, nextTick, reactive } from "vue";
import type { Panel } from "../../src/board-model";
import { useWhole } from "../view/app/composables/useWhole";

test("a tail-only SPEC rewrite rereads the whole file while its displayed prefix stays the same", async () => {
  const scope = effectScope();
  const plan = reactive<{ spec: Panel; stamp: string }>({
    spec: { _tag: "Text", text: "prefix", truncated: true },
    stamp: "1",
  });
  let reads = 0;
  const whole = scope.run(() =>
    useWhole(
      () => ({ installation: "local", runId: "run" }),
      "plan:SPEC.md",
      () => plan.spec,
      () => Promise.resolve(++reads === 1 ? "prefix: old tail" : "prefix: rewritten tail"),
      () => plan.stamp,
    ),
  )!;
  try {
    await nextTick();
    expect(whole.value?.text).toBe("prefix: old tail");
    plan.stamp = "2";
    await nextTick();
    await nextTick();
    expect(reads).toBe(2);
    expect(whole.value).toEqual({ text: "prefix: rewritten tail", cut: null });
  } finally {
    scope.stop();
  }
});
