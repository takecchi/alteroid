import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  assistantFailureOf,
  isAnsweredResult,
  resultErrorLines,
  resultFailureOf,
} from './sdk-failure.js';
import { classifyUsageNotice } from './usage-limits.js';

/**
 * 「SDK が『これは応答ではない』と言っている」印を読む部分。
 *
 * **ここが緑でも上の層が塞がっている保証にはならない**（それは `clone.test.ts` /
 * `runner.test.ts` の仕事）。ここで固定したいのは、**印の読み落としが起きない
 * こと**と、**文言で検知していないこと**の2つだけである。
 */

/** 実機で観測された文言そのまま。 */
const ORG_SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

function assistant(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'なにか' }] },
    parent_tool_use_id: null,
    session_id: 'sess',
    uuid: 'uuid',
    ...fields,
  } as unknown as SDKMessage;
}

function result(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: 'できた',
    session_id: 'sess',
    uuid: 'uuid',
    ...fields,
  } as unknown as SDKMessage;
}

/**
 * SDK の `SDKAssistantMessageError` の全値。**数え上げなので、SDK が語を増やせば
 * 腐る。** 腐ったことを `tsc` に言わせるために、下の型で全値を縛ってある
 * （`assistantFailureOf` は語を列挙せず「空でない文字列」を印として通すので、
 * **実行時に取りこぼす訳ではない。腐るのはこの網と doc のほうである**）。
 *
 * **⚠️ ここが赤くなるのは、たいてい `automation/claude-agent-sdk` の PR である**
 * （`.github/workflows/update-claude-sdk.yml` が毎日出す、SDK を上げるだけの PR）。
 * **その赤は「union が語を増やした」という合図であって、更新を止める理由ではない。**
 * 増えた語をこの表と `sdk-failure.ts` の doc へ足し、その1コミットを同じ PR へ
 * 積んでから緑にしてマージすること。**更新を見送らない。** 増えた語は `tsc` の
 * エラー文が名指しする（`Property '<語>' is missing …` の形）。
 *
 * 型に名前を付けてあるのは、**その名前が `tsc` のエラー文にそのまま出る**からである。
 * 上のワークフローは検証の生の出力を PR 本文へ貼るので、マージを判断する人が読む
 * 場所に、増えた語とやることの両方が届く。
 */
type SDK_の_error_の語が増えた_この表と_sdk_failure_ts_の_doc_へ足して同じ_PR_で緑にする = Record<
  SDKAssistantMessageError,
  true
>;

const SDK_ASSISTANT_ERROR_CODES: SDK_の_error_の語が増えた_この表と_sdk_failure_ts_の_doc_へ足して同じ_PR_で緑にする =
  {
    authentication_failed: true,
    oauth_org_not_allowed: true,
    account_on_hold: true,
    billing_error: true,
    rate_limit: true,
    overloaded: true,
    invalid_request: true,
    model_not_found: true,
    server_error: true,
    unknown: true,
    max_output_tokens: true,
  };

describe('assistantFailureOf — assistant メッセージの失敗の印', () => {
  it('印が無ければ undefined（普通の応答を失敗にしない）', () => {
    expect(assistantFailureOf(assistant({}), 'なにか')).toBeUndefined();
  });

  it('error が付いていれば、その語と本文をそのまま運ぶ', () => {
    const failure = assistantFailureOf(assistant({ error: 'billing_error' }), ORG_SPEND_LIMIT);
    expect(failure).toEqual({
      via: 'assistant_error',
      code: 'billing_error',
      text: ORG_SPEND_LIMIT,
    });
  });

  it('SDK が持つ error の語をどれも取りこぼさない', () => {
    // **どれか1つでも読み落とすと、その種類の失敗だけが「応答」として扱われる**
    // （実機で当たったのは `billing_error`）。網は `SDK_ASSISTANT_ERROR_CODES` が
    // 持っており、あちらは型で全値を縛ってある。
    for (const code of Object.keys(SDK_ASSISTANT_ERROR_CODES)) {
      expect(assistantFailureOf(assistant({ error: code }), 'x')?.code).toBe(code);
    }
  });

  it('空文字や文字列でない error は印として扱わない（`{}` を印にしない）', () => {
    expect(assistantFailureOf(assistant({ error: '' }), 'x')).toBeUndefined();
    expect(assistantFailureOf(assistant({ error: '   ' }), 'x')).toBeUndefined();
    expect(assistantFailureOf(assistant({ error: 1 }), 'x')).toBeUndefined();
    expect(assistantFailureOf(assistant({ error: {} }), 'x')).toBeUndefined();
  });
});

