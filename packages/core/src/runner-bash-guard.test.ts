import { describe, expect, it, vi } from 'vitest';

import type { AgentPreToolRecord } from './agent-hooks.js';
import { BASH_SHAPE_GUARD_ENV, type BashGuardMode } from './bash-guard-mode.js';
import { RunnerBashGuard } from './runner-bash-guard.js';

// `RunnerBashGuard#decide`（`RunnerSession#onPreToolUse` の `Bash` ブロックを切り出したもの）を、口を偽物にして直に縛る。
// 外から（runner を通して）は見えない差を縛るのが目的: 口を呼ぶ順と回数・口が同期で投げたときの伝わり方・結果が Promise でないこと。
// 決定の中身と note の全文は `runner-bash-guard-pin.test.ts`（切り出し前の作りの出力）が縛っている。
// 実時間では待たない。

const RELEASE_PROD = 'gh workflow run release-prod.yml';
const WAITING = 'tail -f /tmp/run.log';
const FD_DUP = 'pnpm test 2>&1';

interface Harness {
  guard: RunnerBashGuard;
  calls: string[];
  notes: string[];
  stderr: string[];
  env: NodeJS.ProcessEnv;
}

function harness(
  options: {
    bashGuard?: BashGuardMode;
    env?: NodeJS.ProcessEnv;
    profileEnv?: () => Record<string, string>;
    actorOf?: (record: AgentPreToolRecord) => string;
    note?: (text: string) => void;
    tryObservation?: (label: string, fn: () => void) => void;
  } = {},
): Harness {
  const calls: string[] = [];
  const notes: string[] = [];
  const stderr: string[] = [];
  const env = options.env ?? {};
  const guard = new RunnerBashGuard({
    env,
    profileEnv:
      options.profileEnv ??
      (() => {
        calls.push('profileEnv');
        return {};
      }),
    bashGuard: options.bashGuard ?? 'ask',
    actorOf:
      options.actorOf ??
      ((record) => {
        calls.push('actorOf');
        return record.agentId === undefined ? 'manager:m' : 'worker:m';
      }),
    note:
      options.note ??
      ((text) => {
        calls.push('note');
        notes.push(text);
      }),
    // 本物（runner.ts の `#tryObservation`）と同じ握り方: 投げたら標準エラー相当へ 1 行残し、投げ直さない
    tryObservation:
      options.tryObservation ??
      ((label, fn) => {
        calls.push(`tryObservation:${label}`);
        try {
          fn();
        } catch (error) {
          stderr.push(`${label}が失敗した: ${String(error)}`);
        }
      }),
  });
  return { guard, calls, notes, stderr, env };
}

function bash(command: unknown, extra: Partial<AgentPreToolRecord> = {}): AgentPreToolRecord {
  return { toolName: 'Bash', toolInput: { command }, ...extra };
}

