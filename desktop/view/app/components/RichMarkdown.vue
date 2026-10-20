<script setup lang="ts">
// Agent-written markdown, which is untrusted. A link never navigates the window.
import { Markdown } from "@comark/vue";
import mermaid, { Mermaid } from "@comark/vue/plugins/mermaid";
import shiki from "@comark/vue/plugins/shiki";
import { SAFE_PLUGINS } from "../../../src/shared/markdown";
import FileRef from "./FileRef.vue";
import MarkdownLink from "./MarkdownLink.vue";

const props = defineProps<{
  text: string;
  streaming?: boolean;
  /** The plan file this was read from, which its relative links are resolved against. */
  from?: string;
}>();
provide(
  "markdownFrom",
  computed(() => props.from),
);

const PLUGINS = [...SAFE_PLUGINS, shiki(), mermaid()];
const COMPONENTS = { a: MarkdownLink, mermaid: Mermaid, "file-ref": FileRef };
</script>

<template>
  <!-- Contained, so nothing an agent positions can leave it. Long tokens break; code,
       tables (Nuxt UI's own wrapper) and diagrams scroll within themselves. -->
  <div
    class="min-w-0 text-sm wrap-anywhere [contain:paint] [&_.mermaid]:overflow-x-auto [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_pre]:wrap-normal [&_table]:wrap-normal"
    data-testid="markdown"
  >
    <Suspense>
      <Markdown :value="text" :streaming="streaming" :plugins="PLUGINS" :components="COMPONENTS" />
      <template #fallback><p class="text-muted text-sm">Rendering…</p></template>
    </Suspense>
  </div>
</template>
