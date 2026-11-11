import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTurnEnded } from './agent-events.js';
import { quotaNoticeOfEnded, quotaNoticeOfError } from './clone-distill-quota-notice.js';
import type { SdkFailure } from './sdk-failure.js';
import { classifyUsageNotice } from './usage-limits.js';

// `quotaNoticeOfEnded` / `quotaNoticeOfError`（`Clone#distillFromTranscript` の「観測する枠切れ notice を決める」判断）を、入力 → 出力で直に縛る。
// 期待値は、切り出し後の出力から確かめたもの（仕様を先に書いたものではない）。
// 切り出し前の作りの出力は `clone-distill-outcome-pin.test.ts` が、`Clone` を通した外から見える結果として縛っている。
// 「後ろの候補を分類しない」は、`classifyUsageNotice` を素通しの `vi.fn` に差し替えて呼び数・呼ぶ順で見る。実時間では待たない。

vi.mock('./usage-limits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./usage-limits.js')>();
  return { ...actual, classifyUsageNotice: vi.fn(actual.classifyUsageNotice) };
});

const REACHED_1 = "You've hit your limit · resets 3pm";
const REACHED_2 = "You're out of usage credits";
const TRANSITION = "You're now using extra usage";
const WARNING = "You've used 90% of your limit";
const ORG_POLICY = 'This service is disabled for your org';
const RATE_429 = 'API Error: 429 {"type":"rate_limit_error"}';

const classify = vi.mocked(classifyUsageNotice);

beforeEach(() => {
  classify.mockClear();
});

function failureOf(text: string): SdkFailure {
  return { via: 'result_is_error', code: 'success', text };
}

function ended(fields: {
  failure?: string;
  body?: string;
  errorLines?: string[];
}): Pick<AgentTurnEnded, 'failure' | 'body' | 'errorLines'> {
  return {
    ...(fields.failure === undefined ? {} : { failure: failureOf(fields.failure) }),
    body: fields.body ?? '',
    errorLines: fields.errorLines ?? [],
  };
}