describe('口を呼ぶ順と回数', () => {
  it('弾かない形: profileEnv は形の歯の判定で 1 回だけ。actorOf・note は呼ばない', () => {
    const h = harness();
    expect(h.guard.decide(bash('echo hi'))).toEqual({ kind: 'none' });
    expect(h.calls).toEqual(['profileEnv']);
  });

  it('release-prod に当たる: 形の歯（profileEnv）を見ず、actorOf → tryObservation → note の順', () => {
    const h = harness({ bashGuard: 'off' });
    expect(h.guard.decide(bash(RELEASE_PROD)).kind).toBe('guardAsk');
    expect(h.calls).toEqual(['actorOf', 'tryObservation:ガードの note の送り出し', 'note']);
  });

  it('off: 弾く待ち形でも判定しない。profileEnv は 1 回だけ、actorOf・note は呼ばない', () => {
    const h = harness({ bashGuard: 'off' });
    expect(h.guard.decide(bash(WAITING))).toEqual({ kind: 'none' });
    expect(h.calls).toEqual(['profileEnv']);
  });

  it('ask の blocked: profileEnv → actorOf → tryObservation → note。note は 1 回、文言は 確認に上げた', () => {
    const h = harness();
    expect(h.guard.decide(bash(WAITING, { agentId: 'a1', agentType: 'worker' })).kind).toBe(
      'guardAsk',
    );
    expect(h.calls).toEqual([
      'profileEnv',
      'actorOf',
      'tryObservation:ガードの note の送り出し',
      'note',
    ]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain('Bash の呼び出しを確認に上げた（worker:m・形=tail-f）');
  });

  it('deny の blocked: note を送ってから deny を返す', () => {
    const h = harness({ bashGuard: 'deny' });
    const outcome = h.guard.decide(bash(WAITING));
    expect(outcome.kind).toBe('decided');
    expect(h.calls.at(-1)).toBe('note');
    expect(h.notes[0]).toContain('Bash の呼び出しを弾いた（manager:m・形=tail-f）');
  });

  it('Bash 以外・command が文字列でない: どの口も呼ばない', () => {
    const h = harness();
    expect(h.guard.decide({ toolName: 'Read', toolInput: { command: WAITING } })).toEqual({
      kind: 'none',
    });
    expect(h.guard.decide({ toolInput: { command: WAITING } })).toEqual({ kind: 'none' });
    expect(h.guard.decide({ toolName: 'Bash', toolInput: null })).toEqual({ kind: 'none' });
    expect(h.guard.decide({ toolName: 'Bash' })).toEqual({ kind: 'none' });
    expect(h.guard.decide(bash(123))).toEqual({ kind: 'none' });
    expect(h.calls).toEqual([]);
  });
});

describe('結果の形', () => {
  it('Promise ではなく値をそのまま返す（同期）', () => {
    const h = harness();
    for (const record of [bash('echo hi'), bash(WAITING), bash(RELEASE_PROD), bash(FD_DUP)]) {
      const outcome = h.guard.decide(record) as unknown as { then?: unknown };
      expect(outcome.then).toBeUndefined();
    }
  });

  it('決定の形: deny 設定は decided/deny、ask 設定は guardAsk、判定が例外なら decided/ask（deny 設定は decided/deny）', () => {
    const badShape = { [BASH_SHAPE_GUARD_ENV]: 'yes' };
    expect({
      deny: harness({ bashGuard: 'deny' }).guard.decide(bash(WAITING)).kind,
      ask: harness().guard.decide(bash(WAITING)).kind,
      shapeUnderAsk: harness({ env: { [BASH_SHAPE_GUARD_ENV]: 'on' } }).guard.decide(bash(FD_DUP))
        .kind,
      throwAsk: harness({ env: badShape }).guard.decide(bash('echo hi')),
      throwDeny: harness({ env: badShape, bashGuard: 'deny' }).guard.decide(bash('echo hi')).kind,
    }).toMatchInlineSnapshot(`
      {
        "ask": "guardAsk",
        "deny": "decided",
        "shapeUnderAsk": "decided",
        "throwAsk": {
          "decision": {
            "kind": "ask",
            "reason": "Bash のガードの判定が例外で終わったので、安全側で確認に上げた（Error: ALTEROID_BASH_SHAPE_GUARD の値が不正: yes（使えるのは on / off。既定は off））。形を変えずに打ち直さず、依頼者へ報告すること。",
          },
          "kind": "decided",
        },
        "throwDeny": "decided",
      }
    `);
  });
});

describe('口が同期で投げたときの伝わり方', () => {
  it('note が投げても握る（tryObservation の側）。結果は変わらず、投げ直さない', () => {
    const h = harness({
      note: () => {
        throw new Error('note が落ちた');
      },
    });
    expect(h.guard.decide(bash(WAITING)).kind).toBe('guardAsk');
    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]).toContain('ガードの note の送り出し');
  });

  it('tryObservation 自体が投げる（握る側の後始末が落ちる）と、decide が同期で投げる（戻り値の Promise の拒否ではない）', () => {
    const h = harness({
      tryObservation: () => {
        throw new Error('tryObservation が落ちた');
      },
    });
    expect(() => h.guard.decide(bash(WAITING))).toThrow('tryObservation が落ちた');
  });

  it('actorOf が投げると握らず、decide が同期で投げる。note は送られない', () => {
    const note = vi.fn();
    const h = harness({
      note,
      actorOf: () => {
        throw new Error('actorOf が落ちた');
      },
    });
    expect(() => h.guard.decide(bash(WAITING))).toThrow('actorOf が落ちた');
    expect(note).not.toHaveBeenCalled();
  });

  it('actorOf は弾かない形では呼ばれないので、投げる設定でも結果は none', () => {
    const h = harness({
      actorOf: () => {
        throw new Error('actorOf が落ちた');
      },
    });
    expect(h.guard.decide(bash('echo hi'))).toEqual({ kind: 'none' });
  });

  it('profileEnv が投げると判定の例外として確認に倒す（deny 設定なら deny）。note は送らない', () => {
    const throwing = (): Record<string, string> => {
      throw new Error('profileEnv が落ちた');
    };
    const notes: string[] = [];
    const ask = harness({ profileEnv: throwing, note: (text) => notes.push(text) });
    const askOutcome = ask.guard.decide(bash('echo hi'));
    const deny = harness({ profileEnv: throwing, bashGuard: 'deny', note: (t) => notes.push(t) });
    const denyOutcome = deny.guard.decide(bash('echo hi'));
    expect(askOutcome).toMatchObject({ kind: 'decided', decision: { kind: 'ask' } });
    expect(denyOutcome).toMatchObject({ kind: 'decided', decision: { kind: 'deny' } });
    expect(notes).toEqual([]);
  });

  it('release-prod に当たるなら profileEnv は呼ばれないので、投げる設定でも判定は例外にならない', () => {
    const h = harness({
      profileEnv: () => {
        throw new Error('profileEnv が落ちた');
      },
    });
    expect(h.guard.decide(bash(RELEASE_PROD)).kind).toBe('guardAsk');
  });
});

describe('env は参照で渡る（作った後の書き換えが次の呼び出しから効く）', () => {
  it('形の歯を後から on にすると、次の decide から deny', () => {
    const h = harness();
    expect(h.guard.decide(bash(FD_DUP))).toEqual({ kind: 'none' });
    h.env[BASH_SHAPE_GUARD_ENV] = 'on';
    expect(h.guard.decide(bash(FD_DUP)).kind).toBe('decided');
  });
});
