// mend — a patch tool that applies an edit an AI model wrote to a tree of text files, in any of the
// four formats models use: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit calls.
// The contract is SPEC.md (kitchen-sink edition, version 1): mend reads the patch, works out every
// edit, and then writes every change or none of them, printing what changed or why it failed.
//
// Node 22, standard library only. Run it as `node main.ts [options] [PATCH]`; in a make.fun trial
// the grader sets MAKEFUN_ENV_URL and the hand-over at the bottom of this file passes the run to
// runner.ts, which is the kit's file and stays as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A whole-run refusal (exit 2): the single line to print. */
class Refuse {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure (exit 1): its code and the path the failure concerns. */
class Miss {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch's lines (SPEC section 3): split at \n, one trailing \r off each, no empty tail piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): relative, forward slashes only, no empty, dot or dot-dot segments. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file held as lines: its own break, whether it ends with one, and the lines themselves. */
interface LineFile {
  br: '\n' | '\r\n';
  tail: boolean;
  lines: string[];
}

function toLines(text: string): LineFile {
  const at = text.indexOf('\n');
  const br: '\n' | '\r\n' = at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, tail: false, lines: [] };
  const parts = text.split(br);
  const tail = text.endsWith(br);
  if (tail) parts.pop();
  return { br, tail, lines: parts };
}

function fromLines(f: LineFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.tail ? f.br : '');
}

/**
 * The tree as the edits leave it. `now` holds every path an edit has touched (null: not there);
 * anything else is read from disk on first sight and remembered in `was`.
 */
class Tree {
  readonly now = new Map<string, string | null>();
  private readonly was = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];

  before(p: string): string | null {
    if (!this.was.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.was.set(p, v);
    }
    return this.was.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.before(p);
  }
}

type Edit = (tree: Tree) => void;

/** Check a path an edit names before anything else about it (section 10). */
function guard(p: string): void {
  if (!safePath(p)) throw new Miss('unsafe', p);
}

/** The file an edit works on, as lines, or a `missing` failure. */
function mustExist(tree: Tree, p: string): LineFile {
  const t = tree.get(p);
  if (t === null) throw new Miss('missing', p);
  return toLines(t);
}

// ---------------------------------------------------------------- matching (section 5)

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

const TIERS: Array<(s: string) => string> = [(s) => s, stripTrail, stripBoth];

