# CC Worktree Nav

Browse and search the files of your git worktrees **inside the current VS Code window**, and jump straight to the worktree the active Claude Code session is working in.

No new window, so a running Claude Code session is never lost to a reload.

## What it solves

| Problem | How |
|---|---|
| `Cmd+P` cannot find files under a worktree | A separate file index behind its own quick open (`Cmd+Alt+P`). Files come from `git ls-files`, so `.gitignore` is honoured for free and `node_modules` never pollutes the results |
| No explorer for worktrees | A **Worktrees** container in the activity bar: the worktree list on top, file trees of the opened ones below |
| Sessions and worktrees do not line up | The active tab's label pins down the session, then its transcript's `cwd` / `gitBranch` are matched against `git worktree list` |

## Install

```bash
ln -s "$PWD" ~/.vscode/extensions/cc-worktree-nav
# restart VS Code once; after that, code changes only need Cmd+Shift+P -> Reload Window
```

## Usage

- **Worktrees icon in the activity bar** — pick a worktree from the list to open its file tree below. Several can be open at once; the set survives a window reload.
- **`Cmd+Alt+P`** — fuzzy search across the opened worktrees. Type `@` to switch scope: all worktrees, just the opened ones, or a single one. Choosing one leaves an `@name ` tag in the box, and a backspace that touches the tag removes it whole.
- **The editor title bar button** (only shown on a Claude Code session tab) — resolves the worktree of that session, opens it in the sidebar and marks it green.

Git status is painted onto the file tree the way the Explorer does it — badges and colors from the same `gitDecoration.*` theme keys, directories tinted by the most urgent state below them, and a `~5 +3 -1` tally on each worktree row. The built-in git extension does not decorate worktrees living outside the workspace, hence the extension's own decoration provider. Status is read only for opened worktrees, and refreshes on save, on file add/remove, and whenever the window regains focus (which covers commits made in a terminal).

## How worktrees are discovered

Each workspace folder is scanned `repoScanDepth` levels down (2 by default) for git repositories, then `git worktree list` runs once per repository. Both the `foo.worktrees/*` and `foo/.claude/worktrees/*` layouts are therefore covered.

Orphan directories left behind by `git worktree prune` — the metadata is gone but the files are still on disk — are listed as `stale` and indexed by walking the directory instead of asking git, so those files do not become unreachable.

## How a session is matched to a worktree

Two steps.

**Which session.** A Claude Code session tab's label is written into its transcript as `customTitle` (when renamed by hand) or `aiTitle` (auto-generated, present on every session). Reading the active tab's label and looking it up therefore identifies exactly one session, rather than guessing at "the most recent one". A prefix match covers labels elided in the UI.

Only when the active tab is not a session tab — Claude docked in the sidebar, for instance — does it fall back to the most recently active transcript by mtime.

**Where that session is.** Walk that transcript backwards to the last record carrying `cwd`, then:

1. `cwd` falls inside a worktree → matched. The deepest match wins, since `.claude/worktrees/x` also sits inside the main checkout.
2. Otherwise match `gitBranch` against each worktree's branch. Claude working inside a worktree may still report the main checkout as `cwd`, with only the branch changed, so this second channel is load-bearing.

**Once a tab label has pinned a session down, that result stands.** Matching no worktree is a meaningful answer — the session is on the main checkout — and it reports that and stops. Falling through to some other session is exactly how you end up jumping to a worktree that has nothing to do with the tab in front of you.

## Known limits

- With Claude docked in the sidebar rather than an editor tab there is no tab label to read, so detection falls back to mtime and may not pick the session you are looking at.
- Looking a session up by tab label assumes labels are unique. Two sessions sharing a title resolve to the more recent transcript.
- The file tree browses and opens. It does not create, rename or delete.

## Debugging

```bash
node src/core.js ~/code   # worktree discovery and session matching, without starting VS Code
```

## License

MIT
