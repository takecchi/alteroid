import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { InboxEvent } from '@alteroid/core';

import {
  createCloneWakeGate,
  describeReopenedTokenNotice,
  isTokenPoolReopenedNotice,
  reopenedTokenOf,
  tokenRotationStream,
  TOKEN_POOL_REOPENED_SOURCE,
  worthDeliveringNow,
} from './index.js';
import type { CloneWakeGate } from './index.js';

describe('tokenRotationStream', () => {
  it.each([
    ['rotated', 'stdout'],
    ['not_rotated', 'stdout'],
    ['restored', 'stdout'],
    ['exhausted', 'stderr'],
    ['sweep_stopped', 'stderr'],
    ['restore_failed', 'stderr'],
    ['parked', 'stderr'],
    ['recovered', 'stdout'],
    ['reopened', 'stdout'],
  ] as const)('%s は %s へ出す', (event, expected) => {
    const stream = tokenRotationStream(event);

    expect(stream).toBe(expected === 'stdout' ? process.stdout : process.stderr);
  });
});

describe('index.ts の原文で測る配線（onSwap の引き取り / 枠の観測の振り分け）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  const blockOf = (opener: RegExp): string[] => {
    const lines = source.split('\n');
    const heads = lines.filter((line) => opener.test(line));
    expect(heads).toHaveLength(1);
    const start = lines.findIndex((line) => opener.test(line));
    const indent = (/^\s*/.exec(lines[start] ?? '')?.[0] ?? '').length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '') continue;
      if ((/^\s*/.exec(line)?.[0] ?? '').length <= indent) return lines.slice(start, i + 1);
    }
    throw new Error('ブロックの終わりが見つからない（字下げの前提が崩れている）');
  };

  const code = (lines: string[]): string[] =>
    lines.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));

  it('入れ替えの知らせが、引き取りの口を宛先つきで起こす', () => {
    const calls = code(blockOf(/^\s*onSwap:\s*\(/)).filter((line) =>
      line.includes('takeOverOnSwap('),
    );

    expect(calls).not.toEqual([]);
    expect(calls.filter((line) => /takeOverOnSwap\(\s*\)/.test(line))).toEqual([]);
  });

  it('⚠️ 成功の観測は observe へ落ちない（#681 (1)。2本目の生産者へ振る）', () => {
    const body = code(blockOf(/^\s*onUsageObservation:\s*async\s*\(/));

    const branch = body.findIndex((line) => line.includes('observation.succeeded === true'));
    const handoff = body.findIndex((line) => line.includes('observeTurnSuccess('));
    const escape = body.findIndex((line) => /^\s*return;\s*$/.test(line));
    const observe = body.findIndex((line) => line.includes('tokenRotator.observe('));

    expect([branch, handoff, escape, observe].filter((i) => i < 0)).toEqual([]);
    expect(branch).toBeLessThan(handoff);
    expect(handoff).toBeLessThan(escape);
    expect(escape).toBeLessThan(observe);
  });

  it('その口は、走行中の委譲と台帳だけの委譲を両方とも起こす', () => {
    const body = code(blockOf(/^\s*takeOverOnSwap\s*=\s*\(/));

    expect(body.filter((line) => line.includes('reattachRunner('))).not.toEqual([]);
    expect(body.filter((line) => line.includes('takeOver('))).not.toEqual([]);
  });
});

describe('index.ts の原文で測る配線（onLost が日誌へ残るか。#1381）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  const blockOf = (opener: RegExp): string[] => {
    const lines = source.split('\n');
    const heads = lines.filter((line) => opener.test(line));
    expect(heads).toHaveLength(1);
    const start = lines.findIndex((line) => opener.test(line));
    const indent = (/^\s*/.exec(lines[start] ?? '')?.[0] ?? '').length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '') continue;
      if ((/^\s*/.exec(line)?.[0] ?? '').length <= indent) return lines.slice(start, i + 1);
    }
    throw new Error('ブロックの終わりが見つからない（字下げの前提が崩れている）');
  };

  const code = (lines: string[]): string[] =>
    lines.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));

  it('器を失ったら、記録用の関数を宛先・原因つきで呼ぶ', () => {
    const calls = code(blockOf(/^\s*onLost:\s*\(/)).filter((line) =>
      line.includes('reportRunnerLost('),
    );

    expect(calls).not.toEqual([]);
    expect(calls.filter((line) => /reportRunnerLost\(\s*\)/.test(line))).toEqual([]);
  });

  it('記録用の関数は、日誌へ external_event として書く', () => {
    // ブロックを1つの文字列にしてから見る: Prettier がメソッドチェーンを2行に割るので、1行の部分一致では見えないため。
    const bodyText = code(blockOf(/^\s*const reportRunnerLost\s*=\s*\(/)).join('\n');

    expect(/stores\.journal[\s\S]*?\.append\(/.test(bodyText)).toBe(true);
    expect(bodyText.includes("type: 'external_event'")).toBe(true);
    expect(bodyText.includes("source: 'runner'")).toBe(true);
  });

  it('記録用の関数を呼ぶのは onLost の1箇所だけ（onLost 以外まで記録しない）', () => {
    const calls = code(source.split('\n')).filter((line) => line.includes('reportRunnerLost('));

    expect(calls).toHaveLength(1);
  });
});

describe('index.ts の原文で測る配線（onPlacementResources → 自動畳みの2つ目の契機、#1394）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  const blockOf = (opener: RegExp): string[] => {
    const lines = source.split('\n');
    const heads = lines.filter((line) => opener.test(line));
    expect(heads).toHaveLength(1);
    const start = lines.findIndex((line) => opener.test(line));
    const indent = (/^\s*/.exec(lines[start] ?? '')?.[0] ?? '').length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '') continue;
      if ((/^\s*/.exec(line)?.[0] ?? '').length <= indent) return lines.slice(start, i + 1);
    }
    throw new Error('ブロックの終わりが見つからない（字下げの前提が崩れている）');
  };

  const code = (lines: string[]): string[] =>
    lines.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));

  it('配置が資源の結果を横流ししてきたら、2つ目の契機の口を実際に呼ぶ', () => {
    const calls = code(blockOf(/^\s*onPlacementResources:\s*\(/)).filter((line) =>
      line.includes('autoFoldOnPlacementResources('),
    );

    expect(calls).not.toEqual([]);
  });

  it('pids が取れなかった報告は弾き、取れたものだけ ManagerPool へ渡す', () => {
    const body = code(blockOf(/^\s*autoFoldOnPlacementResources\s*=\s*\(/)).join('\n');

    expect(body.includes('resources?.pids === undefined')).toBe(true);
    expect(body.includes('autoFoldOnPlacementPressure')).toBe(true);
    expect(body.includes('report.runnerId')).toBe(true);
    expect(body.includes('report.resources.pids')).toBe(true);
  });

  it('ManagerPool.autoFoldOnPlacementPressure を呼ぶのはこの1箇所だけ', () => {
    const calls = code(source.split('\n')).filter((line) =>
      line.includes('autoFoldOnPlacementPressure'),
    );
    const invocations = calls.filter((line) => line.includes('clone.managers'));

    expect(invocations).toHaveLength(1);
  });
});

