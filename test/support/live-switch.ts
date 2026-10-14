// Whether a run asked for the tests that talk to an installed harness. Its own module, so
// the suite runner can drop it without loading `bun:test`.

/** Set to `1` by `bun run test:live`; `bun run test` never passes it on. */
export const LIVE_HARNESSES = "COLLIE_LIVE_HARNESSES";
