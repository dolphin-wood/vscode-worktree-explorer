'use strict';
/**
 * Pure Node logic: worktree discovery, file indexing, Claude session -> worktree detection.
 * No vscode dependency, so `node src/core.js <workspaceRoot>` runs it as a smoke test.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', 'coverage', '__pycache__', '.venv'];

function git(cwd, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** A git repo or linked worktree: .git is a directory in the former, a pointer file in the latter. */
function hasGitEntry(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/**
 * Discover git repos from a set of roots. A workspace folder is often not a repo itself
 * (e.g. a parent directory holding several repos), so scan maxDepth levels down.
 */
function discoverRepos(roots, { maxDepth = 2, excludeDirs = DEFAULT_EXCLUDES } = {}) {
  const found = new Set();
  const skip = new Set(excludeDirs);

  const walk = (dir, depth) => {
    if (hasGitEntry(dir)) { found.add(realpathSafe(dir)); return; } // do not descend into a repo
    if (depth >= maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  for (const r of roots) walk(r, 0);
  return [...found];
}

/** Parse `git worktree list --porcelain` */
function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * List every worktree.
 *  - Collapse multiple entry points of one repo via --git-common-dir, so worktree list runs once per repo.
 *  - A directory with a .git entry where `git worktree list` fails is an orphan left behind by
 *    `git worktree prune`. Its files are still there, so list it as stale rather than dropping it.
 */
async function listWorktrees(repos, { includeMainCheckout = false, includeStale = true } = {}) {
  const byPath = new Map();
  const seenCommonDir = new Set();
  const stale = [];

  for (const repo of repos) {
    const commonRaw = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!commonRaw) { stale.push(repo); continue; }
    const common = realpathSafe(commonRaw.trim());
    if (seenCommonDir.has(common)) continue;
    seenCommonDir.add(common);

    const text = await git(repo, ['worktree', 'list', '--porcelain']);
    if (!text) { stale.push(repo); continue; }
    parseWorktreePorcelain(text).forEach((e, i) => {
      if (e.bare) return;
      const real = realpathSafe(e.path);
      if (byPath.has(real)) return;
      const isMain = i === 0;
      if (isMain && !includeMainCheckout) return;
      byPath.set(real, {
        ...e,
        path: real,
        name: path.basename(real),
        isMain,
        stale: false,
        repo: path.dirname(common) === common ? repo : path.dirname(common),
        repoName: path.basename(path.dirname(common)),
        exists: fs.existsSync(real),
      });
    });
  }

  if (includeStale) {
    for (const repo of stale) {
      const real = realpathSafe(repo);
      if (byPath.has(real)) continue;
      byPath.set(real, {
        path: real,
        name: path.basename(real),
        branch: null,
        head: null,
        detached: false,
        isMain: false,
        stale: true,
        repo: null,
        repoName: path.basename(path.dirname(real)),
        exists: true,
      });
    }
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    if (a.repoName !== b.repoName) return a.repoName.localeCompare(b.repoName);
    return a.name.localeCompare(b.name);
  });
}

/**
 * Index the files in a worktree. Uses git ls-files rather than walking the tree: it is faster
 * and honours .gitignore for free, so node_modules and friends never show up.
 */
async function indexWorktreeFiles(wtPath, { max = 20000, excludeDirs = DEFAULT_EXCLUDES } = {}) {
  const text = await git(wtPath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout: 20000 });
  if (text == null) {
    // No git here (a stale worktree, for instance): fall back to walking the directory
    const files = [];
    const skip = new Set(excludeDirs);
    const walk = (dir, prefix) => {
      if (files.length >= max) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files.length >= max) return;
        if (e.isDirectory()) {
          if (skip.has(e.name)) continue;
          walk(path.join(dir, e.name), prefix + e.name + '/');
        } else if (e.isFile()) {
          files.push(prefix + e.name);
        }
      }
    };
    walk(wtPath, '');
    return { files, truncated: files.length >= max, fallback: true };
  }
  const rel = text.split('\0').filter(Boolean);
  const truncated = rel.length > max;
  return { files: truncated ? rel.slice(0, max) : rel, truncated, fallback: false };
}

/**
 * `git status --porcelain=v1 -z`, parsed. The -z form is NUL-separated with no quoting,
 * so paths with spaces or non-ASCII come through intact. Rename/copy records carry a
 * second NUL-terminated field (the original path) that has to be skipped.
 */
