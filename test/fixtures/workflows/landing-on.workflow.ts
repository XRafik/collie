// A fork that keeps the shipped landing's words for whichever forge its repository is on,
// and adds one rule of its own to the merge: `at.forge` chooses the content.

import { agentWork, defineWorkflow, template } from "collie";
import {
  Merged,
  RENOVATE_ON,
  RenovateInput,
  asRenovator,
  renovation,
  shippedLanding,
  type Landing,
} from "./renovate.workflow.ts";

const squashed = {
  gitlab: template(
    `${RENOVATE_ON.gitlab.merge.text}\n\nHere, squash every merge.`,
    RenovateInput.fields,
  ),
  github: template(
    `${RENOVATE_ON.github.merge.text}\n\nHere, squash every merge.`,
    RenovateInput.fields,
  ),
};

const landing: Landing = {
  ...shippedLanding,
  merge: (at) =>
    agentWork({ ...asRenovator(at, "merge"), instructions: squashed[at.forge], output: Merged }),
};

export default defineWorkflow({
  ...renovation(landing),
  id: "landing-on",
  title: "landing-on — the month's updates, squashed on whichever forge",
  description: "The shipped renovation with every merge squashed, on GitLab or GitHub.",
});
