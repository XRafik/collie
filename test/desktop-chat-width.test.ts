// The Flock chat's width beside the board: chosen by dragging its edge or by keys, and drawn
// within what the window leaves both.

import { describe, expect, test } from "bun:test";
import { CHAT_WIDTH, chatWidth, dragged, nudged } from "../desktop/src/shared/chat-width";

describe("the chat's drawn width", () => {
  test("is the chosen width while the chat and the board both keep their least widths", () => {
    expect(chatWidth(600, 1400)).toBe(600);
  });

  test("is 32rem, or 40% of a window too narrow for it, until one is chosen", () => {
    expect(chatWidth(undefined, 1400)).toBe(512);
    expect(chatWidth(undefined, 1000)).toBe(400);
  });

  test("never goes below the chat's least width", () => {
    expect(CHAT_WIDTH.min).toBe(320);
    expect(chatWidth(100, 1400)).toBe(320);
    expect(chatWidth(undefined, 600)).toBe(320);
  });

  test("leaves the board its least width", () => {
    expect(CHAT_WIDTH.boardMin).toBe(480);
    expect(chatWidth(1200, 1400)).toBe(920);
  });

  test("keeps the chat's least width in a window too narrow for both", () => {
    expect(chatWidth(600, 700)).toBe(320);
  });

  test("gives back the chosen width when a narrowed window widens again", () => {
    expect(chatWidth(700, 1000)).toBe(520);
    expect(chatWidth(700, 1600)).toBe(700);
  });

  test("is clamped again at a larger Zoom, which makes the same window fewer CSS pixels wide", () => {
    // A 1600-device-pixel window at 200% is 800 CSS pixels.
    expect(chatWidth(700, 1600 / 2)).toBe(320);
  });
});

describe("dragging the chat's edge", () => {
  test("widens the chat as the edge moves left and narrows it as it moves right", () => {
    const from = { x: 900, width: 500 };
    expect(dragged(from, 840, 1400)).toBe(560);
    expect(dragged(from, 950, 1400)).toBe(450);
  });

  test("stops at the chat's least width and at the board's", () => {
    const from = { x: 900, width: 500 };
    expect(dragged(from, 1300, 1400)).toBe(320);
    expect(dragged(from, 100, 1400)).toBe(920);
  });
});

describe("nudging the chat's edge with the keys", () => {
  test("← widens the chat and → narrows it, 16px at a time", () => {
    expect(nudged(500, 1400, "ArrowLeft")).toBe(516);
    expect(nudged(500, 1400, "ArrowRight")).toBe(484);
  });

  test("steps from the drawn width, so a chat the window caps narrows at once", () => {
    expect(nudged(1200, 1400, "ArrowRight")).toBe(904);
    expect(nudged(undefined, 1400, "ArrowLeft")).toBe(528);
  });

  test("stops at the least and greatest widths", () => {
    expect(nudged(320, 1400, "ArrowRight")).toBe(320);
    expect(nudged(920, 1400, "ArrowLeft")).toBe(920);
  });

  test("leaves any other key to the page", () => {
    expect(nudged(500, 1400, "ArrowUp")).toBeNull();
    expect(nudged(500, 1400, "a")).toBeNull();
  });
});
