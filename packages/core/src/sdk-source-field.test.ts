import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `worker_wait.sources` の doc が引き写している SDK の JSDoc を、腐ったら
 * 落ちる形で固定する。
 *
 * ## なぜ「型」ではなく「文」を見るのか
 *
 * `usage-limits.ts` は SDK が **定数として export しているもの**（`USAGE_
 * LIMIT_ERROR_PREFIXES` 等）を import しているので、消えれば型エラーで落ちる。
 * **こちらにはその手が無い。** `UserPromptSubmitHookInput.source` は
 * `'user' | 'sdk' | 'system' | ...` の union であって、「この値がいつ付くか」
 * は型ではなく **JSDoc の散文** にしか書かれていない。散文は型検査に掛からず、
 * 変わっても何も落ちない。
 *
 * ## 実際に腐った
 *
 * `worker_wait` を入れた #129 は SDK 0.3.237 に対して書かれ、`sources` の doc
 * に「外部のペイロードには付かない」と書いた。**その時点では正しい引き写し
 * だった。** 翌日の `1ce97ed`（0.3.239 への自動更新）で JSDoc のほうが変わり、
 * doc だけが古いまま残った:
 *
 * - 0.3.237: `Currently only set for Anthropic-internal sessions while the
 *   field is trialed; external payloads omit it.`
 * - 0.3.239: `Payloads may omit it while the field rolls out.`
 *
 * **腐り方が「読む人が計器を過小評価する」側だったのが厄介である。** 「どうせ
 * 取れない」と書いてある軸は誰も見に行かないので、実は取れるようになっていた
 * ことに気づく契機がどこにも無い。SDK の更新は
 * `.github/workflows/update-claude-sdk.yml` が自動で PR にするので、**同じ腐り
 * 方はこれからも起きる。**
 *
 * ## この歯が言えないこと
 *
 * - **JSDoc が正しいことは保証しない。** ここが固定するのは「SDK がこう書いて
 *   いる」であって「実際にそう振る舞う」ではない。実セッションで `source` が
 *   本当に付くかは、`worker_wait.sources` が実機で埋まるかを見るしかない
 * - **文言が変わっただけで落ちる。** 意味が同じ言い換えでも落ちる。**それを
 *   欠陥ではなく仕様として置いている** — 落ちた側が3か所の doc を読み直す
 *   きっかけになればよく、意味の同一性を機械に判定させようとすると、判定を
 *   緩めた分だけ黙って通る腐り方が戻ってくる
 * - **`sdk.d.ts` を読めなかった場合を「該当0件」にしない。** 解決も読み取りも
 *   できなければ、その場で落とす（下の1本目）。読めなかったことを「変わって
 *   いない」と報告する検出器は、無いより悪い
 */

const require_ = createRequire(import.meta.url);

/** 実際に依存として入っている `sdk.d.ts`（`node_modules` の実物）。 */
function sdkTypesPath(): string {
  // `package.json` は `exports` に載っていないので resolve できない。実体
  // （`sdk.mjs`）を解決してから隣を見る。
  return join(dirname(require_.resolve('@anthropic-ai/claude-agent-sdk')), 'sdk.d.ts');
}

/**
 * `UserPromptSubmitHookInput.source` に付いている JSDoc の本文だけを切り出す。
 *
 * **`sdk.d.ts` 全文を対象に文字列を探さない。** 他の場所に似た一文があれば、
 * 目的のフィールドの doc が消えていても通ってしまう。
 */
function sourceFieldJsDoc(): string {
  const path = sdkTypesPath();
  const text = readFileSync(path, 'utf8');
  const declaration = "    source?: 'user' | 'sdk' | 'system'";
  const at = text.indexOf(declaration);
  if (at < 0) return '';
  const opened = text.lastIndexOf('/**', at);
  if (opened < 0) return '';
  const closed = text.indexOf('*/', opened);
  if (closed < 0 || closed > at) return '';
  return text.slice(opened, closed);
}

describe('SDK の UserPromptSubmitHookInput.source（worker_wait.sources の前提）', () => {
  it('sdk.d.ts が実在し、source の JSDoc を切り出せる（読めなかったを通さない）', () => {
    expect(existsSync(sdkTypesPath())).toBe(true);
    expect(sourceFieldJsDoc().length).toBeGreaterThan(0);
  });

  it('切り出しは source フィールドの doc だけを見ている（他所の文に当たらない）', () => {
    // 検出器が非0を出せることと、出す先が正しいことを先に見せる。ここが
    // `sdk.d.ts` 全文だったら、この2つは区別できない。
    const doc = sourceFieldJsDoc();
    // [sdk-verbatim UserPromptSubmitHookInput.source] 「Who authored/injected the prompt」
    expect(doc).toContain('Who authored/injected the prompt');
    expect(doc).not.toContain('hook_event_name');
  });

  it('system は「機械が起こしたターン」で、task notifications と auto-continuation を畳んでいる', () => {
    // `byCause.notification` / `byCause.continuation` が分けようとしている当の
    // ものが、SDK 側ではこの1語に畳まれている。ここが変わったら
    // `runner-protocol.ts` の `sources` の doc の「割れない」が嘘になる。
    // [sdk-verbatim UserPromptSubmitHookInput.source] 「`system` = other machine-injected turns (peer/channel messages, task notifications, auto-continuation)」
    expect(sourceFieldJsDoc()).toContain(
      '`system` = other machine-injected turns (peer/channel messages, task notifications, auto-continuation)',
    );
  });

  it('取れる見込みは「付かないこともある」であって「外部には付かない」ではない', () => {
    const doc = sourceFieldJsDoc();
    // [sdk-verbatim UserPromptSubmitHookInput.source] 「Payloads may omit it while the field rolls out.」
    expect(doc).toContain('Payloads may omit it while the field rolls out.');
    // 0.3.237 の文言。**戻ったら落とす** — 戻ったなら `sources` は外部
    // セッションでは死んでいるので、doc の書き方を変えなければならない。
    expect(doc).not.toContain('external payloads omit it');
  });
});