describe('reopenedTokenOf', () => {
  it('回した回は戻ったと数える（いま通る鍵に移った）', () => {
    expect(
      reopenedTokenOf({
        kind: 'rotated',
        toTokenId: 'tok-b',
        toLabel: '予備1',
        generation: 2,
        signal: 'reached',
        spread: [],
        why: '枠',
      }),
    ).toEqual({ tokenId: 'tok-b', label: '予備1', how: '回した' });
  });

  it('止まっていた現役が開いた回も戻ったと数える', () => {
    expect(
      reopenedTokenOf({
        kind: 'ignored',
        signal: 'none',
        reason: 'account_probe',
        recovered: { tokenId: 'tok-a', label: '本命', source: 'account_probe' },
        why: 'probe で通ることを観測できた',
      }),
    ).toEqual({ tokenId: 'tok-a', label: '本命', how: 'また通るようになった' });
  });

  it('現役の冷却が明けた回も戻ったと数える（#833）', () => {
    expect(
      reopenedTokenOf({
        kind: 'ignored',
        signal: 'none',
        reason: 'tick',
        reopened: {
          tokenId: 'tok-a',
          label: '本命',
          cooldownUntil: '2026-09-11T13:20:00.000Z',
        },
        why: '現役の冷却が明けた',
      }),
    ).toEqual({ tokenId: 'tok-a', label: '本命', how: '冷却が明けた' });
  });

  it('parked は戻っていない（撒いた鍵はまだ通らない）', () => {
    expect(
      reopenedTokenOf({
        kind: 'parked',
        tokenId: 'tok-b',
        label: '予備1',
        generation: 2,
        cooldownUntil: Date.parse('2026-09-07T05:00:00.000Z'),
        signal: 'stranded',
        spread: [],
        why: 'いま通る候補は1本も無い',
      }),
    ).toBeUndefined();
  });

  it('何も起きていない回は戻っていない（目盛りが毎分ここへ来る）', () => {
    expect(
      reopenedTokenOf({
        kind: 'ignored',
        signal: 'none',
        reason: 'tick',
        why: '記録の上ではいまの現役が通る',
      }),
    ).toBeUndefined();
  });

  it('候補が無い回は戻っていない', () => {
    expect(
      reopenedTokenOf({
        kind: 'exhausted',
        signal: 'reached',
        why: '試せる候補を使い切った',
      }),
    ).toBeUndefined();
  });
});

