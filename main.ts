// mend — one patch tool for every AI edit format.
//
// Implements SPEC.md: unified diffs, SEARCH/REPLACE blocks, V4A patches and
// JSON edits, matched at three tiers (exact, trailing whitespace, trimmed),
// applied all-or-nothing. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// This file was written from SPEC.md in the build session for the
// hidden-spec-cli-01 bounty. The trial hand-over at the bottom and runner.ts
// are kept exactly as the kit ships them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to answer exit 2 with exactly one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit to report its failure code and path. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Byte order of paths, UTF-8. */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/* ------------------------------------------------------------------ */
/* File model (§3)                                                     */
/* ------------------------------------------------------------------ */

interface FileModel {
  br: string; // '\r\n' or '\n'
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/* ------------------------------------------------------------------ */
/* Tree (§10): the files as the edits leave them.                      */
/* ------------------------------------------------------------------ */

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

type Edit = (tree: Tree) => void;

/** Successful move edits, for the R output rows (§2). */
interface Move {
  old: string;
  nw: string;
}

/* ------------------------------------------------------------------ */
/* Format detection (§4)                                               */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
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
  )
    return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Matching (§5)                                                       */
/* ------------------------------------------------------------------ */

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

/** All positions where O occurs in lines at the given tier (overlap allowed). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const want = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2) at which O occurs, with its positions. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface OldLine {
  text: string;
  ctx: boolean;
}
interface NewLine {
  text: string;
  ctx: boolean;
}

/**
 * Replace O at pos with N. Context lines are written as the file's own
 * matched lines; at tier 2 the other lines of N are re-indented (§5).
 */
function applyReplace(
  lines: string[],
  pos: number,
  o: OldLine[],
  n: NewLine[],
  tier: number,
): string[] {
  const ctxIdx: number[] = [];
  o.forEach((x, i) => {
    if (x.ctx) ctxIdx.push(i);
  });
  let ci = 0;
  const f = tier === 2 && o.length > 0 ? leadWs(lines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!.text) : '';
  const mapped: string[] = n.map((x) => {
    if (x.ctx) return lines[pos + ctxIdx[ci++]!]!;
    if (tier === 2 && x.text !== '' && x.text.trim() !== '' && x.text.startsWith(p)) {
      return f + x.text.slice(p.length);
    }
    return x.text;
  });
  return [...lines.slice(0, pos), ...mapped, ...lines.slice(pos + o.length)];
}

/** Apply hunks to a file's text (§6). Throws Fail on the first failing hunk. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(
        f.lines,
        h.o.map((x) => x.text),
        strict,
      );
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + h.o.length === f.lines.length;
      f.lines = applyReplace(f.lines, best, h.o, h.n, found.tier);
      if (atEnd) f.finalBreak = !h.noNLctx;
      d += h.n.length - h.o.length;
    } else {
      const pos = Math.min(h.a + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines = [...f.lines.slice(0, pos), ...h.n.map((x) => x.text), ...f.lines.slice(pos)];
      if (atEnd) f.finalBreak = !h.noNLctx;
      d += h.n.length;
    }
  }
  return joinFile(f);
}

/* ------------------------------------------------------------------ */
/* Unified diffs (§6)                                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  o: OldLine[];
  n: NewLine[];
  /** '+' lines only, in order (for creations). */
  plus: string[];
  /** A '\' line follows the hunk's last context-or-'+' line. */
  noNLctx: boolean;
  /** A '\' line follows the hunk's last '+' line. */
  noNLplus: boolean;
}

interface Section {
  oldP: string | null;
  newP: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let pairSet = false;

