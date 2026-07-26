/**
 * Single source of truth for the package version inside `src/`.
 *
 * Kept in sync with `version` in `package.json`. We don't import the JSON at
 * build time so the strict tsconfig (no `resolveJsonModule`) can stay untouched
 * and the bundled output stays dependency-light.
 */
export const VERSION = '0.1.0';
