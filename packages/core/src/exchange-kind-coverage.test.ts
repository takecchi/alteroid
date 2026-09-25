import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXCHANGE_KIND_PREFIXES } from './exchange-kind.js';

/**
 * `type: 'exchange'` の書き込み全箇所が、6つの kind 接頭辞のどれかで始まる
 * 本文を書くこと（issue #1332）の静的な網羅性の歯。
 *
 * **数え方はソースの走査であって実行時の観測ではない。** `this.#journal({...})`
 * / `this.#stores.journal.append({...})` 呼び出しを、括弧の対応を数えて
 * 1つのオブジェクトリテラルとして切り出し、`type: 'exchange'` を持つものだけを
 * 対象にする——この切り出し方は `/tmp/mgr-fddd693c/w1332-table.md`（振り分けの
 * 表）が「実書き込み箇所」を数えたときの手作業（テスト・doc コメント内の逐語
 * 引用・型の抽出・契約テストヘルパー・`turn-input.ts` を除く）を、コメント行を
 * 自然に除外する形（コメント行は `journal({` という呼び出しの形を取らない）で
 * 機械化したものである。
 *
 * **除外は `with: 'human'` の1パターンだけ。** `with` が条件式で決まる箇所
 * （`clone.ts` の `apply`）は、`with: 'human'` という単純な形にならないので
 * 除外されず、`text` 側が両方の分岐で prefix 定数を参照していることを
 * 静的に要求する——実際にそうなっていることは `exchange-kind-apply-branch`
 * の歯（下）が実行時に確かめる。
 *
 * **変異試験（mutation testing）の的**: このファイルへ「接頭辞を持たない
 * 新しい `type: 'exchange'` 書き込み」を1つ足すと、`with: 'self'` である限り
 * この歯が赤くなる。手順・実測は PR 本文に書く。
 */

const CORE_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

interface ExchangeWriteSite {
  readonly file: string;
  /** 呼び出し（`journal(` / `journal.append(`）が始まる行（1始まり）。 */
  readonly line: number;
  /** `journal({ ... })` の `{ ... }` 部分（両端の波括弧を含む）。 */
  readonly objectText: string;
}

/**
 * `journal(` / `journal.append(` 呼び出しを総当たりし、続く `{ ... }` を
 * 括弧の対応で切り出す。**テンプレートリテラル（`` ` ``）の中の `{` / `}` /
 * `,` は地の文として無視する**（`${...}` の中は式として数える）。
 */
function findJournalCallObjects(file: string): ExchangeWriteSite[] {
  const fullPath = path.join(CORE_SRC_DIR, file);
  const text = readFileSync(fullPath, 'utf8');
  const sites: ExchangeWriteSite[] = [];
  const callRe = /\bjournal(?:\.append)?\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    const openBraceIndex = m.index + m[0].length - 1;
    const end = findMatchingBrace(text, openBraceIndex);
    if (end === -1) {
      throw new Error(
        `${file}: ${m.index} にある journal( 呼び出しの閉じ括弧が見つからない（括弧の対応が崩れている）`,
      );
    }
    const objectText = text.slice(openBraceIndex, end + 1);
    if (!/type:\s*'exchange'/.test(objectText)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    sites.push({ file, line, objectText });
  }
  return sites;
}

/** `text[openBraceIndex]` が `{` である前提で、対応する `}` の index を返す。無ければ -1。 */
function findMatchingBrace(text: string, openBraceIndex: number): number {
  let depth = 0;
  let inBacktick = false;
  let templateExprDepth = 0; // バッククォートの中で `${` に入っている深さ
  let inSingle = false;
  let inDouble = false;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (templateExprDepth > 0) {
        if (ch === '{') templateExprDepth += 1;
        else if (ch === '}') templateExprDepth -= 1;
        continue;
      }
      if (ch === '`' && prev !== '\\') {
        inBacktick = false;
        continue;
      }
      if (ch === '$' && text[i + 1] === '{') {
        templateExprDepth = 1;
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
      continue;
    }
  }
  return -1;
}

/** `objectText` の中の `fieldName:` フィールドの値部分（次の最上位カンマまで）を切り出す。 */
function extractFieldValue(objectText: string, fieldName: string): string | undefined {
  const m = new RegExp(`(^|[{,\\s])${fieldName}:\\s*`).exec(objectText);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  const start = i;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inBacktick = false;
  let templateExprDepth = 0;
  let inSingle = false;
  let inDouble = false;
  for (; i < objectText.length; i += 1) {
    const ch = objectText[i];
    const prev = i > 0 ? objectText[i - 1] : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (templateExprDepth > 0) {
        if (ch === '{') templateExprDepth += 1;
        else if (ch === '}') {
          templateExprDepth -= 1;
        }
        continue;
      }
      if (ch === '`' && prev !== '\\') {
        inBacktick = false;
        continue;
      }
      if (ch === '$' && objectText[i + 1] === '{') {
        templateExprDepth = 1;
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '(') {
      depthParen += 1;
      continue;
    }
    if (ch === ')') {
      depthParen -= 1;
      continue;
    }
    if (ch === '[') {
      depthBracket += 1;
      continue;
    }
    if (ch === ']') {
      depthBracket -= 1;
      continue;
    }
    if (ch === '{') {
      depthBrace += 1;
      continue;
    }
    if (ch === '}') {
      if (depthBrace === 0) break; // 呼び出し元オブジェクトの終端
      depthBrace -= 1;
      continue;
    }
    if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      break;
    }
  }
  return objectText.slice(start, i);
}

