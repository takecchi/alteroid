import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  assistantFailureOf,
  isAnsweredResult,
  resultErrorLines,
  resultFailureOf,
} from './sdk-failure.js';
import {
  classifyUsageNotice,
  limitRecoveryOf,
  matchedUsageLimitPrefix,
  withRecoveryNote,
} from './usage-limits.js';

const ORG_SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

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

// 型に長い名前を付ける: その名前が `tsc` のエラー文にそのまま出て、SDK 更新 PR の本文に増えた語とやることの両方が届くため
type SDK_の_error_の語が増えた_この表と_sdk_failure_ts_の_doc_へ足して同じ_PR_で緑にする = Record<
  SDKAssistantMessageError,
  true
>;

const SDK_ASSISTANT_ERROR_CODES: SDK_の_error_の語が増えた_この表と_sdk_failure_ts_の_doc_へ足して同じ_PR_で緑にする =
  {
    authentication_failed: true,
    oauth_org_not_allowed: true,
    account_on_hold: true,
    verification_required: true,
    billing_error: true,
    rate_limit: true,
    overloaded: true,
    invalid_request: true,
    model_not_found: true,
    server_error: true,
    unknown: true,
    max_output_tokens: true,
    cloud_credential_error: true,
  };

describe('assistantFailureOf — assistant メッセージの失敗の印', () => {
  it('印が無ければ undefined（普通の応答を失敗にしない）', () => {
    expect(assistantFailureOf(undefined, 'なにか')).toBeUndefined();
  });

  it('error が付いていれば、その語と本文をそのまま運ぶ', () => {
    const failure = assistantFailureOf('billing_error', ORG_SPEND_LIMIT);
    expect(failure).toEqual({
      via: 'assistant_error',
      code: 'billing_error',
      text: ORG_SPEND_LIMIT,
    });
  });

  it('SDK が持つ error の語をどれも取りこぼさない', () => {
    for (const code of Object.keys(SDK_ASSISTANT_ERROR_CODES)) {
      expect(assistantFailureOf(code, 'x')?.code).toBe(code);
    }
  });

  it('空文字や文字列でない error は印として扱わない（`{}` を印にしない）', () => {
    expect(assistantFailureOf('', 'x')).toBeUndefined();
    expect(assistantFailureOf('   ', 'x')).toBeUndefined();
    expect(assistantFailureOf(1, 'x')).toBeUndefined();
    expect(assistantFailureOf({}, 'x')).toBeUndefined();
  });
});

