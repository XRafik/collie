<script setup lang="ts">
import type { Flow, FlowRun } from "../../../../src/board-model";
import {
  cardForLink,
  flowRows,
  inspectorOf,
  nodeName,
  type FlowCard,
  type FlowSelection,
  type FlowSpot,
} from "../../../src/shared/flow";
const props = defineProps<{
  flow: Flow;
  focused: FlowSpot | null;
  selected: FlowSelection | null;
  cards: ReadonlyArray<FlowCard>;
  away: ReadonlySet<string>;
  now: number;
}>();
const emit = defineEmits<{
  choose: [spot: FlowSpot];
  focus: [spot: FlowSpot];
  origin: [run: string, machine: string];
}>();
const rows = computed(() => flowRows(props.flow));
const buttons = new Map<string, HTMLElement>();
const keyOf = (spot: FlowSpot) => JSON.stringify([spot.run, spot.node]);
const remember = (spot: FlowSpot, element: unknown) => {
  if (element instanceof HTMLElement) buttons.set(keyOf(spot), element);
  else buttons.delete(keyOf(spot));
};
const name = (node: FlowRun) =>
  nodeName(node, {
    missing: node.link !== undefined && cardForLink(node, props.cards) === undefined,
    notLive: node.link?.machine != null && props.away.has(node.link.machine),
  });
const hover = (run: string, node: string) => {
  const info = inspectorOf(props.flow, { run, node, item: null }, props.now);
  return info === null
    ? ""
    : [info.title, info.state.replaceAll("-", " "), info.said, ...info.lines]
        .filter(Boolean)
        .join("\n");
};
const matches = (spot: FlowSpot | null, run: string, node: string) =>
  spot?.run === run && spot.node === node;
defineExpose({
  focus: (spot: FlowSpot) => buttons.get(keyOf(spot))?.focus(),
  reveal: (spot: FlowSpot) =>
    buttons.get(keyOf(spot))?.scrollIntoView({ block: "nearest", inline: "nearest" }),
});
</script>

<template>
  <div role="group" aria-label="Flow" class="max-h-96 shrink-0 overflow-auto">
    <section
      v-for="row in rows"
      :key="row.run"
      role="group"
      :aria-label="row.name"
      class="flex min-w-max items-center border-t border-default py-3 first:border-0"
    >
      <div class="sticky left-0 z-10 w-36 shrink-0 bg-default pr-3">
        <h3 class="text-sm font-semibold">{{ row.title }}</h3>
        <p class="text-xs text-muted">{{ row.machine }}</p>
        <p class="text-xs text-muted">{{ row.execution }}</p>
        <button
          v-if="row.requestedBy"
          type="button"
          tabindex="-1"
          class="text-left text-xs text-primary hover:underline"
          @click="emit('origin', row.requestedBy.run, row.requestedBy.machine.name)"
        >
          Started by {{ row.requestedBy.run }} on {{ row.requestedBy.machine.name }}
        </button>
        <button
          v-else-if="row.startedBy"
          type="button"
          tabindex="-1"
          class="text-left text-xs text-primary hover:underline"
          @click="emit('origin', row.startedBy.run, row.machine)"
        >
          Started by {{ row.startedBy.run
          }}<template v-if="row.startedBy.step"> · {{ row.startedBy.step }}</template>
        </button>
      </div>
      <ol class="flex items-center">
        <li v-for="(node, at) in row.nodes" :key="node.id" class="flex items-center">
          <span
            v-if="at > 0"
            aria-hidden="true"
            class="w-5 border-t-2 border-default"
            :class="{ 'border-dashed': node.state === 'expected' }"
          />
          <UTooltip
            :text="hover(row.run, node.id)"
            :delay-duration="300"
            :ui="{ content: 'whitespace-pre-line' }"
          >
            <button
              :ref="(el) => remember({ run: row.run, node: node.id }, el)"
              type="button"
              class="flex min-h-14 w-44 items-center gap-2 rounded border bg-default px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-primary"
              :class="[
                node.state === 'failed'
                  ? 'border-2 border-error'
                  : node.state === 'needs-you'
                    ? 'border-2 border-warning'
                    : matches(flow.current, row.run, node.id)
                      ? 'border-2 border-info'
                      : 'border-default',
                {
                  'border-dashed': node.state === 'expected' || node.kind === 'offer',
                  'bg-muted': node.link !== undefined,
                  'border-success': node.kind === 'offer',
                  'ring-2 ring-primary/30': matches(selected, row.run, node.id),
                  'opacity-50': node.link?.machine != null && away.has(node.link.machine),
                },
              ]"
              :tabindex="matches(focused, row.run, node.id) ? 0 : -1"
              :aria-label="name(node)"
              :aria-current="matches(flow.current, row.run, node.id) ? 'step' : undefined"
              :aria-pressed="matches(selected, row.run, node.id)"
              @focus="emit('focus', { run: row.run, node: node.id })"
              @click="emit('choose', { run: row.run, node: node.id })"
            >
              <FlowGlyph :state="node.state" />
              <span class="min-w-0"
                ><span class="block text-sm font-semibold">{{ node.title }}</span
                ><span
                  v-if="node.state !== 'expected' && node.said"
                  class="block text-xs text-muted"
                  >{{ node.said }}</span
                ><span
                  v-if="
                    node.link?.machine != null &&
                    away.has(node.link.machine) &&
                    node.link.asOf != null
                  "
                  class="block text-xs text-muted"
                  >as of {{ node.link.asOf }}</span
                ></span
              >
              <UIcon
                v-if="node.link !== undefined"
                name="i-lucide-arrow-up-right"
                class="ml-auto shrink-0 text-muted"
              />
            </button>
          </UTooltip>
        </li>
      </ol>
    </section>
  </div>
</template>
