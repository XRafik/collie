<script setup lang="ts">
import { choose, cleanupView } from "../../../src/shared/machine-cleanup";

const open = defineModel<boolean>("open", { required: true });
const { machines } = useInSync();
const { read, chosen, sweeps, opened, clean, tryAgain } = useCleanup();
watch(open, (now) => now && void opened());

const view = computed(() =>
  cleanupView(
    machines.value.map(({ row }) => row),
    read.value,
    chosen.value,
    sweeps.value,
  ),
);
const toggle = (profile: string, on: boolean) => {
  const picked = new Set(view.value.rows.filter((row) => row.chosen).map((row) => row.profile));
  if (on) picked.add(profile);
  else picked.delete(profile);
  chosen.value = picked;
};
</script>

<template>
  <UModal v-model:open="open" title="Clean up" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="flex flex-col gap-4" data-testid="cleanup">
        <div class="flex gap-2">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            label="All"
            :disabled="view.choosable.length === 0"
            data-testid="cleanup-all"
            @click="chosen = choose(view, 'all')"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            label="None"
            :disabled="view.choosable.length === 0"
            data-testid="cleanup-none"
            @click="chosen = choose(view, 'none')"
          />
        </div>
        <section
          v-for="row in view.rows"
          :key="row.profile"
          class="flex flex-col gap-1 border-t border-default pt-2 text-sm"
          :data-testid="`cleanup-${row.name}`"
        >
          <div class="flex items-center gap-2">
            <UCheckbox
              :model-value="row.chosen"
              :disabled="!row.choosable"
              data-testid="cleanup-chosen"
              @update:model-value="(on) => toggle(row.profile, on === true)"
            />
            <strong>{{ row.name }}</strong>
            <span
              class="ml-auto"
              :class="row.warn ? 'text-warning' : 'text-default'"
              data-testid="cleanup-said"
            >
              {{ row.said }}
            </span>
          </div>
          <p v-if="row.note !== null" class="text-muted" data-testid="cleanup-note">
            {{ row.note }}
          </p>
          <div v-if="row.reason !== null" class="flex items-center gap-2">
            <p class="text-error" data-testid="cleanup-reason">{{ row.reason }}</p>
            <UButton
              v-if="row.tryAgain"
              size="xs"
              color="neutral"
              variant="outline"
              label="Try again"
              class="ml-auto"
              data-testid="cleanup-try-again"
              @click="tryAgain(row.profile)"
            />
          </div>
          <details v-for="group in row.groups" :key="group.kind" data-testid="cleanup-kind">
            <summary class="cursor-pointer">
              {{ group.kind }} · {{ group.count }} · {{ group.size }}
            </summary>
            <ul class="ml-4 flex flex-col gap-1">
              <li v-for="item in group.items" :key="item.target">
                <span class="font-mono break-all">{{ item.target }}</span>
                <span class="text-muted"> · {{ item.size }} · {{ item.reason }}</span>
              </li>
            </ul>
          </details>
          <details v-if="row.kept !== null" data-testid="cleanup-kept">
            <summary class="cursor-pointer text-muted">{{ row.kept.said }}</summary>
            <ul class="ml-4 flex flex-col gap-1">
              <li v-for="item in row.kept.items" :key="`${item.kind} ${item.target}`">
                {{ item.kind }} <span class="font-mono break-all">{{ item.target }}</span>
                <span class="text-muted"> · {{ item.reason }}</span>
              </li>
            </ul>
          </details>
        </section>
        <p class="text-sm font-medium" data-testid="cleanup-total">{{ view.chosen }}</p>
        <UButton
          class="self-start"
          icon="i-lucide-brush-cleaning"
          :label="view.button.said"
          :disabled="view.button.disabled"
          data-testid="cleanup-clean"
          @click="clean(view)"
        />
      </div>
    </template>
  </UModal>
</template>
