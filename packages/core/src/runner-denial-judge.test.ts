import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentPermissionDeniedRecord } from './agent-hooks.js';
import { createRecentMap } from './recent.js';
import {
  ONE_SHOT_ALLOW_TTL_MS,
  digestOf,
  oneShotActorOf,
  oneShotAllowKey,
} from './runner-actor-keys.js';
import { RunnerDenialJudge, type RunnerDenialJudgement } from './runner-denial-judge.js';

// 呼び順を `randomUUID` まで見るため、`node:crypto` の `randomUUID` だけ呼びを記録する皮に差し替える（`createHash` は本物）。
const cryptoSpy = vi.hoisted(() => ({ onUuid: (): void => undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => {
      cryptoSpy.onUuid();
      return actual.randomUUID();
    },
  };
});

// `RunnerDenialJudge#judge`（`RunnerSession#onPermissionDenied` の同期の前半を切り出したもの）を、口を偽物にして直に縛る。
// 外から（runner を通して）は見えない差を縛るのが目的: 口を呼ぶ順と回数・戻りが同期の判別付きの値であること・
// 控え（RecentMap）が参照のまま使われること・口が同期で投げたときの伝わり方。
// note の全文・周回数は `runner-permission-denied-pin.test.ts`（切り出し前の作りの出力）が縛っている。
// 時計は `Date.now` を差し替えて注入する。実時間では待たない。

const NOW = Date.parse('2026-10-04T00:00:00.000Z');

interface Funneled {
  readonly actor: string;
  readonly tool: string;
  readonly key: string;
  readonly at: number;
}

interface Harness {
  judge: RunnerDenialJudge;
  calls: string[];
  notes: string[];
  settled: Array<{ toolUseId: string | undefined; outcome: unknown }>;
  oneShotAllowedToolUses: ReturnType<typeof createRecentMap<Funneled>>;
  allowedButDenied: ReturnType<typeof createRecentMap<{ readonly expiresAt: number }>>;
}

