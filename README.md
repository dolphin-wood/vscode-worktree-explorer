# CC Worktree Nav

在**当前 VSCode 窗口内**浏览、搜索 git worktree 的文件，并一键定位当前 Claude Code session 所在的 worktree。

不新开窗口 → 不会丢掉正在跑的 CC session。

## 解决的三个问题

| 问题 | 做法 |
|---|---|
| worktree 下的文件 `Cmd+P` 搜不到 | 独立的文件索引 + QuickPick（`Cmd+Alt+P`），用 `git ls-files` 取文件，天然跳过 gitignore 的 `node_modules` 等 |
| 没有能浏览 worktree 的资源管理器 | 活动栏里的 **Worktrees** 面板：worktree 列表 → 展开即文件树，点文件直接打开 |
| CC session 和 worktree 对不上 | 用活跃 tab 的标题锁定 session，再读它 transcript 里的 `cwd` / `gitBranch`，与 `git worktree list` 双通道匹配 |

## 安装（本地开发版）

```bash
ln -s "$PWD" ~/.vscode/extensions/cc-worktree-nav
# 然后重启 VSCode（之后改代码只需 Cmd+Shift+P → Reload Window）
```

## 用法

- **活动栏 Worktrees 图标** — 打开面板，浏览所有 worktree 的文件树
- **`Cmd+Alt+P`** — 跨所有 worktree 快速打开文件（右键单个 worktree 可只搜它）
- **编辑器右上角按钮**（只在 Claude session tab 上出现）— 定位当前 Claude session 的 worktree，并在侧栏展开选中；命中的那个 worktree 图标会变绿

worktree 的发现方式：对每个 workspace folder 向下扫 `repoScanDepth`（默认 2）层找 git 仓库，再对每个仓库跑 `git worktree list`。所以 `foo.worktrees/*` 和 `foo/.claude/worktrees/*` 两种布局都能覆盖。

被 `git worktree prune` 掉、但目录和文件还在的孤儿 worktree 会标为 `stale` 一并列出（用目录遍历而非 git 来索引），免得那些文件彻底找不到。

## Session → worktree 是怎么匹配的

分两步。

**第一步：确定是哪个 session。** Claude Code 的会话 tab，它的 label 会写进 transcript 的 `customTitle`（你手动重命名的名字）或 `aiTitle`（没改过时自动生成的）。所以读活跃 tab 的 label，反查 transcript 就能唯一锁定 session —— 而不是猜「最近活跃的那个」。tab 标题在 UI 里被截断时有前缀匹配兜底。

只有当活跃 tab 不是 CC 会话 tab 时（比如 CC 开在侧栏），才退回按 transcript mtime 取最近活跃的 session。

**第二步：确定 session 在哪。** 从该 transcript 尾部往前找最后一条带 `cwd` 的记录，然后：

1. `cwd` 落在某个 worktree 目录内 → 命中（多个匹配取最深的，因为 `.claude/worktrees/x` 同时也在主 checkout 内）
2. 否则拿 `gitBranch` 去对 worktree 的分支 —— CC 在 worktree 里干活时 `cwd` 有可能还是主 checkout，只有分支变了，所以这条通道是必要的

**一旦靠 tab 标题锁定了 session，就认这一个结果。** 匹配不到 worktree 是有意义的结论（说明这个 session 在主 checkout），此时提示「在主 checkout xxx，分支 yyy」并停下，绝不继续往下找别的 session —— 否则就会跳到一个跟当前 tab 毫无关系的 worktree 去。

## 已知边界

- CC 开在**侧栏**而不是编辑器 tab 时，拿不到 tab 标题，只能退回按 mtime 取最近活跃的 session —— 多个 session 并行时可能不是你正在看的那个。
- 靠 tab 标题反查 session 依赖标题唯一。两个 session 起了同名标题时，取 mtime 较新的那个。
- 文件树是只读浏览 + 打开，没有新建/重命名/删除。

## 调试

```bash
node src/core.js ~/Projects   # 不启动 VSCode，直接看 worktree 发现和 session 匹配结果
```
