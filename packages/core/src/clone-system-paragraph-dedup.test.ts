import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import {
  DigestSessionDelta,
  SYSTEM_PARAGRAPH_MIN_CHARS,
  SYSTEM_PARAGRAPH_REF,
} from './digest-session-delta.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores } from './testing.js';

// #4943: システムが作った長い段落は、同じ会話の2回目から短い参照にする

interface Boot {
  clone: CloneHost;
  inputs: string[];
  fire: () => Promise<void>;
}

interface Script {
  /** n 番目（1始まり）の入力を、成功ではなく失敗の result で終える。 */
  failResultAt?: number;
  /** n 番目（1始まり）の入力を受けたあとで、結果の前に流す出来事。 */
  after?: (inputCount: number) => SDKMessage[];
  /** 起動そのものを失敗させる回数（先頭から）。 */
  failFirstStarts?: number;
  /** 1ターンへ束ねる合図の上限（`createClone` の `mergedBatchLimit`）。 */
  mergedBatchLimit?: number;
}

function boot(script: Script = {}): Boot {
  const inputs: string[] = [];
  const captured: { options: Options | undefined } = { options: undefined };
  let starts = 0;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    starts += 1;
    if (starts <= (script.failFirstStarts ?? 0)) throw new Error('起動に失敗した');
    captured.options ??= params.options;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        for (const extra of script.after?.(inputs.length) ?? []) yield extra;
        yield (script.failResultAt === inputs.length
          ? {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['途中で失敗した'],
              session_id: 'sess-fake',
              uuid: `uuid-result-${String(inputs.length)}`,
            }
          : {
              type: 'result',
              subtype: 'success',
              result: 'ok',
              session_id: 'sess-fake',
              uuid: `uuid-result-${String(inputs.length)}`,
            }) as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      // 使用量の観測が取れない回は全文に戻す（#4941）ので、畳む側を見るために閾値から遠い観測を返す
      getContextUsage: async () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const clone = createClone({
    stores: createMemoryStores(),
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    redeliveryGate: ALWAYS_REDELIVER,
    ...(script.mergedBatchLimit === undefined ? {} : { mergedBatchLimit: script.mergedBatchLimit }),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return {
    clone,
    inputs,
    fire: async () => {
      const hook = captured.options?.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      await hook({ session_id: 'sess-fake' } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
    },
  };
}

let seq = 0;

/** runner の `#onPermissionDenied` が組む確認の本文と同じ形（段落は空行で分ける）。 */
function denialAsk(
  reason: string,
  head: string,
  paragraph: string = DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
): string {
  return (
    `分類器が manager の Bash 呼び出しを拒否した。この1回だけ許可しますか。\n\n` +
    `${paragraph}\n\n` +
    `理由: ${reason}\n` +
    `入力の先頭（伏せ字・最大160字。issue #1105 P0）: ${head}`
  );
}

async function send(s: Boot, event: Record<string, unknown>): Promise<string> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    id: `evt-${String(seq)}`,
    at: new Date().toISOString(),
    ...event,
  } as never);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return s.inputs[before] ?? '';
}

function denial(s: Boot, reason: string, head: string, paragraph?: string): Promise<string> {
  return send(s, {
    type: 'manager_message',
    managerId: 'mgr-1',
    kind: 'permission',
    requestId: `toolu_${String(seq + 1)}`,
    text: denialAsk(reason, head, paragraph),
  });
}

