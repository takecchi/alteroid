import { describe, expect, it, vi } from 'vitest';

import type { AgentPermissionDecision } from './agent-session.js';
import { type PendingRequest, RunnerRequestQueue } from './runner-request-queue.js';
import type { RunnerEvent } from './runner-protocol.js';

// `decideAnswer` は口ではなく `runner-decide-answer.js` からの直の import になったので、モジュールごと偽物にして、
// 以前の口の偽物と同じ確認（呼ぶ順・回数・渡す引数・投げたときの伝わり方）を保つ。実物を通す縛りは pin が持つ。
const decideAnswerMock = vi.hoisted(() =>
  vi.fn<
    (
      kind: 'question' | 'permission',
      decision: 'allow' | 'deny' | undefined,
      message: string,
    ) => { decision: 'allow' | 'deny'; unreadable: boolean }
  >(),
);
vi.mock('./runner-decide-answer.js', () => ({ decideAnswer: decideAnswerMock }));

// `RunnerRequestQueue`（`RunnerSession#queueRequest` を切り出した協力者）を、口と `decideAnswer` を偽物にして直に縛る。
// 外から見える結果の縛りは `runner-queue-request-pin.test.ts`（切り出し前の作りで通した pin）、呼び元からの配線は `runner-request-queue-wiring.test.ts`。
// ここで縛るのは: 口を呼ぶ順と回数・`ask` が `signal` の確かめより先であること・各口が同期で投げたときの伝わり方・
// `pending`／`resolved`／`sdkSession` を参照のまま使うこと・戻りが同期であること。
// 各枝が縛る、元のコメントの意図:
// - 「`ask` を中断の確かめより先に出す（#4772）」 → 『中断済みの signal』
// - 「待ち行列から自分を外すのは settle の責任」 → 『pending は参照のまま使う』
// - 「解けたことを覚えるのはここ 1 箇所」 → 『resolved を 1 回だけ set する』
// - 「確認待ちの間に溜めた peer の知らせを届ける」 → 『settle の口の順』

type Log = string[];

interface Rig {
  log: Log;
  queue: RunnerRequestQueue;
  pending: PendingRequest[];
  sdk: { status: string; setStatus: ReturnType<typeof vi.fn> };
  resolved: { set: ReturnType<typeof vi.fn> };
  events: RunnerEvent[];
}

function rig(
  options: {
    status?: string;
    emitThrowsOn?: string;
    setStatusThrowsOn?: string;
    deliverThrows?: boolean;
    decideAnswer?: (
      kind: 'question' | 'permission',
      decision: 'allow' | 'deny' | undefined,
      message: string,
    ) => { decision: 'allow' | 'deny'; unreadable: boolean };
  } = {},
): Rig {
  const log: Log = [];
  const events: RunnerEvent[] = [];
  const pending: PendingRequest[] = [];
  const sdk = {
    status: options.status ?? 'running',
    setStatus: vi.fn((status: string) => {
      log.push(`setStatus:${status}`);
      if (status === options.setStatusThrowsOn) throw new Error(`setStatus が投げた: ${status}`);
      sdk.status = status;
    }),
  };
  const resolved = {
    set: vi.fn((id: string, outcome: AgentPermissionDecision) => {
      log.push(`resolved.set:${id}:${outcome.behavior}`);
    }),
  };
  const queue = new RunnerRequestQueue({
    sdkSession: sdk as never,
    pending,
    resolved,
    emit: (event) => {
      log.push(`emit:${event.type}`);
      events.push(event);
      if (event.type === options.emitThrowsOn) throw new Error(`emit が投げた: ${event.type}`);
    },
    managerId: 'mgr-test',
    deliverPeerNotices: () => {
      log.push('deliverPeerNotices');
      if (options.deliverThrows === true) throw new Error('deliverPeerNotices が投げた');
    },
  });
  decideAnswerMock.mockReset();
  decideAnswerMock.mockImplementation(
    options.decideAnswer ??
      ((kind, decision, message) => {
        log.push(`decideAnswer:${kind}:${String(decision)}:${message}`);
        return { decision: decision ?? 'allow', unreadable: false };
      }),
  );
  return { log, queue, pending, sdk, resolved, events };
}

