<script setup lang="ts">
import type { RowFacts } from "../../../src/shared/diff-view";

defineProps<{ facts: RowFacts | undefined; viewed: boolean }>();

const MARK = { added: "A", deleted: "D", modified: "M" } as const;
</script>

<template>
  <span
    v-if="facts"
    class="ms-auto flex shrink-0 items-center gap-1 text-xs"
    data-testid="row-facts"
  >
    <UIcon
      v-if="viewed"
      name="i-lucide-check"
      class="text-success"
      aria-label="viewed"
      data-testid="row-viewed"
    />
    <span
      v-if="facts.drafts > 0"
      class="flex items-center gap-0.5 text-primary"
      :aria-label="`${facts.drafts} ${facts.drafts === 1 ? 'draft' : 'drafts'}`"
      data-testid="row-drafts"
    >
      <UIcon name="i-lucide-message-square" aria-hidden="true" />{{ facts.drafts }}
    </span>
    <span v-if="facts.lines === 'binary'" class="text-muted">binary</span>
    <template v-else>
      <span class="text-success">+{{ facts.lines.added }}</span>
      <span class="text-error">−{{ facts.lines.removed }}</span>
    </template>
    <span
      class="w-4 rounded border border-default text-center font-mono"
      :aria-label="facts.status"
      data-testid="row-status"
      >{{ MARK[facts.status] }}</span
    >
  </span>
</template>
