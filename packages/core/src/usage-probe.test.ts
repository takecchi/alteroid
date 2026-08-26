import { query } from '@anthropic-ai/claude-agent-sdk';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  describeProbeError,
  redactEnvSecrets,
  runUsageProbe,
  settleWithin,
  type UsageProbeHandle,
  type UsageProbeQuery,
} from './usage-probe.js';

/**
 * `queryFn` に渡された `options`（SDK の `Options`）を横から覗くための偽物。
 * probe は `read` の返り値だけを見るので、`capture` へ実際に渡された `Options`
 * を積んでおいて、呼び出し後にテストがそれを検分する。
 */
function capturingProbe(): { queryFn: UsageProbeQuery; captured: unknown[] } {
  const captured: unknown[] = [];
  const queryFn: UsageProbeQuery = ({ options }) => {
    captured.push(options);
    const handle: UsageProbeHandle = {
      async *[Symbol.asyncIterator]() {
        /* probe は control channel しか読まない */
      },
    };
    return handle;
  };
  return { queryFn, captured };
}

describe('runUsageProbe — env を渡す口', () => {
  it('env を渡さないとき、Options に env が載らない（既定の経路が変わらない）', async () => {
    const { queryFn, captured } = capturingProbe();
    await runUsageProbe(queryFn, { cwd: '/tmp/wherever' }, async () => 'ignored');

    expect(captured).toHaveLength(1);
    const options = captured[0] as Record<string, unknown>;
    expect('env' in options).toBe(false);
  });

  it('env を渡すと { ...process.env, ...渡した値 } になる（丸ごと置き換わらない）', async () => {
    const { queryFn, captured } = capturingProbe();
    // process.env に既に在る変数（PATH）が残っていることまで見る。
    expect(process.env.PATH).toBeDefined();

    await runUsageProbe(
      queryFn,
      { cwd: '/tmp/wherever', env: { CLAUDE_CODE_OAUTH_TOKEN: 'DUMMY-NOT-A-REAL-TOKEN' } },
      async () => 'ignored',
    );

    expect(captured).toHaveLength(1);
    const options = captured[0] as { env?: Record<string, string | undefined> };
    expect(options.env).toBeDefined();
    // 既存の環境変数が残っている（丸ごと置き換わっていない）。
    expect(options.env?.PATH).toBe(process.env.PATH);
    // 渡した値が上書きとして載っている。
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('DUMMY-NOT-A-REAL-TOKEN');
  });

  it('settingSources は常に project のみ（env の有無で変わらない）', async () => {
    const { queryFn, captured } = capturingProbe();
    await runUsageProbe(
      queryFn,
      { cwd: '/tmp/wherever', env: { CLAUDE_CODE_OAUTH_TOKEN: 'DUMMY-NOT-A-REAL-TOKEN' } },
      async () => 'ignored',
    );
    const options = captured[0] as { settingSources?: string[] };
    expect(options.settingSources).toEqual(['project']);
  });
});