describe('システムが作った長い段落は、同じ会話の2回目から短い参照になる（#4943）', () => {
  it('⭐ 分類器の拒否の確認が2回来ると、2回目は固定の説明が参照になり、理由・入力の先頭は全文のまま', async () => {
    const s = boot();
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH.length).toBeGreaterThan(SYSTEM_PARAGRAPH_MIN_CHARS);

    const first = await denial(s, '破壊的な操作に見えた（1回目）', 'rm -rf ./a');
    const second = await denial(s, '外部への送信に見えた（2回目）', 'curl -X POST ./b');

    expect(first).toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH);
    expect(second).not.toContain('allow は「同じ入力での撃ち直しを');
    expect(second).toContain(SYSTEM_PARAGRAPH_REF);
    // 変わる値は全文
    expect(second).toContain('理由: 外部への送信に見えた（2回目）');
    expect(second).toContain('入力の先頭（伏せ字・最大160字。issue #1105 P0）: curl -X POST ./b');
    expect(second).toContain(
      '分類器が manager の Bash 呼び出しを拒否した。この1回だけ許可しますか。',
    );
    // 判断の材料（宛先の案内）は残る
    expect(second).toContain('`manager_send`');

    process.stderr.write(
      `[#4943 測定] 確認の入力: 1回目 ${String(first.length)} 字 → 2回目 ${String(second.length)} 字 ` +
        `（${String(first.length - second.length)} 字減）\n`,
    );
    // 1回目と2回目の差には、状況・台帳の断りの別の仕組み（#4489・#4937）の分も入る。この段落の分は少なくとも減っている
    expect(first.length - second.length).toBeGreaterThanOrEqual(
      DENIAL_ASK_AFTER_ANSWER_PARAGRAPH.length - SYSTEM_PARAGRAPH_REF.length,
    );
    await s.clone.stop();
  });

  it('一時規則を足せる Bash 用の固定の段落も、2回目から参照になる（#4905）', async () => {
    const s = boot();
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE.length).toBeGreaterThan(
      SYSTEM_PARAGRAPH_MIN_CHARS,
    );

    const first = await denial(
      s,
      '外部への送信に見えた（1回目）',
      'git push origin a',
      DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
    );
    const second = await denial(
      s,
      '外部への送信に見えた（2回目）',
      'git push origin b',
      DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
    );

    expect(first).toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE);
    expect(second).not.toContain('同じ入力の1回だけを10分通す一時規則');
    expect(second).toContain(SYSTEM_PARAGRAPH_REF);
    expect(second).toContain('入力の先頭（伏せ字・最大160字。issue #1105 P0）: git push origin b');
    await s.clone.stop();
  });

  it('担当の言葉（質問・道具の入力・報告の本文）と人間の発言・外部イベントは、同じ文字列でも毎回全文', async () => {
    const s = boot();
    const long = `${'同じ長い文面。'.repeat(60)}\n\n${'二つ目の段落も同じ。'.repeat(40)}`;
    expect(long.length).toBeGreaterThan(SYSTEM_PARAGRAPH_MIN_CHARS * 2);

    for (let i = 0; i < 2; i += 1) {
      const human = await send(s, {
        type: 'human_message',
        conversationId: 'conv-1',
        text: long,
      });
      expect(human).toContain(long);
      expect(human).not.toContain(SYSTEM_PARAGRAPH_REF);
    }
    for (let i = 0; i < 2; i += 1) {
      const external = await send(s, {
        type: 'external',
        source: 'github',
        payload: { body: long },
      });
      expect(external).toContain(JSON.stringify(long).slice(1, -1));
      expect(external).not.toContain(SYSTEM_PARAGRAPH_REF);
    }
    for (let i = 0; i < 2; i += 1) {
      const report = await send(s, {
        type: 'manager_message',
        managerId: 'mgr-1',
        kind: 'report',
        text: long,
      });
      expect(report).toContain(long);
      expect(report).not.toContain(SYSTEM_PARAGRAPH_REF);
    }
    for (let i = 0; i < 2; i += 1) {
      const question = await send(s, {
        type: 'manager_message',
        managerId: 'mgr-1',
        kind: 'question',
        text: long,
      });
      expect(question).toContain(long);
      expect(question).not.toContain(SYSTEM_PARAGRAPH_REF);
    }
    // 実行許可でも、固定の段落でない長い段落（道具の入力など担当の言葉）は畳まない
    for (let i = 0; i < 2; i += 1) {
      const permission = await send(s, {
        type: 'manager_message',
        managerId: 'mgr-1',
        kind: 'permission',
        text: `Bash の実行許可: ${long}`,
      });
      expect(permission).toContain(long);
      expect(permission).not.toContain(SYSTEM_PARAGRAPH_REF);
    }
    await s.clone.stop();
  });

  it('⭐ 会話が変わった（session_id が変わった）あとの確認は全文へ戻る', async () => {
    const changedSession = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-other',
      uuid: 'uuid-init-2',
    } as unknown as SDKMessage;
    const s = boot({ after: (n) => (n === 2 ? [changedSession] : []) });

    await denial(s, 'r1', 'h1');
    const second = await denial(s, 'r2', 'h2');
    expect(second).toContain(SYSTEM_PARAGRAPH_REF);
    const third = await denial(s, 'r3', 'h3');
    expect(third).toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH);
    expect(third).not.toContain(SYSTEM_PARAGRAPH_REF);
    // 全文を出した後は、また参照になる
    const fourth = await denial(s, 'r4', 'h4');
    expect(fourth).toContain(SYSTEM_PARAGRAPH_REF);
    await s.clone.stop();
  });

  it('⭐ PreCompact のあとの確認は全文へ戻る', async () => {
    const s = boot();

    await denial(s, 'r1', 'h1');
    const second = await denial(s, 'r2', 'h2');
    expect(second).toContain(SYSTEM_PARAGRAPH_REF);
    await s.fire();
    const third = await denial(s, 'r3', 'h3');
    expect(third).toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH);
    expect(third).not.toContain(SYSTEM_PARAGRAPH_REF);
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの次の確認は全文。成功したターンの次は参照のまま', async () => {
    const s = boot({ failResultAt: 2 });

    await denial(s, 'r1', 'h1');
    // 2回目は参照で入るが、そのターンは失敗で終わる
    const second = await denial(s, 'r2', 'h2');
    expect(second).toContain(SYSTEM_PARAGRAPH_REF);
    const third = await denial(s, 'r3', 'h3');
    expect(third).toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH);
    const fourth = await denial(s, 'r4', 'h4');
    expect(fourth).toContain(SYSTEM_PARAGRAPH_REF);
    await s.clone.stop();
  });

  it('⭐ 入力を SDK へ押し込めなかった回（起動の失敗）では控えが進まず、最初に実際に入る確認は全文', async () => {
    // 束の上限を1にする: 続けて積んだ2件の確認は起点の違う合図の束（#mixedSignalBatch）として1ターンにまとまり、2件とも起動の失敗に入るため。測っているのは「入らなかった回の全文を控えへ移さない」こと
    const s = boot({ failFirstStarts: 1, mergedBatchLimit: 1 });

    seq += 1;
    s.clone.post({
      id: `evt-${String(seq)}`,
      at: new Date().toISOString(),
      type: 'manager_message',
      managerId: 'mgr-1',
      kind: 'permission',
      text: denialAsk('押し込めない回', 'h0'),
    });
    // 受信箱は順に処理する: 1本目（起動の失敗で入力が入らない）の後に2本目が入る。1本目の全文が控えへ移っていれば、2本目は参照になってしまう
    const first = await denial(s, 'r1', 'h1');
    expect(first).toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH);
    expect(first).not.toContain(SYSTEM_PARAGRAPH_REF);
    await s.clone.stop();
  });
});

