# Worktree Explorer

Work with git worktrees without leaving the VS Code window you are already in.

`git worktree` is the clean way to have several branches checked out at once, but VS Code
meets it halfway at best. Opening a worktree means a new window, which discards everything
the current one had loaded. Leaving it where it is means `Cmd+P` cannot find its files,
because worktrees typically live outside the workspace or behind a `.gitignore` line.

This extension gives them a home in the current window: a sidebar to browse them, a search
that can actually see them, and git status painted the way the Explorer paints it.

![The Worktrees sidebar listing five worktrees of one repository, told apart by icon into
branch, locked and detached kinds, with two of them opened below as file trees carrying git
status badges, and a file search scoped to one worktree](docs/screenshot.png)

*One repository, five worktrees. The top pane says what each one is: three sit on branches
(blue while opened below), one is locked, one is detached and shows the commit it sits on.
Two are opened underneath as file trees, with status badges on the changed files. The search
is scoped to `dark-mode` through the `@` tag in the input.*

## Install

```bash
git clone https://github.com/dolphin-wood/vscode-worktree-explorer
ln -s "$PWD/vscode-worktree-explorer" ~/.vscode/extensions/vscode-worktree-explorer
```

Restart VS Code once. After that, code changes only need `Cmd+Shift+P` → **Reload Window**.

## The sidebar

The **Worktrees** container in the activity bar has two panes.

**Worktrees** lists every worktree of every git repository under your workspace folders, each
with a `~5 +3 -1` tally of its uncommitted work and its branch. The tally comes before the
branch because descriptions elide from the right, and a long branch name would otherwise push
the part that actually changes out of view. Click a row to open it.

A row's icon says what kind of worktree it is and whether it is usable:

| | Icon | |
|---|---|---|
| on a branch | `git-branch` | blue while opened below |
| detached | `git-commit` | shows the commit it sits on |
| locked | `lock` | `git worktree lock`; refuses pruning |
| stale | `warning` | metadata pruned, files still on disk |
| missing | `error` | registered, but the directory is gone |
| current agent session | any | green, outranking the rest |

Anything abnormal is also spelled out in the row, since a tinted icon at 16px is easy to
miss. Colour here describes the worktree itself; file-level git state lives in the tree below.

**Opened** holds the file trees of the worktrees you opened. Several can be open at once,
and the set is remembered across window reloads. Files open in the current window like any
other file — no new window, nothing reloaded.

It works like the Explorer where it can: multi-select, open to the side, new file and folder,
rename, delete to the trash, copy path and copy relative path. Each opened worktree is watched,
so files an agent or a terminal creates outside this window show up on their own instead of
waiting for a manual refresh.

The tree follows the active editor: switch to a tab and its file is revealed and selected,
the way the Explorer's `autoReveal` does. It only acts while the view is visible, so it never
forces this sidebar open on a tab switch; a file opened while it was hidden is revealed when
you come back to it.

What the tree hides comes from `.gitignore`, read once per worktree with
`git ls-files --ignored` (a fully ignored directory collapses to one entry, so this stays
cheap). A hand-maintained list of directory names would always trail behind the repository's
own ignore rules, and would miss ignored files entirely. `excludeDirs` remains for the few
things git does not ignore.

## Search

`Cmd+Alt+P` (`Ctrl+Alt+P` on Windows and Linux) opens a fuzzy file search over the opened
worktrees.

Type `@` to change the scope: all worktrees, just the opened ones, or a single one. Picking
one leaves an `@name ` tag in the input, and a backspace that reaches the tag deletes it
whole. The current scope is spelled out in the title bar.

Indexing uses `git ls-files`, which is fast and honours `.gitignore` for free — `node_modules`
and build output never reach the results. The index is cached for a minute per worktree.

## Git status

Files carry the same badges and colors the Explorer uses, from the same `gitDecoration.*`
theme keys, so they follow your color theme. Directories are tinted by the most urgent state
anywhere below them: conflict beats deleted beats modified beats renamed beats added beats
untracked.

VS Code's built-in git extension does not decorate worktrees that live outside the workspace,
which is why this extension provides its own decorations. Status is read only for the opened
worktrees — running `git status` across every worktree on every refresh would cost far more
than it is worth. It refreshes on save, on file add and remove, and whenever the window
regains focus, which covers commits you make in a terminal.