describe('runUsageProbe — withheldEnvKeys（#431）', () => {
  it('withheldEnvKeys だけを渡しても（env は渡さなくても）Options.env が組み立てられ、キーが落ちる', async () => {
    const { queryFn, captured } = capturingProbe();
    const original = process.env.ALTEROID_DATABASE_URL;
    process.env.ALTEROID_DATABASE_URL = 'postgres://unit-test-secret';
    try {
      await runUsageProbe(
        queryFn,
        { cwd: '/tmp/wherever', withheldEnvKeys: ['ALTEROID_DATABASE_URL'] },
        async () => 'ignored',
      );
    } finally {
      if (original === undefined) delete process.env.ALTEROID_DATABASE_URL;
      else process.env.ALTEROID_DATABASE_URL = original;
    }

    const options = captured[0] as { env?: Record<string, string | undefined> };
    expect(options.env).toBeDefined();
    // 落としたキーは消えている。
    expect('ALTEROID_DATABASE_URL' in (options.env ?? {})).toBe(false);
    // ほかの環境変数（PATH）は残っている（丸ごと落ちてはいない）。
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it('withheldEnvKeys も env も無ければ、これまでどおり Options.env 自体を省略する', async () => {
    const { queryFn, captured } = capturingProbe();
    await runUsageProbe(queryFn, { cwd: '/tmp/wherever' }, async () => 'ignored');
    const options = captured[0] as Record<string, unknown>;
    expect('env' in options).toBe(false);
  });

  it('env と withheldEnvKeys を両方渡すと、上書き後に withheldEnvKeys を落とす', async () => {
    const { queryFn, captured } = capturingProbe();
    await runUsageProbe(
      queryFn,
      {
        cwd: '/tmp/wherever',
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'DUMMY-NOT-A-REAL-TOKEN', ALTEROID_DATABASE_URL: 'x' },
        withheldEnvKeys: ['ALTEROID_DATABASE_URL'],
      },
      async () => 'ignored',
    );
    const options = captured[0] as { env?: Record<string, string | undefined> };
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('DUMMY-NOT-A-REAL-TOKEN');
    expect('ALTEROID_DATABASE_URL' in (options.env ?? {})).toBe(false);
  });
});

/**
 * ここから下は #431 の「実測」——`queryFn` を偽物ではなく**実物の SDK の `query`**
 * にして、`Options.spawnClaudeCodeProcess`（`sdk.d.ts` が公開しているフック。
 * VM/コンテナ実行向けに、SDK が本来 `child_process` へ渡すはずの `{ command, args,
 * cwd, env, signal }` をそのまま横取りできる）で、**SDK が実際に子プロセスへ渡す
 * つもりだった生の `env` オブジェクト**を取り出す。
 *
 * 実際に読んだ `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` の該当行
 * （`ProcessTransport#initialize`）は次を destructure している:
 *
 * ```
 * let{...,env:c={...process.env},...}=this.options
 * ```
 *
 * ⟹ `Options.env` を省略すると `c` の既定値は **`{ ...process.env }` そのもの**
 * になり、それが1行も変換されずに `child_process.spawn` 相当（`spawnLocalProcess`）
 * へ渡る。ここではその既定値の組み立てをドキュメントからの推論としてではなく、
 * 実際に `query()` を呼んで確かめる。
 */
function realSdkCapturingProbe(): {
  queryFn: UsageProbeQuery;
  capturedEnv: () => NodeJS.ProcessEnv | undefined;
} {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const queryFn: UsageProbeQuery = ({ prompt, options }) =>
    query({
      prompt,
      options: {
        ...options,
        // **実際の CLI は起こさない。** `env` を受け取った時点で捕まえ、
        // SDK には「起動した体」で握りつぶした stdin/stdout を渡すだけ。
        spawnClaudeCodeProcess: (spawnOptions) => {
          capturedEnv = spawnOptions.env;
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          // すぐ EOF にして、SDK 側の待受けを長引かせない。
          queueMicrotask(() => stdout.end());
          let killed = false;
          return {
            stdin,
            stdout,
            get killed() {
              return killed;
            },
            exitCode: null,
            signalCode: null,
            kill: () => {
              killed = true;
              return true;
            },
            on: () => {},
            once: () => {},
            off: () => {},
          };
        },
      },
    }) as unknown as UsageProbeHandle;
  return { queryFn, capturedEnv: () => capturedEnv };
}

describe('runUsageProbe — 実測: 子プロセスへ渡る env（#431、実物の SDK を使う）', () => {
  const SECRET_KEY = 'ALTEROID_DATABASE_URL';
  const SECRET_VALUE = 'postgres://usage-probe-431-measured-secret';

  it('withheldEnvKeys を渡さないと、SDK が組み立てる spawn 用 env に秘密がそのまま載る', async () => {
    const original = process.env[SECRET_KEY];
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const { queryFn, capturedEnv } = realSdkCapturingProbe();
      await runUsageProbe(queryFn, { cwd: process.cwd() }, async () => 'ignored');
      // ⟹ 実測: usage-poller のように env も withheldEnvKeys も渡さない呼び出しは、
      // SDK の既定 { ...process.env } を丸ごと子へ渡す。
      expect(capturedEnv()?.[SECRET_KEY]).toBe(SECRET_VALUE);
    } finally {
      if (original === undefined) delete process.env[SECRET_KEY];
      else process.env[SECRET_KEY] = original;
    }
  });

  it('withheldEnvKeys を渡すと、SDK が組み立てる spawn 用 env から実際に落ちる（回帰）', async () => {
    const original = process.env[SECRET_KEY];
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const { queryFn, capturedEnv } = realSdkCapturingProbe();
      await runUsageProbe(
        queryFn,
        { cwd: process.cwd(), withheldEnvKeys: [SECRET_KEY] },
        async () => 'ignored',
      );
      expect(capturedEnv()).toBeDefined();
      expect(SECRET_KEY in (capturedEnv() ?? {})).toBe(false);
      // 巻き添えで PATH まで消していないことも確かめる。
      expect(capturedEnv()?.PATH).toBe(process.env.PATH);
    } finally {
      if (original === undefined) delete process.env[SECRET_KEY];
      else process.env[SECRET_KEY] = original;
    }
  });
});

