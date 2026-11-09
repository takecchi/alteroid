import { describe, expect, it } from 'vitest';

import type { AgentPermissionDenial } from './agent-events.js';
import type { DeniedRecord } from './denial-shape.js';
import { createRecentMap } from './recent.js';
import { ONE_SHOT_ALLOW_TTL_MS } from './runner-actor-keys.js';
import { RunnerDenialNotice } from './runner-denial-notice.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerDenialNotice#noteDenial`（`RunnerSession#noteDenial` を切り出したもの）を、口を偽物にして直に縛る。
// 外から（runner を通して）は見えない差を縛るのが目的: 口を呼ぶ順と回数・口が同期で投げたときの伝わり方・結果が Promise でないこと・
// 控え（RecentMap）が参照のまま使われること。
// 欄ごとの値・note の全文は `runner-denial-pin.test.ts`（切り出し前の作りの出力）が縛っている。
// 実時間では待たない。

type Outcome = { kind: 'passed'; toolFailed: boolean } | { kind: 'denied'; via: string };

interface Funneled {
  readonly actor: string;
  readonly tool: string;
  readonly key: string;
  readonly at: number;
}

interface Harness {
  notice: RunnerDenialNotice;
  calls: string[];
  notes: string[];
  events: RunnerEvent[];
  settledTools: string[];
  settledRules: Array<{ toolUseId: string | undefined; outcome: Outcome }>;
  oneShotAllowedToolUses: ReturnType<typeof createRecentMap<Funneled>>;
  allowedButDenied: ReturnType<typeof createRecentMap<{ readonly expiresAt: number }>>;
  preToolInputHeads: ReturnType<typeof createRecentMap<string>>;
  denied: ReturnType<typeof createRecentMap<DeniedRecord>>;
}

function harness(
  options: {
    settleWorkerTool?: (toolUseId: string) => void;
    settleSessionAllowRuleUse?: (toolUseId: string | undefined, outcome: Outcome) => void;
    note?: (text: string) => void;
    emit?: (event: RunnerEvent) => void;
  } = {},
): Harness {
  const calls: string[] = [];
  const notes: string[] = [];
  const events: RunnerEvent[] = [];
  const settledTools: string[] = [];
  const settledRules: Harness['settledRules'] = [];
  const oneShotAllowedToolUses = createRecentMap<Funneled>({ limit: 50 });
  const allowedButDenied = createRecentMap<{ readonly expiresAt: number }>({ limit: 50 });
  const preToolInputHeads = createRecentMap<string>({ limit: 50 });
  const denied = createRecentMap<DeniedRecord>({ limit: 50 });
  const notice = new RunnerDenialNotice({
    settleWorkerTool:
      options.settleWorkerTool ??
      ((toolUseId) => {
        calls.push('settleWorkerTool');
        settledTools.push(toolUseId);
      }),
    settleSessionAllowRuleUse:
      options.settleSessionAllowRuleUse ??
      ((toolUseId, outcome) => {
        calls.push('settleSessionAllowRuleUse');
        settledRules.push({ toolUseId, outcome });
      }),
    oneShotAllowedToolUses,
    allowedButDenied,
    preToolInputHeads,
    denied,
    note:
      options.note ??
      ((text) => {
        calls.push('note');
        notes.push(text);
      }),
    emit:
      options.emit ??
      ((event) => {
        calls.push('emit');
        events.push(event);
      }),
    managerId: 'm1',
  });
  return {
    notice,
    calls,
    notes,
    events,
    settledTools,
    settledRules,
    oneShotAllowedToolUses,
    allowedButDenied,
    preToolInputHeads,
    denied,
  };
}

const FUNNELED: Funneled = { actor: 'manager:m1', tool: 'Bash', key: 'k1', at: 1_000 };

function denial(extra: Partial<AgentPermissionDenial> = {}): AgentPermissionDenial {
  return { tool: 'Bash', toolUseId: 'tu1', ...extra };
}