## Optional: jump to your coding agent's worktree

Everything above is independent of any coding agent. If you use one that works inside
worktrees, a button in the editor title bar resolves the worktree the active session is in,
opens it, and marks it green.

Implemented for **Claude Code** today. Each session is its own editor tab, and its label is
recorded in the session transcript, so the label identifies the session exactly rather than
by guesswork. That transcript's last `cwd` then locates the worktree, falling back to its
`gitBranch` when `cwd` is still the main checkout — which happens, since an agent may switch
branches without changing directory. Matching no worktree is a real answer, not a failure:
the session is on the main checkout, so it reports that and stops rather than jumping to an
unrelated worktree.

Other agents mostly fit. Codex, for one, records the same `cwd` and `git.branch` in
`~/.codex/sessions/**/rollout-*.jsonl`. What does not carry over is identifying the *active*
session, which here depends on sessions being editor tabs with readable labels; Codex lives
in a chat sidebar, where there is no label to read. The plan is to put detection behind a
small per-agent interface and let each agent identify its active session however its surface
allows. Contributions welcome.

## Settings

| Setting | Default | |
|---|---|---|
| `worktreeExplorer.repoScanDepth` | `2` | Levels below each workspace folder to scan for git repositories |
| `worktreeExplorer.extraWorktreeRoots` | `[]` | Extra repository paths, for repos outside the workspace |
| `worktreeExplorer.includeMainCheckout` | `false` | Also list the main checkout, which is usually already in the Explorer |
| `worktreeExplorer.hideIgnoredFiles` | `true` | Hide what `.gitignore` excludes, matching what search does |
| `worktreeExplorer.excludeDirs` | `[".git"]` | Always hidden, on top of `.gitignore` |
| `worktreeExplorer.useFileIcons` | `true` | Use the file icon theme. Turn off if worktrees ignored by the parent repo appear greyed out |
| `worktreeExplorer.autoReveal` | `true` | Reveal the active editor's file in the tree |
| `worktreeExplorer.showGitStatus` | `true` | Git colors and badges on the file tree |
| `worktreeExplorer.quickOpenMaxFiles` | `20000` | Index cap per worktree |
| `worktreeExplorer.searchScopeFallback` | `all` | Scope used when no worktree is open |
| `worktreeExplorer.showEditorTitleButton` | `true` | The title bar button, shown only on an agent session tab |
| `worktreeExplorer.autoRevealOnStartup` | `false` | Open the active agent session's worktree on startup |
| `worktreeExplorer.claudeHome` | `""` | Claude Code home. Empty means `~/.claude` or `$CLAUDE_CONFIG_DIR` |

## How worktrees are discovered

Every workspace folder is scanned `repoScanDepth` levels down for git repositories, then
`git worktree list` runs once per repository, collapsed by `--git-common-dir` so a repo
reached from several entry points is only asked once.

**The worktrees themselves do not have to be anywhere near your workspace.** git reports them
by absolute path, so finding one repository is enough to find every worktree attached to it —
open just the main checkout and its worktrees are listed even though nothing else is on the
workspace. That is the point: reaching them is exactly what would otherwise cost you a second
window. The layout comes from git rather than a convention imposed here, so `foo.worktrees/*`,
`foo/.claude/worktrees/*` and anything else all work.

Orphan directories left by `git worktree prune` — metadata gone, files still on disk — are
listed as `stale` and indexed by walking the directory rather than asking git, so their
files do not quietly become unreachable.

## Limitations

- Session detection needs the session to be an editor tab. With Claude Code docked in the
  sidebar there is no label to read, so it falls back to the most recent transcript by
  modification time, which may not be the session you are looking at.
- Looking a session up by tab label assumes labels are unique. Two sessions sharing a title
  resolve to the more recently written transcript.

## Development

No build step: plain CommonJS loaded straight by VS Code.

```bash
node src/core.js ~/code   # worktree discovery and session matching, without starting VS Code
```

`src/core.js` holds everything that does not touch the `vscode` module — worktree discovery,
file indexing, git status parsing, session detection — so it can be run and tested on its
own. `extension.js` is the VS Code layer: tree providers, the search UI, decorations,
commands.

## License

MIT
