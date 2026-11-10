import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PeerTurnResult } from './peer-broker.js';
import { closeParkedPeers, type ParkedPeers } from './runner.js';

// `runner.ts` から `closeParkedPeers`（預かった peer を閉じる）を別ファイルへ移す前の、直接の固定（pin）。
// 期待の値は今の作りの出力から `vitest -u` で生成して目で読んで確かめたもの（仕様を先に書いたものではない）。
// 既存の `runner-peer.test.ts` は host 経由（`stop`・期限）と、閉じ終えた後に届いた止まりどころの伏せ字（#4923）だけを縛っていた。
// ここは、フェイクの `ParkedPeers`（`broker`・`binding`）を作って直接呼び、`note` の全文・戻り値・`binding` の状態・呼び出しの順を縛る。
// 時計はフェイクのタイマー（`vi.useFakeTimers()`）。実時間は待たない。

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type StopResult = PeerTurnResult;

function stop(sessionId: string, over: Partial<StopResult> = {}): StopResult {
  return {
    sessionId,
    provider: 'codex',
    ok: true,
    text: `${sessionId} の止まりどころ`,
    denied: [],
    approved: [],
    ...over,
  };
}

interface FakeOptions {
  sessions?: { id: string; provider: 'codex' | 'claude' }[];
  background?: string[];
  pending?: { sessionId: string; approvalId: string }[];
  heldAsks?: { run: () => void; deny: (message: string) => void }[];
  heldStops?: StopResult[];
  closeAll?: (binding: ParkedPeers['binding'], log: string[]) => void;
}

function makeParked(options: FakeOptions = {}) {
  const log: string[] = [];
  const binding = {
    heldAsks: options.heldAsks ?? [],
    heldStops: options.heldStops ?? [],
  } as unknown as ParkedPeers['binding'];
  const broker = {
    sessionList: () => options.sessions ?? [],
    backgroundTasks: () => (options.background ?? []).map((id) => ({ id, taskType: 'peer' })),
    pendingApprovals: () => (options.pending ?? []).map((entry) => ({ ...entry, since: 0 })),
    closeAll: () => {
      log.push(`closeAll(collectStop=${typeof binding.collectStop})`);
      options.closeAll?.(binding, log);
    },
  } as unknown as ParkedPeers['broker'];
  return { parked: { broker, binding } satisfies ParkedPeers, binding, log };
}

const identity = (text: string): string => text;

function noteSink(): { notes: string[]; note: (text: string) => void } {
  const notes: string[] = [];
  return { notes, note: (text) => notes.push(text) };
}

async function ticksUntilSettled(promise: Promise<unknown>, limit = 50): Promise<number> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let tick = 0; tick <= limit; tick += 1) {
    if (settled) return tick;
    await Promise.resolve();
  }
  return -1;
}

describe('closeParkedPeers: 預かっていた確認（heldAsks）', () => {
  it('全部を理由付きで断り、空にする（同じ配列のまま）', async () => {
    const denied: string[] = [];
    const heldAsks = [
      { run: vi.fn(), deny: (m: string) => denied.push(`a:${m}`) },
      { run: vi.fn(), deny: (m: string) => denied.push(`b:${m}`) },
    ];
    const fake = makeParked({ heldAsks });
    const { notes, note } = noteSink();
    await closeParkedPeers(fake.parked, '人間・クローンが止めた', note, identity);
    expect(denied).toMatchInlineSnapshot(`
      [
        "a:peer のマネージャーが戻らないので断った（人間・クローンが止めた）",
        "b:peer のマネージャーが戻らないので断った（人間・クローンが止めた）",
      ]
    `);
    expect(fake.binding.heldAsks).toBe(heldAsks);
    expect(heldAsks).toHaveLength(0);
    for (const ask of heldAsks) expect(ask.run).not.toHaveBeenCalled();
    expect(notes).toMatchInlineSnapshot(`
      [
        "預かっていた peer のセッションを閉じた（人間・クローンが止めた）",
      ]
    `);
  });

  it('断るのは closeAll より前（closeAll の中では既に空）', async () => {
    const order: string[] = [];
    const heldAsks = [{ run: vi.fn(), deny: () => order.push('deny') }];
    const fake = makeParked({
      heldAsks,
      closeAll: (binding) => order.push(`closeAll(heldAsks=${String(binding.heldAsks.length)})`),
    });
    await closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    expect(order).toMatchInlineSnapshot(`
      [
        "deny",
        "closeAll(heldAsks=0)",
      ]
    `);
  });
});

