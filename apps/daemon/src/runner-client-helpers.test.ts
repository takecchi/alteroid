import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

// runner-client.ts の補助（404 だけ undefined・本文つきの取り出し・応答の検証）が、元の各所の性質を保つことを押さえる
const ID = 'b'.repeat(32);

function clientWith(
  respond: (method: string, path: string) => Response | Promise<Response>,
  health: Record<string, unknown> = {},
) {
  const calls: { method: string; path: string }[] = [];
  const client = createHttpRunner({
    baseUrl: 'http://runner.test',
    token: 'tok',
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/health')
        return Response.json({ runnerId: 'r', workspacePath: '/w', ...health });
      const method = init?.method ?? 'GET';
      calls.push({ method, path });
      return respond(method, path);
    }) as typeof fetch,
  });
  return { client, calls };
}

describe('HttpRunner の「404 だけ undefined」の取り出しと DELETE', () => {
  it('rescue-files / archive は 404 を undefined にし、500 は投げる', async () => {
    const missing = await clientWith(() => new Response('{}', { status: 404 })).client;
    expect(await missing.openPickupFile?.('rescue', 'm', ID)).toBeUndefined();
    expect(await missing.fetchArchive?.('m', ID)).toBeUndefined();

    const broken = await clientWith(() => new Response('boom', { status: 500 })).client;
    await expect(broken.openPickupFile?.('rescue', 'm', ID)).rejects.toThrow('500');
    await expect(broken.fetchArchive?.('m', ID)).rejects.toThrow('500');
  });

  it('archive は本文を文字列で返し、経路は managerId・archiveId を符号化する', async () => {
    const { client, calls } = clientWith(() => new Response('退避'));
    expect(await (await client).fetchArchive?.('m 1', ID)).toBe('退避');
    expect(calls).toEqual([{ method: 'GET', path: `/managers/m%201/archive/${ID}` }]);
  });

  it('本文の無い 200 は、出し箱と預かりで別の文で投げる', async () => {
    const empty = await clientWith(() => new Response(null, { status: 200 })).client;
    await expect(empty.openPickupFile?.('outbox', 'm', ID)).rejects.toThrow(
      'runner の応答に本文が無い（出し箱の取り出し）',
    );
    await expect(empty.openPickupFile?.('rescue', 'm', ID)).rejects.toThrow(
      'runner の応答に本文が無い（預かりの取り出し）',
    );
  });

  it('DELETE の3本は経路だけが違い、失敗は投げる', async () => {
    const ok = clientWith(() => new Response(null, { status: 204 }));
    const runner = await ok.client;
    await runner.deletePickupFile?.('rescue', 'm', ID);
    await runner.deleteArchive?.('m', ID);
    expect(ok.calls).toEqual([
      { method: 'DELETE', path: `/managers/m/rescue-files/${ID}` },
      { method: 'DELETE', path: `/managers/m/archive/${ID}` },
    ]);

    const bad = await clientWith(() => new Response('{}', { status: 400 })).client;
    await expect(bad.deletePickupFile?.('rescue', 'm', ID)).rejects.toThrow('400');
    await expect(bad.deleteArchive?.('m', ID)).rejects.toThrow('400');
  });
});

describe('HttpRunner の応答の検証', () => {
  it('ok が true でない応答は、操作ごとの文で投げる', async () => {
    const runner = await clientWith(() => Response.json({ ok: false })).client;
    await expect(runner.setMcpServers?.({})).rejects.toThrow(
      'runner の応答を読めなかった（MCP の登録）',
    );
    await expect(runner.setPermissionRules?.([])).rejects.toThrow(
      'runner の応答を読めなかった（委譲先の許可規則）',
    );
    await expect(runner.setCodexAuth?.(null)).rejects.toThrow(
      'runner の応答を読めなかった（Codex の ChatGPT ログイン）',
    );
    await expect(runner.retainPlugins?.([])).rejects.toThrow(
      'runner の応答を読めなかった（plugin の一覧）',
    );
    await expect(runner.takeCodexAuthWriteBack?.('fp')).rejects.toThrow(
      'runner の応答を読めなかった（Codex の書き戻し）',
    );
  });

  it('ok でも欄の形が崩れていれば、指紋ごとの文で投げ、欄が無いものは undefined / null', async () => {
    const broken = await clientWith(() => Response.json({ ok: true, mcpServers: 1, plugins: 1 }))
      .client;
    await expect(broken.setMcpServers?.({})).rejects.toThrow(
      'runner の応答を読めなかった（MCP の登録の指紋）',
    );
    await expect(broken.retainPlugins?.([])).rejects.toThrow(
      'runner の応答を読めなかった（plugin の一覧の指紋）',
    );
    await expect(broken.takeCodexAuthWriteBack?.('fp')).resolves.toBeNull();

    const absent = await clientWith(() => Response.json({ ok: true })).client;
    expect(await absent.setMcpServers?.({})).toBeUndefined();
    expect(await absent.retainPlugins?.([])).toBeUndefined();
  });

  it('/health の欄は、無ければ undefined、在るのに崩れていれば欄名つきで投げる', async () => {
    const absent = await clientWith(() => Response.json({}), { profile: null }).client;
    expect(await absent.profile?.()).toBeUndefined();
    expect(await absent.mcpServers?.()).toBeUndefined();
    expect(await absent.plugins?.()).toBeUndefined();

    const broken = await clientWith(() => Response.json({}), {
      profile: 1,
      mcpServers: 1,
      plugins: 1,
    }).client;
    await expect(broken.profile?.()).rejects.toThrow(
      'runner の /health の profile の欄を読めなかった',
    );
    await expect(broken.mcpServers?.()).rejects.toThrow(
      'runner の /health の mcpServers の欄を読めなかった',
    );
    await expect(broken.plugins?.()).rejects.toThrow(
      'runner の /health の plugins の欄を読めなかった',
    );
  });
});