  const newSection = (): Section => {
    const s: Section = { oldP: null, newP: null, isNew: false, isDeleted: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    pairSet = false;
    return s;
  };

  /** Path after '--- ' / '+++ ': up to the first tab, spaces trimmed, a/ or b/ stripped. */
  const headerPath = (raw: string): string | null => {
    let p = raw;
    const tab = p.indexOf('\t');
    if (tab >= 0) p = p.slice(0, tab);
    p = p.trim();
    if (p === '/dev/null') return null;
    if (p.startsWith('a/')) p = p.slice(2);
    else if (p.startsWith('b/')) p = p.slice(2);
    return p;
  };

  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.lastIndexOf(' b/');
      if (!rest.startsWith('a/') || sep <= 2) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.oldP = rest.slice(2, sep);
      s.newP = rest.slice(sep + 3);
      if (s.oldP === '' || s.newP === '') throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader || pairSet) newSection();
      cur!.oldP = headerPath(line.slice(4));
      cur!.newP = headerPath(lines[i + 1]!.slice(4));
      pairSet = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (
          bl === '' ||
          bl.startsWith(' ') ||
          bl.startsWith('-') ||
          bl.startsWith('+') ||
          bl.startsWith('\\')
        ) {
          body.push(bl);
          i++;
        } else break;
      }
      while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' '))
        body.pop();
      const o: OldLine[] = [];
      const nn: NewLine[] = [];
      const plus: string[] = [];
      for (const b of body) {
        if (b.startsWith(' ')) {
          o.push({ text: b.slice(1), ctx: true });
          nn.push({ text: b.slice(1), ctx: true });
        } else if (b === '') {
          // An empty line is a context line whose text is empty.
          o.push({ text: '', ctx: true });
          nn.push({ text: '', ctx: true });
        } else if (b.startsWith('-')) o.push({ text: b.slice(1), ctx: false });
        else if (b.startsWith('+')) {
          nn.push({ text: b.slice(1), ctx: false });
          plus.push(b.slice(1));
        }
        // '\' lines only mark the line before them.
      }
      let noNLctx = false;
      let noNLplus = false;
      for (let j = body.length - 1; j >= 0; j--) {
        if (body[j]!.startsWith(' ') || body[j]!.startsWith('+')) {
          noNLctx = j + 1 < body.length && body[j + 1]!.startsWith('\\');
          break;
        }
      }
      for (let j = body.length - 1; j >= 0; j--) {
        if (body[j]!.startsWith('+')) {
          noNLplus = j + 1 < body.length && body[j + 1]!.startsWith('\\');
          break;
        }
      }
      cur.hunks.push({ a, o, n: nn, plus, noNLctx, noNLplus });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ') && !pairSet) cur.oldP = line.slice(12).trim();
      else if (line.startsWith('rename to ') && !pairSet) cur.newP = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
      // index, old/new mode, similarity, Index: and anything else: ignored.
      i++;
      continue;
    }
    i++;
  }

  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

function unifiedSectionEdit(s: Section, strict: boolean, moves: Move[]): Edit {
  const oldP = s.oldP;
  const newP = s.newP;
  if (oldP === null || s.isNew) {
    // Creation: the new path, from the '+' lines of all its hunks.
    const p = (newP ?? oldP)!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNL = false;
      for (const h of s.hunks) {
        plus.push(...h.plus);
        if (h.plus.length > 0) noNL = h.noNLplus;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
    };
  }
  if (newP === null || s.isDeleted) {
    // Deletion: hunks are not read.
    const p = oldP;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    // Move: hunks applied to the old file, result at the new path.
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(before, s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      moves.push({ old: oldP, nw: newP });
    };
  }
  // Change of the one path.
  const p = oldP;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, strict, p));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (§7)                                          */
