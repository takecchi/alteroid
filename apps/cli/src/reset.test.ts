import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmIo } from './confirm.js';
import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { resetCommand, buildConfirmMessage, RESET_CONFIRM_GROUPS_FOR_TEST, SUMMARY_LABELS } =
  await import('./reset.js');

interface Reply {
  status: number;
  body: unknown;
}

let reply: Reply;
let sent: { url: string; method: string; body: unknown }[];
let originalFetch: typeof fetch;

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const method = init?.method ?? request.method ?? 'GET';
    const body =
      typeof init?.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    sent.push({ url, method, body });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  reply = { status: 200, body: { cleared: {} } };
  sent = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid reset --yes', () => {
  it('confirm: true を伴って POST /reset を叩き、消した件数を報告する', async () => {
    reply = {
      status: 200,
      body: {
        cleared: {
          memory: 3,
          journal: 1,
          jobs: 0,
          approvals: 0,
          schedules: 0,
          schedulePhases: 0,
          inbox: 0,
          commitments: 0,
          archive: 0,
          sessions: 0,
          profile: 0,
          usageDaily: 0,
          usageBaseline: 0,
          usageLedger: 0,
          usageTurns: 0,
          attachments: 4,
        },
      },
    };
    const read = captureStdout();

    await resetCommand({ yes: true });

    expect(sent).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:4517/reset',
        method: 'POST',
        body: { confirm: true },
      }),
    ]);
    const text = read();
    expect(text).toContain('リセットしました');
    expect(text).toContain('記憶: 3');
    expect(text).toContain('日誌: 1');
    expect(text).toContain('添付（保存したファイルを含む）: 4');
    expect(text).toContain('認証トークンのプール・マネージャーへ降ろす環境変数・Web UI のログイン');
  });

  it('403（旧デーモンの未宣言 owner の本文）は、案内を出さずに止まる（access owner は存在しない。#2948）', async () => {
    reply = {
      status: 403,
      body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
    };

    const message = await resetCommand({ yes: true }).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );

    expect(message).toContain('理由を判別できなかった');
    expect(message).not.toContain('access owner');
    expect(message).not.toContain('access grant <アカウント id>');
  });

  it('403（未 grant）なら、access grant を打てと言う', async () => {
    reply = {
      status: 403,
      body: { error: 'このアカウントには alteroid を使う許可が無い' },
    };

    const message = await resetCommand({ yes: true }).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );

    expect(message).toContain('alteroid access grant <アカウント id>');
  });

  it('403（not_operator の本文。この経路では実際には来ないはず）は、案内を出さない', async () => {
    reply = {
      status: 403,
      body: { error: '実行環境の持ち主だけが操作できる' },
    };

    const message = await resetCommand({ yes: true }).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );

    expect(message).toContain('理由を判別できなかった');
    expect(message).not.toContain('docker compose exec');
    expect(message).not.toContain('access grant');
    expect(message).not.toContain('access owner');
  });
});

describe('確認の文（buildConfirmMessage） — issue #2196', () => {
  it('「仕事のやり方」が確認の文に出る（消える前に知らされる）', () => {
    expect(buildConfirmMessage('http://127.0.0.1:4517')).toContain('仕事のやり方');
  });

  it('接続先（どのデーモンを消すか）が確認の文に出る（#3214）', () => {
    expect(buildConfirmMessage('https://alteroid.example.com')).toContain(
      '接続先: https://alteroid.example.com',
    );
  });

  it('接続先の userinfo（user:pass@）は確認の文に出ない。URL として読めない値でも落ちない（#3214）', () => {
    const message = buildConfirmMessage('https://alice:s3cret@alteroid.example.com:8443/base');
    expect(message).toContain('接続先: https://alteroid.example.com:8443/base');
    expect(message).not.toContain('alice');
    expect(message).not.toContain('s3cret');
    const broken = buildConfirmMessage('//bob:hunter2@not a url');
    expect(broken).not.toContain('bob');
    expect(broken).not.toContain('hunter2');
  });

  it('消した後の報告の見出し（SUMMARY_LABELS）が、全キーどこかの確認の group に載っている', () => {
    const covered = new Set(
      RESET_CONFIRM_GROUPS_FOR_TEST.flatMap((group: { keys: string[] }) => group.keys),
    );
    const labelKeys = SUMMARY_LABELS.map(([key]: [string, string]) => key);

    for (const key of labelKeys) {
      expect(covered.has(key), `${key} が確認の group に見当たらない`).toBe(true);
    }
    expect(covered.size).toBe(labelKeys.length);
  });

  it('報告の見出しは画面（/settings）と同じ言い方で、内部の呼び名（SDK・runner）を出さない', () => {
    const labels = Object.fromEntries(SUMMARY_LABELS) as Record<string, string>;
    expect(labels.sessionLog).toBe('セッションの生ログ');
    expect(labels.usageLedger).toBe('利用状況（記録の開始時刻）');
    for (const label of Object.values(labels)) {
      expect(label).not.toMatch(/SDK|runner/);
    }
  });
});

describe('確認の扱い（confirmIrreversible に揃える） — issue #3200', () => {
  function fakeIo(over: { isTTY?: boolean; answer?: string } = {}): {
    io: ConfirmIo;
    written: string[];
    asked: string[];
  } {
    const written: string[] = [];
    const asked: string[] = [];
    const io: ConfirmIo = {
      isTTY: over.isTTY ?? true,
      write: (text) => {
        written.push(text);
      },
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(over.answer ?? '');
      },
    };
    return { io, written, asked };
  }

  it('端末でなく --yes も無ければ、標準入力に yes があっても POST せず断る', async () => {
    const { io, asked } = fakeIo({ isTTY: false, answer: 'yes' });

    const error = await resetCommand({}, io).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('--yes');
    expect(message).toContain('何も変更していません');
    expect(message).toContain(buildConfirmMessage('http://127.0.0.1:4517'));
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('端末で yes なら、何が消えるかを見せてから POST /reset する（「取り消せません」は1回だけ）', async () => {
    const { io, written, asked } = fakeIo({ answer: 'yes' });
    const read = captureStdout();
    await resetCommand({}, io);
    const out = read();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', body: { confirm: true } });
    expect(asked).toEqual(['続けるなら yes と入力してください: ']);
    const shown = written.join('');
    expect(shown).toContain(buildConfirmMessage('http://127.0.0.1:4517'));
    expect(shown.match(/取り消せません。/g)).toHaveLength(1);
    expect(out).toContain('リセットしました');
  });

  it('端末で yes 以外なら、取り消して POST しない', async () => {
    const { io, written } = fakeIo({ answer: 'n' });

    await expect(resetCommand({}, io)).rejects.toThrow('取り消しました。何も変更していません。');

    expect(sent).toEqual([]);
    expect(written.join('')).not.toContain('取り消しました');
  });

  it('--yes なら端末でなくても聞かずに POST する', async () => {
    const { io, asked } = fakeIo({ isTTY: false });
    captureStdout();
    await resetCommand({ yes: true }, io);

    expect(sent).toHaveLength(1);
    expect(asked).toEqual([]);
  });
});
