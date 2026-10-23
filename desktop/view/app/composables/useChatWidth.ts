// The Flock chat's chosen width, kept in Desktop's settings; undefined is the start width.

export const useChatWidth = () => {
  const { desktopSettings, change } = useDesktopSettings();
  const toast = useToast();
  const chosen = ref<number | undefined>(desktopSettings.value.chatWidth);
  // An older save told back must not undo a newer choice.
  let saving = 0;
  watch(
    () => desktopSettings.value.chatWidth,
    (saved) => {
      if (saving === 0) chosen.value = saved;
    },
  );
  const save = () => {
    saving += 1;
    return change({ chatWidth: chosen.value ?? null })
      .finally(() => {
        saving -= 1;
      })
      .then((refused) => {
        if (refused !== null)
          toast.add({ title: `The chat's width was not kept: ${refused}`, color: "error" });
      });
  };
  return { chosen, save };
};
