<script setup lang="ts">
import type { PlanPanel } from "../../../../src/board-model";
import { locationOf, type PlanAnchor, planAnchor } from "../../../src/shared/review-comments";
import type { PlanText } from "./PlanFile.vue";

const props = defineProps<{ plan: PlanPanel; installation: string; runId: string }>();
const { textOf } = useActions();

const SPEC = "SPEC.md";
const ticketFile = (file: string) => `issues/${file}`;

/** Each ticket's stamp by its path in the plan; none for a plan file that is not a ticket. */
const stamps = computed(
  () => new Map(props.plan.tickets.map((ticket) => [ticketFile(ticket.file), ticket.stamp])),
);

/** Each plan file asked for, by its path in the plan; null while it is first read. */
const read = ref(new Map<string, PlanText | null>());
/** The stamp each file was last asked for at, so a changed one is read again. */
const asked = new Map<string, string | undefined>();
const load = (file: string) => {
  const stamp = stamps.value.get(file);
  if (asked.has(file) && asked.get(file) === stamp) return;
  asked.set(file, stamp);
  if (!read.value.has(file)) read.value.set(file, null);
  void textOf(props.installation, props.runId, `plan:${file}`).then((text) => {
    if (asked.get(file) !== stamp) return;
    read.value.set(file, text === null ? { failed: `${file} could not be read.` } : { text });
  });
};

/** The plan file a link opened, shown above the plan until it is closed. */
const opened = ref<string | null>(null);
provide("openPlanFile", (file: string) => {
  opened.value = file;
});
const wholeSpec = useWhole(
  () => props,
  `plan:${SPEC}`,
  () => props.plan.spec,
  textOf,
  () => props.plan.specStamp,
);
const spec = computed<PlanText>(() =>
  props.plan.spec._tag === "Text"
    ? { text: wholeSpec.value?.text ?? "", cut: wholeSpec.value?.cut ?? null }
    : { failed: props.plan.spec.reason },
);

const tickets = computed(() =>
  props.plan.tickets.map((ticket) => ({
    label: ticket.title,
    value: ticket.file,
    icon: ticket.done ? "i-lucide-circle-check" : "i-lucide-circle",
  })),
);
const expanded = ref<string[]>([]);
watch([expanded, opened, stamps], () => {
  expanded.value.forEach((file) => load(ticketFile(file)));
  if (opened.value !== null && opened.value !== SPEC) load(opened.value);
});

const { add } = useReviewDrafts(() => props);
/** The span last selected in a plan file, until it is commented on or let go. */
const selected = ref<PlanAnchor | null>(null);
const select = (file: string, event: MouseEvent) => {
  const selection = window.getSelection();
  const inside =
    selection !== null &&
    selection.rangeCount > 0 &&
    event.currentTarget instanceof Node &&
    event.currentTarget.contains(selection.getRangeAt(0).commonAncestorContainer);
  const anchor = inside ? planAnchor(file, selection.toString()) : null;
  if (anchor !== null) selected.value = anchor;
};
const comment = (text: string) => {
  if (selected.value !== null) add(selected.value, text);
  selected.value = null;
};
</script>

<template>
  <div data-testid="plan" class="flex flex-col gap-4">
    <CommentComposer
      v-if="selected !== null"
      class="sticky top-0 z-10"
      data-testid="plan-comment"
      :location="locationOf(selected)"
      :quote="selected.quote"
      @add="comment"
      @cancel="selected = null"
    />
    <section
      v-if="opened !== null"
      data-testid="plan-file"
      class="rounded border border-default p-3"
    >
      <div class="mb-2 flex items-center justify-between">
        <code class="text-xs text-muted" data-testid="plan-file-name">{{ opened }}</code>
        <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-x"
          aria-label="Close"
          data-testid="close-plan-file"
          @click="opened = null"
        />
      </div>
      <div @mouseup="select(opened, $event)">
        <PlanFile :file="opened === SPEC ? spec : read.get(opened)" :from="opened" />
      </div>
    </section>
    <div @mouseup="select(SPEC, $event)">
      <PlanFile :file="spec" :from="SPEC" />
    </div>
    <UAccordion
      v-if="tickets.length > 0"
      v-model="expanded"
      type="multiple"
      :items="tickets"
      data-testid="tickets"
    >
      <template #body="{ item }">
        <div
          :data-testid="`ticket-${item.value}`"
          @mouseup="select(ticketFile(item.value), $event)"
        >
          <PlanFile :file="read.get(ticketFile(item.value))" :from="ticketFile(item.value)" />
        </div>
      </template>
    </UAccordion>
  </div>
</template>
