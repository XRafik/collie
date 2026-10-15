import { Schema } from "effect";
import type { Ran } from "../mr";

export const Issue = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
});
export type Issue = typeof Issue.Type;
export interface IssueRef {
  readonly number: number;
  readonly url: string;
}
export type IssueList =
  | { readonly ok: true; readonly issues: ReadonlyArray<Issue> }
  | { readonly ok: false; readonly reason: string };
export type FiledIssue =
  | ({ readonly ok: true } & IssueRef)
  | { readonly ok: false; readonly reason: string };

export function filedIssueOf(answer: Ran, project: string, gitlab: boolean): FiledIssue {
  if (answer.code !== 0)
    return { ok: false, reason: answer.stderr || answer.stdout || "issue creation failed" };
  const prefix = `https://${project}/${gitlab ? "-/issues" : "issues"}/`;
  for (const url of answer.stdout.trim().split(/\s+/)) {
    if (!url.startsWith(prefix)) continue;
    const number = url.slice(prefix.length);
    if (/^[1-9]\d*$/.test(number) && Number.isSafeInteger(Number(number)))
      return { ok: true, number: Number(number), url };
  }
  return {
    ok: false,
    reason: "issue creation returned no issue URL; inspect the repository before retrying",
  };
}
