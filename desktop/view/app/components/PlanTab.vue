<script setup lang="ts">
import type { PlanPanel } from "../../../../src/board-model";
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
</script>

<template>
  <div data-testid="plan" class="flex flex-col gap-4">
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
      <PlanFile :file="opened === SPEC ? spec : read.get(opened)" :from="opened" />
    </section>
    <PlanFile :file="spec" :from="SPEC" />
    <UAccordion
      v-if="tickets.length > 0"
      v-model="expanded"
      type="multiple"
      :items="tickets"
      data-testid="tickets"
    >
      <template #body="{ item }">
        <div :data-testid="`ticket-${item.value}`">
          <PlanFile :file="read.get(ticketFile(item.value))" :from="ticketFile(item.value)" />
        </div>
      </template>
    </UAccordion>
  </div>
</template>
