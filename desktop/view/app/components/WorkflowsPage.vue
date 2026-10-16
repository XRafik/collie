<script setup lang="ts">
import { Exit, type Schema } from "effect";
import type { HostDefinitions } from "../../../../src/definitions-model";
import { failureOf } from "../../../src/shared/actions";
import type { Token } from "../composables/useHighlight";

/** One view for the Flock, read-only: In sync Machines share their definitions. */
const emit = defineEmits<{ back: [] }>();
const { machines } = useFlock();
const { definitionsOf } = useActions();

// Mounted each time the page opens, so each opening reads again.
const machine = machines.value.find(({ local }) => local) ?? machines.value[0];
const read = ref<HostDefinitions | null>(null);
const failed = ref<string | null>(machine === undefined ? "No Machine is connected" : null);
onMounted(async () => {
  if (machine === undefined) return;
  const exit = await definitionsOf(machine.installation);
  if (Exit.isSuccess(exit)) read.value = exit.value;
  else failed.value = failureOf(exit.cause).reason;
});

const chosen = ref<{ kind: "workflow" | "persona"; id: string } | null>(null);
const workflow = computed(() =>
  chosen.value?.kind === "workflow"
    ? read.value?.workflows.find(({ id }) => id === chosen.value?.id)
    : undefined,
);
const persona = computed(() =>
  chosen.value?.kind === "persona"
    ? read.value?.personas.find(({ name }) => name === chosen.value?.id)
    : undefined,
);
const isChosen = (kind: "workflow" | "persona", id: string) =>
  chosen.value?.kind === kind && chosen.value.id === id;

const files = shallowRef<
  ReadonlyArray<{ path: string; lines: ReadonlyArray<ReadonlyArray<Token>> | null }>
>([]);
watch(workflow, async (now, _, onCleanup) => {
  let stale = false;
  onCleanup(() => (stale = true));
  files.value = (now?.files ?? []).map(({ path }) => ({ path, lines: null }));
  const coloured = await Promise.all(
    (now?.files ?? []).map(async ({ path, text }) => ({
      path,
      lines: await highlightLines(text.split("\n"), path),
    })),
  );
  if (!stale) files.value = coloured;
});

const json = (value: typeof Schema.Json.Type | null) => JSON.stringify(value, null, 2);
</script>