const spec = (extra: Partial<Parameters<RunnerRequestQueue['queueRequest']>[0]> = {}) => ({
  id: 'r1',
  kind: 'permission' as const,
  summary: '要約',
  askedAt: '2026-10-20T00:00:00.000Z',
  input: { a: 1 },
  source: undefined,
  signal: undefined,
  abortAnswer: { message: '中断', decision: 'deny' as const, aborted: true as const },
  ...extra,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('口を呼ぶ順と回数', () => {
  it('積む: setStatus(waiting_human) → emit(ask) の順で 1 回ずつ。pending に 1 件、ask の欄は渡した値', () => {
    const r = rig();
    r.queue.queueRequest(spec({ source: { provider: 'codex', sessionId: 's' } as never }));
    expect(r.log).toEqual(['setStatus:waiting_human', 'emit:ask']);
    expect(r.pending.map((request) => request.id)).toEqual(['r1']);
    expect(r.events).toEqual([
      {
        type: 'ask',
        managerId: 'mgr-test',
        requestId: 'r1',
        kind: 'permission',
        summary: '要約',
        askedAt: '2026-10-20T00:00:00.000Z',
        source: { type: 'peer', provider: 'codex' },
      },
    ]);
  });

  it('source が無ければ ask に source の欄が無い', () => {
    const r = rig();
    r.queue.queueRequest(spec());
    expect(Object.keys(r.events[0] ?? {})).toEqual([
      'type',
      'managerId',
      'requestId',
      'kind',
      'summary',
      'askedAt',
    ]);
  });

  it('settle: setStatus(running) → emit(settled) → （answered が解ける）→ deliverPeerNotices。decideAnswer と resolved.set は result の側で 1 回ずつ', async () => {
    const r = rig({ status: 'waiting_human' });
    const { result, answered } = r.queue.queueRequest(spec());
    r.log.length = 0;
    r.pending[0]?.settle({ message: 'ok', decision: 'allow' });
    expect(r.log).toEqual(['setStatus:running', 'emit:settled', 'deliverPeerNotices']);
    let answeredDone = false;
    void answered.then(() => {
      answeredDone = true;
    });
    await flush();
    expect(answeredDone).toBe(true);
    expect(await result).toEqual({ behavior: 'allow' });
    expect(r.log).toEqual([
      'setStatus:running',
      'emit:settled',
      'deliverPeerNotices',
      'decideAnswer:permission:allow:ok',
      'resolved.set:r1:allow',
    ]);
    expect(r.pending).toEqual([]);
  });

  it('二度目の settle は何もしない（口を呼ばず、answered も変わらない）', async () => {
    const r = rig({ status: 'waiting_human' });
    const { answered } = r.queue.queueRequest(spec());
    const request = r.pending[0];
    request?.settle({ message: 'first', decision: 'allow' });
    r.log.length = 0;
    request?.settle({ message: 'second', decision: 'deny' });
    expect(r.log).toEqual([]);
    expect(await answered).toEqual({ message: 'first', decision: 'allow' });
  });

  it('withdrawn は settled の withdrawn.reason に載る。aborted・通常の答えには載らない', () => {
    const r = rig();
    r.queue.queueRequest(spec({ id: 'a' }));
    r.queue.queueRequest(spec({ id: 'b' }));
    r.queue.queueRequest(spec({ id: 'c' }));
    r.pending[0]?.settle({ message: '畳む', decision: 'deny', withdrawn: true });
    r.pending[0]?.settle({ message: '中断', decision: 'deny', aborted: true });
    r.pending[0]?.settle({ message: 'ok' });
    const settled = r.events.filter((event) => event.type === 'settled');
    expect(settled).toEqual([
      { type: 'settled', managerId: 'mgr-test', requestId: 'a', withdrawn: { reason: '畳む' } },
      { type: 'settled', managerId: 'mgr-test', requestId: 'b' },
      { type: 'settled', managerId: 'mgr-test', requestId: 'c' },
    ]);
  });
});

describe('result の写像（decideAnswer の戻りを使う）', () => {
  it('decideAnswer へは kind・decision・message をそのまま渡す。deny は message を返す', async () => {
    const calls: unknown[][] = [];
    const r = rig({
      decideAnswer: (...args) => {
        calls.push(args);
        return { decision: 'deny', unreadable: false };
      },
    });
    const { result } = r.queue.queueRequest(spec({ kind: 'question' }));
    r.pending[0]?.settle({ message: 'だめ', decision: 'deny' });
    expect(await result).toEqual({ behavior: 'deny', message: 'だめ' });
    expect(calls).toEqual([['question', 'deny', 'だめ']]);
  });

  it('unreadable は文言を前置きして deny。teardown（withdrawn・aborted）では前置きしない', async () => {
    const r = rig({ decideAnswer: () => ({ decision: 'deny', unreadable: true }) });
    const first = r.queue.queueRequest(spec({ id: 'x' }));
    const second = r.queue.queueRequest(spec({ id: 'y' }));
    const third = r.queue.queueRequest(spec({ id: 'z' }));
    r.pending[0]?.settle({ message: 'うーん' });
    r.pending[0]?.settle({ message: '畳む', withdrawn: true });
    r.pending[0]?.settle({ message: '中断', aborted: true });
    const [a, b, c] = [await first.result, await second.result, await third.result];
    expect(a).toEqual({
      behavior: 'deny',
      message:
        "[decision が無く、承認とも拒否とも読み取れなかったので安全側で拒否した] うーん\n\n許可するときは decision: 'allow' を明示して答え直すこと。",
    });
    expect(b).toEqual({ behavior: 'deny', message: '畳む' });
    expect(c).toEqual({ behavior: 'deny', message: '中断' });
  });

  it('question の allow は updatedInput に withAnswers（問いごとの答え）。teardown なら question でも deny', async () => {
    const r = rig();
    const input = { questions: [{ question: 'どっち？' }, { question: 3 }], keep: true };
    const answeredOne = r.queue.queueRequest(spec({ id: 'q1', kind: 'question', input }));
    const torn = r.queue.queueRequest(spec({ id: 'q2', kind: 'question', input }));
    r.pending[0]?.settle({ message: '右' });
    r.pending[0]?.settle({ message: '畳む', withdrawn: true });
    expect(await answeredOne.result).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'どっち？': '右' } },
    });
    expect(await torn.result).toEqual({ behavior: 'deny', message: '畳む' });
  });
});