function harness(
  options: {
    settleSessionAllowRuleUse?: () => void;
    sweepExpiredSessionAllowRules?: () => void;
    noteDenial?: () => boolean;
    view?: () => undefined;
    note?: (text: string) => void;
    vaultValues?: () => string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Harness {
  const calls: string[] = [];
  const notes: string[] = [];
  const settled: Harness['settled'] = [];
  const oneShotAllowedToolUses = createRecentMap<Funneled>({ limit: 50 });
  const allowedButDenied = createRecentMap<{ readonly expiresAt: number }>({ limit: 50 });
  const originalEntries = oneShotAllowedToolUses.entries.bind(oneShotAllowedToolUses);
  oneShotAllowedToolUses.entries = () => {
    calls.push('oneShotAllowedToolUses.entries');
    return originalEntries();
  };
  const originalGet = allowedButDenied.get.bind(allowedButDenied);
  allowedButDenied.get = (key) => {
    calls.push('allowedButDenied.get');
    return originalGet(key);
  };
  const judge = new RunnerDenialJudge({
    settleSessionAllowRuleUse:
      options.settleSessionAllowRuleUse ??
      ((toolUseId, outcome) => {
        calls.push('settleSessionAllowRuleUse');
        settled.push({ toolUseId, outcome });
      }),
    sweepExpiredSessionAllowRules:
      options.sweepExpiredSessionAllowRules ??
      (() => {
        calls.push('sweepExpiredSessionAllowRules');
      }),
    denialStreaks: {
      noteDenial:
        options.noteDenial ??
        (() => {
          calls.push('denialStreaks.noteDenial');
          return false;
        }),
      view:
        options.view ??
        (() => {
          calls.push('denialStreaks.view');
          return undefined;
        }),
    },
    note:
      options.note ??
      ((text) => {
        calls.push('note');
        notes.push(text);
      }),
    managerId: 'm1',
    env: options.env ?? {},
    vaultValues:
      options.vaultValues ??
      (() => {
        calls.push('vaultValues');
        return [];
      }),
    oneShotAllowedToolUses,
    allowedButDenied,
  });
  cryptoSpy.onUuid = () => {
    calls.push('randomUUID');
  };
  vi.spyOn(Date, 'now').mockImplementation(() => {
    calls.push('Date.now');
    return NOW;
  });
  return { judge, calls, notes, settled, oneShotAllowedToolUses, allowedButDenied };
}

function record(fields: Partial<AgentPermissionDeniedRecord> = {}): AgentPermissionDeniedRecord {
  return {
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    toolUseId: 'tu-1',
    reason: '分類器が止めた',
    signal: new AbortController().signal,
    ...fields,
  } as AgentPermissionDeniedRecord;
}

function permitKeyOf(toolName: string, toolInput: unknown, agentId?: string): string {
  return oneShotAllowKey(
    oneShotActorOf('m1', { agentId }),
    toolName,
    digestOf(JSON.stringify(toolInput)),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('呼ぶ順と回数', () => {
  it('継続する回: settle → sweep → 連続拒否 → note #2 → 入力の先頭（vaultValues）→ randomUUID → Date.now → 再拒否の判定', () => {
    const h = harness();
    h.judge.judge(record({ toolUseId: undefined }));
    expect(h.calls).toEqual([
      'settleSessionAllowRuleUse',
      'sweepExpiredSessionAllowRules',
      'denialStreaks.noteDenial',
      'note',
      'vaultValues',
      'randomUUID',
      'Date.now',
      'oneShotAllowedToolUses.entries',
      'allowedButDenied.get',
    ]);
    expect(h.notes).toHaveLength(1);
  });

  it('toolUseId があれば randomUUID は呼ばれない', () => {
    const h = harness();
    h.judge.judge(record());
    expect(h.calls).not.toContain('randomUUID');
  });

  it('settle には toolUseId と denied/PermissionDenied を渡す', () => {
    const h = harness();
    h.judge.judge(record());
    expect(h.settled).toEqual([
      { toolUseId: 'tu-1', outcome: { kind: 'denied', via: 'PermissionDenied' } },
    ]);
  });

  it('連続拒否が上限に達した回は view を取り、入口の note の前に note #1 を出す', () => {
    const h = harness({
      noteDenial: () => {
        return true;
      },
    });
    h.judge.judge(record());
    expect(h.calls.filter((c) => c === 'denialStreaks.view')).toEqual(['denialStreaks.view']);
    expect(h.notes).toHaveLength(2);
    expect(h.notes[0]).toContain('分類器の拒否が');
    expect(h.notes[1]).toContain('分類器の拒否のフックが届いた');
  });

  it('道具名なし: note #2 → #3 で decided（no-retry）。鍵作り・Date.now は呼ばれない', () => {
    const h = harness();
    const result = h.judge.judge(record({ toolName: undefined }));
    expect(result).toEqual({ kind: 'decided', decision: { kind: 'no-retry' } });
    expect(h.calls).toEqual([
      'settleSessionAllowRuleUse',
      'sweepExpiredSessionAllowRules',
      'denialStreaks.noteDenial',
      'note',
      'note',
    ]);
  });

  it('入力が鍵にならない: note #2 → #4 で decided（no-retry）。vaultValues・Date.now は呼ばれない', () => {
    const h = harness();
    const result = h.judge.judge(record({ toolInput: undefined }));
    expect(result).toEqual({ kind: 'decided', decision: { kind: 'no-retry' } });
    expect(h.calls).not.toContain('vaultValues');
    expect(h.calls).not.toContain('Date.now');
    expect(h.notes).toHaveLength(2);
  });

  it('JSON にできない入力（循環）も鍵にならない', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const h = harness();
    const result = h.judge.judge(record({ toolInput: cyclic }));
    expect(result).toEqual({ kind: 'decided', decision: { kind: 'no-retry' } });
  });
});

describe('戻りは同期の判別付きの値', () => {
  it('継続する回は continue と後半が使う値を返す（Promise ではない）', () => {
    const h = harness();
    const result: RunnerDenialJudgement = h.judge.judge(record());
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({
      kind: 'continue',
      actor: 'manager:m1',
      toolName: 'Bash',
      streakActor: 'manager',
      inputHead: expect.any(String),
      permitKey: permitKeyOf('Bash', { command: 'ls' }),
      id: 'tu-1',
    });
  });

  it('作業者の拒否は streakActor に agentId、permitKey に agentId を使う', () => {
    const h = harness();
    const result = h.judge.judge(record({ agentId: 'ag-7', agentType: 'worker-x' }));
    expect(result).toMatchObject({
      kind: 'continue',
      actor: 'worker:m1:worker-x',
      streakActor: 'ag-7',
      permitKey: permitKeyOf('Bash', { command: 'ls' }, 'ag-7'),
    });
  });

  it('toolUseId が無ければ id は randomUUID の値', () => {
    const h = harness();
    const result = h.judge.judge(record({ toolUseId: undefined }));
    expect(result.kind === 'continue' ? result.id : '').toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('再拒否の判定は控えを参照のまま読む', () => {
  const key = permitKeyOf('Bash', { command: 'ls' });

  it('撃ち直しの控え（oneShotAllowedToolUses）が期限内なら decided（no-retry）と note #5', () => {
    const h = harness();
    h.oneShotAllowedToolUses.set('tu-x', { actor: 'a', tool: 'Bash', key, at: NOW });
    const result = h.judge.judge(record());
    expect(result).toEqual({ kind: 'decided', decision: { kind: 'no-retry' } });
    expect(h.notes.at(-1)).toContain('allow を返した撃ち直しのあとでも再び止めた');
  });

  it('控えの期限がちょうど切れる時刻（at + TTL === now）は止めない（> であり >= ではない）', () => {
    const h = harness();
    h.oneShotAllowedToolUses.set('tu-x', {
      actor: 'a',
      tool: 'Bash',
      key,
      at: NOW - ONE_SHOT_ALLOW_TTL_MS,
    });
    expect(h.judge.judge(record()).kind).toBe('continue');
  });

  it('別の鍵の控えは止めない', () => {
    const h = harness();
    h.oneShotAllowedToolUses.set('tu-x', { actor: 'a', tool: 'Bash', key: 'other', at: NOW });
    expect(h.judge.judge(record()).kind).toBe('continue');
  });

  it('allowedButDenied が期限内なら decided（no-retry）', () => {
    const h = harness();
    h.allowedButDenied.set(key, { expiresAt: NOW + 1 });
    expect(h.judge.judge(record())).toEqual({ kind: 'decided', decision: { kind: 'no-retry' } });
  });

  it('allowedButDenied の期限がちょうど今（expiresAt === now）なら止めない', () => {
    const h = harness();
    h.allowedButDenied.set(key, { expiresAt: NOW });
    expect(h.judge.judge(record()).kind).toBe('continue');
  });

  it('judge の後に参照へ書いた控えを、次の judge が見る（写していない）', () => {
    const h = harness();
    expect(h.judge.judge(record()).kind).toBe('continue');
    h.allowedButDenied.set(key, { expiresAt: NOW + 1 });
    expect(h.judge.judge(record()).kind).toBe('decided');
  });

  it('judge は控えを書かない・消さない', () => {
    const h = harness();
    h.oneShotAllowedToolUses.set('tu-x', { actor: 'a', tool: 'Bash', key, at: NOW });
    h.judge.judge(record());
    expect(h.oneShotAllowedToolUses.get('tu-x')).toBeDefined();
    expect(h.allowedButDenied.entries()).toEqual([]);
  });
});

describe('口が同期で投げたときの伝わり方', () => {
  it.each([
    ['settleSessionAllowRuleUse', { settleSessionAllowRuleUse: () => failing() }],
    ['sweepExpiredSessionAllowRules', { sweepExpiredSessionAllowRules: () => failing() }],
    ['denialStreaks.noteDenial', { noteDenial: () => failing() }],
    ['vaultValues', { vaultValues: () => failing() }],
  ])('%s が投げると judge も同期でそのまま投げる（握らない）', (_name, options) => {
    const h = harness(options);
    expect(() => h.judge.judge(record())).toThrow('口が落ちた（テスト用）');
  });

  it('note が投げると、投げた回の後ろの口は呼ばれない', () => {
    const calls: string[] = [];
    const h = harness({
      note: () => {
        calls.push('note');
        return failing();
      },
      vaultValues: () => {
        calls.push('vaultValues');
        return [];
      },
    });
    expect(() => h.judge.judge(record())).toThrow('口が落ちた（テスト用）');
    expect(calls).toEqual(['note']);
  });

  it('道具名なしの note #3 が投げると、投げたまま decided は返らない', () => {
    let count = 0;
    const h = harness({
      note: () => {
        count += 1;
        if (count === 2) failing();
      },
    });
    expect(() => h.judge.judge(record({ toolName: undefined }))).toThrow('口が落ちた（テスト用）');
  });
});

function failing(): never {
  throw new Error('口が落ちた（テスト用）');
}