async function gitStatus(wtPath) {
  const out = await git(wtPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 15000 });
  if (out == null) return null;
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    entries.push({ x, y, path: rec.slice(3) });
    if (x === 'R' || x === 'C') i++; // skip the original path of a rename/copy
  }
  return entries;
}

/** Collapse the two-letter status code into one of the states the UI paints. */
function classifyStatus(x, y) {
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'R' || x === 'C') return 'renamed';
  if (x === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

/** One directory level, for the file tree. */
function readDirEntries(dir, { excludeDirs = DEFAULT_EXCLUDES } = {}) {
  const skip = new Set(excludeDirs);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const isDir = e.isDirectory() || (e.isSymbolicLink() && (() => {
      try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
    })());
    if (isDir && skip.has(e.name)) continue;
    out.push({ name: e.name, isDir, path: path.join(dir, e.name) });
  }
  out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
  return out;
}

// ---------------------------------------------------------------- Claude session

function claudeHome(override) {
  if (override) return override;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

/** Read the tail of a file, so a transcript tens of MB long is never read whole. */
function readTail(file, bytes = 128 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {} // eslint-disable-line
  }
}

function readHead(file, bytes = 96 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(bytes, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {} // eslint-disable-line
  }
}

/**
 * Walk the transcript backwards for the last record carrying cwd. gitBranch is collected
 * separately: when Claude works inside a worktree the cwd may still be the main checkout
 * and only gitBranch changes.
 */
function extractSessionState(file) {
  let cwd = null, gitBranch = null, sessionId = null, version = null;
  let customTitle = null, aiTitle = null, altTitle = null;

  // Scan backwards: a rename appends a new record, so the first title seen is the newest
  const scan = (text) => {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l.startsWith('{')) continue;
      let d;
      try { d = JSON.parse(l); } catch { continue; }
      if (!sessionId && d.sessionId) sessionId = d.sessionId;
      if (!version && d.version) version = d.version;
      if (!cwd && typeof d.cwd === 'string') cwd = d.cwd;
      if (!gitBranch && typeof d.gitBranch === 'string' && d.gitBranch) gitBranch = d.gitBranch;
      if (!customTitle && typeof d.customTitle === 'string' && d.customTitle) customTitle = d.customTitle;
      if (!aiTitle && typeof d.aiTitle === 'string' && d.aiTitle) aiTitle = d.aiTitle;
      if (!altTitle && typeof d.title === 'string' && d.title) altTitle = d.title;
    }
  };

  scan(readTail(file));
  // aiTitle is written after the first exchange, so in a long session it sits near the head
  if (!aiTitle && !customTitle) scan(readHead(file));

  // The tab shows customTitle (manual rename) if present, else aiTitle (auto-generated, always present)
  return { cwd, gitBranch, sessionId, version, customTitle, aiTitle, altTitle, title: customTitle || aiTitle || altTitle };
}