describe('通る鍵に戻ったときに起こす配線', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('クローンへ合図を1つ入れ、マネージャーの引き取りも起こす', () => {
    const body = source.slice(source.indexOf('const reopened = reopenedTokenOf(outcome);'));
    const block = body.slice(0, body.indexOf('\n    if (entry === null) return;'));

    expect(block).toContain('clone.post(');
    // 1行では見ない: prettier が `clone.managers` と `.restore()` を別の行へ割るため。
    expect(block).toContain('clone.managers');
    expect(block).toContain('.restore(');
    expect(block).toContain('.resumeStoppedByUsage(');
  });

  it('指名が変わったらクローンのセッションを作り直す（parked も含む）', () => {
    // 1行では見ない: 複数行の三項になっているため。
    const at = source.indexOf('const recycled =');
    expect(at).toBeGreaterThan(-1);
    const decl = source.slice(
      at,
      source.indexOf(';', source.indexOf('recycleSessionForToken()', at)),
    );

    expect(decl).toContain("outcome.kind === 'rotated'");
    expect(decl).toContain("outcome.kind === 'parked'");
    expect(decl).toContain('clone.recycleSessionForToken()');
  });
});

describe('再開の合図は、セッションが畳まれた後に入れる', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const reopened = reopenedTokenOf(outcome);'));
  const block = body.slice(0, body.indexOf('\n    if (entry === null) return;'));

  it('recycleSessionForToken の返り値を捨てていない', () => {
    expect(source).toContain('clone.recycleSessionForToken()');
    expect(source).toMatch(/const recycled =[\s\S]*clone\.recycleSessionForToken\(\)/);
  });

  it("'now' のときだけ即座に入れ、'deferred' なら保留する", () => {
    expect(block).toContain("if (recycled === 'now') wake();");
    expect(block).toContain('else pendingTokenWake = wake;');
  });

  it('保留した合図は onTokenSessionRecycled で入る（取り出してから呼ぶ）', () => {
    const hook = source.slice(source.indexOf('onTokenSessionRecycled: () => {'));
    const hookBody = hook.slice(0, hook.indexOf('\n    },'));
    expect(hookBody).toContain('const wake = pendingTokenWake;');
    expect(hookBody).toContain('pendingTokenWake = undefined;');
    expect(hookBody).toContain('wake?.();');
    expect(hookBody.indexOf('pendingTokenWake = undefined;')).toBeLessThan(
      hookBody.indexOf('wake?.();'),
    );
  });

  it('保留は高々1つしか持たない（後の1回だけが要る）', () => {
    expect(source).toContain('let pendingTokenWake: (() => void) | undefined = undefined;');
  });
});

// `ReopenedHow` を import せずローカルに宣言する: `index.ts` が `ReopenedToken` / `ReopenedHow` を export していないため。
type ReopenedHowFixture = 'また通るようになった' | '回した' | '冷却が明けた';

function reopened(
  tokenId: string,
  how: ReopenedHowFixture = 'また通るようになった',
): { tokenId: string; label: string; how: ReopenedHowFixture } {
  return { tokenId, label: tokenId, how };
}

