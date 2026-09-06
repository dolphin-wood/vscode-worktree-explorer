'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const core = require('./src/core');

const CONTAINER_CMD = 'workbench.view.extension.worktreeExplorer';
const INDEX_TTL_MS = 60_000;
const MAX_PICK_ITEMS = 300;
const OPENED_KEY = 'worktreeExplorer.openedWorktrees';

const cfg = () => vscode.workspace.getConfiguration('worktreeExplorer');

// ---------------------------------------------------------------- fuzzy

/** Subsequence score: consecutive hits, word starts, and hits inside the basename all weigh more. */
function fuzzyScore(query, target, baseStart = 0) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0, ti = 0, streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const hit = t.indexOf(q[qi], ti);
    if (hit === -1) return -1;
    if (hit === ti && qi > 0) { streak++; score += 6 + streak * 2; } else { streak = 0; score += 1; }
    const prev = hit > 0 ? target[hit - 1] : '/';
    if (prev === '/' || prev === '-' || prev === '_' || prev === '.') score += 5;
    if (hit >= baseStart) score += 3;
    ti = hit + 1;
  }
  return score - Math.floor((target.length - query.length) / 12);
}

// ---------------------------------------------------------------- shared state

class Store {
  constructor(context) {
    this.context = context;
    this.all = [];
    this.loading = null;
    this.opened = context.workspaceState.get(OPENED_KEY, []);
    this.activePath = null;
    this._emitter = new vscode.EventEmitter();
    this.onChange = this._emitter.event;
    this._onStructural = new vscode.EventEmitter();
    this.onStructural = this._onStructural.event;
  }

  fire() { this._emitter.fire(); }

  scopeRoots() {
    const folders = (vscode.workspace.workspaceFolders || [])
      .filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    return [...folders, ...(cfg().get('extraWorktreeRoots') || [])];
  }

  /**
   * Caches every worktree including the main checkout; the view filters by config when rendering.
   * Detection needs the main checkout present to be able to say "this session is not in a worktree".
   */
  async load() {
    if (this.all.length) return this.all;
    if (!this.loading) {
      this.loading = (async () => {
        const repos = core.discoverRepos(this.scopeRoots(), {
          maxDepth: cfg().get('repoScanDepth') || 2,
        });
        this.all = await core.listWorktrees(repos, { includeMainCheckout: true });
        return this.all;
      })();
    }
    return this.loading;
  }

  visible() {
    return cfg().get('includeMainCheckout') === true ? this.all : this.all.filter((w) => !w.isMain);
  }

  openedWorktrees() {
    return this.opened.map((p) => this.all.find((w) => w.path === p)).filter(Boolean);
  }

  isOpen(p) { return this.opened.includes(p); }

  openWt(p) {
    if (!this.opened.includes(p)) this.opened = [...this.opened, p];
    this.persist();
  }

  closeWt(p) { this.opened = this.opened.filter((x) => x !== p); this.persist(); }
  closeAll() { this.opened = []; this.persist(); }

  persist() {
    this.context.workspaceState.update(OPENED_KEY, this.opened);
    vscode.commands.executeCommand('setContext', 'worktreeExplorer.hasOpened', this.opened.length > 0);
    this.fire();
  }

  setActive(p) { this.activePath = p; this.fire(); }

  refresh() {
    this.all = [];
    this.loading = null;
    this._onStructural.fire();
    this.fire();
  }
}

// ---------------------------------------------------------------- top view: worktree list

class ListProvider {
  constructor(store) {
    this.store = store;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    store.onChange(() => this._emitter.fire());
  }

  async getChildren(el) {
    if (el) return [];
    await this.store.load();
    return this.store.visible();
  }

  getParent() { return undefined; }

