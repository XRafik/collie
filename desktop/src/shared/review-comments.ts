// A Run's Review comment drafts, what each is about, and the one message they are sent as
// (ADR-0051). No Bun-only import: the view bundles this.

/** A span of a plan file, by its path in the plan directory, quoted as selected. */
export interface PlanAnchor {
  readonly _tag: "Plan";
  readonly file: string;
  readonly quote: string;
}

export type Anchor = PlanAnchor;

export interface Draft {
  readonly id: string;
  readonly anchor: Anchor;
  readonly text: string;
}

export const addDraft = (drafts: ReadonlyArray<Draft>, draft: Draft): Draft[] => [...drafts, draft];

export const editDraft = (drafts: ReadonlyArray<Draft>, id: string, text: string): Draft[] =>
  drafts.map((draft) => (draft.id === id ? { ...draft, text } : draft));

export const removeDraft = (drafts: ReadonlyArray<Draft>, id: string): Draft[] =>
  drafts.filter((draft) => draft.id !== id);

/** What is left once the drafts `sent` carried have gone. */
export const clearSent = (drafts: ReadonlyArray<Draft>, sent: ReadonlySet<string>): Draft[] =>
  drafts.filter((draft) => !sent.has(draft.id));

/** A selection in a plan file as an anchor; null for one with nothing but whitespace. */
export const planAnchor = (file: string, selected: string): PlanAnchor | null =>
  selected.trim() === "" ? null : { _tag: "Plan", file, quote: selected };

const QUOTE_MAX = 300;

/** The quote as `>` lines, a long one kept to its start and end. */
const quoted = (quote: string) => {
  const head = Math.ceil((QUOTE_MAX - 1) / 2);
  const cut =
    quote.length <= QUOTE_MAX
      ? quote
      : `${quote.slice(0, head)}…${quote.slice(quote.length - (QUOTE_MAX - 1 - head))}`;
  return cut
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
};

export const locationOf = (anchor: Anchor) => `the plan's \`${anchor.file}\``;

/** Every draft, in the order written, as one message whose comments are as the human wrote them. */
export const compose = (drafts: ReadonlyArray<Draft>) => {
  const count = `${drafts.length} review comment${drafts.length === 1 ? "" : "s"}`;
  const items = drafts.map(
    (draft, at) =>
      `${at + 1}. ${locationOf(draft.anchor)}\n${quoted(draft.anchor.quote)}\n\n${draft.text}`,
  );
  return [
    `${count} from the human in Desktop. Each names where it is, quotes what it is about, then says what they want.`,
    ...items,
  ].join("\n\n");
};