describe('createCloneWakeGate', () => {
  it('クローンが枠で止まっているなら配る（畳んでいなければ folded は0）', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });
  });

  it('クローンが枠で止まっていないなら畳む（配らない）', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
  });

  it('畳んだ回数を数え、配る回にその数を渡す', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 3 });
  });

  it('配ったら0へ戻る（次に畳み始めたら1から数え直す）', () => {
    const gate = createCloneWakeGate();

    gate.decide(reopened('tok-a'), false, false);
    gate.decide(reopened('tok-a'), false, false);
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 2 });

    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'fold' });

    gate.observeUnusable();
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 1 });

    gate.decide(reopened('tok-a'), false, false);
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'fold' });

    gate.observeUnusable();
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 2 });
  });

  it('トークンごとに独立して数える', () => {
    const gate = createCloneWakeGate();

    gate.decide(reopened('tok-a'), false, false);
    gate.decide(reopened('tok-a'), false, false);
    expect(gate.decide(reopened('tok-b'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 2 });
  });

  it('🔴 不変条件3: 落ちる→戻る→また落ちる→また戻る で2本目の「戻った」も必ず届く', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });

    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });

    gate.observeUnusable();
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 1 });

    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    gate.observeUnusable();
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 2 });
  });

  it('🔴 #1223: 同じ身元が60回続けて来ても、配るのは最初の1回だけ', () => {
    const gate = createCloneWakeGate();

    const kinds = Array.from(
      { length: 60 },
      () => gate.decide(reopened('tok-a'), true, false).kind,
    );

    expect(kinds[0]).toBe('wake');
    expect(kinds.slice(1)).toEqual(Array.from({ length: 59 }, () => 'fold'));
  });

  it('🔴 #1223 再発: cloneBlocked が true/false を往復しても、observeUnusable() 無しでは同じ身元を配り直さない', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });

    for (let i = 0; i < 3; i++) {
      expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
      expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'fold' });
    }
  });

  it('別のトークンの配達に挟まれても、先のトークンの重複は畳まれ続ける', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    expect(gate.decide(reopened('tok-b'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'fold' });
  });

  it('🔴 #1223 再発2: 観測ベースの回復が同じ鍵・resetsAt 未来のままなら、observeUnusable() を挟んでも配らない（20周・配達0・畳み20）', () => {
    const gate = createCloneWakeGate();

    const kinds = Array.from({ length: 20 }, () => {
      gate.observeUnusable();
      return gate.decide(reopened('tok-a'), true, false, true).kind;
    });

    expect(kinds.filter((kind) => kind === 'wake')).toHaveLength(0);
    expect(kinds.filter((kind) => kind === 'fold')).toHaveLength(20);
  });

  it('4つ目の条件が偽なら、observeUnusable() を挟んだ回はいつもどおり配る（3つ目の条件・不変条件3を壊さない）', () => {
    const gate = createCloneWakeGate();

    gate.decide(reopened('tok-a'), true, false, false);
    gate.observeUnusable();
    expect(gate.decide(reopened('tok-a'), true, false, false)).toEqual({
      kind: 'wake',
      folded: 0,
    });
  });

  it('4つ目の条件は3つ目の条件より前に見る（told に一致しない新しい身元でも、stale なら畳む）', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), true, false, true)).toEqual({ kind: 'fold' });
  });

  it('4つ目の条件で畳んでも folded は積み上がり、次に配る回の本文へ渡る', () => {
    const gate = createCloneWakeGate();

    gate.decide(reopened('tok-a'), true, false, true);
    gate.decide(reopened('tok-a'), true, false, true);
    expect(gate.decide(reopened('tok-a'), true, false, false)).toEqual({
      kind: 'wake',
      folded: 2,
    });
  });
});

// `source` を引数で受ける: 呼び出し側で `{ ...tokenPoolEvent(), source }` とスプレッドすると、union の `source` を持たない枝に対して `TS2322` で落ちるため。
function tokenPoolEvent(source: string = TOKEN_POOL_REOPENED_SOURCE): InboxEvent {
  return {
    type: 'external',
    id: 'evt-token-pool-1',
    at: '2026-09-07T00:00:00.000Z',
    source,
    payload: { text: 'ダミー' },
  };
}

describe('isTokenPoolReopenedNotice', () => {
  it('external かつ source が token-pool なら真', () => {
    expect(isTokenPoolReopenedNotice(tokenPoolEvent())).toBe(true);
  });

  it('external でも source が違えば偽', () => {
    const event = tokenPoolEvent('runner-registry');
    expect(isTokenPoolReopenedNotice(event)).toBe(false);
  });

  it('external 以外は真になりようがない（型で弾かれる）', () => {
    const event: InboxEvent = {
      type: 'human_message',
      id: 'evt-human-1',
      at: '2026-09-07T00:00:00.000Z',
      text: 'こんにちは',
      conversationId: 'conv-1',
    };
    expect(isTokenPoolReopenedNotice(event)).toBe(false);
  });
});

