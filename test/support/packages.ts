// Real Bun installs and typechecks, with registry metadata reused between fixtures.
// Bun may hardlink installed files to this cache; detach a file before a fixture edits it.
export const testBunfig = `[install]
prefer = "offline"
`;
