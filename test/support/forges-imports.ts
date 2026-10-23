// ADR-draft-a-forge-is-asked-over-http-with-its-clis-login D1: only `src/forge/` imports `forges`.

/** `from "forges…"` or `import("forges…")`, of the package or any of its subpaths. */
const IMPORTS = /(?:\bfrom\s*|\bimport\s*\(\s*)["']forges(?:\/[^"']*)?["']/;

/** Each file, by its text, that imports `forges` outside the forge directory. */
export const forgesImportsIn = (files: ReadonlyMap<string, string>) =>
  [...files]
    .filter(([file, text]) => !file.startsWith("src/forge/") && IMPORTS.test(text))
    .map(([file]) => `${file} imports forges`);
