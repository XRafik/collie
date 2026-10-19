// Answers in flight and drafts, shared by every card and dialog for as long as Desktop runs.

import { shallowRef } from "vue";
import type { Question } from "../../../../src/board-model";
import type { DesktopAction } from "../../../src/shared/flock";
import {
  type Answering,
  answerKey,
  answerSent,
  answersSettled,
  answerTried,
  draftTyped,
  nothingAnswered,
} from "../../../src/shared/pending-answer";

const state = shallowRef<Answering>(nothingAnswered);
let sends = 0;

export const useAnswering = () => ({
  state,
  /** Sends one answer through `act`, under a request of its own. */
  answer: (
    installation: string,
    machine: string,
    question: Question,
    value: string,
    shown: string,
    act: (action: DesktopAction, tried: (done: boolean | null) => void) => Promise<boolean>,
  ) => {
    const key = answerKey(installation, question.run, question.id);
    const sent = { shown, machine, send: ++sends };
    state.value = answerSent(state.value, key, sent);
    return act(
      { _tag: "Answer", runId: question.run, decision: question.id, value },
      (done) => (state.value = answerTried(state.value, key, sent, done)),
    );
  },
  type: (key: string, text: string) => (state.value = draftTyped(state.value, key, text)),
  settle: (card: string, installation: string, open: ReadonlyArray<Question>) =>
    (state.value = answersSettled(state.value, card, installation, open)),
});
