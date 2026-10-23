// The Flock chat's width beside the board, in CSS pixels: a larger Zoom makes the window fewer of them.

/** The chat's sizes in px, and the share of the window it starts at. */
export const CHAT_WIDTH = {
  start: 512,
  startShare: 0.4,
  min: 320,
  boardMin: 480,
  step: 16,
} as const;

/** The widest the chat is drawn in a window `window` wide. */
export const chatWidthMax = (window: number): number =>
  Math.max(CHAT_WIDTH.min, window - CHAT_WIDTH.boardMin);

/** The chat's drawn width: the chosen one, or the start where none is, within its least and greatest. */
export const chatWidth = (chosen: number | undefined, window: number): number =>
  Math.max(
    CHAT_WIDTH.min,
    Math.min(
      chosen ?? Math.min(CHAT_WIDTH.start, window * CHAT_WIDTH.startShare),
      chatWidthMax(window),
    ),
  );

/** The width a drag from `from` to `x` chooses; the chat is right of its edge. */
export const dragged = (from: { x: number; width: number }, x: number, window: number) =>
  chatWidth(from.width + from.x - x, window);

/** The width `key` chooses, stepped from the drawn width, or null for a key that does not size it. */
export const nudged = (chosen: number | undefined, window: number, key: string): number | null => {
  const by = key === "ArrowLeft" ? 1 : key === "ArrowRight" ? -1 : null;
  return by === null ? null : chatWidth(chatWidth(chosen, window) + by * CHAT_WIDTH.step, window);
};
