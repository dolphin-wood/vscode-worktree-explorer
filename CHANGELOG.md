# Changelog

## 0.1.0

First release.

- Two-pane sidebar: every worktree of every repository under the workspace, and file trees
  for the ones you open. Icons distinguish branch, detached, locked, stale and missing.
- Fuzzy file search across worktrees, scoped with an `@worktree` tag. Indexed through
  `git ls-files`, so `.gitignore` is honoured.
- Git status on the file tree, using the Explorer's own theme colours, refreshed on save,
  on file changes, and when the window regains focus.
- Reveals the worktree of the active Claude Code session from the editor title bar.