describe('歯1: CloneWakeGate.decide と redeliveryGate は同じ答えを返す', () => {
  const redeliveryGate = (
    event: InboxEvent,
    context: { usageBlocked: boolean; releasePending: boolean },
  ): boolean =>
    isTokenPoolReopenedNotice(event)
      ? worthDeliveringNow(context.usageBlocked, context.releasePending)
      : true;

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const)(
    'usageBlocked=%s / releasePending=%s のとき、wake の判定と一致する',
    (blocked, releasePending) => {
      const gate = createCloneWakeGate();

      const wakeSaysWake = gate.decide(reopened('tok-a'), blocked, releasePending).kind === 'wake';
      const gateSaysDeliver = redeliveryGate(tokenPoolEvent(), {
        usageBlocked: blocked,
        releasePending,
      });

      expect(gateSaysDeliver).toBe(wakeSaysWake);
    },
  );

  it('token-pool 以外の合図は usageBlocked / releasePending に関わらず常に配る（wake 側の対象外）', () => {
    const other = tokenPoolEvent('runner-registry');
    expect(redeliveryGate(other, { usageBlocked: true, releasePending: false })).toBe(true);
    expect(redeliveryGate(other, { usageBlocked: false, releasePending: false })).toBe(true);
    expect(redeliveryGate(other, { usageBlocked: true, releasePending: true })).toBe(true);
    expect(redeliveryGate(other, { usageBlocked: false, releasePending: true })).toBe(true);
  });
});

describe('本番の配線: redeliveryGate は wake() と同じ部品を呼ぶ', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('redeliveryGate が isTokenPoolReopenedNotice と worthDeliveringNow を呼ぶ', () => {
    const at = source.indexOf('redeliveryGate: (');
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf('\n  });', at));

    expect(block).toContain('isTokenPoolReopenedNotice(event)');
    expect(block).toContain('worthDeliveringNow(usageBlocked, releasePending)');
  });

  it('redeliveryGate が staleObservedRecoveryNoticeEvent を呼び、必要な4つの材料を渡す', () => {
    const at = source.indexOf('redeliveryGate: (');
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf('\n  });', at));

    expect(block).toContain('staleObservedRecoveryNoticeEvent(');
    expect(block).toContain('usageBlockedResetsAt');
    expect(block).toContain('usageBlockedTokenId');
    expect(block).toContain(
      'worthDeliveringNow(usageBlocked, releasePending) &&\n' +
        '          !staleObservedRecoveryNoticeEvent(event, usageBlockedResetsAt, usageBlockedTokenId)',
    );
  });
});

describe('本番の配線: createClone に AUTH_WITHHELD_ENV_KEYS が渡る（Issue #1495 ①）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('createClone の withheldEnvKeys に AUTH_WITHHELD_ENV_KEYS が渡る', () => {
    const at = source.indexOf('const clone = createClone({');
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf('\n  });', at));

    expect(block).toContain('withheldEnvKeys: [...AUTH_WITHHELD_ENV_KEYS]');
    expect(block).not.toContain('withheldEnvKeys: storage.withheldEnvKeys');
    expect(block).not.toContain('...storage.withheldEnvKeys');
  });
});

describe('describeReopenedTokenNotice', () => {
  const reopened = { tokenId: 'tok-a', label: '本命', how: 'また通るようになった' as const };
  const observedAt = '2026-09-13T12:50:03.000Z';

  it('畳んでいなければ断り書きを付けない（陽性対照: 本文は従来と1文字も変わらない）', () => {
    const text = describeReopenedTokenNotice(reopened, 0, observedAt);

    expect(text).toBe(
      '認証トークンが通る状態に戻った（また通るようになった）: ' +
        '「本命」（id tok-a）。枠で止まっていた仕事は、ここから再開できる。',
    );
    expect(text).not.toContain('まとめた');
    expect(text).not.toContain(observedAt);
  });

  it('畳んだ件数が本文に出る（届いた総数 ＝ 畳んだ数 + 配った1件）', () => {
    const text = describeReopenedTokenNotice(reopened, 3, observedAt);

    expect(text).toContain('4 件届き、1件にまとめた');
  });

  it('畳んだ回は本文に観測時刻（observedAt）をそのまま名乗る', () => {
    const text = describeReopenedTokenNotice(reopened, 3, observedAt);

    expect(text).toContain(`本文は ${observedAt} の観測である`);
  });

  it('how が「回した」でも同じ形で本文に出る（観測時刻も添う）', () => {
    const text = describeReopenedTokenNotice({ ...reopened, how: '回した' }, 1, observedAt);

    expect(text).toContain('認証トークンが通る状態に戻った（回した）');
    expect(text).toContain('2 件届き、1件にまとめた');
    expect(text).toContain(observedAt);
  });
});