/** `with:` フィールドが単純な文字列リテラル `'human'` かどうか。 */
function isLiteralHumanWith(objectText: string): boolean {
  const withValue = extractFieldValue(objectText, 'with');
  return withValue !== undefined && withValue.trim() === "'human'";
}

/** `text:` フィールドの値が、6接頭辞のどれかの定数を参照しているか。 */
function textFieldReferencesAnyPrefix(objectText: string): boolean {
  const textValue = extractFieldValue(objectText, 'text');
  if (textValue === undefined) return false;
  return EXCHANGE_KIND_PREFIXES.some(({ kind }) =>
    textValue.includes(`EXCHANGE_KIND_${kind.toUpperCase()}_PREFIX`),
  );
}

const EXPECTED_SITE_COUNT: Record<string, number> = {
  // 41（issue #1332 起票時点） + 2（issue #1374 / PR #1422 が足した
  // #noteRedeliveryPredicateHitA / #noteRedeliveryPredicateHitB。
  // main へ合流した後に振り分けて kind 接頭辞を付けた——除外リストには
  // 入れない、というマネージャーの方針転換に合わせた）
  // + 1（issue #1425 が `case 'rate_limit'` に足した、跨いで畳んだ本数の
  // flush。`EXCHANGE_KIND_GAUGE_PREFIX` を使うので接頭辞は既に付いている）
  // + 2（issue #903 続きが足した `#journalRestoreUnreadPassStart` /
  // `#journalRestoreUnreadPassEnd`。どちらも `[計器]` = `EXCHANGE_KIND_GAUGE_PREFIX` を書く）。
  // + 1（#1398 c23-1 の `interruptTurn`。人間の求めで止めたことを `[判断]` =
  // `EXCHANGE_KIND_DECISION_PREFIX` で書く）。
  // + 1（#325 段2 が足した `#externalMcpServers`。MCP サーバの登録が読めなかったことを
  // `EXCHANGE_KIND_FAILURE_PREFIX` で書く）。
  // + 2（issue #955 の (A) の `#noteHeldEscalation`。held の後に畳み直した判断を
  // `[判断]` = `EXCHANGE_KIND_DECISION_PREFIX` で書く1本と、内部のターンで畳み直した
  // ことを直近の人間の会話へ知らせる `with: 'human'` の1本）。
  'clone.ts': 50,
  // 40（issue #1332 起票時点） + 1（issue #1425 が `case 'rate_limit'` に
  // 足した、跨いで畳んだ本数の flush。同じく `EXCHANGE_KIND_GAUGE_PREFIX`）
  // + 1（issue #1388 が `#flushSynthesizedNoticeFor` に足した、合流窓へ
  // 続けて畳まれた合図の到着間隔の計器。同じく `EXCHANGE_KIND_GAUGE_PREFIX`）
  // + 1（#325 段3 が足した `#pushMcpServers`。MCP サーバの登録を runner へ降ろせなかった
  // ことを `EXCHANGE_KIND_FAILURE_PREFIX` で書く）。
  'manager.ts': 44,
};

describe('type: exchange の書き込み全箇所が kind 接頭辞を持つ（issue #1332）', () => {
  for (const file of ['clone.ts', 'manager.ts']) {
    const sites = findJournalCallObjects(file);

    it(`${file}: 実書き込み箇所の総数が${String(EXPECTED_SITE_COUNT[file])}件（テスト・doc コメント・型抽出・契約テストヘルパー・turn-input.ts は journal( 呼び出しの形を取らないので自然に除外される）`, () => {
      expect(sites.length).toBe(EXPECTED_SITE_COUNT[file]);
    });

    describe(`${file}: 各箇所が「with: 'human'（構造で応答と分かる）」か「6接頭辞のどれかを text に持つ」のどちらか`, () => {
      for (const site of sites) {
        it(`${file}:${String(site.line)}`, () => {
          if (isLiteralHumanWith(site.objectText)) {
            // with: 'human' の行は、kind 接頭辞を付けない（AGENTS.md への依頼の
            // とおり、with 欄そのものが「人間との生の往復」を既に構造化している）。
            return;
          }
          expect(textFieldReferencesAnyPrefix(site.objectText)).toBe(true);
        });
      }
    });
  }
});

describe('exchange-kind-apply-branch: clone.ts の apply（with が self/human の条件式）', () => {
  it('self 側の分岐だけが EXCHANGE_KIND_REPLY_PREFIX を text に持つ（human 側は付けない）', () => {
    const sites = findJournalCallObjects('clone.ts');
    const applySite = sites.find((site) =>
      site.objectText.includes("turn.conversationId === null ? 'self' : 'human'"),
    );
    expect(applySite).toBeDefined();
    const textValue = extractFieldValue(applySite!.objectText, 'text');
    expect(textValue).toBeDefined();
    // self 側にだけ EXCHANGE_KIND_REPLY_PREFIX を足す形（三項演算子で分岐）に
    // なっていることをソースの形で確かめる。human 側の分岐（`turn.text` その
    // もの）に接頭辞の定数が紛れ込んでいないことは、`clone.test.ts` 側の
    // 実行時の歯（human 応答の本文が1文字も変わらないこと）で別途測る。
    expect(textValue).toContain('EXCHANGE_KIND_REPLY_PREFIX');
    expect(textValue).toMatch(/turn\.conversationId === null \? EXCHANGE_KIND_REPLY_PREFIX : ''/);
  });
});
