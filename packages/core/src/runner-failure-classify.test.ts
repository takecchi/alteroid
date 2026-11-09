import { describe, expect, it } from 'vitest';

import type { AgentTurnEnded } from './agent-events.js';
import type { CredentialStore } from './credentials.js';
import { RunnerFailureClassifier, resultTextOf } from './runner-failure-classify.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { SdkFailure } from './sdk-failure.js';
import { captureStderr } from './testing.js';

// `RunnerFailureClassifier`（`RunnerSession#applyTurnEnded` の失敗分類の前半）を、口を偽物にして直に縛る。
// 見るのは: 呼ぶ順と回数・戻りが `boolean`（Promise でない）・`emit` や `unclassifiedFailures` が同期で投げたときの伝わり方・
// `unclassifiedFailures` を参照のまま使うこと。実時間では待たない。
// `runner-failure-classify-pin.test.ts`（切り出し前の作りの出力）が、`RunnerSession` を通した外から見える結果を縛っている。

const ORG_SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";
const NOT_LOGGED_IN = 'Not logged in · Please run /login';
const NO_CREDENTIALS = undefined;
const SOME_CREDENTIALS = {} as unknown as CredentialStore;

function turnEnded(fields: Partial<AgentTurnEnded> = {}): AgentTurnEnded {
  return { type: 'turn_ended', succeeded: false, body: '', errorLines: [], denials: [], ...fields };
}

function failureOf(text: string, fields: Partial<SdkFailure> = {}): SdkFailure {
  return { via: 'result_is_error', code: 'success', text, ...fields };
}

interface Rig {
  classifier: RunnerFailureClassifier;
  emitted: RunnerEvent[];
  seen: Map<string, number>;
}

function rig(
  options: {
    credentials?: CredentialStore | undefined;
    emit?: (event: RunnerEvent) => void;
    seen?: Map<string, number>;
  } = {},
): Rig {
  const emitted: RunnerEvent[] = [];
  const seen = options.seen ?? new Map<string, number>();
  const classifier = new RunnerFailureClassifier({
    emit: (event) => {
      emitted.push(event);
      options.emit?.(event);
    },
    managerId: 'mgr-1',
    credentials: options.credentials,
    unclassifiedFailures: seen,
  });
  return { classifier, emitted, seen };
}

/** `classify` を stderr を捕まえて同期で呼ぶ（stderr の行は `captureStderr` の外へ返す）。 */
async function classifyCapturing(
  r: Rig,
  event: AgentTurnEnded,
  failure: SdkFailure | undefined,
): Promise<{ hint: boolean; lines: string[] }> {
  let hint = false;
  const lines = await captureStderr(() => {
    hint = r.classifier.classify(event, failure);
  });
  return { hint, lines: lines.filter((line) => line.includes('枠の文言として分類できなかった')) };
}

describe('failure === undefined', () => {
  it('何もしない: 戻りは false、emit も件数の更新も stderr も無い', async () => {
    const r = rig();
    const out = await classifyCapturing(
      r,
      turnEnded({ succeeded: true, body: NOT_LOGGED_IN, errorLines: [ORG_SPEND_LIMIT] }),
      undefined,
    );
    expect(out).toEqual({ hint: false, lines: [] });
    expect(r.emitted).toEqual([]);
    expect([...r.seen]).toEqual([]);
  });
});

describe('分類できた失敗', () => {
  it('failure.text から: usage_notice を 1 回だけ emit し、件数は更新せず、戻りは false（鍵の器が無くても）', async () => {
    const r = rig({ credentials: NO_CREDENTIALS });
    const out = await classifyCapturing(
      r,
      turnEnded({ errorLines: [NOT_LOGGED_IN] }),
      failureOf(ORG_SPEND_LIMIT),
    );
    expect(out).toEqual({ hint: false, lines: [] });
    expect(r.emitted).toEqual([
      {
        type: 'usage_notice',
        managerId: 'mgr-1',
        notice: { kind: 'reached', text: ORG_SPEND_LIMIT },
      },
    ]);
    expect([...r.seen]).toEqual([]);
  });

  it('errorLines から（failure.text は空）: 同じ usage_notice が出る', () => {
    const r = rig();
    const hint = r.classifier.classify(
      turnEnded({ errorLines: ['x', ORG_SPEND_LIMIT] }),
      failureOf(''),
    );
    expect(hint).toBe(false);
    expect(r.emitted).toEqual([
      {
        type: 'usage_notice',
        managerId: 'mgr-1',
        notice: { kind: 'reached', text: ORG_SPEND_LIMIT },
      },
    ]);
  });

  it('応答の本文（event.body）の上限の文面は候補に入れない', async () => {
    const r = rig();
    const out = await classifyCapturing(
      r,
      turnEnded({ body: ORG_SPEND_LIMIT }),
      failureOf('落ちた'),
    );
    expect(r.emitted).toEqual([]);
    expect(out.lines).toHaveLength(1);
    expect([...r.seen]).toEqual([['result_is_error:success', 1]]);
  });
});

