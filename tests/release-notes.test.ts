import assert from "node:assert/strict";
import test from "node:test";

import { extractReleaseNotes, normalizeVersion } from "../.github/scripts/extract-release-notes.mjs";

test("normalizeVersion accepts v-prefixed tags", () => {
  assert.equal(normalizeVersion("v0.1.1"), "0.1.1");
});

test("extractReleaseNotes returns only the requested changelog section", () => {
  const changelog = `
# Changelog

## Unreleased

## 0.1.1 - 2026-05-26

- Fixed thumbnails.
- Improved release notes.

## 0.1.0 - 2026-05-26

- Initial release.
`;

  assert.equal(
    extractReleaseNotes(changelog, "v0.1.1"),
    `## 0.1.1 - 2026-05-26

- Fixed thumbnails.
- Improved release notes.
`,
  );
});

test("extractReleaseNotes fails when a version section is missing", () => {
  assert.throws(
    () => extractReleaseNotes("# Changelog\n\n## 0.1.0\n\n- Initial release.\n", "0.1.1"),
    /does not contain a section for 0\.1\.1/,
  );
});