describe('runUsageProbe — 失敗の理由を構造化して持ち帰る（#429）', () => {
  it('成功したら { ok: true, value } を返す', async () => {
    const { queryFn } = capturingProbe();
    const outcome = await runUsageProbe(queryFn, { cwd: '/tmp/wherever' }, async () => 'answer');
    expect(outcome).toEqual({ ok: true, value: 'answer' });
  });

  it('queryFn が同期的に投げたら kind: exception（起動失敗）で理由を持ち帰る', async () => {
    const queryFn: UsageProbeQuery = () => {
      throw new Error('spawn ENOENT: no such file');
    };
    const outcome = await runUsageProbe(queryFn, { cwd: '/tmp/wherever' }, async () => 'ignored');
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'exception', reason: 'Error: spawn ENOENT: no such file' },
    });
  });

  it('read が投げたら kind: exception（起動失敗）で理由を持ち帰る', async () => {
    const { queryFn } = capturingProbe();
    const outcome = await runUsageProbe(queryFn, { cwd: '/tmp/wherever' }, async () => {
      throw new Error('control channel exploded');
    });
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'exception', reason: 'Error: control channel exploded' },
    });
  });

  it('締め切りに間に合わなかったら kind: timeout で、締め切りの値を理由に含める', async () => {
    const { queryFn } = capturingProbe();
    const outcome = await runUsageProbe(
      queryFn,
      { cwd: '/tmp/wherever', timeoutMs: 20 },
      () =>
        new Promise(() => {
          /* 決して解決しない — 締め切りだけが勝つ */
        }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('timeout');
      expect(outcome.failure.reason).toContain('20ms');
    }
  });

  it('read が例外で終わっても、外の signal が既に中断していれば kind: aborted になる（起動失敗と混ざらない）', async () => {
    const { queryFn } = capturingProbe();
    const controller = new AbortController();
    const outcomePromise = runUsageProbe(
      queryFn,
      { cwd: '/tmp/wherever', signal: controller.signal },
      () =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('transport closed'));
          controller.signal.addEventListener('abort', onAbort);
        }),
    );
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'aborted', reason: '観測中に中断された' },
    });
  });

  it('外の signal が中断した状態のまま締め切りを迎えても kind: aborted になる（締め切りと混ざらない）', async () => {
    const { queryFn } = capturingProbe();
    const controller = new AbortController();
    const outcomePromise = runUsageProbe(
      queryFn,
      { cwd: '/tmp/wherever', signal: controller.signal, timeoutMs: 20 },
      () =>
        new Promise(() => {
          /* handle が abort に反応しない偽物でも、中断が優先される */
        }),
    );
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'aborted', reason: '締め切り前に中断された' },
    });
  });

  it('#429 秘密の扱い: 例外メッセージに候補トークンの値が入っていても reason からは伏せる', async () => {
    const secretToken = 'sk-ant-DUMMY-NOT-A-REAL-TOKEN-0123456789';
    const queryFn: UsageProbeQuery = () => {
      throw new Error(`auth failed for token ${secretToken}`);
    };
    const outcome = await runUsageProbe(
      queryFn,
      { cwd: '/tmp/wherever', env: { CLAUDE_CODE_OAUTH_TOKEN: secretToken } },
      async () => 'ignored',
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reason).not.toContain(secretToken);
      expect(outcome.failure.reason).toContain('[REDACTED]');
    }
  });
});

describe('settleWithin — 第3引数 onRejected（#429）', () => {
  it('rejection の理由を onRejected へ渡しつつ、戻り値はこれまでどおり undefined', async () => {
    const captured: unknown[] = [];
    const result = await settleWithin(Promise.reject(new Error('boom')), 1000, (error) => {
      captured.push(error);
    });
    expect(result).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe('boom');
  });

  it('onRejected を省略しても、これまでどおり握り潰して undefined を返す（既存呼び出し元の契約を壊さない）', async () => {
    const result = await settleWithin(Promise.reject(new Error('boom')), 1000);
    expect(result).toBeUndefined();
  });

  it('resolve したときは onRejected を呼ばない', async () => {
    const captured: unknown[] = [];
    const result = await settleWithin(Promise.resolve('value'), 1000, (error) => {
      captured.push(error);
    });
    expect(result).toBe('value');
    expect(captured).toHaveLength(0);
  });

  it('promise が undefined（口が無い）なら onRejected も呼ばれない', async () => {
    const captured: unknown[] = [];
    const result = await settleWithin(undefined, 1000, (error) => {
      captured.push(error);
    });
    expect(result).toBeUndefined();
    expect(captured).toHaveLength(0);
  });
});

describe('redactEnvSecrets（#429）', () => {
  it('env に渡した値をすべて [REDACTED] に置き換える（複数回の出現も全部）', () => {
    expect(redactEnvSecrets('token=ABC123 and ABC123 again', { X: 'ABC123' })).toBe(
      'token=[REDACTED] and [REDACTED] again',
    );
  });

  it('env が undefined なら何もしない', () => {
    expect(redactEnvSecrets('as-is', undefined)).toBe('as-is');
  });

  it('空文字の値は無視する（空文字は全文字の間に挟まってしまうので置換しない）', () => {
    expect(redactEnvSecrets('abc', { EMPTY: '' })).toBe('abc');
  });
});

describe('describeProbeError（#429）', () => {
  it('Error なら name: message の1行目だけを使う（スタックトレースは持ち帰らない）', () => {
    const error = new Error('line1\nline2');
    error.name = 'CustomError';
    expect(describeProbeError(error, undefined)).toBe('CustomError: line1');
  });

  it('Error でなければ String() する', () => {
    expect(describeProbeError('plain string', undefined)).toBe('plain string');
  });

  it('env の値が含まれていれば伏せる', () => {
    const error = new Error('failed with SECRET-VALUE');
    expect(describeProbeError(error, { TOKEN: 'SECRET-VALUE' })).toBe(
      'Error: failed with [REDACTED]',
    );
  });
});