describe('分類できなかった失敗', () => {
  it('件数は via:code の組で数え、初出だけ stderr に出る。参照のまま書く（渡した Map に載る）', async () => {
    const seen = new Map<string, number>([['result_is_error:success', 1]]);
    const r = rig({ seen });
    const first = await classifyCapturing(r, turnEnded(), failureOf('x'));
    expect(first.lines).toEqual([]);
    expect([...seen]).toEqual([['result_is_error:success', 2]]);

    const second = await classifyCapturing(
      r,
      turnEnded(),
      failureOf('y', { via: 'assistant_error', code: 'unknown' }),
    );
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toContain('manager=mgr-1 via=assistant_error code=unknown');
    expect([...seen]).toEqual([
      ['result_is_error:success', 2],
      ['assistant_error:unknown', 1],
    ]);
    expect(r.emitted).toEqual([]);
  });

  it.each([
    ['failure.text', turnEnded(), failureOf(NOT_LOGGED_IN)],
    ['event.errorLines', turnEnded({ errorLines: ['x', NOT_LOGGED_IN] }), failureOf('')],
    [
      'resultTextOf(event).text（event.body）',
      turnEnded({ body: NOT_LOGGED_IN }),
      failureOf('別の理由', { via: 'assistant_error', code: 'unknown' }),
    ],
    ['大文字小文字を区別しない', turnEnded(), failureOf('NOT LOGGED IN')],
  ])('鍵の器が無く、%s に Not logged in があれば true', (_label, event, failure) => {
    expect(rig({ credentials: NO_CREDENTIALS }).classifier.classify(event, failure)).toBe(true);
  });

  it('鍵の器が在れば、Not logged in があっても false（件数は数える）', () => {
    const r = rig({ credentials: SOME_CREDENTIALS });
    expect(r.classifier.classify(turnEnded(), failureOf(NOT_LOGGED_IN))).toBe(false);
    expect([...r.seen]).toEqual([['result_is_error:success', 1]]);
  });

  it('Not logged in が無ければ、鍵の器が無くても false', () => {
    expect(rig().classifier.classify(turnEnded(), failureOf('別の理由'))).toBe(false);
  });

  it('戻りは boolean そのもの（Promise でない）', () => {
    const value: unknown = rig().classifier.classify(turnEnded(), failureOf(NOT_LOGGED_IN));
    expect(value).toBe(true);
    expect(value).not.toBeInstanceOf(Promise);
  });
});

describe('口が同期で投げたとき', () => {
  it('emit が投げると classify から同期で投げ、後ろ（件数・案内）には進まない', () => {
    const r = rig({
      emit: () => {
        throw new Error('emit が落ちた（テスト用）');
      },
    });
    expect(() => r.classifier.classify(turnEnded(), failureOf(ORG_SPEND_LIMIT))).toThrow(
      'emit が落ちた（テスト用）',
    );
    expect(r.emitted).toHaveLength(1);
    expect([...r.seen]).toEqual([]);
  });

  it('unclassifiedFailures の読みが投げると classify から同期で投げ、emit は呼ばない', () => {
    const seen = new Map<string, number>();
    seen.get = () => {
      throw new Error('件数の読みが落ちた（テスト用）');
    };
    const r = rig({ seen });
    expect(() => r.classifier.classify(turnEnded(), failureOf('x'))).toThrow(
      '件数の読みが落ちた（テスト用）',
    );
    expect(r.emitted).toEqual([]);
  });
});

describe('resultTextOf（runner.ts から移した）', () => {
  it('本文があればそれ・無ければ outcome の包み・どちらも無ければ（報告なし）', () => {
    expect(resultTextOf(turnEnded({ body: '本文' }))).toEqual({ text: '本文', empty: false });
    expect(resultTextOf(turnEnded({ outcome: 'error_max_turns' }))).toEqual({
      text: '（結果なしで終了: error_max_turns）',
      empty: false,
    });
    expect(resultTextOf(turnEnded())).toEqual({ text: '（報告なし）', empty: true });
  });
});
