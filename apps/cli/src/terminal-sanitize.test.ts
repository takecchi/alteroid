import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout, pretendTty } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { sanitizeForTerminal, redactBody, redactError } = await import('./redact.js');
const { memoryListCommand, memoryShowCommand } = await import('./memory.js');
const { practiceListCommand, practiceShowCommand, practiceHistoryCommand } =
  await import('./practice.js');
const { permissionListCommand } = await import('./permission.js');
const { tokenListCommand } = await import('./token.js');
const { runnersCommand } = await import('./runners.js');
const { topologyCommand } = await import('./topology.js');
const { conversationsShowCommand } = await import('./conversations.js');
const { profileRemoveCommand } = await import('./profile.js');
const { approvalText } = await import('./conversation-approvals.js');
const { sendMessage } = await import('./chat.js');
const { describeCliFailure } = await import('./failure-message.js');
const { withErrorReason } = await import('./format.js');

const ESC = '\u001b';
const BEL = '\u0007';
const EVIL = `A${ESC}[2J${ESC}[H${ESC}]0;PWNED${BEL}B${ESC}[31mred${ESC}[0mC`;
const EVIL_CLEAN = 'ABredC';

function expectNoControl(text: string): void {
  // eslint-disable-next-line no-control-regex -- 制御文字の検出そのものが目的
  expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  expect(text).not.toContain('PWNED\u0007');
}

let originalFetch: typeof fetch;
let routes: Record<string, unknown> = {};

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = new URL(typeof input === 'string' ? input : (request.url ?? String(input)));
    const method = init?.method ?? request.method ?? 'GET';
    const hit = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
    const body = hit ?? {};
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  routes = {};
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('sanitizeForTerminal', () => {
  it('CSI・OSC（BEL 終端・ST 終端）・DCS・単独の ESC・SGR を、中身ごと落とす', () => {
    expect(sanitizeForTerminal(EVIL)).toBe(EVIL_CLEAN);
    expect(sanitizeForTerminal(`a${ESC}]52;c;ZXZpbA==${ESC}\\b`)).toBe('ab');
    expect(sanitizeForTerminal(`a${ESC}Pq#0;2;0;0;0${ESC}\\b`)).toBe('ab');
    expect(sanitizeForTerminal(`a${ESC}(Bb${ESC}cd${ESC}`)).toBe('abd');
    expectNoControl(sanitizeForTerminal(`a${ESC}]0;title`));
  });

  it('C0（\\n と \\t 以外）・DEL・C1 を落とし、\\n と \\t と日本語は残す', () => {
    expect(sanitizeForTerminal('a\u0000b\u0007c\u0008d\u000be\u000cf\rg\u007fh\u0085i\u009b')).toBe(
      'abcdefghi',
    );
    expect(sanitizeForTerminal('行1\n\t行2\r\n行3 😀')).toBe('行1\n\t行2\n行3 😀');
    expect(sanitizeForTerminal('a\u009b2Jb\u009d0;T\u0007c')).toBe('abc');
  });

  it('冪等である', () => {
    expect(sanitizeForTerminal(sanitizeForTerminal(EVIL))).toBe(EVIL_CLEAN);
  });

  it('秘密の途中に制御文字を挟んでも、掃除が先なので伏せ字をすり抜けない（順序）', () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const split = `${token.slice(0, 10)}${ESC}[0m${token.slice(10)}`;
    expect(redactBody(split)).not.toContain(token.slice(0, 20));
    expect(redactError(split)).not.toContain(token.slice(0, 20));
    expectNoControl(redactBody(split));
  });
});

describe('#3415 承認の行の切り詰め', () => {
  it('サロゲートペアの途中で切らない（孤立した上位サロゲートを出さない）', () => {
    const line = approvalText({
      id: 'abcdef1234',
      createdAt: 't',
      question: `${'a'.repeat(79)}😀tail`,
    } as never);
    expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(line).toContain(`${'a'.repeat(79)}…`);
  });

  it('質問の ESC 列は端末へ出る文字列に残らない', () => {
    const line = approvalText({
      id: 'abcdef1234',
      createdAt: 't',
      question: `x${ESC}[2Jy${ESC}]0;T${BEL}z`,
    } as never);
    expectNoControl(line);
    expect(line).toContain('xyz');
  });
});

