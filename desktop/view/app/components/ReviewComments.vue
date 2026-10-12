<script setup lang="ts">
import type { BoardAgent, RunAgent } from "../../../../src/board-model";
import { recipients } from "../../../src/shared/record-terminal";
import { compose, counted, locationOf, quoteOf } from "../../../src/shared/review-comments";

const props = defineProps<{
  installation: string;
  runId: string;
  launches: ReadonlyArray<RunAgent> | undefined;
  live: ReadonlyArray<BoardAgent>;
}>();
const { drafts, edit, remove, clear } = useReviewDrafts(() => props);
const { run } = useActions();

const offered = computed(() => recipients(props.launches, props.live));
/** The human's choice while the Run still has it, else its newest live agent. */
const picked = ref<string>();
const agent = computed(() =>
  offered.value.some((one) => one.name === picked.value)
    ? picked.value
    : offered.value.at(-1)?.name,
);

const sending = ref(false);
const send = async () => {
  if (agent.value === undefined) return;
  const sent = [...drafts.value];
  sending.value = true;
  const delivered = await run(props.installation, {
    _tag: "Deliver",
    runId: props.runId,
    agent: agent.value,
    text: compose(drafts.value),
  });
  sending.value = false;
  if (delivered) clear(sent);
};
</script>

<template>
  <section
    v-if="drafts.length > 0"
    data-testid="review-comments"
    class="flex flex-col gap-3 rounded border border-default p-3"
  >
    <h3 class="text-sm font-medium">{{ counted(drafts) }}</h3>
    <ul class="flex flex-col gap-3">
      <li v-for="draft in drafts" :key="draft.id" class="flex flex-col gap-1" data-testid="draft">
        <span class="text-xs text-muted">{{ locationOf(draft.anchor) }}</span>
        <blockquote class="line-clamp-3 border-l-2 border-default pl-2 text-xs text-muted">
          {{ quoteOf(draft.anchor) }}
        </blockquote>
        <DraftEdit
          :text="draft.text"
          @edit="(text) => edit(draft.id, text)"
          @remove="remove(draft.id)"
        />
      </li>
    </ul>
    <div class="flex items-center gap-2">
      <USelect
        v-if="offered.length > 0"
        :model-value="agent"
        :items="offered.map((one) => ({ label: one.label, value: one.name }))"
        size="sm"
        aria-label="Send to"
        @update:model-value="(name: string) => (picked = name)"
        data-testid="recipient"
      />
      <p v-else class="text-sm text-muted" data-testid="no-recipient">
        This Run has no live agent to tell
      </p>
      <UButton
        label="Send"
        icon="i-lucide-send"
        size="sm"
        :disabled="agent === undefined"
        :loading="sending"
        data-testid="send-comments"
        @click="send"
      />
    </div>
  </section>
</template>