/** The most recently active sessions, ordered by transcript mtime. */
function recentSessions({ home, limit = 12 } = {}) {
  const dir = path.join(claudeHome(home), 'projects');
  let slugs;
  try { slugs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const cands = [];
  for (const s of slugs) {
    if (!s.isDirectory()) continue;
    const sdir = path.join(dir, s.name);
    let files;
    try { files = fs.readdirSync(sdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(sdir, f);
      try {
        const st = fs.statSync(full);
        if (!st.size) continue;
        cands.push({ file: full, slug: s.name, mtime: st.mtimeMs });
      } catch { /* ignore */ }
    }
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands.slice(0, limit).map((c) => ({ ...c, ...extractSessionState(c.file) }));
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Match a session to a worktree.
 *  1. cwd falls inside a worktree - the strongest signal. Take the deepest match, since a
 *     worktree may live under the main checkout at .claude/worktrees and both would match.
 *  2. Otherwise match gitBranch against each worktree's branch.
 */
function matchSessionToWorktree(session, worktrees) {
  if (session.cwd) {
    const hits = worktrees.filter((w) => isInside(session.cwd, w.path));
    if (hits.length) {
      hits.sort((a, b) => b.path.length - a.path.length);
      return { worktree: hits[0], via: 'cwd' };
    }
  }
  if (session.gitBranch) {
    const hit = worktrees.find((w) => w.branch === session.gitBranch);
    if (hit) return { worktree: hit, via: 'branch' };
  }
  return null;
}

function normTitle(t) {
  return String(t || '').trim().replace(/\s+/g, ' ').replace(/[.…]+$/, '').toLowerCase();
}

/** Pin down a session by editor tab label. Claude writes the tab name into customTitle. */
function findSessionByTitle(sessions, tabTitle) {
  const want = normTitle(tabTitle);
  if (!want) return null;
  const cands = sessions.filter((s) => s.title);
  return (
    cands.find((s) => normTitle(s.customTitle) === want) ||
    cands.find((s) => normTitle(s.aiTitle) === want) ||
    cands.find((s) => normTitle(s.altTitle) === want) ||
    // The tab label may be elided in the UI, so fall back to a prefix match
    cands.find((s) => want.length >= 8 && (normTitle(s.customTitle).startsWith(want) || normTitle(s.aiTitle).startsWith(want))) ||
    null
  );
}

/**
 * Detect the worktree of the "current" session. scopeRoots narrows candidates to the
 * directories open in this window, so a session running in another window is not picked up.
 */
function detectSessionWorktree(worktrees, { home, scopeRoots = [], limit = 40, tabTitle = null } = {}) {
  const sessions = recentSessions({ home, limit });

  // A tab label pins down exactly one session. Once pinned, commit to it: failing to match a
  // worktree is a meaningful answer (the session is on the main checkout). Silently falling
  // through to another session is precisely what made this jump to the wrong worktree.
  const byTitle = tabTitle ? findSessionByTitle(sessions, tabTitle) : null;
  if (byTitle) {
    const m = matchSessionToWorktree(byTitle, worktrees);
    return {
      worktree: m ? m.worktree : null,
      via: m ? `tab+${m.via}` : null,
      session: byTitle,
      matchedByTitle: true,
    };
  }

  const inScope = (s) => {
    if (!scopeRoots.length || !s.cwd) return true;
    return scopeRoots.some((r) => isInside(s.cwd, r) || isInside(r, s.cwd));
  };
  for (const pass of [sessions.filter(inScope), sessions]) {
    for (const s of pass) {
      const m = matchSessionToWorktree(s, worktrees);
      if (m) return { ...m, session: s, matchedByTitle: false };
    }
  }
  return { worktree: null, via: null, session: sessions[0] || null, matchedByTitle: false };
}

module.exports = {
  DEFAULT_EXCLUDES,
  discoverRepos,
  listWorktrees,
  parseWorktreePorcelain,
  indexWorktreeFiles,
  gitStatus,
  classifyStatus,
  readDirEntries,
  claudeHome,
  recentSessions,
  extractSessionState,
  findSessionByTitle,
  normTitle,
  detectSessionWorktree,
  matchSessionToWorktree,
  isInside,
};

// ---------------------------------------------------------------- smoke test
if (require.main === module) {
  (async () => {
    const roots = process.argv.slice(2);
    if (!roots.length) roots.push(process.cwd());
    const repos = discoverRepos(roots);
    console.log('repos:', repos);
    const wts = await listWorktrees(repos, { includeMainCheckout: true });
    console.log('\nworktrees:');
    for (const w of wts) console.log(`  ${w.isMain ? '[main]' : '      '} ${w.name.padEnd(34)} ${String(w.branch || '(detached)').padEnd(46)} ${w.path}`);
    const tabTitle = process.env.TAB_TITLE || null;
    const det = detectSessionWorktree(wts, { scopeRoots: roots, tabTitle });
    console.log(`\ndetect (tabTitle=${JSON.stringify(tabTitle)}) ->`,
      det.worktree ? `${det.worktree.name}${det.worktree.isMain ? ' [main checkout]' : ''} (via ${det.via})` : 'not inside any worktree');
    console.log('  byTitle:', det.matchedByTitle, '| session:', det.session && {
      title: det.session.title, cwd: det.session.cwd, gitBranch: det.session.gitBranch });
    if (wts.length) {
      const target = wts.find((w) => !w.isMain) || wts[0];
      const idx = await indexWorktreeFiles(target.path);
      console.log(`\nindex ${target.name}: ${idx.files.length} files, truncated=${idx.truncated}`);
      console.log('  sample:', idx.files.slice(0, 3));
    }
  })();
}
