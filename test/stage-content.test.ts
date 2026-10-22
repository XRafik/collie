import { expect, test } from "bun:test";
import { STAGE_CLEARS, STAGE_ON } from "../workflows/stage.workflow";
import { contentOf } from "../src/sdk";
import onGitlab from "../workflows/stage.gitlab.md" with { type: "text" };
import onGithub from "../workflows/stage.github.md" with { type: "text" };
import releaseOnGitlab from "../workflows/release.gitlab.md" with { type: "text" };
import releaseOnGithub from "../workflows/release.github.md" with { type: "text" };

// stage keeps a content file per forge, as release does (ADR-0050 D1).

const content = { gitlab: contentOf(onGitlab), github: contentOf(onGithub) };
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const URL = "https://gitlab.example.com/group/app";

test("both forges' stage content has the steps the module asks for, and every step fills from what it gives", () => {
  for (const one of Object.values(content))
    expect([...one.sections.keys()]).toEqual(["assess", "stage", "unstage"]);
  // A template naming anything the module does not give is refused as it is made.
  expect(Object.keys(STAGE_ON.github)).toEqual(Object.keys(STAGE_ON.gitlab));
});

test("stage decides package or application by release's own rule, word for word", () => {
  const rule = (markdown: string) =>
    /Decide first whether this repository is a package or an application:[\s\S]*?with the\s+evidence\./.exec(
      markdown,
    )?.[0] ?? "";
  for (const [forge, release] of [
    ["gitlab", releaseOnGitlab],
    ["github", releaseOnGithub],
  ] as const) {
    expect(rule(release)).not.toBe("");
    expect(flat(content[forge].sections.get("assess") ?? "")).toContain(flat(rule(release)));
  }
});

test("each Clearance names the repository's URL", () => {
  for (const [step, clears] of Object.entries(STAGE_CLEARS)) {
    const lines = clears(URL, ["deploy-stage"]);
    expect([step, lines.some((line) => line.includes(URL))]).toEqual([step, true]);
  }
});

test("the stage step is cleared for the jobs it was given, and never a production job", () => {
  const lines = STAGE_CLEARS.stage(URL, ["deploy-stage-spilnu", "deploy-stage-happytiger"]);
  const said = lines.join("; ");
  expect(said).toContain("`deploy-stage-spilnu`, `deploy-stage-happytiger`");
  expect(lines).toContain("never a production job");
  expect(said).not.toMatch(/playing[^;]*production/);
});

test("the content's preamble says what a Stage Run does in staging words", () => {
  for (const markdown of [onGitlab, onGithub]) {
    const preamble = markdown
      .slice(0, markdown.indexOf("\n## "))
      .replaceAll(/(merge|pull) request/gi, "");
    expect(preamble).toContain("for the human to test, unmerged");
    expect(preamble).not.toMatch(/\b(release[sd]?|approv\w*|merges?|merging|Go)\b/i);
  }
});

test("staging deploys the head's own pipeline and rolls back only what it staged, never production", () => {
  for (const one of Object.values(content)) {
    const staging = flat(one.sections.get("stage") ?? "");
    for (const said of [
      "{{head}}",
      "{{stage_jobs}}",
      "Nothing is merged",
      "Roll stage back",
      "only in the",
      "Never play, retry or ask about a production job",
    ])
      expect(staging).toContain(said);
    const unstage = flat(one.sections.get("unstage") ?? "");
    for (const said of ["{{failure}}", "{{head}}", "{{stage_jobs}}", "only in the"])
      expect(unstage).toContain(said);
  }
});