/** Every start index at which `old` matches `lines` under one tier's reading (overlaps allowed). */
function occurrencesAt(lines: string[], old: string[], tier: number): number[] {
  const read = TIERS[tier]!;
  const want = old.map(read);
  const hits: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < old.length; k += 1) {
      if (read(lines[i + k]!) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

interface Found {
  tier: number;
  hits: number[];
}

/** The first tier at which `old` occurs at least once, and its occurrences there. */
function findTier(lines: string[], old: string[], strict: boolean): Found | null {
  for (let tier = 0; tier < (strict ? 1 : 3); tier += 1) {
    const hits = occurrencesAt(lines, old, tier);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

/**
 * One line of a replacement: either a context line (written as the file's own matched line, by its
 * offset into the old lines) or an added line (written as the patch wrote it, re-indented at tier 2).
 */
type NewLine = { ctx: number } | { add: string };

/** The lines a replacement writes, once the tier and the matched position are known. */
function renderNew(fileLines: string[], at: number, old: string[], spec: NewLine[], tier: number): string[] {
  const out: string[] = [];
  for (const n of spec) {
    if ('ctx' in n) {
      out.push(fileLines[at + n.ctx]!);
    } else if (tier === 2) {
      const f = leadWs(fileLines[at]!);
      const p = leadWs(old[0]!);
      const s = n.add;
      out.push(s.trim() !== '' && s.startsWith(p) ? f + s.slice(p.length) : s);
    } else {
      out.push(n.add);
    }
  }
  return out;
}

/** Replace the matched old lines at `at` with the rendered new ones, in place. */
function splice(f: LineFile, at: number, old: string[], spec: NewLine[], tier: number): void {
  const made = renderNew(f.lines, at, old, spec, tier);
  f.lines.splice(at, old.length, ...made);
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  body: Array<{ kind: ' ' | '-' | '+' | '\\'; text: string }>;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renOld: string | null;
  renNew: string | null;
  creates: boolean;
  deletes: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ line names: after the four characters, to the first tab, spaces off. */
function headerPath(raw: string): string {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  const open = (): Section => {
    sec = { gitOld: null, gitNew: null, headOld: null, headNew: null, renOld: null, renNew: null, creates: false, deletes: false, hunks: [] };
    sections.push(sec);
    inHeader = true;
    return sec;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const cut = rest.startsWith('a/') ? rest.indexOf(' b/') : -1;
      if (cut < 0) throw new Refuse(`error: parse ${i + 1}`);
      const s = open();
      s.gitOld = rest.slice(2, cut);
      s.gitNew = rest.slice(cut + 3);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || sec === null) throw new Refuse(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      sec.hunks.push(hunk);
      inHeader = false;
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = b[0];
        if (b === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          hunk.body.push({ kind: b === '' ? ' ' : (c as Hunk['body'][number]['kind']), text: b === '' ? '' : b.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || !inHeader || sec.headOld !== null) open();
      sec!.headOld = headerPath(line);
      sec!.headNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Refuse(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        // A +++ with no --- before it in this header names nothing on its own; ignore it.
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) sec.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.creates = true;
      else if (line.startsWith('deleted file mode')) sec.deletes = true;
      i += 1;
      continue;
    }
    i += 1; // prose, fences and anything else outside a header is ignored
  }

  return sections.map((s) => unifiedEdit(s));
}

/** Whether a `\` line follows the hunk's last context or + line (the no-newline marker). */
function backslashAfterLastWrite(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
    const kind = hunk.body[k]!.kind;
    if (kind === ' ' || kind === '+') return hunk.body[k + 1]?.kind === '\\';
  }
  return false;
}

function unifiedEdit(s: Section): Edit {
  const oldPath = s.headOld ?? s.renOld ?? s.gitOld;
  const newPath = s.headNew ?? s.renNew ?? s.gitNew;
  const isCreate = s.creates || oldPath === '/dev/null';
  const isDelete = s.deletes || newPath === '/dev/null';

  return (tree) => {
    if (isCreate) {
      const p = newPath!;
      guard(p);
      if (tree.get(p) !== null) throw new Miss('exists', p);
      const made: string[] = [];
      let noTail = false;
      for (const h of s.hunks) {
        h.body.forEach((b, k) => {
          if (b.kind === '+') {
            made.push(b.text);
            noTail = h.body[k + 1]?.kind === '\\';
          }
        });
      }
      tree.now.set(p, made.length === 0 ? '' : made.join('\n') + (noTail ? '' : '\n'));
      return;
    }
    const from = oldPath!;
    guard(from);
    if (isDelete) {
      if (tree.get(from) === null) throw new Miss('missing', from);
      tree.now.set(from, null);
      return;
    }
    const isMove = newPath !== null && newPath !== from;
    if (isMove) guard(newPath!);
    const f = mustExist(tree, from);
    if (isMove && tree.get(newPath!) !== null) throw new Miss('exists', newPath!);
    let d = 0;
    for (const h of s.hunks) {
      const old: string[] = [];
      const spec: NewLine[] = [];
      for (const b of h.body) {
        if (b.kind === ' ') {
          spec.push({ ctx: old.length });
          old.push(b.text);
        } else if (b.kind === '-') old.push(b.text);
        else if (b.kind === '+') spec.push({ add: b.text });
      }
      if (old.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const wasEnd = at === f.lines.length;
        const made = renderNew(f.lines, at, old, spec, 0);
        f.lines.splice(at, 0, ...made);
        if (wasEnd) f.tail = !backslashAfterLastWrite(h);
        d += spec.length;
        continue;
      }
      const found = findTier(f.lines, old, STRICT);
      if (found === null) throw new Miss('no-match', from);
      const target = h.a - 1 + d;
      let at = found.hits[0]!;
      for (const hit of found.hits) {
        if (Math.abs(hit - target) < Math.abs(at - target)) at = hit;
      }
      const runsToEnd = at + old.length === f.lines.length;
      splice(f, at, old, spec, found.tier);
      if (runsToEnd) f.tail = !backslashAfterLastWrite(h);
      d += spec.length - old.length;
    }
    if (isMove) {
      tree.now.set(from, null);
      tree.now.set(newPath!, fromLines(f));
      tree.moves.push([from, newPath!] as const);
    } else {
      tree.now.set(from, fromLines(f));
    }
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let floor = 0; // the first line a block's path may sit on
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let k = searchAt - 1; k >= floor; k -= 1) {
      const cand = lines[k]!;
      if (isBlank(cand) || cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Refuse(`error: parse ${searchAt + 1}`);
    let mid = -1;
    for (let k = searchAt + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        mid = k;
        break;
      }
    }
    let end = -1;
    if (mid >= 0) {
      for (let k = mid + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (mid < 0 || end < 0) throw new Refuse(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, mid);
    const newLines = lines.slice(mid + 1, end);
    const p = path;
    edits.push((tree) => {
      guard(p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Miss('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const f = mustExist(tree, p);
      const found = findTier(f.lines, oldLines, STRICT);
      if (found === null) throw new Miss('no-match', p);
      if (found.hits.length > 1) throw new Miss('ambiguous', p);
      splice(f, found.hits[0]!, oldLines, newLines.map((t) => ({ add: t })), found.tier);
      tree.now.set(p, fromLines(f));
    });
    prevPath = path;
    floor = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A (section 8)

interface Chunk {
  anchor: string | null;
  eof: boolean;
  old: string[];
  spec: NewLine[];
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Refuse('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Refuse(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Refuse(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = line.startsWith('*** Add File: ')
      ? 'add'
      : line.startsWith('*** Delete File: ')
        ? 'del'
        : line.startsWith('*** Update File: ')
          ? 'upd'
          : null;
    if (kind === null) throw new Refuse(`error: parse ${i + 1}`);
    const headAt = i;
    const p = line.slice(line.indexOf(': ') + 2).trim();
    i += 1;
    const raw: Array<{ text: string; at: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, at: i });
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Refuse(`error: parse ${r.at + 1}`);
      }
      edits.push((tree) => {
        guard(p);
        if (tree.get(p) !== null) throw new Miss('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'del') {
      if (raw.length > 0) throw new Refuse(`error: parse ${raw[0]!.at + 1}`);
      edits.push((tree) => {
        guard(p);
        if (tree.get(p) === null) throw new Miss('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // Update File
    let moveTo: string | null = null;
    let body = raw;
    if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
      moveTo = body[0]!.text.slice('*** Move to: '.length).trim();
      body = body.slice(1);
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    for (const r of body) {
      const l = r.text;
      if (l.startsWith('@@')) {
        cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, old: [], spec: [] };
        chunks.push(cur);
        continue;
      }
      if (l === '*** End of File') {
        if (cur === null) {
          cur = { anchor: null, eof: true, old: [], spec: [] };
          chunks.push(cur);
        } else cur.eof = true;
        continue;
      }
      if (l.startsWith('*** Move to: ')) throw new Refuse(`error: parse ${r.at + 1}`);
      const c = l[0];
      if (l === '' || c === ' ' || c === '-' || c === '+') {
        if (cur === null) {
          cur = { anchor: null, eof: false, old: [], spec: [] };
          chunks.push(cur);
        }
        if (l === '' || c === ' ') {
          cur.spec.push({ ctx: cur.old.length });
          cur.old.push(l === '' ? '' : l.slice(1));
        } else if (c === '-') cur.old.push(l.slice(1));
        else cur.spec.push({ add: l.slice(1) });
        continue;
      }
      throw new Refuse(`error: parse ${r.at + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Refuse(`error: parse ${headAt + 1}`);
    const to = moveTo;
    edits.push((tree) => {
      guard(p);
      if (to !== null) guard(to);
      const f = mustExist(tree, p);
      if (to !== null && tree.get(to) !== null) throw new Miss('exists', to);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const anchorLine = [ch.anchor];
          let placed = -1;
          for (let tier = 0; tier < (STRICT ? 1 : 3) && placed < 0; tier += 1) {
            const hits = occurrencesAt(f.lines, anchorLine, tier).filter((h) => h >= cursor);
            if (hits.length > 0) placed = hits[0]!;
          }
          if (placed < 0) throw new Miss('no-match', p);
          cursor = placed + 1;
        }
        if (ch.old.length === 0) {
          const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
          const made = renderNew(f.lines, at, ch.old, ch.spec, 0);
          f.lines.splice(at, 0, ...made);
          cursor = at + made.length;
          continue;
        }
        let done: { at: number; tier: number } | null = null;
        for (let tier = 0; tier < (STRICT ? 1 : 3) && done === null; tier += 1) {
          const hits = occurrencesAt(f.lines, ch.old, tier).filter(
            (h) => h >= cursor && (!ch.eof || h + ch.old.length === f.lines.length),
          );
          if (hits.length > 0) done = { at: hits[0]!, tier };
        }
        if (done === null) throw new Miss('no-match', p);
        splice(f, done.at, ch.old, ch.spec, done.tier);
        cursor = done.at + ch.spec.length;
      }
      if (to !== null) {
        tree.now.set(p, null);
        tree.now.set(to, fromLines(f));
        tree.moves.push([p, to] as const);
      } else {
        tree.now.set(p, fromLines(f));
      }
    });
  }
  return edits;
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object, or null when it is not one (a parse fault wherever it sits). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const present = (tree: Tree): string => {
    guard(p);
    const t = tree.get(p);
    if (t === null) throw new Miss('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      guard(p);
      if (tree.get(p) !== null) throw new Miss('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = present(tree);
      const at = before.indexOf('\n');
      const crlf = at > 0 && before[at - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Miss('no-match', p);
      if (count > 1) throw new Miss('ambiguous', p);
      const at2 = t.indexOf(old);
      const out = t.slice(0, at2) + flat(newStr) + t.slice(at2 + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const f = toLines(present(tree));
      if (line < 0 || line > f.lines.length) throw new Miss('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, fromLines(f));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Refuse('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Refuse(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Refuse(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Refuse(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Refuse(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- the run (sections 1, 2, 4, 10)

let STRICT = false;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
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
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) format = a.slice('--format='.length);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? parseJson(text, lines)
        : kind === 'unified'
          ? parseUnified(lines)
          : kind === 'search-replace'
            ? parseSearchReplace(lines)
            : parseV4a(lines);
    if (edits.length === 0) throw new Refuse('error: parse 1');
  } catch (e) {
    if (e instanceof Refuse) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Miss[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Miss)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // The change list: one line per changed path, moves folded into R lines, all in byte order.
  interface Row {
    sortBy: string;
    line: string;
    path: string;
    next: string | null;
  }
  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  for (const p of tree.now.keys()) {
    const was = tree.before(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { sortBy: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, next: now };
    rows.push(row);
    byPath.set(p, row);
  }
  const folded = new Set<Row>();
  for (const [from, to] of tree.moves) {
    const dRow = byPath.get(from);
    const aRow = byPath.get(to);
    if (dRow === undefined || aRow === undefined) continue;
    if (tree.before(from) === null || tree.now.get(from) !== null) continue;
    if (tree.before(to) !== null || tree.now.get(to) === null) continue;
    if (!dRow.line.startsWith('D ') || !aRow.line.startsWith('A ')) continue;
    aRow.line = `R ${from} -> ${to}`;
    folded.add(dRow);
  }
  const shown = rows.filter((r) => !folded.has(r));
  shown.sort((x, y) => Buffer.compare(Buffer.from(x.sortBy), Buffer.from(y.sortBy)));
  if (!check) {
    const written = new Set<string>();
    for (const p of tree.now.keys()) {
      if (written.has(p)) continue;
      written.add(p);
      const was = tree.before(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...shown.map((r) => r.line), `ok: ${shown.length} ${shown.length === 1 ? 'file' : 'files'}`] };
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
