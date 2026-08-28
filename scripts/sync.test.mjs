import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSkill, validateSkill, validateTree } from "./sync.mjs";

const validSkill = (name) =>
  `---\nname: ${name}\ndescription: Use ${name}.\n---\n\n# ${name}\n`;

test("accepts one SKILL.md per upstream skill directory", () => {
  const entries = [
    { path: "orca-cli", type: "tree" },
    { path: "orca-cli/SKILL.md", type: "blob", sha: "abc" },
  ];
  assert.deepEqual(validateTree(entries), [entries[1]]);
});

test("rejects scripts and other unexpected upstream entries", () => {
  assert.throws(
    () =>
      validateTree([
        { path: "orca-cli", type: "tree" },
        { path: "orca-cli/SKILL.md", type: "blob" },
        { path: "orca-cli/scripts/run.sh", type: "blob" },
      ]),
    /UNEXPECTED_UPSTREAM_ENTRY/,
  );
});

test("rejects links and submodules", () => {
  assert.throws(
    () => validateTree([{ path: "orca-cli", type: "commit" }]),
    /UNEXPECTED_UPSTREAM_ENTRY/,
  );
});

test("normalizes only the known Linear URL placeholder", () => {
  const source = validSkill("orca-linear").replace("Use", "Use <pr-or-mr-url> with");
  assert.match(normalizeSkill("orca-linear/SKILL.md", source), /PR_OR_MR_URL/);
  assert.match(normalizeSkill("orca-cli/SKILL.md", source), /<pr-or-mr-url>/);
});

test("requires the frontmatter name to match the directory", () => {
  assert.throws(
    () => validateSkill("orca-cli/SKILL.md", validSkill("other-skill")),
    /SKILL_NAME_MISMATCH/,
  );
});

test("rejects angle brackets in a description", () => {
  assert.throws(
    () =>
      validateSkill(
        "orca-cli/SKILL.md",
        validSkill("orca-cli").replace("Use", "Use <placeholder> for"),
      ),
    /UNSUPPORTED_DESCRIPTION/,
  );
});

test("accepts a normalized matching skill", () => {
  assert.doesNotThrow(() =>
    validateSkill("orca-linear/SKILL.md", validSkill("orca-linear")),
  );
});