describe('中断（signal）', () => {
  it('すでに中断済み: ask → （signal を見る）→ onAbort → settled の順。リスナーは付けない', () => {
    const r = rig();
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const onAbort = vi.fn(() => {
      r.log.push('onAbort');
    });
    r.queue.queueRequest(spec({ signal: controller.signal, onAbort }));
    expect(r.log).toEqual([
      'setStatus:waiting_human',
      'emit:ask',
      'onAbort',
      'setStatus:running',
      'emit:settled',
      'deliverPeerNotices',
    ]);
    expect(add).not.toHaveBeenCalled();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('あとから中断: once のリスナーを付け、中断で onAbort → settle(abortAnswer)。リスナーは外れて、二度は走らない', async () => {
    const r = rig();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const onAbort = vi.fn(() => {
      r.log.push('onAbort');
    });
    const { result } = r.queue.queueRequest(spec({ signal: controller.signal, onAbort }));
    expect(add.mock.calls.map((call) => [call[0], call[2]])).toEqual([['abort', { once: true }]]);
    controller.abort();
    expect(r.log.slice(2)).toEqual([
      'onAbort',
      'setStatus:running',
      'emit:settled',
      'deliverPeerNotices',
    ]);
    // 中断で解けても、後始末で `unlisten` が呼ばれる（外す対象は付けたリスナーそのもの）
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    expect(await result).toEqual({ behavior: 'deny', message: '中断' });
  });

  it('答えで解けたら、中断のリスナーを外す。あとからの中断では onAbort が走らない', () => {
    const r = rig();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const onAbort = vi.fn();
    r.queue.queueRequest(spec({ signal: controller.signal, onAbort }));
    r.pending[0]?.settle({ message: 'ok', decision: 'allow' });
    expect(remove).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('signal が無ければ何も付けない', () => {
    const r = rig();
    r.queue.queueRequest(spec());
    expect(r.log).toEqual(['setStatus:waiting_human', 'emit:ask']);
  });
});

describe('参照のまま使う（写さない）', () => {
  it('pending: 外から差し込んだ要素・外した要素を、同じ配列として見る（積むのも外すのもこの配列）', () => {
    const r = rig({ status: 'waiting_human' });
    const other = { id: 'other' } as unknown as PendingRequest;
    r.pending.push(other);
    r.queue.queueRequest(spec());
    expect(r.pending.map((request) => request.id)).toEqual(['other', 'r1']);
    r.pending[1]?.settle({ message: 'ok', decision: 'allow' });
    // 自分だけを外す。まだ他が残っているので running へは戻さない
    expect(r.pending).toEqual([other]);
    expect(r.sdk.setStatus).not.toHaveBeenCalledWith('running');
  });

  it('pending: すでに外されていた確認の settle は、他の要素を触らない（indexOf が -1 なら外さない）', () => {
    const r = rig({ status: 'waiting_human' });
    r.queue.queueRequest(spec());
    const request = r.pending[0];
    r.pending.splice(0);
    const other = { id: 'other' } as unknown as PendingRequest;
    r.pending.push(other);
    request?.settle({ message: 'ok', decision: 'allow' });
    expect(r.pending).toEqual([other]);
  });

  it('sdkSession: status はそのときの値を読む（waiting_human でなければ running へ戻さない。空になっても）', () => {
    const r = rig();
    r.queue.queueRequest(spec());
    r.sdk.status = 'done';
    r.log.length = 0;
    r.pending[0]?.settle({ message: 'ok', decision: 'allow' });
    expect(r.log).toEqual(['emit:settled', 'deliverPeerNotices']);
  });

  it('sdkSession: 残りがあれば、waiting_human でも running へ戻さない', () => {
    const r = rig();
    r.queue.queueRequest(spec({ id: 'a' }));
    r.queue.queueRequest(spec({ id: 'b' }));
    r.log.length = 0;
    r.pending[0]?.settle({ message: 'ok', decision: 'allow' });
    expect(r.log).toEqual(['emit:settled', 'deliverPeerNotices']);
  });

  it('resolved は set だけを使う（set だけを持つ値で足りる）。解けた結果を 1 回だけ覚える', async () => {
    const r = rig();
    const { result } = r.queue.queueRequest(spec());
    r.pending[0]?.settle({ message: 'ok', decision: 'allow' });
    await result;
    expect(r.resolved.set).toHaveBeenCalledTimes(1);
    expect(r.resolved.set).toHaveBeenCalledWith('r1', { behavior: 'allow' });
  });
});

describe('戻りが同期', () => {
  it('queueRequest は Promise ではなく { result, answered } をそのまま返す（await を挟まず、積んだ後に戻る）', () => {
    const r = rig();
    const returned = r.queue.queueRequest(spec());
    expect(returned).not.toBeInstanceOf(Promise);
    expect(Object.keys(returned)).toEqual(['result', 'answered']);
    expect(returned.result).toBeInstanceOf(Promise);
    expect(returned.answered).toBeInstanceOf(Promise);
    expect(r.pending).toHaveLength(1);
    expect(r.events).toHaveLength(1);
  });
});

describe('口が同期で投げたとき', () => {
  it('ask の emit が投げる: queueRequest が投げ、確認は pending に残り、signal は見ない（リスナーは付かない）', () => {
    const r = rig({ emitThrowsOn: 'ask' });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    expect(() => r.queue.queueRequest(spec({ signal: controller.signal }))).toThrow(
      'emit が投げた: ask',
    );
    expect(r.pending.map((request) => request.id)).toEqual(['r1']);
    expect(r.log).toEqual(['setStatus:waiting_human', 'emit:ask']);
    expect(add).not.toHaveBeenCalled();
  });

  it('setStatus(waiting_human) が投げる: 積んだ後で投げ、ask は出ない', () => {
    const r = rig({ setStatusThrowsOn: 'waiting_human' });
    expect(() => r.queue.queueRequest(spec())).toThrow('setStatus が投げた: waiting_human');
    expect(r.pending.map((request) => request.id)).toEqual(['r1']);
    expect(r.events).toEqual([]);
  });

  it('settled の emit が投げる: settle が投げ、外す・running へ戻すは済み、answered は解けず、deliverPeerNotices も呼ばれない', async () => {
    const r = rig({ status: 'waiting_human', emitThrowsOn: 'settled' });
    // ask は出るので、投げる種類は settled だけ
    const { answered } = r.queue.queueRequest(spec());
    r.log.length = 0;
    expect(() => r.pending[0]?.settle({ message: 'ok', decision: 'allow' })).toThrow(
      'emit が投げた: settled',
    );
    expect(r.log).toEqual(['setStatus:running', 'emit:settled']);
    expect(r.pending).toEqual([]);
    let answeredDone = false;
    void answered.then(() => {
      answeredDone = true;
    });
    await flush();
    expect(answeredDone).toBe(false);
  });

  it('deliverPeerNotices が投げる: settle が投げるが、answered は解けている（settle(value) は deliver より前）', async () => {
    const r = rig({ status: 'waiting_human', deliverThrows: true });
    const { result, answered } = r.queue.queueRequest(spec());
    expect(() => r.pending[0]?.settle({ message: 'ok', decision: 'allow' })).toThrow(
      'deliverPeerNotices が投げた',
    );
    expect(await answered).toEqual({ message: 'ok', decision: 'allow' });
    expect(await result).toEqual({ behavior: 'allow' });
  });

  it('decideAnswer が投げる: result は拒否され、resolved には何も覚えない。answered は解けている', async () => {
    const r = rig({
      decideAnswer: () => {
        throw new Error('decideAnswer が投げた');
      },
    });
    const { result, answered } = r.queue.queueRequest(spec());
    r.pending[0]?.settle({ message: 'ok', decision: 'allow' });
    await expect(result).rejects.toThrow('decideAnswer が投げた');
    expect(await answered).toEqual({ message: 'ok', decision: 'allow' });
    expect(r.resolved.set).not.toHaveBeenCalled();
  });

  it('すでに中断済みの signal で settled の emit が投げる: queueRequest が投げ、ask は先に出ている', () => {
    const r = rig({ emitThrowsOn: 'settled' });
    const controller = new AbortController();
    controller.abort();
    expect(() => r.queue.queueRequest(spec({ signal: controller.signal }))).toThrow(
      'emit が投げた: settled',
    );
    expect(r.events.map((event) => event.type)).toEqual(['ask', 'settled']);
  });
});