  getTreeItem(wt) {
    const item = new vscode.TreeItem(wt.name, vscode.TreeItemCollapsibleState.None);
    item.id = `wt:${wt.path}`;
    const multiRepo = new Set(this.store.visible().filter((w) => !w.isMain).map((w) => w.repoName)).size > 1;
    const branch = wt.stale ? 'stale (pruned)'
      : wt.branch || `(detached ${String(wt.head || '').slice(0, 7)})`;
    const isActive = wt.path === this.store.activePath;
    const isOpen = this.store.isOpen(wt.path);

    item.description = [
      isOpen ? '●' : null,
      branch,
      this.store.git ? this.store.git.summaryText(wt.path) : null,
      multiRepo ? `— ${wt.repoName}` : null,
    ].filter(Boolean).join(' ');
    item.contextValue = 'wtxListItem';
    item.iconPath = new vscode.ThemeIcon(
      wt.stale ? 'warning' : wt.isMain ? 'repo' : 'git-branch',
      isActive ? new vscode.ThemeColor('charts.green') : undefined,
    );
    item.tooltip = new vscode.MarkdownString([
      `**${wt.name}**${isActive ? '  \u00b7  \u27f5 current Claude session' : ''}`,
      '',
      `Branch: \`${wt.branch || '(detached)'}\``,
      `Repo: \`${wt.repoName}\``,
      `Path: \`${wt.path}\``,
      wt.stale ? '\n\u26a0\ufe0f Git metadata was pruned; browsable as a plain directory only.' : '',
    ].filter(Boolean).join('\n'));
    item.command = { command: 'worktreeExplorer.openWorktree', title: 'Open', arguments: [wt] };
    return item;
  }
}

// ---------------------------------------------------------------- bottom view: files of opened worktrees

class Node {
  constructor(kind, filePath, wt, parent) {
    this.kind = kind;         // 'worktree' | 'dir' | 'file'
    this.path = filePath;
    this.wt = wt;
    this.parent = parent;
    this.label = path.basename(filePath);
  }
}

class FilesProvider {
  constructor(store) {
    this.store = store;
    this.nodes = new Map();
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    // Note: the node cache is deliberately NOT cleared here. A repaint (a git-status tally
    // changing, say) must reuse the same node objects, otherwise the TreeView cannot match
    // elements across the refresh and every expanded folder collapses.
    store.onChange(() => this._emitter.fire());
    store.onStructural(() => this.nodes.clear());
  }

  node(kind, filePath, wt, parent) {
    const key = `${kind}:${filePath}`;
    let n = this.nodes.get(key);
    if (!n) {
      n = new Node(kind, filePath, wt, parent);
      this.nodes.set(key, n);
    } else {
      if (wt) n.wt = wt;                       // worktree objects are rebuilt on a full refresh
      if (parent !== undefined) n.parent = parent;
    }
    return n;
  }

  async getChildren(node) {
    if (!node) {
      await this.store.load();
      return this.store.openedWorktrees().map((wt) => this.node('worktree', wt.path, wt, undefined));
    }
    if (node.kind === 'file') return [];
    const excludeDirs = cfg().get('excludeDirs') || ['.git'];
    const ignored = cfg().get('hideIgnoredFiles') === false ? null : await getIgnored(node.wt);
    return core.readDirEntries(node.path, { excludeDirs, ignored, root: node.wt.path })
      .map((e) => this.node(e.isDir ? 'dir' : 'file', e.path, node.wt, node));
  }

  getParent(node) { return node.parent; }