describe('口を呼ぶ順と回数', () => {
  it('toolUseId あり・初出: settleWorkerTool → settleSessionAllowRuleUse → emit。それぞれ 1 回', () => {
    const h = harness();
    h.notice.noteDenial(denial(), 'live');
    expect(h.calls).toEqual(['settleWorkerTool', 'settleSessionAllowRuleUse', 'emit']);
    expect(h.settledTools).toEqual(['tu1']);
    expect(h.settledRules).toEqual([
      { toolUseId: 'tu1', outcome: { kind: 'denied', via: 'live' } },
    ]);
  });

  it('1 回だけの許可の拒否: settleWorkerTool → settleSessionAllowRuleUse → note → emit', () => {
    const h = harness();
    h.oneShotAllowedToolUses.set('tu1', FUNNELED);
    h.notice.noteDenial(denial(), 'result');
    expect(h.calls).toEqual(['settleWorkerTool', 'settleSessionAllowRuleUse', 'note', 'emit']);
    expect(h.notes[0]).toContain('合図の出所: result');
  });

  it('toolUseId なし: settleWorkerTool は呼ばず、settleSessionAllowRuleUse は undefined で 1 回、代用の鍵で emit', () => {
    const h = harness();
    h.notice.noteDenial({ tool: 'Bash', input: { command: 'ls' } }, 'result');
    expect(h.calls).toEqual(['settleSessionAllowRuleUse', 'emit']);
    expect(h.settledRules).toEqual([
      { toolUseId: undefined, outcome: { kind: 'denied', via: 'result' } },
    ]);
    const event = h.events[0] as { toolUseId: string };
    expect(event.toolUseId).toMatch(/^Bash:[0-9a-f]{16}$/);
  });

  it('同じ拒否の 2 度目（入力が後から載った）: settle 2 つは毎回呼ぶ。note は形だけ 1 回、emit は無い', () => {
    const h = harness();
    h.notice.noteDenial(denial(), 'live');
    h.calls.length = 0;
    h.notice.noteDenial(denial({ input: { command: 'ls' } }), 'result');
    expect(h.calls).toEqual(['settleWorkerTool', 'settleSessionAllowRuleUse', 'note']);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain('形だけ残す');
    expect(h.events).toHaveLength(1);
  });

  it('同じ拒否の 3 度目: settle 2 つだけ。note も emit も無い', () => {
    const h = harness();
    h.notice.noteDenial(denial(), 'live');
    h.notice.noteDenial(denial({ input: { command: 'ls' } }), 'result');
    h.calls.length = 0;
    h.notice.noteDenial(denial({ input: { command: 'ls' } }), 'result');
    expect(h.calls).toEqual(['settleWorkerTool', 'settleSessionAllowRuleUse']);
  });
});

describe('結果の形', () => {
  it('戻り値は undefined（Promise ではない）。どの枝でも同じ', () => {
    const h = harness();
    h.oneShotAllowedToolUses.set('tu1', FUNNELED);
    const results: unknown[] = [
      h.notice.noteDenial(denial(), 'live'),
      h.notice.noteDenial(denial({ input: { command: 'ls' } }), 'result'),
      h.notice.noteDenial(denial({ input: { command: 'ls' } }), 'result'),
      h.notice.noteDenial({}, 'result'),
    ];
    for (const result of results) expect(result).toBeUndefined();
  });

  it('emit は呼ばれた時点で届いている（await 無しで観測できる）', () => {
    const h = harness();
    h.notice.noteDenial(denial(), 'live');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'permission_denied',
      managerId: 'm1',
      toolUseId: 'tu1',
      via: 'live',
      actor: 'manager:m1',
    });
  });
});

