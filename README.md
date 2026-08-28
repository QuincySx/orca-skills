# Orca Skills

A lightweight mirror of the installable skills from [stablyai/orca](https://github.com/stablyai/orca).

This repository intentionally contains only the upstream `skills/` tree. Orca's application
source, build outputs, dependencies, and version-matched long-form guides are excluded so
skill hosting and installation tools do not need to process the upstream repository's full
file set.

## Upstream snapshot

- Repository: `stablyai/orca`
- Branch: `main`
- Snapshot source commit, skills tree, and sync date: [`UPSTREAM.json`](UPSTREAM.json)

Six mirrored `SKILL.md` files are byte-for-byte identical to upstream. In `linear-tickets`
and `orca-linear`, the angle-bracket URL placeholder in the frontmatter description is
spelled `PR_OR_MR_URL` so current Codex Skill validation accepts it; runtime instructions
are unchanged. Complete runtime guides are served by the matching Orca binary through
`orca skills get <skill-name>`, as documented in each skill.

## Sync

Run the dependency-free Node.js sync command from the repository root:

```sh
node scripts/sync.mjs
```

The sync reads only the upstream GitHub `skills` tree. It accepts exactly one
`SKILL.md` per skill directory and stops on scripts, links, submodules, nested files, or
other unexpected entries. It never clones or executes the upstream repository. Run the
tests with `node --test scripts/sync.test.mjs`.

GitHub Actions runs this sync every Monday at 09:00 Asia/Taipei and can also be started
manually. When validated Skill content changes, the workflow commits only `skills/` and
`UPSTREAM.json` back to `main` as `github-actions[bot]`.