describe('DigestSessionDelta.foldParagraphs（単体）', () => {
  const longParagraph = `固定の段落。${'同じ文言が続く。'.repeat(30)}`;
  const text = `先頭の行\n\n${longParagraph}\n\n短い段落`;

  it('控えは commit するまで進まない。commit の後の2回目から参照になり、短い段落は常に全文', () => {
    const delta = new DigestSessionDelta();
    expect(delta.foldParagraphs(text)).toBe(text);
    // commit しない → 次も全文
    expect(delta.foldParagraphs(text)).toBe(text);
    delta.commit();
    expect(delta.foldParagraphs(text)).toBe(`先頭の行\n\n${SYSTEM_PARAGRAPH_REF}\n\n短い段落`);
  });

  it('押し込めなかった回の持ち越し（discardStaged）は控えに入らない', () => {
    const delta = new DigestSessionDelta();
    delta.foldParagraphs(text);
    delta.discardStaged();
    delta.commit();
    expect(delta.foldParagraphs(text)).toBe(text);
  });

  it('reset で控えが消え、次は全文', () => {
    const delta = new DigestSessionDelta();
    delta.foldParagraphs(text);
    delta.commit();
    delta.reset();
    expect(delta.foldParagraphs(text)).toBe(text);
  });

  it('1字でも違う段落は全文。eligible が偽の段落は畳まない', () => {
    const delta = new DigestSessionDelta();
    delta.foldParagraphs(text);
    delta.commit();
    expect(delta.foldParagraphs(`${longParagraph}。`)).toBe(`${longParagraph}。`);
    expect(delta.foldParagraphs(text, () => false)).toBe(text);
  });

  it('同じ入力の中の2つ目は全文のまま', () => {
    const delta = new DigestSessionDelta();
    const twice = `${longParagraph}\n\n${longParagraph}`;
    expect(delta.foldParagraphs(twice)).toBe(twice);
  });
});
