# Build notes

- Added `h: 60 * 60 * 1000` to `UNITS` in `src/duration.ts`.
- `parseDuration` now loops over every number and unit in the text.
- Added `formatDuration` to `src/duration.ts`.
- Added `src/timeout.ts` with `Clock` and `deadline`.
- Added tests to `test/duration.test.ts` and `test/timeout.test.ts`.
- Updated `README.md`.
