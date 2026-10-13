import { defineWorkflow } from "collie";
import { Effect } from "effect";

export default defineWorkflow({
  id: "reported",
  closes: "reported",
  run: () => Effect.void,
});