describe('closeParkedPeers: 閉じた peer の初期値と戻り値', () => {
  it('session が無ければ空の配列。note は最後の1行だけ（既定の主語）', async () => {
    const fake = makeParked();
    const { notes, note } = noteSink();
    const result = await closeParkedPeers(fake.parked, '器を畳む', note, identity);
    expect(result).toEqual([]);
    expect(notes).toMatchInlineSnapshot(`
      [
        "預かっていた peer のセッションを閉じた（器を畳む）",
      ]
    `);
    expect(fake.log).toMatchInlineSnapshot(`
      [
        "closeAll(collectStop=function)",
      ]
    `);
  });

  it('sessionList の全 session を id・provider だけで返す（interrupted は付かない）。順は sessionList の順', async () => {
    const fake = makeParked({
      sessions: [
        { id: 's-b', provider: 'claude' },
        { id: 's-a', provider: 'codex' },
      ],
    });
    const result = await closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-b",
          "provider": "claude",
        },
        {
          "id": "s-a",
          "provider": "codex",
        },
      ]
    `);
    for (const entry of result) expect('interrupted' in entry).toBe(false);
  });

  it('主語の上書き（#6123）: 最後の note が subject を使う', async () => {
    const fake = makeParked();
    const { notes, note } = noteSink();
    await closeParkedPeers(
      fake.parked,
      '担当のセッションが終わった',
      note,
      identity,
      '担当の peer',
    );
    expect(notes).toMatchInlineSnapshot(`
      [
        "担当の peer のセッションを閉じた（担当のセッションが終わった）",
      ]
    `);
  });
});

describe('closeParkedPeers: 預かっていた止まりどころ（heldStops）', () => {
  it('note と record。heldStops は空になり、起きた順に note が並ぶ', async () => {
    const heldStops = [
      stop('s-1', { text: '作業は   終わった\nよ' }),
      stop('s-2', {
        provider: 'claude',
        text: '無視される',
        pendingApproval: { approvalId: 'ap-9', toolName: 'Bash', summary: 'rm -rf /tmp/x' },
      }),
    ];
    const fake = makeParked({
      sessions: [
        { id: 's-1', provider: 'codex' },
        { id: 's-2', provider: 'claude' },
        { id: 's-3', provider: 'codex' },
      ],
      heldStops,
    });
    const { notes, note } = noteSink();
    const result = await closeParkedPeers(fake.parked, '期限', note, identity);
    expect(heldStops).toHaveLength(0);
    expect(fake.binding.heldStops).toBe(heldStops);
    expect(notes).toMatchInlineSnapshot(`
      [
        "背景の peer（codex）[s-1] の止まりどころを届けられないまま閉じた（期限）: session_id: s-1（続けるなら peer_reply に渡す）
      provider: codex

      作業は   終わった
      よ",
        "背景の peer（claude）[s-2] の止まりどころを届けられないまま閉じた（期限）: session_id: s-2（続けるなら peer_reply に渡す）
      provider: claude

      確認待ち: approval_id=ap-9
      操作: Bash
      内容: rm -rf /tmp/x

      peer_approve に approval_id と decision を渡して答えること（allow=その場で許可 / deny=拒否 / escalate=判断できないのでユーザーへ回す）。答えるまで相手のターンは止まっている（ほかの peer セッションを起こしても、この確認は閉じない。セッションが終わる・あなたが止まると拒否として閉じる）。",
        "預かっていた peer のセッションを閉じた（期限）",
      ]
    `);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-1",
          "interrupted": "作業は 終わった よ",
          "provider": "codex",
        },
        {
          "id": "s-2",
          "interrupted": "確認待ちで止まっていた: Bash rm -rf /tmp/x",
          "provider": "claude",
        },
        {
          "id": "s-3",
          "provider": "codex",
        },
      ]
    `);
  });

  it('伏せ字が先、切り詰めが後（#4923）: 切り口にかかる値も伏せ字になり、先頭が漏れない', async () => {
    const secret = 'SECRETVALUE';
    // 伏せ字より前に 300 字で切ると、`SECRETVALUE` が `SEC` だけ残って伏せ字が効かない
    const text = `${'a'.repeat(297)}${secret}${'b'.repeat(50)}`;
    const fake = makeParked({
      sessions: [{ id: 's-1', provider: 'codex' }],
      heldStops: [stop('s-1', { text })],
    });
    const { notes, note } = noteSink();
    const result = await closeParkedPeers(fake.parked, '理由', note, (value) =>
      value.replaceAll(secret, '[伏せ字]'),
    );
    const interrupted = result[0]?.interrupted ?? '';
    expect(interrupted).toMatchInlineSnapshot(
      `"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa[伏せ…（52 文字省略。全 352 文字）"`,
    );
    expect(interrupted).not.toContain('SEC');
    expect(interrupted).toContain('[伏せ');
    expect(notes.join('\n')).not.toContain(secret);
  });

  it('抜粋は 300 字で切って省いた字数を添える。短ければ何も足さない（空白は1つに畳む）', async () => {
    const fake = makeParked({
      sessions: [
        { id: 's-long', provider: 'codex' },
        { id: 's-short', provider: 'codex' },
      ],
      heldStops: [
        stop('s-long', { text: 'x'.repeat(301) }),
        stop('s-short', { text: ' 短い\n\n本文 ' }),
      ],
    });
    const result = await closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-long",
          "interrupted": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…（1 文字省略。全 301 文字）",
          "provider": "codex",
        },
        {
          "id": "s-short",
          "interrupted": "短い 本文",
          "provider": "codex",
        },
      ]
    `);
  });

  it('heldStops にしか居ない peer（sessionList に無い）も、record で末尾に足される', async () => {
    const fake = makeParked({
      sessions: [{ id: 's-1', provider: 'codex' }],
      heldStops: [stop('s-gone', { provider: 'claude' })],
    });
    const result = await closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-1",
          "provider": "codex",
        },
        {
          "id": "s-gone",
          "interrupted": "s-gone の止まりどころ",
          "provider": "claude",
        },
      ]
    `);
  });
});

