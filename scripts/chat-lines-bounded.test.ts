import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// eslint の規則にしない: 特定の型・関数名の出現を repo 全体で数える検査は、eslint の1ファイルずつの走査に自然な形が無いため。
// `grep` を使わず、Node の `fs` で読んだ文字列に正規表現を通す: `grep` の取りこぼしを踏まないため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// `apps/web/app` だけを走査しない: 切り出したパッケージに置いた2箇所目を数え漏らすため。
const WEB_UI_SOURCE_ROOTS = [
  'apps/web/app',
  'packages/ui/src',
  'packages/logic/src',
  'packages/swr/src',
].map((dir) => path.join(ROOT, dir));
const CHAT_TSX = 'apps/web/app/routes/chat.tsx';

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

function collectWebAppFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectWebAppFiles(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
}

export interface LineStateHit {
  file: string;
  snippet: string;
}

// 型名 `Line` の直後の `[]` まで一致させる: `Line[]` を要素に含むだけの型（`useState<{ lines: Line[] }>` 等）を拾わないため。
const LINE_ARRAY_STATE = /useState<\s*Line\s*\[\]\s*>/g;

export function findLineArrayStateDeclarations(files: readonly string[]): LineStateHit[] {
  const hits: LineStateHit[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of text.matchAll(LINE_ARRAY_STATE)) {
      const start = Math.max(0, m.index - 40);
      hits.push({
        file,
        snippet: text.slice(start, m.index + m[0].length + 10).replace(/\s+/g, ' '),
      });
    }
  }
  return hits;
}

// `setLines(` から `retainedBy(` までの距離だけで判定する: 間の書き方（`const next = ...` を挟むか等）に依存しないため。
const SET_LINES_WITH_RETAINED_BY = /setLines\([\s\S]{0,200}?retainedBy\(/g;

export function findSetLinesUsingRetainedBy(source: string): string[] {
  return [...source.matchAll(SET_LINES_WITH_RETAINED_BY)].map((m) =>
    m[0].replace(/\s+/g, ' ').slice(0, 160),
  );
}

const allWebAppFiles: string[] = [];
for (const root of WEB_UI_SOURCE_ROOTS) collectWebAppFiles(root, allWebAppFiles);

describe('/chat の lines state は増え続けない（issue #446 再発防止）', () => {
  it('前提: apps/web/app 配下から少なくとも1つのソースファイルを見つけている', () => {
    expect(allWebAppFiles.length).toBeGreaterThan(0);
  });

  it('前提: 検出パターンは chat.tsx 自身の useState<Line[]> に当たる（検出できることの確認）', () => {
    const text = readFileSync(path.join(ROOT, CHAT_TSX), 'utf8');
    const matches = [...text.matchAll(LINE_ARRAY_STATE)];
    expect(
      matches.length,
      'chat.tsx の lines state の書き方が変わり、この歯の検出パターンが当たらなくなっている疑いがある',
    ).toBeGreaterThan(0);
  });

  it('Line[] を保つ useState は apps/web 全体で chat.tsx の1箇所だけである', () => {
    const hits = findLineArrayStateDeclarations(allWebAppFiles);
    const elsewhere = hits.filter((h) => h.file !== CHAT_TSX);
    expect(
      elsewhere,
      elsewhere.length === 0
        ? ''
        : `Line[] を保つ useState<Line[]> が chat.tsx 以外にも見つかった。刈る規則（retainedBy）を` +
            `迂回できる2つ目の入れ物を作らないこと:\n${elsewhere
              .map((h) => `  ${h.file}: ${h.snippet}`)
              .join('\n')}`,
    ).toEqual([]);
    expect(hits.filter((h) => h.file === CHAT_TSX).length).toBeGreaterThan(0);
  });

  it('chat.tsx に retainedBy を使った setLines 呼び出しが在る（刈る経路そのものが消えていない）', () => {
    const text = readFileSync(path.join(ROOT, CHAT_TSX), 'utf8');
    const hits = findSetLinesUsingRetainedBy(text);
    expect(
      hits.length,
      '刈る経路（setLines(...retainedBy(...)...)）が chat.tsx から消えている。#440 が指摘した' +
        '「一度きりの edge を破壊する形」に戻していないか、または不変条件チェックそのものを' +
        '消していないか確認すること。⚠️ この歯は「呼び出しが在るか」しか見ていない —— 効いて' +
        'いるかは chat.test.tsx の retainedBy の単体テストと配線テストが持つ。',
    ).toBeGreaterThan(0);
  });
});

describe('検出パターンそのもの（歯が空振りしていないことの確認。合成 fixture）', () => {
  it('useState<Line[]> の表記ゆれ（空白あり）にも当たる', () => {
    const source = 'const [lines, setLines] = useState< Line[] >([]);';
    expect([...source.matchAll(LINE_ARRAY_STATE)]).toHaveLength(1);
  });

  it('無関係な useState（別の型）には当たらない', () => {
    const source = [
      'const [draft, setDraft] = useState("");',
      'const [sending, setSending] = useState<boolean>(false);',
      'const [rows, setRows] = useState<LineItem[]>([]);',
    ].join('\n');
    expect([...source.matchAll(LINE_ARRAY_STATE)]).toHaveLength(0);
  });

  it('setLines(...retainedBy(...)...) の形を、間に他のコードを挟んでいても拾う', () => {
    const source = [
      'if (retainedBy(lines, shownId, previousShownId).length !== lines.length) {',
      '  setLines((previous) => {',
      '    const next = retainedBy(previous, shownId, previousShownId);',
      '    return next.length === previous.length ? previous : next;',
      '  });',
      '}',
    ].join('\n');
    expect(findSetLinesUsingRetainedBy(source)).toHaveLength(1);
  });

  it('retainedBy を使わない setLines には当たらない（陰性 fixture）', () => {
    const source = [
      'setLines((previous) => [...previous, { key: "h-0", role: "human", text, of: shownId }]);',
    ].join('\n');
    expect(findSetLinesUsingRetainedBy(source)).toHaveLength(0);
  });
});
