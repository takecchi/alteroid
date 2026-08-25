import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **`/chat` の `lines` state が単調に増える形の再発を、静的に検知する歯**
 * （issue #446 の再発防止 (人間の明示の指示)）。
 *
 * #446 は `ChatPane`（`apps/web/app/routes/chat.tsx`）の `lines` state
 * （`useState<Line[]>([])`）が、会話を行き来するあいだ際限なく増える形だった。
 * 直しは2つ組みである — (1) 保つ持ち主を「いま見ている会話・直前の会話・
 * 持ち主なし」に絞る純関数 `retainedBy`、(2) それを毎 render 適用する
 * 不変条件チェック（#440 の指摘どおり、一度きりの edge では成立しない）。
 * この歯が測るのは、その組が**存在していること**の2点である:
 *
 * 1. `Line[]` を保つ `useState` が `apps/web` 全体で `chat.tsx` の1箇所にしか
 *    無いこと —— 保つ場所が増えると、刈る規則をそこだけ迂回できてしまう
 * 2. `chat.tsx` に `retainedBy` を使った `setLines` 呼び出しが在ること ——
 *    #440 が実際にやった「刈る経路そのものを丸ごと消す」形が再発したら
 *    ここで落ちる
 *
 * **⚠️ この歯が測れないこと（存在検査の限界）を正直に書く。** これは
 * 「呼び出しが在るか」しか見ておらず、**その呼び出しが実際に効いているか**
 * （死んだ分岐に置かれていないか、`shownId`/`previousShownId` を正しく
 * 渡しているか、刈る境界が正しいか）は見ない。死んだ呼び出しでもこの歯は
 * 通る。**その穴は歯 A/B が塞ぐ** —— `chat.test.tsx` の
 * `保つ持ち主の上限（retainedBy。issue #446）`（純関数の単体テスト。数で
 * 保証する）と `会話を跨いだ手元の行の生死（配線。issue #446）`（component
 * を実際に描いて、観測できる帰結——履歴に無い手元の行が2つ先で消え、1つ先
 * までは残る——で保証する）である。この歯だけを見て「守られている」と
 * 読まないこと。
 *
 * **なぜ一般の eslint 規則にしなかったか。** `eslint.config.js` に
 * `@typescript-eslint/no-restricted-imports`（`@alteroid/core` の値 import
 * 禁止）のような一般規則を足す道も検討した。だが上の2点はどちらも
 * **「特定の型・特定の関数名がいまいくつ在るか」を repo 全体で数える**
 * 検査であり、eslint の1ファイルずつの AST 走査（`no-restricted-syntax` 等）
 * には自然な形が無い —— 「全ファイルを跨いだ出現回数」を見るには、eslint
 * のルールをまたいで状態を持ち回るか、専用のカスタムルールをプラグインとして
 * 書き起こす必要があり、後者はこの2点だけのために保守対象を1つ増やす。
 * 一方この歯は `conversation-window-single-source.test.ts` /
 * `agents-md-references.test.ts` と同じ作法（Node の `fs` で読んだ生の
 * 文字列に正規表現を当てる、`pnpm test` の中で普通に走る）で、依存も
 * 追加の実行経路も増えない。**選んだのは「もう在る作法に合わせられるか」
 * のほうを優先したためであり、eslint 側のほうが良いと後で分かれば移してよい。**
 *
 * **`grep` を使わない。** `AGENTS.md`「静かに失敗する道具」の `grep` の
 * 取りこぼしを踏まないよう、Node の `fs` で読んだ生の文字列に対して
 * 自前の正規表現を通す（`scripts/agents-md-references.test.ts` と同じ作法）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_APP_ROOT = path.join(ROOT, 'apps/web/app');
const CHAT_TSX = 'apps/web/app/routes/chat.tsx';

/** 変異試験・生成物・依存を対象から外す。 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

/** `apps/web/app` 配下の `.ts`/`.tsx` を、リポジトリ根からの相対パス（`/` 区切り）で集める。 */
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

/**
 * `useState<Line[]>` の形を探す。**型名 `Line` の直後の `[]` まで含めて一致させる**
 * ことで、`Line[]` を要素に含むだけの他の型（`useState<{ lines: Line[] }>` 等）を
 * 誤って拾わないようにしてある——#446 の時点でそういう形は無いが、拾いすぎて
 * 「他にも在る」と誤読させるより、まず本体の形に絞った。
 */
const LINE_ARRAY_STATE = /useState<\s*Line\s*\[\]\s*>/g;

/** `apps/web` 全体から `useState<Line[]>` の出現を探す。テストファイルも含めて数える。 */
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

/**
 * `setLines(...)` の中で `retainedBy(` を呼んでいる箇所を探す（刈る経路そのもの）。
 *
 * 窓を前後 200 文字ずつ許容するのは `conversation-window-single-source.test.ts`
 * と同じ理由 —— 呼び出しの書き方（引数を1行にまとめるか、`const next = ...` を
 * 挟むか）は実装の都合で変わりうるので、`setLines(` の開き括弧の直後から
 * `retainedBy(` までの距離だけで判定し、間の書き方には依存しない。
 */
const SET_LINES_WITH_RETAINED_BY = /setLines\([\s\S]{0,200}?retainedBy\(/g;

export function findSetLinesUsingRetainedBy(source: string): string[] {
  return [...source.matchAll(SET_LINES_WITH_RETAINED_BY)].map((m) =>
    m[0].replace(/\s+/g, ' ').slice(0, 160),
  );
}

const allWebAppFiles: string[] = [];
collectWebAppFiles(WEB_APP_ROOT, allWebAppFiles);

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
    // 1箇所しか無いことだけでなく、それが chat.tsx の本物であることも確かめる
    // （elsewhere が0件でも hits 自体が0件では「見ていない」と区別が付かない）。
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