describe('closeParkedPeers: 確認待ちで止まっていた peer（#6123）', () => {
  it('interrupted が未設定のものだけ approval_id で控える。session が見つからないものは飛ばす。待たない（タイマーを作らない）', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fake = makeParked({
      sessions: [
        { id: 's-1', provider: 'codex' },
        { id: 's-2', provider: 'claude' },
        { id: 's-3', provider: 'codex' },
      ],
      heldStops: [stop('s-1', { text: '先に届いていた止まりどころ' })],
      pending: [
        { sessionId: 's-1', approvalId: 'ap-1' },
        { sessionId: 's-2', approvalId: 'ap-2' },
        { sessionId: 'no-such', approvalId: 'ap-x' },
      ],
    });
    const result = await closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-1",
          "interrupted": "先に届いていた止まりどころ",
          "provider": "codex",
        },
        {
          "id": "s-2",
          "interrupted": "確認待ちで止まっていた（approval_id=ap-2）",
          "provider": "claude",
        },
        {
          "id": "s-3",
          "provider": "codex",
        },
      ]
    `);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('closeParkedPeers: collectStop と closeAll の位置', () => {
  it('closeAll の時点で collectStop が立っている。closeAll の中で全部届けば待たない（タイマーを作らない）', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fake = makeParked({
      sessions: [
        { id: 's-1', provider: 'codex' },
        { id: 's-2', provider: 'codex' },
      ],
      background: ['peer:s-1', 'peer:s-2'],
      closeAll: (binding, log) => {
        binding.collectStop?.(stop('s-1', { text: '一つめ' }));
        log.push('delivered s-1');
        binding.collectStop?.(stop('s-2', { text: '二つめ' }));
        log.push('delivered s-2');
      },
    });
    const { notes, note } = noteSink();
    const result = await closeParkedPeers(fake.parked, '理由', note, identity);
    expect(fake.log).toMatchInlineSnapshot(`
      [
        "closeAll(collectStop=function)",
        "delivered s-1",
        "delivered s-2",
      ]
    `);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-1",
          "interrupted": "一つめ",
          "provider": "codex",
        },
        {
          "id": "s-2",
          "interrupted": "二つめ",
          "provider": "codex",
        },
      ]
    `);
    expect(notes).toMatchInlineSnapshot(`
      [
        "預かっていた peer のセッションを閉じた（理由）",
      ]
    `);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(typeof fake.binding.collectStop).toBe('function');
  });

  it('閉じ終えた後に届いた止まりどころは note だけで集めない（#4885）。戻り値は変わらない', async () => {
    const fake = makeParked({ sessions: [{ id: 's-1', provider: 'codex' }] });
    const { notes, note } = noteSink();
    const result = await closeParkedPeers(fake.parked, '期限', note, (t) =>
      t.replaceAll('秘', '■'),
    );
    const before = JSON.stringify(result);
    fake.binding.collectStop?.(stop('s-1', { text: '秘密の本文' }));
    fake.binding.collectStop?.(stop('s-new', { provider: 'claude' }));
    expect(notes).toMatchInlineSnapshot(`
      [
        "預かっていた peer のセッションを閉じた（期限）",
        "背景の peer（codex）[s-1] の止まりどころが、閉じ終えた後に届いた（期限）: session_id: s-1（続けるなら peer_reply に渡す）
      provider: codex

      ■密の本文",
        "背景の peer（claude）[s-new] の止まりどころが、閉じ終えた後に届いた（期限）: session_id: s-new（続けるなら peer_reply に渡す）
      provider: claude

      s-new の止まりどころ",
      ]
    `);
    expect(JSON.stringify(result)).toBe(before);
    expect(result).toHaveLength(1);
  });
});