describe('isAnsweredResult — 応答として扱ってよい result か', () => {
  it('subtype が success で is_error が立っていなければ応答', () => {
    expect(isAnsweredResult(result({}))).toBe(true);
    expect(isAnsweredResult(result({ is_error: false }))).toBe(true);
  });

  /**
   * **この1本がこの改修の核心である。** 直す前の判定（`isSuccessResult`）は
   * `subtype === 'success'` だけを見ていたので、この組み合わせが「答えが返った」
   * ことになり、`result.result` の中身（＝上限の文言）が応答として保存された。
   */
  it('subtype が success でも is_error が立っていれば応答ではない', () => {
    expect(isAnsweredResult(result({ is_error: true }))).toBe(false);
  });

  it('subtype が success 以外なら応答ではない', () => {
    for (const subtype of [
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]) {
      expect(isAnsweredResult(result({ subtype }))).toBe(false);
    }
  });
});

describe('resultFailureOf — result の失敗の印', () => {
  it('応答として扱える result では undefined', () => {
    expect(resultFailureOf(result({}))).toBeUndefined();
  });

  it('subtype が失敗なら via は result_subtype で、本文をそのまま運ぶ', () => {
    expect(
      resultFailureOf(result({ subtype: 'error_during_execution', result: ORG_SPEND_LIMIT })),
    ).toEqual({
      via: 'result_subtype',
      code: 'error_during_execution',
      text: ORG_SPEND_LIMIT,
    });
  });

  it('subtype が success で is_error なら via は result_is_error（区別を潰さない）', () => {
    // **2つを同じ `via` にまとめないこと。** `subtype` が失敗で終わった回と、
    // 成功と名乗りながら `is_error` が立っている回は、次に掘り始める位置が違う。
    expect(resultFailureOf(result({ is_error: true, result: ORG_SPEND_LIMIT }))?.via).toBe(
      'result_is_error',
    );
  });

  it('api_error_status が読めれば code に添える（429 と 402 と 500 は待ち方が違う）', () => {
    expect(resultFailureOf(result({ is_error: true, api_error_status: 429 }))?.code).toBe(
      'success/429',
    );
    expect(
      resultFailureOf(result({ subtype: 'error_during_execution', api_error_status: 500 }))?.code,
    ).toBe('error_during_execution/500');
    // 読めない値は添えない（`undefined/NaN` のような無意味な語を作らない）。
    expect(resultFailureOf(result({ is_error: true, api_error_status: 'x' }))?.code).toBe(
      'success',
    );
  });

  it('本文が無ければ空文字（`undefined` を文字列化しない）', () => {
    expect(resultFailureOf(result({ is_error: true, result: undefined }))?.text).toBe('');
  });
});

describe('resultErrorLines — result.errors[]', () => {
  it('文字列の行だけを拾う', () => {
    expect(resultErrorLines(result({ errors: ['a', 1, null, 'b'] }))).toEqual(['a', 'b']);
  });

  it('無ければ空（投げない）', () => {
    expect(resultErrorLines(result({}))).toEqual([]);
    expect(resultErrorLines(result({ errors: 'まとめて1本' }))).toEqual([]);
  });
});

/**
 * **検知に文言を使っていないこと。**
 *
 * ここを取り違えると自家中毒になる — `classifyUsageNotice` は部分一致なので、
 * クローンが「上限に当たった」と日報に書いた瞬間に上限と誤判定する。だから
 * 「応答かどうか」は構造化された印だけで決め、文言の分類は**失敗が確定した後の
 * 材料**にしか使わない（`sdk-failure.ts` の doc の順序）。
 */
describe('検知に文言を使っていない', () => {
  it('上限の文言が入っているだけの成功した result は、失敗として扱わない', () => {
    // クローンが日報に「上限に当たった」と書いた回そのものである。
    const written = result({ subtype: 'success', result: `今日は ${ORG_SPEND_LIMIT} に当たった` });
    expect(isAnsweredResult(written)).toBe(true);
    expect(resultFailureOf(written)).toBeUndefined();
    // **文言の側は当たっている**（＝この2つを繋ぐと誤判定になる、という証拠）。
    expect(classifyUsageNotice(`今日は ${ORG_SPEND_LIMIT} に当たった`)?.kind).toBe('reached');
  });

  it('印が付いていれば、本文が英語でも日本語でも関係なく失敗（文言に依存しない）', () => {
    expect(
      assistantFailureOf(assistant({ error: 'billing_error' }), '内部で何かが壊れた')?.code,
    ).toBe('billing_error');
    expect(resultFailureOf(result({ is_error: true, result: '普通の返事' }))?.via).toBe(
      'result_is_error',
    );
  });
});
