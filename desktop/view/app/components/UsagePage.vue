<script setup lang="ts">
import type { Level } from "../../../src/shared/usage";

const emit = defineEmits<{ back: [] }>();
const usage = useUsage();
onMounted(() => void usage.refresh());
const METER = { ok: "primary", warn: "warning", out: "error" } as const satisfies Record<
  Level,
  string
>;
</script>

<template>
  <section data-testid="usage-page" class="flex flex-col bg-default">
    <PageHeader title="Usage" @back="emit('back')" />
    <div class="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
      <div class="flex flex-col gap-6" :class="columnClass('usage')">
        <p
          v-if="usage.page.value.sections.length === 0 && usage.page.value.notRead.length === 0"
          class="text-sm text-muted"
        >
          No live Machine has reported usage yet.
        </p>
        <section
          v-for="section in usage.page.value.sections"
          :key="section.key"
          class="flex flex-col gap-2"
          :data-testid="`usage-${section.key}`"
        >
          <h3 class="text-sm font-semibold">{{ section.title }}</h3>
          <div
            v-for="window in section.windows"
            :key="window.key"
            class="grid grid-cols-[8rem_1fr_3rem] items-center gap-2 text-sm"
          >
            <span>{{ window.label }}</span>
            <UProgress :model-value="window.percent" :color="METER[window.level]" size="sm" />
            <span class="text-right tabular-nums">{{ window.percent }}%</span>
            <span v-if="window.reset !== null" class="col-start-2 text-xs text-muted">
              {{ window.reset }}
            </span>
          </div>
          <span v-if="section.said !== null" class="text-xs text-muted">{{ section.said }}</span>
          <p class="text-sm">
            Logged in on
            <span v-for="(machine, i) in section.machines" :key="machine.name"
              >{{ i > 0 ? ", " : "" }}{{ machine.name
              }}<span v-if="machine.problem !== null" class="text-warning"
                >: {{ machine.problem }}</span
              ></span
            >
          </p>
        </section>
        <section
          v-if="usage.page.value.notRead.length > 0"
          class="flex flex-col gap-2"
          data-testid="not-read"
        >
          <h3 class="text-sm font-semibold">Not read</h3>
          <p v-for="item in usage.page.value.notRead" :key="item.key" class="text-sm text-muted">
            {{ item.said }}
          </p>
        </section>
      </div>
    </div>
  </section>
</template>
