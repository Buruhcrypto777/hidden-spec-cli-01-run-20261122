// mend — apply an AI-written edit to a tree of text files.
// Node 22, standard library only. Run as: node main.ts [options] [PATCH]
// Implements SPEC.md v1, the whole contract: four patch formats
// (unified diff, SEARCH/REPLACE, V4A, JSON edits), three matching tiers,
// all-or-nothing writes, and exact stdout and exit codes.
//
// When MAKEFUN_ENV_URL is set, this file hands the trial over to
// runner.ts (kept as the kit has it); otherwise it is the mend CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

/** An exit-2 failure: one line of output, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed, with the code and path the report names. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and no
 *  empty piece after a final \n. Line numbers count these lines from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (text.endsWith('\n')) ls.pop();
  return ls.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 *  and none of its /-separated segments is empty, . or .. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with one. */
interface FileView {
  lines: string[];
  br: string;
  final: boolean;
}

function viewOf(text: string): FileView {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function textOf(v: FileView): string {
  if (v.lines.length === 0) return '';
  return v.lines.join(v.br) + (v.final ? v.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk on first use. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit: apply it to the tree, or throw a Fail. `moves` collects the
 *  (old, new) pairs of move edits that succeeded, for the R lines. */
type EditFn = (tree: Tree, strict: boolean, moves: Array<[string, string]>) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

/** A line as a tier sees it: exact, trailing spaces/tabs off, or both ends off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based start position where O's lines match the file's lines at a tier. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0 || n > lines.length) return out;
  const keys = oldLines.map((l) => tierKey(l, tier));
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0 only when strict) at which O occurs at least once, else -1. */
function firstTier(lines: string[], oldLines: string[], strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    if (occurrences(lines, oldLines, t).length > 0) return t;
  }
  return -1;
}

/** Old lines O and new lines N of one hunk, block or chunk. For each line of
 *  N, `newFromOld` names the index into O whose file line it must be written
 *  as (a context line), or -1 for a fresh line. */
interface BodyLines {
  oldLines: string[];
  newLines: string[];
  newFromOld: number[];
}

/** Build O and N from a body, one call per body line. */
function bodyBuilder(): {
  ctx(t: string): void;
  old(t: string): void;
  fresh(t: string): void;
  build(): BodyLines;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const newFromOld: number[] = [];
  return {
    ctx(t: string): void {
      newFromOld.push(oldLines.length);
      oldLines.push(t);
      newLines.push(t);
    },
    old(t: string): void {
      oldLines.push(t);
    },
    fresh(t: string): void {
      newFromOld.push(-1);
      newLines.push(t);
    },
    build(): BodyLines {
      return { oldLines, newLines, newFromOld };
    },
  };
}

/** Replace the file's lines [pos, pos + O.length) with N. A context line is
 *  written as the file's own matched line, never the patch's. At tier 2 every
 *  other line of N is re-indented: a line that starts with P (the leading
 *  spaces/tabs of O's first line) has that P replaced by F (those of the
 *  file's first matched line). */
function spliceLines(fileLines: string[], pos: number, body: BodyLines, tier: number): string[] {
  const { oldLines, newLines, newFromOld } = body;
  let f = '';
  let p = '';
  if (tier === 2 && oldLines.length > 0) {
    f = leadingWs(fileLines[pos]!);
    p = leadingWs(oldLines[0]!);
  }
  const repl: string[] = [];
  for (let j = 0; j < newLines.length; j++) {
    const src = newFromOld[j]!;
    if (src >= 0) {
      repl.push(fileLines[pos + src]!);
    } else {
      let line = newLines[j]!;
      if (tier === 2 && !/^[ \t]*$/.test(line) && line.startsWith(p)) {
        line = f + line.slice(p.length);
      }
      repl.push(line);
    }
  }
  return [...fileLines.slice(0, pos), ...repl, ...fileLines.slice(pos + oldLines.length)];
}

/* ------------------------------------------------------------------ */
/* Detecting the format (SPEC.md section 4)                            */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** Old start line, 1-based, from the @@ header. */
  a: number;
  body: BodyLines;
  /** A \ line follows the hunk's last context or + line. */
  noEol: boolean;
  /** A \ line follows the hunk's last + line. */
  plusNoEol: boolean;
}

interface Section {
  /** Paths from the `diff --git` line, if any. */
  diffOld: string | null;
  diffNew: string | null;
  /** Paths from `rename from` / `rename to`, if any. */
  renFrom: string | null;
  renTo: string | null;
  /** Paths from the `---` / `+++` pair, if any. */
  hdrOld: string | null;
  hdrNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** Resolve a section's paths: the `---` / `+++` pair wins, then `rename
 *  from` / `rename to`, then the `diff --git` paths. */
function sectionPaths(s: Section): { oldPath: string | null; newPath: string | null } {
  return {
    oldPath: s.hdrOld ?? s.renFrom ?? s.diffOld,
    newPath: s.hdrNew ?? s.renTo ?? s.diffNew,
  };
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces
 *  removed, a leading a/ or b/ removed. /dev/null means no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when the line is
 *  not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)(?:\s.*)?$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

/** Parse one hunk body starting just after its @@ header at index `hi`.
 *  Returns the hunk and the index of the first line after the body. */
function parseHunkBody(lines: string[], hi: number): { hunk: Hunk; next: number } {
  const items: Array<{ kind: 'ctx' | 'old' | 'fresh' | 'bs'; text: string }> = [];
  let i = hi + 1;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      items.push(
        l === '' || l.startsWith(' ')
          ? { kind: 'ctx', text: l === '' ? '' : l.slice(1) }
          : l.startsWith('-')
            ? { kind: 'old', text: l.slice(1) }
            : l.startsWith('+')
              ? { kind: 'fresh', text: l.slice(1) }
              : { kind: 'bs', text: l.slice(1) },
      );
      i++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it. Only a truly empty
  // patch line is stripped: a ' ' line is an explicit context line and stays.
  const raw = lines.slice(hi + 1, i);
  let keep = raw.length;
  while (keep > 0 && raw[keep - 1] === '') keep--;
  const kept = items.slice(0, keep);
  const b = bodyBuilder();
  for (const it of kept) {
    if (it.kind === 'ctx') b.ctx(it.text);
    else if (it.kind === 'old') b.old(it.text);
    else if (it.kind === 'fresh') b.fresh(it.text);
  }
  // A \ line refers to the body line before it.
  let noEol = false;
  let plusNoEol = false;
  let lastN = -1;
  let lastPlus = -1;
  for (let k = 0; k < kept.length; k++) {
    if (kept[k]!.kind === 'ctx' || kept[k]!.kind === 'fresh') lastN = k;
    if (kept[k]!.kind === 'fresh') lastPlus = k;
  }
  if (lastN >= 0 && kept[lastN + 1]?.kind === 'bs') noEol = true;
  if (lastPlus >= 0 && kept[lastPlus + 1]?.kind === 'bs') plusNoEol = true;
  return { hunk: { a: 0, body: b.build(), noEol, plusNoEol }, next: hi + 1 + keep };
}

/** Apply one hunk to a file view. `d` is the running length drift of this
 *  section's hunks so far. Returns the new view and the drift this hunk adds. */
function applyHunk(view: FileView, hunk: Hunk, d: number, strict: boolean, path: string): { view: FileView; drift: number } {
  const { oldLines, newLines } = hunk.body;
  if (oldLines.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, view.lines.length));
    const lines = [...view.lines.slice(0, at), ...newLines, ...view.lines.slice(at)];
    let final = view.final;
    if (newLines.length > 0 && at === view.lines.length) final = !hunk.noEol;
    return { view: { lines, br: view.br, final }, drift: newLines.length };
  }
  const tier = firstTier(view.lines, oldLines, strict);
  if (tier < 0) throw new Fail('no-match', path);
  const occs = occurrences(view.lines, oldLines, tier);
  const target = hunk.a - 1 + d;
  let best = occs[0]!;
  let bestDist = Math.abs(best - target);
  for (const o of occs) {
    const dist = Math.abs(o - target);
    if (dist < bestDist) {
      best = o;
      bestDist = dist;
    }
  }
  const pos = best;
  const lines = spliceLines(view.lines, pos, hunk.body, tier);
  let final = view.final;
  if (pos + oldLines.length === view.lines.length && newLines.length > 0) {
    final = !hunk.noEol;
  }
  return { view: { lines, br: view.br, final }, drift: newLines.length - oldLines.length };
}

/** The one edit of a unified section. */
function unifiedSectionEdit(
  oldP: string | null,
  newP: string | null,
  isCreate: boolean,
  isDelete: boolean,
  hunks: Hunk[],
): EditFn {
  return (tree, strict, moves) => {
    if (isCreate || oldP === null) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!isSafe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusNoEol = false;
      for (const h of hunks) {
        const { newLines, newFromOld } = h.body;
        for (let j = 0; j < newLines.length; j++) {
          if (newFromOld[j] === -1) plus.push(newLines[j]!);
        }
        if (h.body.newLines.some((_, j) => newFromOld[j] === -1)) lastPlusNoEol = h.plusNoEol;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
      return;
    }
    if (isDelete || newP === null) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (!isSafe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!isSafe(oldP)) throw new Fail('unsafe', oldP);
    if (!isSafe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let view = viewOf(cur);
    let d = 0;
    for (const h of hunks) {
      const r = applyHunk(view, h, d, strict, oldP);
      view = r.view;
      d += r.drift;
    }
    const out = textOf(view);
    if (oldP !== newP) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/** Parse a unified diff patch into its sections' edits. */
function parseUnified(lines: string[]): EditFn[] {
  const edits: EditFn[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const fresh = (diffOld: string | null, diffNew: string | null): Section => ({
    diffOld,
    diffNew,
    renFrom: null,
    renTo: null,
    hdrOld: null,
    hdrNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  const close = (): void => {
    if (cur !== null) {
      const { oldPath, newPath } = sectionPaths(cur);
      edits.push(unifiedSectionEdit(oldPath, newPath, cur.isCreate, cur.isDelete, cur.hunks));
    }
    cur = null;
  };
  const hunkHead = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        const p = diffGitPaths(line);
        if (p === null) throw new Exit2(`error: parse ${i + 1}`);
        cur = fresh(p[0], p[1]);
        inHeader = true;
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = fresh(null, null);
        inHeader = true;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.hdrOld = headerPath(line);
          cur.hdrNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = hunkHead.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        const { hunk, next } = parseHunkBody(lines, i);
        hunk.a = Number(m[1]);
        cur.hunks.push(hunk);
        i = next;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        close();
        const p = diffGitPaths(line);
        if (p === null) throw new Exit2(`error: parse ${i + 1}`);
        cur = fresh(p[0], p[1]);
        inHeader = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // After the first hunk: more hunks, a new section, or ignored prose.
    if (line.startsWith('@@')) {
      const m = hunkHead.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i);
      hunk.a = Number(m[1]);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      close();
      const p = diffGitPaths(line);
      if (p === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(p[0], p[1]);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      close();
      cur = fresh(null, null);
      inHeader = true;
      continue;
    }
    i++;
  }
  close();
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): EditFn {
  return (tree, strict) => {
    if (!isSafe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const view = viewOf(cur);
    const tier = firstTier(view.lines, oldLines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occs = occurrences(view.lines, oldLines, tier);
    if (occs.length > 1) throw new Fail('ambiguous', path);
    const body: BodyLines = { oldLines, newLines, newFromOld: newLines.map(() => -1) };
    const lines = spliceLines(view.lines, occs[0]!, body, tier);
    tree.now.set(path, textOf({ lines, br: view.br, final: view.final }));
  };
}

function parseSearchReplace(lines: string[]): EditFn[] {
  const edits: EditFn[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        si = j;
        break;
      }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(si + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLines;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[]): EditFn {
  return (tree, strict, moves) => {
    if (!isSafe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const view = viewOf(cur);
    let lines = view.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const one = [chunk.anchor];
        let found = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && found < 0; t++) {
          for (const p of occurrences(lines, one, t)) {
            if (p >= cursor) {
              found = p;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { oldLines, newLines } = chunk.body;
      if (oldLines.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at)];
        cursor = at + newLines.length;
        continue;
      }
      const tier = firstTier(lines, oldLines, strict);
      if (tier < 0) throw new Fail('no-match', path);
      let occs = occurrences(lines, oldLines, tier).filter((p) => p >= cursor);
      if (chunk.eof) occs = occs.filter((p) => p + oldLines.length === lines.length);
      if (occs.length === 0) throw new Fail('no-match', path);
      const pos = occs[0]!;
      lines = spliceLines(lines, pos, chunk.body, tier);
      cursor = pos + newLines.length;
    }
    const out = textOf({ lines, br: view.br, final: view.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4A(lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLine = i + 1;
    i++;
    const raw: Array<{ text: string; num: number }> = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!isSafe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, text);
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      edits.push((tree) => {
        if (!isSafe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        j = 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; b: ReturnType<typeof bodyBuilder> } | null = null;
      let seenChunk = false;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push({ anchor: cur.anchor, eof: cur.eof, body: cur.b.build() });
          cur = null;
        }
      };
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          pushCur();
          cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), eof: false, b: bodyBuilder() };
          seenChunk = true;
        } else if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          pushCur();
          seenChunk = true;
        } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (cur === null) {
            if (seenChunk) throw new Exit2(`error: parse ${r.num}`);
            cur = { anchor: null, eof: false, b: bodyBuilder() };
            seenChunk = true;
          }
          if (t === '' || t.startsWith(' ')) cur.b.ctx(t === '' ? '' : t.slice(1));
          else if (t.startsWith('-')) cur.b.old(t.slice(1));
          else cur.b.fresh(t.slice(1));
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!isSafe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (at < 0 || at > lines.length) throw new Fail('no-match', p);
      lines.splice(at, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

/** Parse a JSON patch: one array of edit objects, or one object per line. */
function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2, 10)                         */
/* ------------------------------------------------------------------ */

function parsePatch(kind: string, text: string, lines: string[]): EditFn[] {
  if (kind === 'unified') return parseUnified(lines);
  if (kind === 'search-replace') return parseSearchReplace(lines);
  if (kind === 'v4a') return parseV4A(lines);
  return parseJson(text, lines);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && (FORMATS as readonly string[]).includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parsePatch(kind, text, lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = moves.length;
    try {
      edit(tree, strict, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      for (let k = rows.length - 1; k >= 0; k--) {
        if (rows[k]!.line === `D ${oldP}` || rows[k]!.line === `A ${newP}`) rows.splice(k, 1);
      }
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
