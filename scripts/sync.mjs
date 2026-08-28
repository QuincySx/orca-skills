#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "stablyai";
const REPOSITORY = "orca";
const BRANCH = "main";
const API_ROOT = "https://api.github.com";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const STATE_FILE = path.join(REPO_ROOT, "UPSTREAM.json");
const SKILL_FILE_PATTERN = /^([a-z0-9][a-z0-9-]*)\/SKILL\.md$/;
const SKILL_DIR_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const LINEAR_SKILLS = new Set(["linear-tickets/SKILL.md", "orca-linear/SKILL.md"]);

function fail(code, message, next) {
  const suffix = next ? ` Next: ${next}` : "";
  throw new Error(`[${code}] ${message}${suffix}`);
}

async function github(pathname) {
  const response = await fetch(`${API_ROOT}${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "orca-skills-sync",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    fail(
      "GITHUB_API",
      `${response.status} ${response.statusText} for ${pathname}.`,
      "Retry later or inspect GitHub API availability.",
    );
  }
  return response.json();
}

export function validateTree(entries) {
  const directories = new Set();
  const blobs = [];

  for (const entry of entries) {
    if (entry.type === "tree" && SKILL_DIR_PATTERN.test(entry.path)) {
      directories.add(entry.path);
      continue;
    }
    if (entry.type === "blob" && SKILL_FILE_PATTERN.test(entry.path)) {
      blobs.push(entry);
      continue;
    }
    fail(
      "UNEXPECTED_UPSTREAM_ENTRY",
      `Refusing upstream ${entry.type} at skills/${entry.path}.`,
      "Review the new upstream layout before expanding the mirror allowlist.",
    );
  }

  if (blobs.length === 0) {
    fail("EMPTY_SKILLS_TREE", "Upstream skills tree contains no SKILL.md files.");
  }

  const filesByDirectory = new Set(blobs.map((entry) => entry.path.split("/")[0]));
  for (const directory of directories) {
    if (!filesByDirectory.has(directory)) {
      fail(
        "EMPTY_SKILL_DIRECTORY",
        `Upstream skills/${directory} has no SKILL.md.`,
        "Review the upstream change manually.",
      );
    }
  }
  for (const directory of filesByDirectory) {
    if (!directories.has(directory)) {
      fail("MISSING_TREE_ENTRY", `Missing tree entry for skills/${directory}.`);
    }
  }

  return blobs.sort((left, right) => left.path.localeCompare(right.path));
}

export function normalizeSkill(relativePath, content) {
  if (!LINEAR_SKILLS.has(relativePath)) return content;
  return content.replaceAll("<pr-or-mr-url>", "PR_OR_MR_URL");
}

function descriptionText(frontmatter) {
  const lines = frontmatter.split("\n");
  const index = lines.findIndex((line) => line.startsWith("description:"));
  if (index === -1) return null;
  const firstValue = lines[index].slice("description:".length).trim();
  if (!/^>[+-]?$/.test(firstValue)) return firstValue;

  const body = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s/.test(line)) break;
    body.push(line.trim());
  }
  return body.join(" ");
}

export function validateSkill(relativePath, content) {
  const pathMatch = relativePath.match(SKILL_FILE_PATTERN);
  if (!pathMatch) fail("INVALID_SKILL_PATH", `Invalid mirrored path: ${relativePath}.`);
  if (content.includes("\0")) fail("BINARY_SKILL", `NUL byte found in ${relativePath}.`);

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!frontmatterMatch) {
    fail("INVALID_FRONTMATTER", `${relativePath} has no YAML frontmatter.`);
  }
  const frontmatter = frontmatterMatch[1];
  const name = frontmatter.match(/^name:\s*([^\s]+)\s*$/m)?.[1];
  if (name !== pathMatch[1]) {
    fail(
      "SKILL_NAME_MISMATCH",
      `${relativePath} declares name ${JSON.stringify(name)} instead of ${pathMatch[1]}.`,
    );
  }
  const description = descriptionText(frontmatter);
  if (!description) fail("MISSING_DESCRIPTION", `${relativePath} has no description.`);
  if (description.includes("<") || description.includes(">")) {
    fail(
      "UNSUPPORTED_DESCRIPTION",
      `${relativePath} contains angle brackets in its description.`,
      "Review and add a narrow compatibility normalization if intentional.",
    );
  }
}

async function fetchSnapshot() {
  const commit = await github(`/repos/${OWNER}/${REPOSITORY}/commits/${BRANCH}`);
  const rootTree = await github(
    `/repos/${OWNER}/${REPOSITORY}/git/trees/${commit.commit.tree.sha}`,
  );
  const skillsEntry = rootTree.tree.find(
    (entry) => entry.path === "skills" && entry.type === "tree",
  );
  if (!skillsEntry) {
    fail("MISSING_SKILLS_TREE", "Upstream repository has no skills directory.");
  }

  const skillsTree = await github(
    `/repos/${OWNER}/${REPOSITORY}/git/trees/${skillsEntry.sha}?recursive=1`,
  );
  if (skillsTree.truncated) {
    fail(
      "TRUNCATED_TREE",
      "GitHub truncated the upstream skills tree.",
      "Do not sync until the tree can be enumerated completely.",
    );
  }

  const files = new Map();
  for (const entry of validateTree(skillsTree.tree)) {
    const blob = await github(`/repos/${OWNER}/${REPOSITORY}/git/blobs/${entry.sha}`);
    if (blob.encoding !== "base64") {
      fail("UNSUPPORTED_BLOB", `Unsupported encoding for skills/${entry.path}.`);
    }
    const decoded = Buffer.from(blob.content.replaceAll("\n", ""), "base64").toString(
      "utf8",
    );
    const normalized = normalizeSkill(entry.path, decoded);
    validateSkill(entry.path, normalized);
    files.set(entry.path, normalized);
  }

  return { commit: commit.sha, skillsTree: skillsEntry.sha, files };
}

async function readCurrentSkills() {
  const files = new Map();
  let directories;
  try {
    directories = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }

  for (const directory of directories) {
    if (!directory.isDirectory() || !SKILL_DIR_PATTERN.test(directory.name)) {
      fail(
        "UNEXPECTED_LOCAL_ENTRY",
        `Refusing local skills/${directory.name}.`,
        "Move unrelated files out of the mirrored skills directory.",
      );
    }
    const skillDirectory = path.join(SKILLS_DIR, directory.name);
    const entries = await fs.readdir(skillDirectory, { withFileTypes: true });
    if (
      entries.length !== 1 ||
      entries[0].name !== "SKILL.md" ||
      !entries[0].isFile()
    ) {
      fail(
        "UNEXPECTED_LOCAL_SKILL_CONTENT",
        `Refusing to replace skills/${directory.name}; it does not contain only SKILL.md.`,
        "Review or relocate the extra local content first.",
      );
    }
    const relativePath = `${directory.name}/SKILL.md`;
    const content = await fs.readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
    files.set(relativePath, content);
  }

  return files;
}

function compareFiles(current, upstream) {
  const changes = { added: [], changed: [], removed: [] };
  for (const [relativePath, content] of upstream) {
    if (!current.has(relativePath)) changes.added.push(relativePath);
    else if (current.get(relativePath) !== content) changes.changed.push(relativePath);
  }
  for (const relativePath of current.keys()) {
    if (!upstream.has(relativePath)) changes.removed.push(relativePath);
  }
  return changes;
}

async function writeSnapshot(snapshot, changes) {
  for (const relativePath of changes.removed) {
    await fs.rm(path.join(SKILLS_DIR, path.dirname(relativePath)), { recursive: true });
  }
  for (const relativePath of [...changes.added, ...changes.changed]) {
    const destination = path.join(SKILLS_DIR, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}`;
    await fs.writeFile(temporary, snapshot.files.get(relativePath), "utf8");
    await fs.rename(temporary, destination);
  }

  const state = {
    repository: `https://github.com/${OWNER}/${REPOSITORY}`,
    branch: BRANCH,
    commit: snapshot.commit,
    skillsTree: snapshot.skillsTree,
    syncedAt: new Date().toISOString().slice(0, 10),
  };
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const snapshot = await fetchSnapshot();
  const current = await readCurrentSkills();
  const changes = compareFiles(current, snapshot.files);
  const changedCount = changes.added.length + changes.changed.length + changes.removed.length;

  console.log(
    `[orca-skills-sync] upstream=${snapshot.commit} tree=${snapshot.skillsTree} skills=${snapshot.files.size}`,
  );
  if (changedCount === 0) {
    console.log("[orca-skills-sync] status=unchanged");
    return;
  }

  const summary =
    `added=${changes.added.length} changed=${changes.changed.length} removed=${changes.removed.length}`;
  if (checkOnly) {
    console.log(`[orca-skills-sync] status=update-available ${summary}`);
    process.exitCode = 2;
    return;
  }

  await writeSnapshot(snapshot, changes);
  console.log(`[orca-skills-sync] status=updated ${summary}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[orca-skills-sync] ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