describe('closeParkedPeers: 背景ターンを待つ上限（PARKED_PEER_STOP_COLLECT_MS）', () => {
  const sessions: { id: string; provider: 'codex' | 'claude' }[] = [
    { id: 's-1', provider: 'codex' },
    { id: 's-2', provider: 'claude' },
  ];

  function spyTimers() {
    const realSetTimeout = globalThis.setTimeout;
    const unrefs: ReturnType<typeof vi.fn>[] = [];
    const delays: unknown[] = [];
    // フェイクのタイマーを包み、`unref` の呼び出しと遅れを控える
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms);
      const timer = realSetTimeout(fn, ms) as unknown as { unref?: () => unknown };
      const unref = vi.fn(() => timer);
      timer.unref = unref;
      unrefs.push(unref);
      return timer;
    }) as unknown as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    return { unrefs, delays, clearSpy };
  }

  it('全部届くまで待ち、届いたら上限を待たず、タイマーを clearTimeout する。unref も呼ぶ', async () => {
    vi.useFakeTimers();
    const timers = spyTimers();
    const fake = makeParked({ sessions, background: ['peer:s-1', 'peer:s-2'] });
    const { notes, note } = noteSink();
    let settled = false;
    const promise = closeParkedPeers(fake.parked, '理由', note, identity).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(false);
    fake.binding.collectStop?.(stop('s-1', { text: '一つめ' }));
    await vi.advanceTimersByTimeAsync(1_000 - 1);
    expect(settled).toBe(false);
    fake.binding.collectStop?.(stop('s-2', { text: '二つめ', provider: 'claude' }));
    const result = await promise;
    expect(timers.delays).toEqual([5_000]);
    expect(timers.unrefs).toHaveLength(1);
    expect(timers.unrefs[0]).toHaveBeenCalledTimes(1);
    expect(timers.clearSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-1",
          "interrupted": "一つめ",
          "provider": "codex",
        },
        {
          "id": "s-2",
          "interrupted": "二つめ",
          "provider": "claude",
        },
      ]
    `);
    expect(notes).toMatchInlineSnapshot(`
      [
        "預かっていた peer のセッションを閉じた（理由）",
      ]
    `);
  });

  it('上限（5000ms）で切る: 4999ms では待ち、5000ms で解ける。届かなかった背景ターンを数える（届いたものは上書きしない）', async () => {
    vi.useFakeTimers();
    const timers = spyTimers();
    const fake = makeParked({ sessions, background: ['peer:s-1', 'peer:s-2'] });
    let settled = false;
    const promise = closeParkedPeers(fake.parked, '理由', () => undefined, identity).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    fake.binding.collectStop?.(stop('s-1', { text: '届いた止まりどころ' }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(settled).toBe(true);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-1",
          "interrupted": "届いた止まりどころ",
          "provider": "codex",
        },
        {
          "id": "s-2",
          "interrupted": "背景ターンが走っていた（閉じたが、止まりどころは届かなかった）",
          "provider": "claude",
        },
      ]
    `);
    expect(timers.clearSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('上限で切った後に届いた止まりどころは note だけ（戻り値は変わらない）', async () => {
    vi.useFakeTimers();
    const fake = makeParked({ sessions, background: ['peer:s-1'] });
    const { notes, note } = noteSink();
    const promise = closeParkedPeers(fake.parked, '期限', note, identity);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    const before = JSON.stringify(result);
    fake.binding.collectStop?.(stop('s-1', { text: '遅れて届いた' }));
    expect(JSON.stringify(result)).toBe(before);
    expect(notes).toMatchInlineSnapshot(`
      [
        "預かっていた peer のセッションを閉じた（期限）",
        "背景の peer（codex）[s-1] の止まりどころが、閉じ終えた後に届いた（期限）: session_id: s-1（続けるなら peer_reply に渡す）
      provider: codex

      遅れて届いた",
      ]
    `);
  });

  it('確認待ちで控えた peer は、背景ターンでも上限後に上書きしない（interrupted が未設定のものだけ数える）。背景に居ても session が無い id は足さない', async () => {
    vi.useFakeTimers();
    const fake = makeParked({
      sessions,
      background: ['peer:s-1', 'peer:s-2', 'peer:ghost'],
      pending: [{ sessionId: 's-1', approvalId: 'ap-1' }],
    });
    const promise = closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "s-1",
          "interrupted": "確認待ちで止まっていた（approval_id=ap-1）",
          "provider": "codex",
        },
        {
          "id": "s-2",
          "interrupted": "背景ターンが走っていた（閉じたが、止まりどころは届かなかった）",
          "provider": "claude",
        },
      ]
    `);
  });

  it('peer: の接頭辞は先頭だけ外す（途中の peer: は残る）', async () => {
    vi.useFakeTimers();
    const fake = makeParked({
      sessions: [{ id: 'x-peer:y', provider: 'codex' }],
      background: ['peer:x-peer:y'],
    });
    const promise = closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    fake.binding.collectStop?.(stop('x-peer:y'));
    const result = await promise;
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "id": "x-peer:y",
          "interrupted": "x-peer:y の止まりどころ",
          "provider": "codex",
        },
      ]
    `);
  });
});

