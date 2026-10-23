// The Flock chat's harness, model and effort selects, over Desktop's settings and the chat's
// account, and a choice saved at once.

import type { DesktopSettingsChange } from "../../../src/shared/flock";
import { chatSelects, refusalSaid } from "../../../src/shared/chat-choices";
import { chatChoicesAtom } from "../flock";

export const useChatChoices = () => {
  const { desktopSettings, change } = useDesktopSettings();
  const { value } = useHeld(() => chatChoicesAtom);
  /** Why the latest choice was refused, until it is dismissed or another is made. */
  const refused = ref<string | null>(null);
  return {
    selects: computed(() => chatSelects(desktopSettings.value, value.value ?? null)),
    refused,
    choose: (changed: DesktopSettingsChange) => {
      refused.value = null;
      return change(changed).then((reason) => {
        if (reason !== null) refused.value = refusalSaid(reason);
      });
    },
    dismiss: () => {
      refused.value = null;
    },
  };
};
