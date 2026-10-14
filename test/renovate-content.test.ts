import { expect, test } from "bun:test";
import { RENOVATE, RENOVATE_ON } from "../workflows/renovate.workflow";
import { contentOf } from "../src/sdk";
import onGitlab from "../workflows/renovate.gitlab.md" with { type: "text" };
import onGithub from "../workflows/renovate.github.md" with { type: "text" };

// renovate keeps a content file per forge (ADR-0050 D1, as amended): the procedure differs,
// so each says it its forge's way, and what is Linear's is said the same in both.

const gitlab = contentOf(onGitlab);
const github = contentOf(onGithub);

test("both forges' renovate content has the same steps, and every step fills from what renovate gives it", () => {
  expect([...github.sections.keys()]).toEqual([...gitlab.sections.keys()]);
  expect([...gitlab.sections.keys()]).toEqual([
    "track",
    "assess",
    "batch",
    "stage",
    "approval",
    "merge",
    "release",
    "record",
  ]);
  // A template naming anything RenovateInput does not give is refused as it is made.
  expect(Object.keys(RENOVATE_ON.github)).toEqual(Object.keys(RENOVATE_ON.gitlab));
});

test("tracking and recording are Linear's, and word for word the same on both forges", () => {
  for (const step of ["track", "record"])
    expect(github.sections.get(step)).toBe(gitlab.sections.get(step));
});

test("RENOVATE is still the GitLab content a fork written before there were two reads", () => {
  expect(RENOVATE).toBe(RENOVATE_ON.gitlab);
  expect(RENOVATE.merge.text).toContain("glab mr approve");
  expect(RENOVATE_ON.github.merge.text).toContain("gh pr merge");
});

test("the batch branch is named outside Renovate Bot's branch prefix on both forges", () => {
  for (const content of [gitlab, github]) {
    const batch = content.sections.get("batch") ?? "";
    expect(batch).toContain("`deps/batch-<YYYY-MM-DD>`");
    expect(batch).toContain("git push -u origin deps/batch-<date>");
    expect(batch).not.toContain("renovate/batch");
  }
});