  getTreeItem(node) {
    if (node.kind === 'worktree') {
      const wt = node.wt;
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `root:${node.path}`;
      item.description = [
        wt.stale ? 'stale' : wt.branch || '(detached)',
        this.store.git ? this.store.git.summaryText(wt.path) : null,
      ].filter(Boolean).join('  ');
      item.contextValue = 'wtxOpenedRoot';
      item.iconPath = new vscode.ThemeIcon(
        'root-folder',
        wt.path === this.store.activePath ? new vscode.ThemeColor('charts.green') : undefined,
      );
      item.tooltip = wt.path;
      return item;
    }
    const isDir = node.kind === 'dir';
    const item = new vscode.TreeItem(
      node.label,
      isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${node.kind}:${node.path}`;
    item.resourceUri = vscode.Uri.file(node.path); // decorations are keyed off this
    if (cfg().get('useFileIcons') === false) {
      item.iconPath = isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }
    item.contextValue = isDir ? 'wtxDir' : 'wtxFile';
    item.tooltip = node.path;
    if (!isDir) item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.path)] };
    return item;
  }

  nodeFor(wt) { return this.node('worktree', wt.path, wt, undefined); }

  /**
   * Build the node chain from an opened worktree root down to fsPath, creating the
   * intermediate nodes as it goes. TreeView.reveal walks getParent to the root, so every
   * ancestor has to exist as a node before the leaf can be revealed.
   */
  nodeForPath(fsPath) {
    const wt = this.store.openedWorktrees().find((w) => core.isInside(fsPath, w.path));
    if (!wt) return null;
    let node = this.node('worktree', wt.path, wt, undefined);
    const rel = path.relative(wt.path, fsPath);
    if (!rel || rel.startsWith('..')) return node;
    let cur = wt.path;
    const segs = rel.split(path.sep);
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]);
      let isDir = i < segs.length - 1;
      if (!isDir) {
        try { isDir = fs.statSync(cur).isDirectory(); } catch { isDir = false; }
      }
      node = this.node(isDir ? 'dir' : 'file', cur, wt, node);
    }
    return node;
  }
}

// ---------------------------------------------------------------- git status

const GIT_DECO = {
  modified:  { badge: 'M', color: 'gitDecoration.modifiedResourceForeground',    label: 'Modified' },
  untracked: { badge: 'U', color: 'gitDecoration.untrackedResourceForeground',   label: 'Untracked' },
  added:     { badge: 'A', color: 'gitDecoration.addedResourceForeground',       label: 'Added' },
  deleted:   { badge: 'D', color: 'gitDecoration.deletedResourceForeground',     label: 'Deleted' },
  renamed:   { badge: 'R', color: 'gitDecoration.renamedResourceForeground',     label: 'Renamed' },
  conflict:  { badge: 'C', color: 'gitDecoration.conflictingResourceForeground', label: 'Conflict' },
};
// Which state wins when a directory holds several: the more urgent one.
const GIT_RANK = { untracked: 1, added: 2, renamed: 3, modified: 4, deleted: 5, conflict: 6 };

/**
 * Paints git status onto the file tree the way the Explorer does. The built-in git extension
 * does not decorate worktrees living outside the workspace (or ignored by the parent repo),
 * so status is read here and served as a FileDecorationProvider.
 *
 * Only opened worktrees are polled - running `git status` across every worktree on each
 * refresh would cost far more than it is worth.
 */
class GitStatus {
  constructor(store) {
    this.store = store;
    this.files = new Map();  // fsPath -> state
    this.dirs = new Map();   // ancestor fsPath -> most urgent state below it
    this.counts = new Map(); // worktree path -> { state: n }
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._emitter.event;
    this.timer = undefined;
  }

  provideFileDecoration(uri) {
    if (uri.scheme !== 'file' || cfg().get('showGitStatus') === false) return undefined;
    const own = this.files.get(uri.fsPath);
    if (own) {
      const d = GIT_DECO[own];
      return { badge: d.badge, color: new vscode.ThemeColor(d.color), tooltip: d.label };
    }
    const below = this.dirs.get(uri.fsPath);
    if (below) {
      const d = GIT_DECO[below];
      return { color: new vscode.ThemeColor(d.color), tooltip: `Contains ${d.label.toLowerCase()} files` };
    }
    return undefined;
  }

  /** Short SCM-style tally for a worktree row, e.g. "~5 +3 -1". */
  summaryText(wtPath) {
    const t = this.counts.get(wtPath);
    if (!t) return null;
    const tilde = (t.modified || 0) + (t.renamed || 0);
    const plus = (t.untracked || 0) + (t.added || 0);
    const minus = t.deleted || 0;
    const bang = t.conflict || 0;
    const parts = [];
    if (tilde) parts.push(`~${tilde}`);
    if (plus) parts.push(`+${plus}`);
    if (minus) parts.push(`-${minus}`);
    if (bang) parts.push(`!${bang}`);
    return parts.length ? parts.join(' ') : null;
  }

  schedule(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), delay);
  }

  async refresh() {
    const clear = cfg().get('showGitStatus') === false;
    const files = new Map();
    const dirs = new Map();
    const counts = new Map();

    if (!clear) {
      await Promise.all(this.store.openedWorktrees().map(async (wt) => {
        const entries = await core.gitStatus(wt.path);
        if (!entries) return;
        const tally = {};
        for (const e of entries) {
          const kind = core.classifyStatus(e.x, e.y);
          tally[kind] = (tally[kind] || 0) + 1;
          const abs = path.join(wt.path, e.path);
          files.set(abs, kind);
          for (let d = path.dirname(abs); d.length > wt.path.length && d.startsWith(wt.path); d = path.dirname(d)) {
            const prev = dirs.get(d);
            if (!prev || GIT_RANK[kind] > GIT_RANK[prev]) dirs.set(d, kind);
          }
        }
        counts.set(wt.path, tally);
      }));
    }

    this.files = files;
    this.dirs = dirs;
    this.counts = counts;
    this._emitter.fire(undefined);
    this.store.fire(); // repaint the worktree rows so their tallies update
  }
}

// ---------------------------------------------------------------- file index

const indexCache = new Map();
const ignoredCache = new Map();

/** Cached `git ls-files --ignored` for a worktree. Null means git could not answer. */
async function getIgnored(wt) {
  const hit = ignoredCache.get(wt.path);
  if (hit && Date.now() - hit.ts < INDEX_TTL_MS) return hit.set;
  const set = await core.gitIgnoredEntries(wt.path);
  ignoredCache.set(wt.path, { set, ts: Date.now() });
  return set;
}

async function getIndex(wt) {
  const hit = indexCache.get(wt.path);
  if (hit && Date.now() - hit.ts < INDEX_TTL_MS) return hit;
  const res = await core.indexWorktreeFiles(wt.path, {
    max: cfg().get('quickOpenMaxFiles') || 20000,
  });
  const entry = { ...res, ts: Date.now() };
  indexCache.set(wt.path, entry);
  return entry;
}

// ---------------------------------------------------------------- scoped search

/**
 * The search scope lives in the input box as an `@<worktree> ` prefix, faking a tag:
 * typing @ opens a worktree picker, choosing one writes the prefix into the value, and a
 * backspace that touches the prefix removes it whole.
 * (A QuickPick input is plain text; VS Code has no rich-text chip API, so this is the closest.)
 */
async function quickOpenFiles(store, initialScope) {
  await store.load();
  const pickable = store.visible().filter((w) => !w.isMain || cfg().get('includeMainCheckout'));
  if (!pickable.length) {
    vscode.window.showInformationMessage('No worktree found.');
    return;
  }

  const targetsOf = (sc) => {
    if (sc.kind === 'wt') return [sc.wt];
    if (sc.kind === 'opened') return store.openedWorktrees();
    return pickable;
  };
  /** Lay the worktree names out in a row, trimming the tail once the title bar runs out of room. */
  const joinNames = (wts, max = 56) => {
    if (!wts.length) return 'none';
    let out = '';
    for (let i = 0; i < wts.length; i++) {
      const next = out ? `${out}, ${wts[i].name}` : wts[i].name;
      if (i > 0 && next.length > max) return `${out}, +${wts.length - i}`;
      out = next;
    }
    return out;
  };

  const labelOf = (sc) => {
    if (sc.kind === 'wt') return sc.wt.name;
    return `${sc.kind === 'opened' ? 'opened' : 'all'} \u2014 ${joinNames(targetsOf(sc))}`;
  };

  let scope = initialScope;
  if (scope.kind === 'opened' && !store.openedWorktrees().length) {
    scope = { kind: cfg().get('searchScopeFallback') === 'opened' ? 'opened' : 'all' };
  }

  const qp = vscode.window.createQuickPick();
  qp.matchOnDescription = false; // filtering is done here
  qp.placeholder = 'Search files  \u2014  type @ to change scope';
  const clearBtn = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Clear scope (or press backspace)' };

  let pool = [];
  let suppress = false; // guards against re-entering onDidChangeValue when we rewrite the value

  const prefix = () => (scope.kind === 'wt' ? `@${scope.wt.name} ` : '');
  const syncChrome = () => {
    qp.title = `Scope: ${labelOf(scope)}`;
    qp.buttons = scope.kind === 'wt' ? [clearBtn] : [];
  };

  const rebuildPool = async () => {
    qp.busy = true;
    const targets = targetsOf(scope);
    const multi = targets.length > 1;
    const next = [];
    await Promise.all(targets.map(async (wt) => {
      const { files, truncated } = await getIndex(wt);
      if (truncated) qp.title = `Scope: ${labelOf(scope)} \u2014 ${wt.name} truncated at the index limit`;
      for (const rel of files) {
        const hay = multi ? `${wt.name}/${rel}` : rel;
        next.push({
          label: path.basename(rel),
          description: hay,
          p: path.join(wt.path, rel),
          hay,
          baseStart: hay.length - path.basename(rel).length,
        });
      }
    }));
    pool = next;
    qp.busy = false;
  };

  const renderFiles = (query) => {
    const q = query.trim().replace(/\s+/g, '');
    if (!q) {
      qp.items = pool.slice(0, MAX_PICK_ITEMS)
        .map((x) => ({ label: x.label, description: x.description, p: x.p, alwaysShow: true }));
      return;
    }
    const scored = [];
    for (const x of pool) {
      const s = fuzzyScore(q, x.hay, x.baseStart);
      if (s >= 0) scored.push([s, x]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    qp.items = scored.slice(0, MAX_PICK_ITEMS)
      .map(([, x]) => ({ label: x.label, description: x.description, p: x.p, alwaysShow: true }));
  };

  /** The worktree picker shown after typing @ */
  const renderScopePicker = (q) => {
    const opened = store.openedWorktrees();
    const base = [
      { label: '$(list-flat) All worktrees', description: `${pickable.length}`, scope: { kind: 'all' }, key: 'all worktrees', alwaysShow: true },
      ...(opened.length
        ? [{ label: '$(folder-opened) Opened', description: opened.map((w) => w.name).join(', '), scope: { kind: 'opened' }, key: 'opened', alwaysShow: true }]
        : []),
      ...pickable.map((w) => ({
        label: `$(git-branch) ${w.name}`,
        description: w.stale ? 'stale' : w.branch || '(detached)',
        scope: { kind: 'wt', wt: w },
        key: `${w.name} ${w.branch || ''}`,
        alwaysShow: true,
      })),
    ];
    const needle = q.trim();
    qp.items = needle
      ? base.map((it) => [fuzzyScore(needle, it.key), it]).filter(([s]) => s >= 0)
        .sort((a, b) => b[0] - a[0]).map(([, it]) => it)
      : base;
  };

  const applyScope = async (next) => {
    scope = next;
    suppress = true;
    qp.value = prefix();
    suppress = false;
    syncChrome();
    await rebuildPool();
    renderFiles('');
  };

  const handleValue = async (v) => {
    const p = prefix();
    if (p) {
      if (v.startsWith(p)) { renderFiles(v.slice(p.length)); return; }
      // Backspace reached into the prefix: drop the whole tag
      await applyScope({ kind: store.openedWorktrees().length ? 'opened' : 'all' });
      return;
    }
    if (v.startsWith('@')) { renderScopePicker(v.slice(1)); return; }
    renderFiles(v);
  };

  qp.onDidChangeValue((v) => { if (!suppress) handleValue(v); });

  syncChrome();
  qp.show();
  await rebuildPool();
  if (scope.kind === 'wt') { suppress = true; qp.value = prefix(); suppress = false; }
  await handleValue(qp.value); // covers anything typed while the index was building

  qp.onDidTriggerButton(() => applyScope({ kind: store.openedWorktrees().length ? 'opened' : 'all' }));

  qp.onDidAccept(async () => {
    const sel = qp.selectedItems[0];
    if (!sel) return;
    if (sel.scope) { await applyScope(sel.scope); return; } // scope chosen, keep the picker open
    if (sel.p) {
      qp.hide();
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sel.p), { preview: false });
    }
  });

  qp.onDidHide(() => qp.dispose());
}

// ---------------------------------------------------------------- activate

function activate(context) {
  const store = new Store(context);
  const gitStatus = new GitStatus(store);
  store.git = gitStatus;
  const listProvider = new ListProvider(store);
  const filesProvider = new FilesProvider(store);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(gitStatus));

  const listView = vscode.window.createTreeView('worktreeExplorer.list', { treeDataProvider: listProvider });
  const filesView = vscode.window.createTreeView('worktreeExplorer.files', {
    treeDataProvider: filesProvider, showCollapseAll: true,
  });
  context.subscriptions.push(listView, filesView);
  vscode.commands.executeCommand('setContext', 'worktreeExplorer.hasOpened', store.opened.length > 0);

  const syncFilesTitle = () => {
    const n = store.openedWorktrees().length;
    filesView.description = n ? String(n) : undefined;
  };
  store.onChange(syncFilesTitle);

  /** Callers pass either a worktree object (list view) or a Node (file tree). */
  const wtOf = (x) => (x && x.wt ? x.wt : x);

  const openWorktree = async (wt) => {
    if (!wt || !wt.path) return;
    store.openWt(wt.path);
    gitStatus.schedule(0);
    await vscode.commands.executeCommand(CONTAINER_CMD);
    try { await filesView.reveal(filesProvider.nodeFor(wt), { expand: true, select: true, focus: false }); } catch { /* view not ready */ }
    followEditor(vscode.window.activeTextEditor);
  };

  /**
   * Claude Code session tabs are webviews of type `claudeVSCodePanel`. VS Code reports the
   * viewType with an internal prefix, hence the suffix test rather than equality. Matching
   * the exact type keeps the plan-preview webview (`claudePlanPreview`) out.
   */
  const isClaudeSessionTab = (tab) => {
    const vt = tab && tab.input && typeof tab.input === 'object' ? tab.input.viewType : undefined;
    return typeof vt === 'string' && /(^|[-.])claudeVSCodePanel$/.test(vt);
  };

  const activeClaudeTab = () => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    return isClaudeSessionTab(tab) ? tab : null;
  };

  /**
   * A session tab's label is its title (customTitle when renamed by hand, otherwise
   * aiTitle, which every session has), which is what pins the session down.
   */
  const activeClaudeTabTitle = () => {
    const tab = activeClaudeTab();
    return tab ? tab.label : null;
  };

  // Drives the `when` clause of the editor title button, so it only takes up room
  // on an actual Claude session tab.
  const syncTabContext = () => {
    vscode.commands.executeCommand('setContext', 'worktreeExplorer.activeTabIsClaude', !!activeClaudeTab());
  };

  const revealSession = async ({ quiet = false } = {}) => {
    const all = await store.load();
    const tabTitle = activeClaudeTabTitle();
    const det = core.detectSessionWorktree(all, {
      home: cfg().get('claudeHome') || undefined,
      scopeRoots: store.scopeRoots(),
      tabTitle,
    });
    const s = det.session;
    const who = s && s.title ? `"${s.title}"` : 'The current session';

    if (!det.worktree) {
      store.setActive(null);
      if (quiet) return;
      const detail = s
        ? `${who} is in \`${s.cwd || '?'}\` (branch \`${s.gitBranch || '?'}\`), which is not any worktree.`
        : 'No Claude session transcript found.';
      const hint = det.matchedByTitle ? '' : '\nCould not pin the session down from the tab label, so the most recently active one was used.';
      const pick = await vscode.window.showWarningMessage(`${detail}${hint}`, 'Open Worktrees view');
      if (pick) await vscode.commands.executeCommand(CONTAINER_CMD);
      return;
    }

    store.setActive(det.worktree.path);

    if (det.worktree.isMain) {
      if (!quiet) {
        vscode.window.setStatusBarMessage(
          `$(repo) ${who} is on the main checkout ${det.worktree.name} \u00b7 branch ${(s && s.gitBranch) || '?'}`, 5000);
      }
      return;
    }

    await openWorktree(det.worktree);
    try { await listView.reveal(det.worktree, { select: true, focus: false }); } catch { /* noop */ }
    if (!quiet) {
      vscode.window.setStatusBarMessage(
        `$(root-folder) ${who} → ${det.worktree.name}（${det.via}）`, 4000);
    }
  };