describe('quotaNoticeOfEnded', () => {
  it('候補は failure.text・body・errorLines の順で、最初の reached の1件を返す', () => {
    expect(quotaNoticeOfEnded(ended({ failure: REACHED_1 }))?.text).toBe(REACHED_1);
    expect(quotaNoticeOfEnded(ended({ body: REACHED_1 }))?.text).toBe(REACHED_1);
    expect(quotaNoticeOfEnded(ended({ errorLines: ['x', REACHED_1] }))?.text).toBe(REACHED_1);
    expect(
      quotaNoticeOfEnded(
        ended({ failure: REACHED_1, body: REACHED_2, errorLines: ["You've reached your cap"] }),
      )?.text,
    ).toBe(REACHED_1);
    expect(quotaNoticeOfEnded(ended({ failure: 'boom', body: REACHED_2 }))?.text).toBe(REACHED_2);
    expect(quotaNoticeOfEnded(ended({ body: REACHED_1, errorLines: [REACHED_2] }))?.text).toBe(
      REACHED_1,
    );
    expect(quotaNoticeOfEnded(ended({ errorLines: [REACHED_1, REACHED_2] }))?.text).toBe(REACHED_1);
    expect(quotaNoticeOfEnded(ended({ errorLines: [REACHED_1, REACHED_2] }))?.kind).toBe('reached');
  });

  it('reached 以外（transition・warning・org_policy・429 の文言・無関係）は拾わず、後ろの reached は拾う', () => {
    expect(
      quotaNoticeOfEnded(ended({ failure: TRANSITION, body: WARNING, errorLines: [ORG_POLICY] })),
    ).toBeUndefined();
    expect(quotaNoticeOfEnded(ended({ failure: TRANSITION, errorLines: [REACHED_2] }))?.text).toBe(
      REACHED_2,
    );
    expect(
      quotaNoticeOfEnded(ended({ failure: 'boom', body: 'ただの失敗', errorLines: ['err'] })),
    ).toBeUndefined();
    expect(quotaNoticeOfEnded(ended({ failure: RATE_429 }))).toBeUndefined();
  });

  it('候補が無い・空の候補は分類しても reached にならず、undefined の failure は飛ばして数えない', () => {
    expect(quotaNoticeOfEnded(ended({}))).toBeUndefined();
    // failure が無いので候補は body（空文字）の1本だけ。空文字は飛ばさず分類にかかる
    expect(classify.mock.calls).toEqual([['']]);
    classify.mockClear();
    expect(
      quotaNoticeOfEnded(ended({ failure: '', body: '   ', errorLines: ['', REACHED_1] }))?.text,
    ).toBe(REACHED_1);
    expect(classify.mock.calls).toEqual([[''], ['   '], [''], [REACHED_1]]);
  });

  it('最初の reached で止まり、後ろの候補は分類しない（呼ぶ順・呼び数）', () => {
    quotaNoticeOfEnded(
      ended({ failure: REACHED_1, body: REACHED_2, errorLines: ['a', "You've reached your cap"] }),
    );
    expect(classify.mock.calls).toEqual([[REACHED_1]]);

    classify.mockClear();
    quotaNoticeOfEnded(ended({ failure: 'boom', body: REACHED_2, errorLines: ['a', 'b'] }));
    expect(classify.mock.calls).toEqual([['boom'], [REACHED_2]]);

    classify.mockClear();
    quotaNoticeOfEnded(ended({ errorLines: [REACHED_1, REACHED_2] }));
    expect(classify.mock.calls).toEqual([[''], [REACHED_1]]);
  });

  it('reached が無ければ全部の候補を順に分類して undefined', () => {
    expect(
      quotaNoticeOfEnded(ended({ failure: 'f', body: 'b', errorLines: ['e1', 'e2'] })),
    ).toBeUndefined();
    expect(classify.mock.calls).toEqual([['f'], ['b'], ['e1'], ['e2']]);
  });

  it('戻りは Promise でなく同期の値（async で包まない）', () => {
    const result = quotaNoticeOfEnded(ended({ failure: REACHED_1 }));
    expect(result).not.toBeInstanceOf(Promise);
    expect(quotaNoticeOfEnded(ended({}))).not.toBeInstanceOf(Promise);
  });

  it('入力の欄が同期で投げたときは、その例外がそのまま同期で出る', () => {
    const boom = new Error('欄が投げた');
    const hostile = {
      get failure(): SdkFailure | undefined {
        throw boom;
      },
      body: '',
      errorLines: [],
    } as unknown as Pick<AgentTurnEnded, 'failure' | 'body' | 'errorLines'>;
    expect(() => quotaNoticeOfEnded(hostile)).toThrow(boom);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('quotaNoticeOfError', () => {
  it('reached の文言は String(error) で分類し、text は reasonOf(error)（1行の Error では String(error) と同じ）', () => {
    const notice = quotaNoticeOfError(new Error(REACHED_1));
    expect(notice?.kind).toBe('reached');
    expect(notice?.text).toBe(`Error: ${REACHED_1}`);
    expect(classify.mock.calls).toEqual([[`Error: ${REACHED_1}`]]);
  });

  it('Error でない文字列も String(error) で分類する', () => {
    const notice = quotaNoticeOfError(REACHED_1);
    expect(notice?.kind).toBe('reached');
    expect(notice?.text).toBe(REACHED_1);
    expect(quotaNoticeOfError('plain string')).toBeUndefined();
  });

  it('reached にならず 429 なら、reasonOf(error) の text で reached を作る', () => {
    expect(quotaNoticeOfError(new Error(RATE_429))).toEqual({
      kind: 'reached',
      text: `Error: ${RATE_429}`,
    });
    expect(quotaNoticeOfError(new Error(`${TRANSITION} API Error: 429`))).toEqual({
      kind: 'reached',
      text: `Error: ${TRANSITION} API Error: 429`,
    });
  });

  it('reached の文言の例外も 2行目以降の値は text に載らない（reasonOf は1行目だけ。#6698）', () => {
    const notice = quotaNoticeOfError(new Error(`${REACHED_1}\nparams: sk-live-SECRET-VALUE`));
    expect(notice).toEqual({ kind: 'reached', text: `Error: ${REACHED_1}` });
    expect(quotaNoticeOfError(`${REACHED_1}\nparams: sk-live-SECRET-VALUE`)?.text).not.toContain(
      'SECRET-VALUE',
    );
  });

  // 値を運ばないことの代償として固定する（#6698）: 枠の文言が2行目以降にある例外は reached のままだが、text には載らない。
  // 枠の名前・リセットの時刻が1行目にある通常の文言（上の試験）は、そのまま残る。
  it('枠の文言が2行目にある例外: 分類は reached のまま、text は1行目だけ（2行目の文言は残らない）', () => {
    expect(quotaNoticeOfError(new Error(`API request failed\n${REACHED_1}`))).toEqual({
      kind: 'reached',
      text: 'Error: API request failed',
    });
  });

  it('cause 付きの Error: reached の文言でも 429 でも、reasonOf の枝（cause を <- で畳んだ文）', () => {
    const reached = quotaNoticeOfError(new Error(REACHED_2, { cause: new Error('下の理由') }));
    expect(reached?.text).toBe(`Error: ${REACHED_2} <- Error: 下の理由`);
    expect(quotaNoticeOfError(new Error(RATE_429, { cause: new Error('下の理由') }))).toEqual({
      kind: 'reached',
      text: `Error: ${RATE_429} <- Error: 下の理由`,
    });
  });

  it('transition・warning・org_policy・関係の無い Error は undefined', () => {
    for (const text of [TRANSITION, WARNING, ORG_POLICY, 'network down']) {
      expect(quotaNoticeOfError(new Error(text))).toBeUndefined();
    }
  });

  it('戻りは Promise でなく同期の値', () => {
    expect(quotaNoticeOfError(new Error(RATE_429))).not.toBeInstanceOf(Promise);
    expect(quotaNoticeOfError(new Error('x'))).not.toBeInstanceOf(Promise);
  });

  it('String(error) が投げる値でも、その例外がそのまま同期で出る', () => {
    const boom = new Error('toString が投げた');
    const hostile = {
      toString(): string {
        throw boom;
      },
    };
    expect(() => quotaNoticeOfError(hostile)).toThrow(boom);
  });
});