<template>
  <section data-testid="workflows-page" class="flex flex-col bg-default">
    <PageHeader title="Workflows" @back="emit('back')">
      <p v-if="machine" class="text-sm text-muted" data-testid="read-from">
        Read from {{ machine.name }}
      </p>
    </PageHeader>
    <div class="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
      <div class="flex flex-col gap-6" :class="columnClass('workflows')">
        <p v-if="failed !== null" class="text-sm text-error" data-testid="read-failed">
          {{ failed }}
        </p>
        <p v-else-if="read === null" class="text-sm text-muted">Reading…</p>
        <div v-else class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6">
          <nav class="flex flex-col gap-4" aria-label="Workflows and Personas">
            <section class="flex flex-col gap-1">
              <h3 class="text-sm font-semibold text-muted">Workflows</h3>
              <button
                v-for="one in read.workflows"
                :key="one.id"
                type="button"
                :data-testid="`workflow-${one.id}`"
                :aria-pressed="isChosen('workflow', one.id)"
                class="rounded px-2 py-1 text-left hover:bg-elevated"
                :class="isChosen('workflow', one.id) ? 'bg-elevated' : ''"
                @click="chosen = { kind: 'workflow', id: one.id }"
              >
                <span class="flex items-center gap-2">
                  <strong class="truncate">{{ one.title }}</strong>
                  <UBadge size="sm" variant="subtle" color="neutral" :label="one.layer" />
                  <UBadge
                    v-if="one.broken !== null"
                    size="sm"
                    variant="subtle"
                    color="error"
                    label="Won't construct"
                  />
                </span>
                <code class="text-xs text-muted">{{ one.id }}</code>
                <p class="text-sm text-muted">{{ one.description }}</p>
              </button>
            </section>
            <section v-if="read.problems.length > 0" class="flex flex-col gap-1">
              <h3 class="text-sm font-semibold text-warning">Would not load</h3>
              <p v-for="problem in read.problems" :key="problem.path" class="text-sm">
                <code>{{ problem.path }}</code>
                <span class="block text-muted">{{ problem.message }}</span>
              </p>
            </section>
            <section class="flex flex-col gap-1">
              <h3 class="text-sm font-semibold text-muted">Personas</h3>
              <button
                v-for="one in read.personas"
                :key="one.name"
                type="button"
                :data-testid="`persona-${one.name}`"
                :aria-pressed="isChosen('persona', one.name)"
                class="rounded px-2 py-1 text-left hover:bg-elevated"
                :class="isChosen('persona', one.name) ? 'bg-elevated' : ''"
                @click="chosen = { kind: 'persona', id: one.name }"
              >
                <span class="flex items-center gap-2">
                  <strong class="truncate">{{ one.name }}</strong>
                  <UBadge size="sm" variant="subtle" color="neutral" :label="one.layer" />
                </span>
                <p class="text-sm text-muted">{{ one.description }}</p>
              </button>
            </section>
            <section v-if="read.errors.length > 0" class="flex flex-col gap-1">
              <h3 class="text-sm font-semibold text-warning">Personas that would not load</h3>
              <p v-for="error in read.errors" :key="error" class="text-sm text-muted">
                {{ error }}
              </p>
            </section>
          </nav>

          <article v-if="workflow" class="flex min-w-0 flex-col gap-4" data-testid="workflow">
            <header>
              <h3 class="text-lg font-semibold">{{ workflow.title }}</h3>
              <p>{{ workflow.description }}</p>
              <p class="text-sm text-muted">
                {{ workflow.layer }} · <code>{{ workflow.path }}</code>
              </p>
            </header>
            <p v-if="workflow.broken !== null" class="text-sm text-error">
              Won't construct: {{ workflow.broken }}
            </p>
            <section>
              <h4 class="font-semibold">Inputs</h4>
              <p v-if="workflow.inputs.length === 0" class="text-sm text-muted">None</p>
              <div v-for="input in workflow.inputs" :key="input.name" class="mt-2">
                <p>
                  <code>{{ input.name }}</code>
                  <span class="text-sm text-muted">
                    {{ input.required ? "required" : "optional" }}
                  </span>
                </p>
                <pre class="overflow-x-auto text-xs">{{ json(input.schema) }}</pre>
                <p v-for="limit in input.limits" :key="limit" class="text-sm text-muted">
                  {{ limit }}
                </p>
              </div>
            </section>
            <section>
              <h4 class="font-semibold">Settled by the host</h4>
              <p v-for="option in workflow.options" :key="option.name" class="text-sm">
                <code>{{ option.name }}</code> {{ option.meaning }}
              </p>
            </section>
            <section
              v-for="[label, drawn] in [
                ['Result', workflow.success],
                ['Failure', workflow.error],
              ] as const"
              :key="label"
            >
              <h4 class="font-semibold">{{ label }}</h4>
              <pre class="overflow-x-auto text-xs">{{ json(drawn.schema) }}</pre>
              <p v-for="limit in drawn.limits" :key="limit" class="text-sm text-muted">
                {{ limit }}
              </p>
            </section>
            <section>
              <h4 class="font-semibold">Metadata</h4>
              <pre class="overflow-x-auto text-xs">{{ json(workflow.metadata) }}</pre>
            </section>
            <section
              v-for="file in files"
              :key="file.path"
              class="rounded border border-default"
              data-testid="workflow-file"
            >
              <code class="block px-3 py-2 text-sm">{{ file.path }}</code>
              <div class="overflow-x-auto border-t border-default" data-highlighted>
                <p v-if="file.lines === null" class="p-3 text-sm text-muted">Highlighting…</p>
                <table v-else class="w-full font-mono text-xs">
                  <tr v-for="(tokens, at) in file.lines" :key="at">
                    <td class="w-10 select-none px-2 text-right text-muted">{{ at + 1 }}</td>
                    <td class="whitespace-pre px-2"><TokenSpans :tokens="tokens" /></td>
                  </tr>
                </table>
              </div>
            </section>
          </article>

          <article v-else-if="persona" class="flex min-w-0 flex-col gap-4" data-testid="persona">
            <header>
              <h3 class="text-lg font-semibold">{{ persona.name }}</h3>
              <p>{{ persona.description }}</p>
              <p class="text-sm text-muted">
                {{ persona.layer }} · <code>{{ persona.path }}</code>
                <template v-if="persona.extends !== null">
                  · extends {{ persona.extends }}</template
                >
              </p>
            </header>
            <RichMarkdown :text="persona.body" />
          </article>
          <p v-else class="text-sm text-muted">Choose a Workflow or a Persona to read it.</p>
        </div>
      </div>
    </div>
  </section>
</template>
