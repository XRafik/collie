// The Flock chat's harness, model and effort selects, over Desktop's settings and the account
// the main process pushes of what the chat holds and could run on.

import { chatSelects, chosen, refusedChoice } from "../../../src/shared/chat-choices";
import { chatChoicesAtom } from "../flock";

export type ChatChoice = "harness" | "model" | "effort";

export const useChatChoices = () => {
  const { value } = useHeld(() => chatChoicesAtom);
  const { desktopSettings, change } = useDesktopSettings();
  const refused = ref<string | null>(null);
  return {
    /** Null until the account is first told. */
    selects: computed(() =>
      value.value === undefined ? null : chatSelects(desktopSettings.value, value.value),
    ),
    /** What the last choice was refused for, until it is dismissed or a choice is saved. */
    refused,
    dismiss: () => {
      refused.value = null;
    },
    /** Saves `value` at once; a refusal saves nothing. */
    choose: (which: ChatChoice, value: string) =>
      change(chosen(which, value)).then((reason) => {
        refused.value = reason === null ? null : refusedChoice(reason);
      }),
  };
};