describe('子プロセスの env の土台は、書き写す前のスナップショットである（2026-10-06）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('スナップショット → 移行 → 書き写し の順に並ぶ', () => {
    const anchors = [
      'const bootEnvSnapshot: NodeJS.ProcessEnv = { ...process.env };',
      'await migrateEnvBaseCredentialsOnce(stores, bootEnvSnapshot);',
      'await applyAppScopedEnvVars(stores, process.env, localRunnerEnv);',
    ];
    expect(missingAnchors(source, anchors)).toEqual([]);
    const snapshotAt = source.indexOf(anchors[0] ?? '');
    const migrateAt = source.indexOf(anchors[1] ?? '');
    const applyAt = source.indexOf(anchors[2] ?? '');
    expect(snapshotAt).toBeLessThan(migrateAt);
    expect(migrateAt).toBeLessThan(applyAt);
  });

  it('クローンの子の土台と、同一プロセスの runner の env に、スナップショット由来を渡す', () => {
    expect(
      missingAnchors(source, [
        'childEnvBase: bootEnvSnapshot,',
        'env: localRunnerEnv,',
        'env: options.env,',
      ]),
    ).toEqual([]);
  });

  it('正本の更新が成功したら、クローンのセッションをターンの境界で畳む（onApplied）', () => {
    const at = source.indexOf('onApplied: () => {');
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, source.indexOf('},', at));
    expect(body).toContain('clone.recycleSessionForToken()');
  });
});

function missingAnchors(body: string, anchors: readonly string[]): string[] {
  return anchors.filter((anchor) => !body.includes(anchor));
}

describe('クローンの門は clone.post だけを絞る（restore / resumeStoppedByUsage は無条件）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const wakeStart = source.indexOf('const wake = () => {');
  const wakeEnd = source.indexOf('\n      if (recycled === ', wakeStart);
  const wakeBody = source.slice(wakeStart, wakeEnd);

  it('clone.post は cloneWakeGate.decide の判定の中にある', () => {
    const decideAt = wakeBody.indexOf('cloneWakeGate.decide(');
    const postAt = wakeBody.indexOf('clone.post(');
    const ifFoldAt = wakeBody.indexOf("decision.kind === 'fold'");

    expect(
      missingAnchors(wakeBody, [
        'cloneWakeGate.decide(',
        'clone.post(',
        "decision.kind === 'fold'",
      ]),
    ).toEqual([]);
    expect(decideAt).toBeLessThan(ifFoldAt);
    expect(ifFoldAt).toBeLessThan(postAt);
  });

  it('restore() / resumeStoppedByUsage() は判定の分岐（if/else）の外にある', () => {
    const restoreAt = wakeBody.indexOf('clone.managers');
    const resumeAt = wakeBody.indexOf('.resumeStoppedByUsage(');
    const postAt = wakeBody.indexOf('clone.post(');

    expect(
      missingAnchors(wakeBody, ['clone.managers', '.resumeStoppedByUsage(', 'clone.post(']),
    ).toEqual([]);
    expect(postAt).toBeLessThan(restoreAt);
    expect(restoreAt).toBeLessThan(resumeAt);
  });

  it('clone.post は identity に deliveredIdentity(reopened) を渡す', () => {
    const postAt = wakeBody.indexOf('clone.post({');
    const postEnd = wakeBody.indexOf('\n          });', postAt);
    const postBlock = wakeBody.slice(postAt, postEnd);

    expect(
      missingAnchors(postBlock, [
        'text: describeReopenedTokenNotice(reopened, decision.folded, observedAt),',
        'tokenId: reopened.tokenId,',
        'observedRecovery,',
        'identity: deliveredIdentity(reopened),',
      ]),
    ).toEqual([]);
  });

  it('本文へ渡す observedAt と、合図の at は同じ変数（観測時刻のズレを防ぐ）', () => {
    const elseAt = wakeBody.indexOf('} else {', wakeBody.indexOf("decision.kind === 'fold'"));
    const postAt = wakeBody.indexOf('clone.post({', elseAt);
    const postEnd = wakeBody.indexOf('\n          });', postAt);
    const elseBlock = wakeBody.slice(elseAt, postEnd);

    expect(
      missingAnchors(elseBlock, [
        'const observedAt = new Date().toISOString();',
        'at: observedAt,',
        'describeReopenedTokenNotice(reopened, decision.folded, observedAt)',
      ]),
    ).toEqual([]);
  });
});