  /**
   * Follow the active editor, the way the Explorer's autoReveal does. Only while the view is
   * actually visible - revealing into a hidden view would force this sidebar open on every
   * tab switch. A file opened while it was hidden is remembered and revealed on the way in.
   */
  let pendingReveal = null;
  const revealPath = async (fsPath) => {
    const node = filesProvider.nodeForPath(fsPath);
    if (!node) return;
    try {
      await filesView.reveal(node, { select: true, focus: false, expand: false });
    } catch { /* hidden by .gitignore or excludeDirs, so not in the tree */ }
  };
  const followEditor = (editor) => {
    if (cfg().get('autoReveal') === false) return;
    const uri = editor && editor.document && editor.document.uri;
    if (!uri || uri.scheme !== 'file') return;
    if (!filesView.visible) { pendingReveal = uri.fsPath; return; }
    pendingReveal = null;
    revealPath(uri.fsPath);
  };

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('worktreeExplorer.refresh', () => {
    indexCache.clear();
    ignoredCache.clear();
    store.refresh();
    gitStatus.schedule(0);
  });
  reg('worktreeExplorer.revealSessionWorktree', () => revealSession());
  reg('worktreeExplorer.openWorktree', (x) => openWorktree(wtOf(x)));
  reg('worktreeExplorer.closeWorktree', (x) => { const wt = wtOf(x); if (wt) { store.closeWt(wt.path); gitStatus.schedule(0); } });
  reg('worktreeExplorer.closeAllWorktrees', () => { store.closeAll(); gitStatus.schedule(0); });
  reg('worktreeExplorer.quickOpen', () => quickOpenFiles(store, { kind: 'opened' }));
  reg('worktreeExplorer.quickOpenInWorktree', (x) => {
    const wt = wtOf(x);
    return quickOpenFiles(store, wt && wt.path ? { kind: 'wt', wt } : { kind: 'opened' });
  });
  reg('worktreeExplorer.copyPath', async (x) => {
    if (!x || !x.path) return;
    await vscode.env.clipboard.writeText(x.path);
    vscode.window.setStatusBarMessage(`$(clippy) Copied ${x.path}`, 2500);
  });
  reg('worktreeExplorer.revealInFinder', (x) => {
    if (x && x.path) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(x.path));
  });
  reg('worktreeExplorer.openInNewWindow', (x) => {
    const wt = wtOf(x);
    if (wt && wt.path) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceNewWindow: true });
  });
  reg('worktreeExplorer.openTerminalHere', (x) => {
    if (!x || !x.path) return;
    const cwd = x.kind === 'file' ? path.dirname(x.path) : x.path;
    vscode.window.createTerminal({ name: path.basename(cwd), cwd }).show();
  });

  // git worktree add/remove fires no ordinary file event, so watch .git/worktrees
  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/worktrees/**', false, true, false);
  let timer;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(() => store.refresh(), 800); };
  watcher.onDidCreate(debounced);
  watcher.onDidDelete(debounced);
  context.subscriptions.push(watcher);

  const inOpenedWorktree = (fsPath) =>
    store.openedWorktrees().some((wt) => core.isInside(fsPath, wt.path));

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => store.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('worktreeExplorer')) { store.refresh(); gitStatus.schedule(0); }
    }),
    // Keep the status fresh without polling: react to edits here, and to anything that
    // happened outside the window (a terminal commit, a rebase) when focus comes back.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file' && inOpenedWorktree(doc.uri.fsPath)) gitStatus.schedule();
    }),
    vscode.workspace.onDidCreateFiles(() => gitStatus.schedule()),
    vscode.workspace.onDidDeleteFiles(() => gitStatus.schedule()),
    vscode.workspace.onDidRenameFiles(() => gitStatus.schedule()),
    vscode.window.onDidChangeWindowState((st) => { if (st.focused) gitStatus.schedule(250); }),
    vscode.window.tabGroups.onDidChangeTabs(syncTabContext),
    vscode.window.tabGroups.onDidChangeTabGroups(syncTabContext),
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    filesView.onDidChangeVisibility((e) => {
      if (!e.visible || !pendingReveal) return;
      const p = pendingReveal;
      pendingReveal = null;
      revealPath(p);
    }),
  );

  syncFilesTitle();
  syncTabContext();
  followEditor(vscode.window.activeTextEditor);
  gitStatus.schedule(600);
  if (cfg().get('autoRevealOnStartup')) setTimeout(() => revealSession({ quiet: true }), 1500);
}

function deactivate() {}

module.exports = { activate, deactivate };