/* ------------------------------------------------------------------ */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let boundary = 0; // first line index a path line may come from
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // Path: nearest non-blank line before SEARCH, after the previous block,
    // not starting with three backticks once trimmed.
    let path: string | null = null;
    for (let j = i - 1; j >= boundary; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    // Find ======= then >>>>>>> REPLACE.
    let eq = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srBlockEdit(path, oldLines, newLines, strict));
    prevPath = path;
    boundary = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    f.lines = applyReplace(
      f.lines,
      pos,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      found.tier,
    );
    tree.now.set(path, joinFile(f));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (§8)                                                    */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  o: OldLine[];
  n: NewLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File:')) return 'add';
    if (l.startsWith('*** Delete File:')) return 'delete';
    if (l.startsWith('*** Update File:')) return 'update';
    return null;
  };

  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = line.slice(line.indexOf(':') + 1).trim();
    i++;
    // Collect the body: up to the next section start or End Patch.
    const bodyStart = i;
    while (i < last && sectionStart(lines[i]!) === null) i++;
    const body = lines.slice(bodyStart, i);
    // Blank lines at the end of a section are not part of it.
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let j = 0; j < body.length; j++) {
        const b = body[j]!;
        if (b.startsWith('+')) fileLines.push(b.slice(1));
        else if (b === '') fileLines.push('');
        else throw new Exit2(`error: parse ${bodyStart + j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${bodyStart + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      // Update File.
      let moveTo: string | null = null;
      let j = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to:')) {
        moveTo = body[0]!.slice('*** Move to:'.length).trim();
        j = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      while (j < body.length) {
        const b = body[j]!;
        if (b.startsWith('@@')) {
          const anchorText = b.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, o: [], n: [], eof: false };
          chunks.push(cur);
          j++;
        } else if (b.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${bodyStart + j + 1}`);
          cur.eof = true;
          cur = null;
          j++;
        } else if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${bodyStart + j + 1}`);
            cur = { anchor: null, o: [], n: [], eof: false };
            chunks.push(cur);
          }
          if (b.startsWith(' ')) {
            cur.o.push({ text: b.slice(1), ctx: true });
            cur.n.push({ text: b.slice(1), ctx: true });
          } else if (b.startsWith('-')) cur.o.push({ text: b.slice(1), ctx: false });
          else if (b.startsWith('+')) cur.n.push({ text: b.slice(1), ctx: false });
          else {
            cur.o.push({ text: '', ctx: true });
            cur.n.push({ text: '', ctx: true });
          }
          j++;
        } else {
          throw new Exit2(`error: parse ${bodyStart + j + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${headerLine}`);
      }
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
    }
  }
  return edits;
}

function v4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: Chunk[],
  strict: boolean,
  moves: Move[],
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const out = applyV4aChunks(before, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function applyV4aChunks(text: string, chunks: Chunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let cursor = 0;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundIdx: number | null = null;
      for (const t of tiers) {
        for (let k = cursor; k < f.lines.length; k++) {
          if (normLine(f.lines[k]!, t) === normLine(ch.anchor, t)) {
            foundIdx = k;
            break;
          }
        }
        if (foundIdx !== null) break;
      }
      if (foundIdx === null) throw new Fail('no-match', path);
      cursor = foundIdx + 1;
    }
    if (ch.o.length > 0) {
      let chosen: { tier: number; pos: number } | null = null;
      for (const t of tiers) {
        const occ = occurrences(
          f.lines,
          ch.o.map((x) => x.text),
          t,
        ).filter((p) => p >= cursor && (!ch.eof || p + ch.o.length === f.lines.length));
        if (occ.length > 0) {
          chosen = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (!chosen) throw new Fail('no-match', path);
      f.lines = applyReplace(f.lines, chosen.pos, ch.o, ch.n, chosen.tier);
      cursor = chosen.pos + ch.n.length;
    } else {
      const pos = ch.eof ? f.lines.length : cursor;
      f.lines = [...f.lines.slice(0, pos), ...ch.n.map((x) => x.text), ...f.lines.slice(pos)];
      cursor = pos + ch.n.length;
    }
  }
  return joinFile(f);
}

/* ------------------------------------------------------------------ */
/* JSON edits (§9)                                                     */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
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
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Run (§1, §2, §10)                                                   */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  // Output rows (§2), with R rows replacing their D + A pair.
  const rOlds = new Set<string>();
  const rNews = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    if (
      tree.original(m.old) !== null &&
      tree.original(m.nw) === null &&
      tree.get(m.old) === null &&
      tree.get(m.nw) !== null
    ) {
      rOlds.add(m.old);
      rNews.add(m.nw);
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!rOlds.has(p) && !rNews.has(p)) {
      rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