describe('recovered の日誌行は、受信箱へ配ったかどうかと無関係に必ず出る', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  // `settleTokenOutcome` の本体だけに絞る: `stores.journal.append(` は関数の外にも在り、そこまで数えると「1箇所だけ」が測れないため。
  const fnStart = source.indexOf('async function settleTokenOutcome(');
  const fnEnd = source.indexOf('tokenWatch = startTokenRotationWatch({', fnStart);
  const fnBody = source.slice(fnStart, fnEnd);

  it('entry の計算は、クローンの門（reopened のブロック）より前で行う', () => {
    const entryAt = fnBody.indexOf('const entry = tokenRotationEntry(outcome, observed);');
    const reopenedAt = fnBody.indexOf('const reopened = reopenedTokenOf(outcome);');

    expect(
      missingAnchors(fnBody, [
        'const entry = tokenRotationEntry(outcome, observed);',
        'const reopened = reopenedTokenOf(outcome);',
      ]),
    ).toEqual([]);
    expect(entryAt).toBeLessThan(reopenedAt);
  });

  it('journal への追記は settleTokenOutcome の中に1箇所だけで、クローンの門の分岐に複製されていない', () => {
    const occurrences = fnBody.split('stores.journal.append(entry)').length - 1;
    expect({ 'settleTokenOutcome の中の stores.journal.append(entry) の数': occurrences }).toEqual({
      'settleTokenOutcome の中の stores.journal.append(entry) の数': 1,
    });

    const reopenedBlockStart = fnBody.indexOf('if (reopened !== undefined) {');
    const appendAt = fnBody.indexOf('stores.journal.append(entry)');
    const closeAt = fnBody.indexOf('\n    }\n\n    if (entry === null) return;');

    expect(
      missingAnchors(fnBody, [
        'if (reopened !== undefined) {',
        '\n    }\n\n    if (entry === null) return;',
      ]),
    ).toEqual([]);
    expect(closeAt).toBeLessThan(appendAt);
    expect(reopenedBlockStart).toBeLessThan(closeAt);
  });
});

describe('settleTokenOutcome への畳みの配線（issue #1311 段B）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const fnStart = source.indexOf('async function settleTokenOutcome(');
  const fnEnd = source.indexOf('tokenWatch = startTokenRotationWatch({', fnStart);
  const fnBody = source.slice(fnStart, fnEnd);

  it('stdout への1行（tokenRotationStream(...).write）は畳みの判定より前——畳みの有無と無関係に必ず実行される', () => {
    const streamAt = fnBody.indexOf('tokenRotationStream(entry.event).write(');
    const observeAt = fnBody.indexOf('tokenRotationJournalFold.observe(entry, Date.now());');

    expect(
      missingAnchors(fnBody, [
        'tokenRotationStream(entry.event).write(',
        'const folded = tokenRotationJournalFold.observe(entry, Date.now());',
      ]),
    ).toEqual([]);
    expect(streamAt).toBeGreaterThan(-1);
    expect(streamAt).toBeLessThan(observeAt);
  });

  it('reopened の門（recycleSessionForToken / cloneWakeGate.observeUnusable / wake）は畳みの判定より前——畳みの有無と無関係に必ず実行される', () => {
    const observeAt = fnBody.indexOf('tokenRotationJournalFold.observe(entry, Date.now());');
    const unusableAt = fnBody.indexOf('cloneWakeGate.observeUnusable();');
    const reopenedBlockAt = fnBody.indexOf('const reopened = reopenedTokenOf(outcome);');

    expect(
      missingAnchors(fnBody, [
        'cloneWakeGate.observeUnusable();',
        'const reopened = reopenedTokenOf(outcome);',
      ]),
    ).toEqual([]);
    expect(unusableAt).toBeLessThan(observeAt);
    expect(reopenedBlockAt).toBeLessThan(observeAt);
  });

  it('畳んだ要約（folded.summary）は、entry 自身より先に追記する（日誌は時系列で読まれる）', () => {
    const summaryAppendAt = fnBody.indexOf('stores.journal.append(folded.summary)');
    const entryAppendAt = fnBody.indexOf('stores.journal.append(entry)');

    expect(
      missingAnchors(fnBody, [
        'stores.journal.append(folded.summary)',
        'stores.journal.append(entry)',
      ]),
    ).toEqual([]);
    expect(summaryAppendAt).toBeGreaterThan(-1);
    expect(summaryAppendAt).toBeLessThan(entryAppendAt);
  });

  it('entry 自身の追記は folded.write が真のときだけ行う（畳んだ回は書かない）', () => {
    expect(missingAnchors(fnBody, ['if (!folded.write) return;'])).toEqual([]);
    const guardAt = fnBody.indexOf('if (!folded.write) return;');
    const entryAppendAt = fnBody.indexOf('stores.journal.append(entry)');
    expect(guardAt).toBeLessThan(entryAppendAt);
  });
});