describe('#3414 chat・conversations', () => {
  const target = { baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false };
  const frame = (name: string, data: unknown) =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

  it('chat の返答は、ESC 列が2つの text にまたがっても端末へ出ない', async () => {
    const chunks = [
      frame('open', { conversationId: 'c1' }),
      frame('text', { text: `before ${ESC}[` }),
      frame('text', { text: `2J${ESC}]0;PWN` }),
      frame('text', { text: `ED${BEL} after ${ESC}[31mred${ESC}[0m tab\there\n` }),
      frame('text', { text: `残り${ESC}` }),
      frame('done', { type: 'done' }),
    ];
    globalThis.fetch = ((input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string }).url);
      if (url.endsWith('/chat')) {
        return Promise.resolve(
          new Response(chunks.join(''), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ messages: [], scanned: 0, reachedStart: true, supersededCount: 0 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    const read = captureStdout();
    await sendMessage(target as never, '質問', null);
    const out = read();
    expectNoControl(out);
    expect(out).toContain('before ');
    expect(out).toContain(' after red tab\there\n');
    expect(out).not.toContain('PWNED\u0007');
  });

  it('conversations show の本文と承認の行から落ちる', async () => {
    routes['/conversations/c1'] = {
      messages: [{ id: 'm1', at: '2026-01-01T00:00:00.000Z', role: 'outbound', text: EVIL }],
      scanned: 1,
      reachedStart: true,
      supersededCount: 0,
    };
    routes['/approvals'] = {
      approvals: [{ id: 'abcdef1234', createdAt: '2026-01-01T00:00:01.000Z', question: EVIL }],
    };
    const read = captureStdout();
    await conversationsShowCommand('c1');
    const out = read();
    expectNoControl(out);
    expect(out).toContain(EVIL_CLEAN);
  });
});

describe('#3448 topology・permission list・token list・runners・失敗の文', () => {
  it('topology', async () => {
    routes['/topology'] = {
      observedAt: '2026-10-04T10:00:00.000Z',
      clone: { state: 'idle' },
      storage: { label: 'postgres', state: 'ok', checkedAt: '2026-10-04T10:00:00.000Z' },
      runners: [],
      managers: [
        {
          managerId: 'mgr-1',
          status: 'waiting_human',
          live: true,
          request: EVIL,
          startedAt: '2026-10-04T10:00:00.000Z',
          updatedAt: '2026-10-04T10:00:00.000Z',
          waiting: [
            {
              requestId: 'q1',
              kind: 'question',
              summary: EVIL,
              askedAt: '2026-10-04T10:00:00.000Z',
            },
          ],
          workers: [],
        },
      ],
      links: [],
    };
    const read = captureStdout();
    await topologyCommand();
    const out = read();
    expectNoControl(out);
    expect(out).toContain(EVIL_CLEAN);
  });

  it('permission list', async () => {
    routes['/permission-grants'] = {
      grants: [
        {
          id: 'g1',
          rule: `Bash(${EVIL}:*)`,
          answer: EVIL,
          grantedAt: '2026-01-01T00:00:00.000Z',
          route: { accountId: 'acc' },
        },
      ],
    };
    const read = captureStdout();
    await permissionListCommand({});
    const out = read();
    expectNoControl(out);
    expect(out).toContain(EVIL_CLEAN);
  });

  it('token list', async () => {
    routes['/tokens'] = {
      settings: { rotateOn: 'rate_limit', cooldownMs: 1000 },
      tokens: [
        {
          id: 't1',
          label: 'main',
          order: 1,
          invalidatedAt: '2026-01-01T00:00:00.000Z',
          invalidatedReason: EVIL,
          lastRejectedReason: EVIL,
          lastRejectedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const read = captureStdout();
    await tokenListCommand();
    const out = read();
    expectNoControl(out);
    expect(out).toContain(EVIL_CLEAN);
  });

  it('runners', async () => {
    routes['/runners'] = {
      runners: [
        {
          label: `https://r${EVIL}`,
          state: 'connected',
          since: '2026-08-22T00:00:00.000Z',
          runnerId: `r1${EVIL}`,
          workspacePath: `/work${EVIL}`,
          instanceId: `inst${EVIL}`,
          error: EVIL,
          revision: { status: 'unknown' },
          credentials: [],
          credentialsProbe: { status: 'asked' },
          profileProbe: { status: 'asked' },
        },
      ],
      daemonRevision: {
        status: 'known',
        commit: 'b'.repeat(40),
        short: 'b'.repeat(12),
        source: 'build',
      },
    };
    const read = captureStdout();
    await runnersCommand();
    const out = read();
    expectNoControl(out);
    expect(out).toContain(`/workABredC`);
  });

  it('失敗の文（withErrorReason・describeCliFailure）', async () => {
    const response = new Response(JSON.stringify({ error: EVIL }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
    const reason = await withErrorReason('読めませんでした', response);
    expectNoControl(reason);
    expect(reason).toContain(EVIL_CLEAN);
    const failure = describeCliFailure(new Error(EVIL));
    expectNoControl(failure);
    expect(failure).toContain(EVIL_CLEAN);
  });
});

describe('#3455 memory・practice・profile', () => {
  const memoryDoc = {
    kind: 'fact',
    slug: 'x',
    title: `T${ESC}[2Jt`,
    description: `d${ESC}]0;PWNED${BEL}`,
    createdAt: { kind: 'known', at: '2026-01-01T00:00:00.000Z' },
    descriptionFreshness: { kind: 'fresh' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('memory list は題・概要を、どの出力先でも落とす', async () => {
    routes['/memory'] = { documents: [memoryDoc] };
    for (const tty of [false, true]) {
      const restore = pretendTty(tty);
      const read = captureStdout();
      await memoryListCommand();
      const out = read();
      restore();
      vi.restoreAllMocks();
      stubFetch();
      expectNoControl(out);
      expect(out).toContain('Tt');
    }
  });

  it('practice list・history は題・slug・kind を落とす', async () => {
    routes['/practices'] = {
      practices: [
        {
          kind: `k${ESC}[2J`,
          slug: `s${ESC}[2J`,
          title: EVIL,
          createdAt: 'c',
          updatedAt: 'u',
          chars: 3,
        },
      ],
      unreadable: [{ slug: `u${ESC}[2J`, reason: `r${ESC}]0;X${BEL}` }],
    };
    routes['/practices/p/versions'] = {
      versions: [{ version: 1, kind: 'k', title: EVIL, at: 'a', chars: 1 }],
    };
    const read = captureStdout();
    await practiceListCommand();
    await practiceHistoryCommand('p');
    const out = read();
    expectNoControl(out);
    expect(out).toContain(EVIL_CLEAN);
  });

  it('memory show は、端末のときだけ本文を落とす', async () => {
    routes['/memory/x'] = {
      document: { ...memoryDoc, content: `hello${EVIL} end`, version: 'v1' },
    };
    const restore = pretendTty(true);
    const read = captureStdout();
    await memoryShowCommand('x');
    const out = read();
    restore();
    expectNoControl(out);
    expect(out).toBe(`helloABredC end\n`);
  });

  it('memory show は、パイプ（非 TTY）のとき本文を1バイトも変えない', async () => {
    const body = `hello${EVIL} end\r\n\u0085`;
    routes['/memory/x'] = { document: { ...memoryDoc, content: body, version: 'v1' } };
    const restore = pretendTty(false);
    const read = captureStdout();
    await memoryShowCommand('x');
    const out = read();
    restore();
    expect(out).toBe(`${body}\n`);
  });

  it('practice show も、端末では落とし、パイプでは変えない', async () => {
    const found = {
      practice: { kind: 'k', slug: 'p', title: 't', content: `hi${EVIL}`, version: 'v1' },
    };
    routes['/practices/p'] = found;
    routes['/practices/p/versions/1'] = found;
    let restore = pretendTty(true);
    let read = captureStdout();
    await practiceShowCommand('p', {});
    const tty = read();
    restore();
    vi.restoreAllMocks();
    stubFetch();
    restore = pretendTty(false);
    read = captureStdout();
    await practiceShowCommand('p', {});
    const piped = read();
    restore();
    expectNoControl(tty);
    expect(tty).toContain('hiABredC');
    expect(piped).toContain(`hi${EVIL}`);
  });

  it('profile の反映結果の output の行を落とす', async () => {
    const applied = {
      ok: true,
      output: `line1${EVIL}\nline2${ESC}[2J`,
    };
    routes['GET /profile'] = {
      updatedAt: 't',
      entries: [{ name: 'default', scope: 'all', updatedAt: 't', sha256: 'abc', bytes: 1 }],
      composed: { clone: {}, runner: {} },
    };
    routes['DELETE /profile/default'] = {
      updatedAt: 't',
      clone: applied,
      runners: [{ runnerId: `r${ESC}[2J`, ...applied, error: undefined }],
    };
    const read = captureStdout();
    await profileRemoveCommand('default', { yes: true });
    const out = read();
    expectNoControl(out);
    expect(out).toContain('    | line1ABredC');
  });
});
