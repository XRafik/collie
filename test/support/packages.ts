// Real Bun installs and typechecks, with registry metadata reused between fixtures.
// Copy rather than hardlink: a test may edit an installed package without editing the cache.
export const testBunfig = `[install]
prefer = "offline"
backend = "copyfile"
`;