describe('デーモンが止まるとき、token_rotation の畳み残しを吐き出す（issue #1311 段B）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const shutdownStart = source.indexOf('async function shutdown(): Promise<void> {');
  const shutdownEnd = source.indexOf('\n  await writeRuntimeInfo(paths.state, {', shutdownStart);
  const shutdownBody = source.slice(shutdownStart, shutdownEnd);

  it('shutdown() は tokenRotationJournalFold.flush() を呼び、在れば journal へ追記する', () => {
    expect(
      missingAnchors(shutdownBody, [
        'const foldedAtShutdown = tokenRotationJournalFold.flush();',
        'if (foldedAtShutdown !== undefined) {',
        'await stores.journal.append(foldedAtShutdown)',
      ]),
    ).toEqual([]);
  });

  it('見張り（tokenWatch）を止めた後で吐き出す——tick が二度と新しい連なりを作らないことを確かめてから畳み残しを確定する', () => {
    const tokenWatchStopAt = shutdownBody.indexOf('tokenWatch?.stop();');
    const flushAt = shutdownBody.indexOf('tokenRotationJournalFold.flush();');
    expect(tokenWatchStopAt).toBeGreaterThan(-1);
    expect(tokenWatchStopAt).toBeLessThan(flushAt);
  });
});

describe('🔴 #1051: 1回の再開の機会につき、配る合図は1件', () => {
  // `hitUsageLimit()` で `observeUnusable()` も呼ぶ: 省くと模型だけが `told` を持ち越しやすい形になり、#1223 の歯が #1051 の不変条件を壊しているように見えるため。
  function fakeClone(gate: CloneWakeGate) {
    let blocked = false;
    let pending = false;
    return {
      get usageBlocked() {
        return blocked;
      },
      get usageReleasePending() {
        return pending;
      },
      hitUsageLimit() {
        if (!blocked) gate.observeUnusable();
        blocked = true;
      },
      receiveNotice() {
        if (blocked) pending = true;
      },
      consumeRelease() {
        pending = false;
        blocked = false;
      },
    };
  }

  function emit(gate: CloneWakeGate, clone: ReturnType<typeof fakeClone>, tokenId: string) {
    const decision = gate.decide(reopened(tokenId), clone.usageBlocked, clone.usageReleasePending);
    if (decision.kind === 'wake') clone.receiveNotice();
    return decision.kind;
  }

  it('回復が2回続けて検出されても、配るのは1件だけ（往復のぶんを畳む）', () => {
    const gate = createCloneWakeGate();
    const clone = fakeClone(gate);
    clone.hitUsageLimit();

    const kinds = [emit(gate, clone, 'tok-a'), emit(gate, clone, 'tok-a')];

    expect(kinds).toEqual(['wake', 'fold']);
  });

  it('何十件届いても、再試行が始まるまでは1件しか配らない', () => {
    const gate = createCloneWakeGate();
    const clone = fakeClone(gate);
    clone.hitUsageLimit();

    const kinds = Array.from({ length: 30 }, () => emit(gate, clone, 'tok-a'));

    expect(kinds.filter((kind) => kind === 'wake')).toEqual(['wake']);
    expect(kinds.filter((kind) => kind === 'fold')).toHaveLength(29);
  });

  it('🔴 回復 → 枠に入る → また回復 なら2件とも配る（起こし損ねを作らない）', () => {
    const gate = createCloneWakeGate();
    const clone = fakeClone(gate);

    clone.hitUsageLimit();
    const first = emit(gate, clone, 'tok-a');

    clone.consumeRelease();
    clone.hitUsageLimit();

    const second = emit(gate, clone, 'tok-a');

    expect([first, second]).toEqual(['wake', 'wake']);
  });

  it('別のトークンが戻った回は、前のトークンの印に巻き込まれない', () => {
    const gate = createCloneWakeGate();
    const clone = fakeClone(gate);
    clone.hitUsageLimit();

    expect(emit(gate, clone, 'tok-a')).toBe('wake');
    expect(emit(gate, clone, 'tok-b')).toBe('fold');

    clone.consumeRelease();
    clone.hitUsageLimit();
    expect(emit(gate, clone, 'tok-b')).toBe('wake');
  });
});
