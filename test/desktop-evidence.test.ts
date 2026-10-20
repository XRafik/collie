import { describe, expect, test } from "bun:test";
import type { RunDetail } from "../src/board-model";
import { hasEvidence } from "../desktop/src/shared/evidence";
import { webLinks } from "../desktop/src/shared/links";

const nothing = { verifications: [], evidence: [], handoffFiles: [], links: [] };
const file = { name: "shot.png", bytes: 10 };

describe("whether a Run has evidence to show", () => {
  test("is false with nothing", () => {
    expect(hasEvidence(nothing)).toBe(false);
    expect(hasEvidence({ ...nothing, handoffFiles: undefined })).toBe(false);
  });

  test("is true for each kind on its own", () => {
    const check = {
      id: "v1",
      name: "check",
      result: "pass",
      expect: "pass",
      exit: 0,
      at: "2026-10-19T10:00:00Z",
      by: "collie",
    } as const;
    expect(hasEvidence({ ...nothing, verifications: [check] })).toBe(true);
    expect(hasEvidence({ ...nothing, evidence: [file] })).toBe(true);
    expect(hasEvidence({ ...nothing, handoffFiles: [file] })).toBe(true);
    expect(
      hasEvidence({
        ...nothing,
        links: webLinks({ texts: ["See https://example.com"], mr: null }),
      }),
    ).toBe(true);
  });

  test("is false for metrics alone", () => {
    const metrics: RunDetail["outcome"]["metrics"] = {
      timeToFirstEvidence: 12,
      verifications: { pass: 3, fail: 1, unstable: 0, byCollie: 2 },
      slices: { done: 1, total: 2 },
      rework: 1,
      peakContext: { tokens: 1000, agent: "implementer" },
      halts: ["question"],
      obstacles: ["blocked"],
    };
    const withMetrics = { ...nothing, outcome: { metrics } };
    expect(hasEvidence(withMetrics)).toBe(false);
  });
});