describe('closeParkedPeers: 非同期の周回数', () => {
  it('待たない経路は、呼び出しから 1 周回で解ける', async () => {
    const fake = makeParked({ sessions: [{ id: 's-1', provider: 'codex' }] });
    const promise = closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    expect(await ticksUntilSettled(promise)).toMatchInlineSnapshot(`1`);
  });

  it('待つ経路は、最後の止まりどころが届いてから解けるまでの周回数が決まっている', async () => {
    vi.useFakeTimers();
    const fake = makeParked({
      sessions: [{ id: 's-1', provider: 'codex' }],
      background: ['peer:s-1'],
    });
    const promise = closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    await Promise.resolve();
    fake.binding.collectStop?.(stop('s-1'));
    expect(await ticksUntilSettled(promise)).toMatchInlineSnapshot(`2`);
  });
});

describe('closeParkedPeers: 途中で投げたとき', () => {
  it('note が同期で投げる（heldStops の note）: Promise が拒否される。heldStops は空・collectStop は立たず・closeAll は呼ばれない', async () => {
    const fake = makeParked({
      sessions: [{ id: 's-1', provider: 'codex' }],
      heldStops: [stop('s-1'), stop('s-2')],
    });
    const seen: string[] = [];
    const promise = closeParkedPeers(
      fake.parked,
      '理由',
      (text) => {
        seen.push(text);
        throw new Error('note が投げた');
      },
      identity,
    );
    await expect(promise).rejects.toThrow('note が投げた');
    expect(seen).toHaveLength(1);
    expect(fake.binding.heldStops).toHaveLength(0);
    expect(fake.binding.collectStop).toBeUndefined();
    expect(fake.log).toEqual([]);
  });

  it('最後の note が投げる: 拒否される。collectStop は立ったまま（閉じ終えた後の note も投げれば collectStop の呼び手へ伝わる）', async () => {
    const fake = makeParked({ sessions: [{ id: 's-1', provider: 'codex' }] });
    let calls = 0;
    const promise = closeParkedPeers(
      fake.parked,
      '理由',
      () => {
        calls += 1;
        throw new Error('最後の note');
      },
      identity,
    );
    await expect(promise).rejects.toThrow('最後の note');
    expect(calls).toBe(1);
    expect(typeof fake.binding.collectStop).toBe('function');
    expect(() => fake.binding.collectStop?.(stop('s-1'))).toThrow('最後の note');
    expect(calls).toBe(2);
  });

  it('ask.deny が投げる: 拒否される。heldAsks は空（splice 済み）・残りの deny は呼ばれず、closeAll も呼ばれない', async () => {
    const second = vi.fn();
    const fake = makeParked({
      heldAsks: [
        {
          run: vi.fn(),
          deny: () => {
            throw new Error('deny が投げた');
          },
        },
        { run: vi.fn(), deny: second },
      ],
    });
    const promise = closeParkedPeers(fake.parked, '理由', () => undefined, identity);
    await expect(promise).rejects.toThrow('deny が投げた');
    expect(fake.binding.heldAsks).toHaveLength(0);
    expect(second).not.toHaveBeenCalled();
    expect(fake.binding.collectStop).toBeUndefined();
    expect(fake.log).toEqual([]);
  });

  it('broker.closeAll が投げる: 拒否される。collectStop は立ったまま・最後の note は出ない・待たない（タイマーを作らない）', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fake = makeParked({
      sessions: [{ id: 's-1', provider: 'codex' }],
      background: ['peer:s-1'],
      closeAll: () => {
        throw new Error('closeAll が投げた');
      },
    });
    const { notes, note } = noteSink();
    const promise = closeParkedPeers(fake.parked, '理由', note, identity);
    await expect(promise).rejects.toThrow('closeAll が投げた');
    expect(typeof fake.binding.collectStop).toBe('function');
    expect(notes).toEqual([]);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
