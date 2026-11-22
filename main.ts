// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Moves a successful move edit recorded, for the R output line (section 2). */
const moves: Array<[string, string]> = [];

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A line of N: `ctx` lines are written as the file's own matched line, at its O index `at`. */
interface NewLine {
  text: string;
  ctx: boolean;
  at: number;
}

function occurrences(O: string[], lines: string[], tier: number): number[] {
  const eq = (a: string, b: string): boolean =>
    tier === 0 ? a === b : tier === 1 ? trimEndWs(a) === trimEndWs(b) : trimWs(a) === trimWs(b);
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!eq(O[j]!, lines[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(O: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (let t = 0; t <= (strict ? 0 : 2); t += 1) {
    const pos = occurrences(O, lines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Replace lines[pos .. pos+O.length) with N (section 5). */
function applyLines(lines: string[], pos: number, O: string[], N: NewLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  if (tier === 2 && O.length > 0) {
    const f = leadWs(lines[pos]!);
    const p = leadWs(O[0]!);
    for (const nl of N) {
      if (nl.ctx) {
        out.push(lines[pos + nl.at]!);
        continue;
      }
      const t = nl.text;
      out.push(t !== '' && t.trim() !== '' && t.startsWith(p) ? f + t.slice(p.length) : t);
    }
  } else {
    for (const nl of N) out.push(nl.ctx ? lines[pos + nl.at]! : nl.text);
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
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

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
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
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoNl: boolean;
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** A path after `--- `/`+++ `: up to the first tab, spaces removed, one a/ or b/ removed. */
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function finishHunk(a: number, body: string[]): Hunk {
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NewLine[] = [];
  let noNl = false;
  let lastPlusNoNl = false;
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, i) => {
    const c = l[0];
    if (l === '' || c === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, at: o.length - 1 });
      lastCtxPlus = i;
    } else if (c === '-') o.push(l.slice(1));
    else if (c === '+') {
      n.push({ text: l.slice(1), ctx: false, at: -1 });
      lastCtxPlus = i;
      lastPlus = i;
    }
  });
  if (lastCtxPlus >= 0 && (body[lastCtxPlus + 1] ?? '').startsWith('\\')) noNl = true;
  if (lastPlus >= 0 && (body[lastPlus + 1] ?? '').startsWith('\\')) lastPlusNoNl = true;
  return { a, o, n, noNl, lastPlusNoNl };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let parts = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(h.o, parts.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bd = Math.abs(best - target);
      for (const p of found.pos) {
        const dd = Math.abs(p - target);
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
      const atEnd = best + h.o.length === parts.lines.length;
      parts = { lines: applyLines(parts.lines, best, h.o, h.n, found.tier), br: parts.br, final: atEnd ? !h.noNl : parts.final };
      d += h.n.length - h.o.length;
    } else {
      const ins = Math.min(h.a + d, parts.lines.length);
      const atEnd = ins === parts.lines.length;
      const lines = [...parts.lines.slice(0, ins), ...h.n.map((x) => x.text), ...parts.lines.slice(ins)];
      parts = { lines, br: parts.br, final: atEnd ? !h.noNl : parts.final };
      d += h.n.length;
    }
  }
  return joinFile(parts.lines, parts.br, parts.final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: { a: number; body: string[] } | null = null;
  const fresh = (): Section => ({ gitOld: undefined, gitNew: undefined, hdrOld: undefined, hdrNew: undefined, renOld: undefined, renNew: undefined, create: false, del: false, hunks: [] });
  const closeHunk = (): void => {
    if (hunk !== null && cur !== null) {
      cur.hunks.push(finishHunk(hunk.a, hunk.body));
      hunk = null;
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (hunk !== null) {
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) || l.startsWith('@@')) {
        closeHunk();
      } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        hunk.body.push(l);
        continue;
      } else closeHunk();
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        cur = fresh();
        sections.push(cur);
      }
      cur.hdrOld = diffPath(l);
      cur.hdrNew = diffPath(lines[i + 1]!);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0 && hunk === null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice('rename from '.length).trim();
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice('rename to '.length).trim();
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        continue;
      }
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      continue;
    }
  }
  closeHunk();
  return sections.map((s) => {
    const oldP = s.hdrOld !== undefined ? s.hdrOld : s.renOld !== undefined ? s.renOld : s.gitOld ?? null;
    const newP = s.hdrNew !== undefined ? s.hdrNew : s.renNew !== undefined ? s.renNew : s.gitNew ?? null;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      if (s.create || oldP === null) {
        const np = newP!;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of s.hunks) for (const x of h.n) if (!x.ctx) plus.push(x.text);
        let noNl = false;
        for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
          if (s.hunks[k]!.n.some((x) => !x.ctx)) {
            noNl = s.hunks[k]!.lastPlusNoNl;
            break;
          }
        }
        tree.now.set(np, plus.length === 0 ? '' : `${plus.join('\n')}${noNl ? '' : '\n'}`);
        return;
      }
      const op = oldP!;
      if (s.del || newP === null) {
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (newP !== op) {
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(before, s.hunks, strict, op);
        tree.now.set(op, null);
        tree.now.set(newP, out);
        moves.push([op, newP]);
        return;
      }
      tree.now.set(op, applyHunks(before, s.hunks, strict, op));
    };
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end).map((t) => ({ text: t, ctx: false, at: -1 }));
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.map((x) => x.text).join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = splitFile(before);
      const found = findTier(oldLines, parts.lines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      tree.now.set(p, joinFile(applyLines(parts.lines, found.pos[0]!, oldLines, newLines, found.tier), parts.br, parts.final));
    });
    prevPath = p;
    prevEnd = end;
    i = end;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: { anchor: string | null; eof: boolean; body: string[] } | null = null;
  /** Blank lines seen since the last body line: separators unless a body line follows. */
  let pendingBlanks: string[] = [];
  const closeChunk = (): void => {
    if (chunk !== null && cur !== null) {
      const body = chunk.body;
      if (!chunk.eof) while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: string[] = [];
      const n: NewLine[] = [];
      for (const l of body) {
        if (l === '' || l.startsWith(' ')) {
          const t = l === '' ? '' : l.slice(1);
          o.push(t);
          n.push({ text: t, ctx: true, at: o.length - 1 });
        } else if (l.startsWith('-')) o.push(l.slice(1));
        else if (l.startsWith('+')) n.push({ text: l.slice(1), ctx: false, at: -1 });
      }
      cur.chunks.push({ anchor: chunk.anchor, eof: chunk.eof, o, n });
      chunk = null;
    }
  };
  const closeSection = (): void => {
    if (cur !== null && cur.kind === 'add') while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    pendingBlanks = [];
    closeChunk();
    cur = null;
  };
  const startSection = (kind: VSection['kind'], path: string, lineNo: number): void => {
    closeSection();
    cur = { kind, path, moveTo: null, lines: [], chunks: [], updateLine: lineNo };
    sections.push(cur);
  };
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File:')) {
      startSection('add', l.slice('*** Add File:'.length).trim(), i + 1);
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      startSection('del', l.slice('*** Delete File:'.length).trim(), i + 1);
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      startSection('update', l.slice('*** Update File:'.length).trim(), i + 1);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (l.startsWith('+')) cur.lines.push(l.slice(1));
      else if (l === '') cur.lines.push('');
      else if (blank(l)) continue;
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (l.startsWith('*** Move to:')) {
      if (cur.moveTo !== null || cur.chunks.length > 0 || chunk !== null) throw new Exit2(`error: parse ${i + 1}`);
      pendingBlanks = [];
      cur.moveTo = l.slice('*** Move to:'.length).trim();
      continue;
    }
    if (l === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      pendingBlanks = [];
      chunk.eof = true;
      closeChunk();
      continue;
    }
    if (l.startsWith('@@')) {
      pendingBlanks = [];
      closeChunk();
      chunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (blank(l)) {
      pendingBlanks.push(l);
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (chunk === null) {
        if (cur.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        chunk = { anchor: null, eof: false, body: [] };
      }
      chunk.body.push(...pendingBlanks, l);
      pendingBlanks = [];
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSection();
  for (const s of sections) {
    if (s.kind === 'update' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.updateLine}`);
  }
  return sections.map((s) => {
    if (s.kind === 'add') {
      const p = s.path;
      const text = s.lines.length === 0 ? '' : `${s.lines.join('\n')}\n`;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      };
    }
    if (s.kind === 'del') {
      const p = s.path;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = s.path;
    const moveTo = s.moveTo;
    const chunks = s.chunks;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      let parts = splitFile(before);
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null && c.anchor !== '') {
          const tiers = strict ? [0] : [0, 1, 2];
          let at = -1;
          for (const t of tiers) {
            const eq = (a: string, b: string): boolean =>
              t === 0 ? a === b : t === 1 ? trimEndWs(a) === trimEndWs(b) : trimWs(a) === trimWs(b);
            for (let k = cursor; k < parts.lines.length; k += 1) {
              if (eq(c.anchor!, parts.lines[k]!)) {
                at = k;
                break;
              }
            }
            if (at >= 0) break;
          }
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        if (c.o.length === 0) {
          const ins = c.eof ? parts.lines.length : cursor;
          const lines = [...parts.lines.slice(0, ins), ...c.n.map((x) => x.text), ...parts.lines.slice(ins)];
          parts = { lines, br: parts.br, final: parts.final };
          cursor = ins + c.n.length;
          continue;
        }
        const found = (() => {
          for (let t = 0; t <= (strict ? 0 : 2); t += 1) {
            const pos = occurrences(c.o, parts.lines, t).filter((x) => x >= cursor && (!c.eof || x + c.o.length === parts.lines.length));
            if (pos.length > 0) return { tier: t, pos };
          }
          return null;
        })();
        if (found === null) throw new Fail('no-match', p);
        const at = found.pos[0]!;
        parts = { lines: applyLines(parts.lines, at, c.o, c.n, found.tier), br: parts.br, final: parts.final };
        cursor = at + c.n.length;
      }
      const out = joinFile(parts.lines, parts.br, parts.final);
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, out);
        moves.push([p, moveTo]);
      } else tree.now.set(p, out);
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
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
  moves.length = 0;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, nw] of moves) {
    if (tree.original(o) !== null && tree.original(nw) === null && tree.now.get(o) === null && tree.now.get(nw) !== null) {
      movedOld.add(o);
      movedNew.add(nw);
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
    }
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