describe('口が同期で投げたときの伝わり方（握らず、noteDenial が同期で投げる）', () => {
  it('settleWorkerTool が投げる: 後ろの口は何も呼ばれず、控えにも触れない', () => {
    const h = harness({
      settleWorkerTool: () => {
        throw new Error('settleWorkerTool が落ちた');
      },
    });
    expect(() => h.notice.noteDenial(denial(), 'live')).toThrow('settleWorkerTool が落ちた');
    expect(h.calls).toEqual([]);
    expect(h.denied.size).toBe(0);
  });

  it('toolUseId が無ければ settleWorkerTool は呼ばれないので、投げる設定でも通る', () => {
    const h = harness({
      settleWorkerTool: () => {
        throw new Error('settleWorkerTool が落ちた');
      },
    });
    expect(() => h.notice.noteDenial({ tool: 'Bash' }, 'result')).not.toThrow();
    expect(h.calls).toEqual(['settleSessionAllowRuleUse', 'emit']);
  });

  it('settleSessionAllowRuleUse が投げる: 控えと emit に触れず、settleWorkerTool は済んでいる', () => {
    const settled: string[] = [];
    const h = harness({
      settleWorkerTool: (id) => settled.push(id),
      settleSessionAllowRuleUse: () => {
        throw new Error('settleSessionAllowRuleUse が落ちた');
      },
    });
    h.oneShotAllowedToolUses.set('tu1', FUNNELED);
    expect(() => h.notice.noteDenial(denial(), 'live')).toThrow(
      'settleSessionAllowRuleUse が落ちた',
    );
    expect(settled).toEqual(['tu1']);
    expect(h.oneShotAllowedToolUses.get('tu1')).toEqual(FUNNELED);
    expect(h.allowedButDenied.size).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('1 回だけの許可の note が投げる: 控えの書き換え（delete・allowedButDenied.set）は済み、denied と emit は届かない', () => {
    const h = harness({
      note: () => {
        throw new Error('note が落ちた');
      },
    });
    h.oneShotAllowedToolUses.set('tu1', FUNNELED);
    expect(() => h.notice.noteDenial(denial(), 'live')).toThrow('note が落ちた');
    expect(h.oneShotAllowedToolUses.get('tu1')).toBeUndefined();
    expect(h.allowedButDenied.get('k1')).toEqual({ expiresAt: 1_000 + ONE_SHOT_ALLOW_TTL_MS });
    expect(h.denied.get('tu1')).toBeUndefined();
    expect(h.events).toEqual([]);
  });

  it('形だけの note が投げる: denied の更新（input: true）は済んでいる', () => {
    const h = harness({
      note: () => {
        throw new Error('note が落ちた');
      },
    });
    h.denied.set('tu1', { input: false });
    expect(() => h.notice.noteDenial(denial({ input: { command: 'ls' } }), 'result')).toThrow(
      'note が落ちた',
    );
    expect(h.denied.get('tu1')).toEqual({ input: true });
  });

  it('emit が投げる: denied への書き込みは済んでいる（呼び直しても emit は再送されない）', () => {
    let first = true;
    const h = harness({
      emit: () => {
        if (!first) throw new Error('2 回目は呼ばれないはず');
        first = false;
        throw new Error('emit が落ちた');
      },
    });
    expect(() => h.notice.noteDenial(denial(), 'live')).toThrow('emit が落ちた');
    expect(h.denied.get('tu1')).toEqual({ input: false });
    expect(() => h.notice.noteDenial(denial(), 'live')).not.toThrow();
  });
});

describe('控え（RecentMap）は参照のまま使われる', () => {
  it('外から oneShotAllowedToolUses に入れた値が効き、引いたら消える。allowedButDenied に書いた値が外から見える', () => {
    const h = harness();
    h.oneShotAllowedToolUses.set('tu1', FUNNELED);
    h.notice.noteDenial(denial(), 'live');
    expect(h.oneShotAllowedToolUses.get('tu1')).toBeUndefined();
    expect(h.allowedButDenied.get('k1')).toEqual({ expiresAt: 1_000 + ONE_SHOT_ALLOW_TTL_MS });
    expect(h.notes).toHaveLength(1);
  });

  it('外から preToolInputHeads に入れた値が inputHead に載り、引いたら消える', () => {
    const h = harness();
    h.preToolInputHeads.set('tu1', 'ls -la');
    h.notice.noteDenial(denial(), 'live');
    expect(h.events[0]).toMatchObject({ inputHead: 'ls -la' });
    expect(h.preToolInputHeads.get('tu1')).toBeUndefined();
  });

  it('外から denied に入れた値が効く（emit しない）。協力者が書いた値が外から見える', () => {
    const h = harness();
    h.denied.set('tu1', { input: true });
    h.notice.noteDenial(denial({ input: { command: 'ls' } }), 'result');
    expect(h.calls).toEqual(['settleWorkerTool', 'settleSessionAllowRuleUse']);

    h.notice.noteDenial(denial({ toolUseId: 'tu2', input: { command: 'ls' } }), 'result');
    expect(h.denied.get('tu2')).toEqual({ input: true });
    h.notice.noteDenial(denial({ toolUseId: 'tu3' }), 'live');
    expect(h.denied.get('tu3')).toEqual({ input: false });
    expect(h.denied.entries().map(([id]) => id)).toEqual(['tu1', 'tu2', 'tu3']);
  });

  it('managerId は emit の managerId と actor に使われる', () => {
    const h = harness();
    h.notice.noteDenial(denial({ agentId: 'a1', agentType: 'reviewer' }), 'live');
    expect(h.events[0]).toMatchObject({ managerId: 'm1', actor: 'worker:m1:reviewer' });
  });
});