describe('isAnsweredResult — 応答として扱ってよい result か', () => {
  it('subtype が success で is_error が立っていなければ応答', () => {
    expect(isAnsweredResult(result({}))).toBe(true);
    expect(isAnsweredResult(result({ is_error: false }))).toBe(true);
  });

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

describe('検知に文言を使っていない', () => {
  it('上限の文言が入っているだけの成功した result は、失敗として扱わない', () => {
    const written = result({ subtype: 'success', result: `今日は ${ORG_SPEND_LIMIT} に当たった` });
    expect(isAnsweredResult(written)).toBe(true);
    expect(resultFailureOf(written)).toBeUndefined();
    expect(classifyUsageNotice(`今日は ${ORG_SPEND_LIMIT} に当たった`)?.kind).toBe('reached');
  });

  it('印が付いていれば、本文が英語でも日本語でも関係なく失敗（文言に依存しない）', () => {
    expect(assistantFailureOf('billing_error', '内部で何かが壊れた')?.code).toBe('billing_error');
    expect(resultFailureOf(result({ is_error: true, result: '普通の返事' }))?.via).toBe(
      'result_is_error',
    );
  });
});

describe('cloud_credential_error — 回復の見込みを名乗らない', () => {
  const AWS_CREDENTIAL_ERROR =
    'API Error: Could not load AWS credentials · （原因の文言。実測していない）. Check or refresh your AWS credentials and try again.';
  const GOOGLE_CLOUD_CREDENTIAL_ERROR =
    'API Error: Could not load Google Cloud credentials · Could not load the default credentials. Check or refresh your Google Cloud credentials and try again.';

  it('文言は上限の合図ではない（上限のカードへ回さない）', () => {
    expect(classifyUsageNotice(AWS_CREDENTIAL_ERROR)).toBeUndefined();
    expect(classifyUsageNotice(GOOGLE_CLOUD_CREDENTIAL_ERROR)).toBeUndefined();
  });

  it('回復の見込みは `unknown`（**`time` を名乗らない**）', () => {
    expect(limitRecoveryOf(AWS_CREDENTIAL_ERROR)).toBe('unknown');
    expect(limitRecoveryOf(GOOGLE_CLOUD_CREDENTIAL_ERROR)).toBe('unknown');
  });

  it('見込みの行を足さない（`unknown` のとき文言を1文字も変えない）', () => {
    const base = `結果なしで終了: cloud_credential_error（assistant_error） / ${AWS_CREDENTIAL_ERROR}`;
    expect(withRecoveryNote(base, limitRecoveryOf(AWS_CREDENTIAL_ERROR))).toBe(base);
  });

  it('語は言い換えずそのまま運ぶ（こちらの語彙へ畳まない）', () => {
    expect(assistantFailureOf('cloud_credential_error', AWS_CREDENTIAL_ERROR)).toEqual({
      via: 'assistant_error',
      code: 'cloud_credential_error',
      text: AWS_CREDENTIAL_ERROR,
    });
  });

  it('陰性対照 — 分類できる文言では `unknown` を返さない', () => {
    expect(limitRecoveryOf(ORG_SPEND_LIMIT)).toBe('time');
    expect(
      limitRecoveryOf(
        "You've hit your individual spend limit · ask your admin to raise it at claude.ai/settings/usage",
      ),
    ).toBe('action');
  });
});

describe('verification_required — 回復の見込みを名乗らない', () => {
  const VERIFICATION_REQUIRED_TEXT =
    'API Error: organization verification required · complete verification at https://console.anthropic.com/settings/verification';

  it('文言は上限の合図ではない（上限のカードへ回さない）', () => {
    expect(classifyUsageNotice(VERIFICATION_REQUIRED_TEXT)).toBeUndefined();
  });

  it('回復の見込みは `unknown`（**`time` を名乗らない**）', () => {
    expect(limitRecoveryOf(VERIFICATION_REQUIRED_TEXT)).toBe('unknown');
  });

  it('見込みの行を足さない（`unknown` のとき文言を1文字も変えない）', () => {
    const base = `結果なしで終了: verification_required（assistant_error） / ${VERIFICATION_REQUIRED_TEXT}`;
    expect(withRecoveryNote(base, limitRecoveryOf(VERIFICATION_REQUIRED_TEXT))).toBe(base);
  });

  it('語は言い換えずそのまま運ぶ（こちらの語彙へ畳まない）', () => {
    expect(assistantFailureOf('verification_required', VERIFICATION_REQUIRED_TEXT)).toEqual({
      via: 'assistant_error',
      code: 'verification_required',
      text: VERIFICATION_REQUIRED_TEXT,
    });
  });

  it('陰性対照 — 分類できる文言では `unknown` を返さない', () => {
    expect(limitRecoveryOf(ORG_SPEND_LIMIT)).toBe('time');
    expect(
      limitRecoveryOf(
        "You've hit your individual spend limit · ask your admin to raise it at claude.ai/settings/usage",
      ),
    ).toBe('action');
  });

  it('どの接頭辞にも当たっていないこと（`unknown` になった理由まで固定する）', () => {
    expect(
      matchedUsageLimitPrefix(VERIFICATION_REQUIRED_TEXT),
      '`verification_required` の文言が USAGE_LIMIT_ERROR_PREFIXES の新しい接頭辞に ' +
        '当たるようになった（まだ time/action を名乗っているとは限らない——先に当たる ' +
        '側が起きた段階）。matchedUsageLimitPrefix(VERIFICATION_REQUIRED_TEXT) の返り値 ' +
        '（＝ここで当たった接頭辞そのもの）を確認すること。この語は実測で「人間（または ' +
        '組織の管理者）が動くまで開かない」側だと分かっているので、当たった接頭辞を ' +
        'LIMIT_RECOVERY_BY_PREFIX へ足すときはこの語の扱いも一緒に決めること' +
        '（#809 で新設した usage-limits.ts の limitRecoveryOfAssistantError は、この語を ' +
        '既に action と判断してある。矛盾する値を LIMIT_RECOVERY_BY_PREFIX 側へ足さないこと）。',
    ).toBeUndefined();
  });
});
