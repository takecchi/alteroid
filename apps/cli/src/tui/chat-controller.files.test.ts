import { describe, expect, it } from 'vitest';

import { ChatController } from './chat-controller.js';
import { resolveCommand, helpLines } from './commands.js';
import { fakeApi } from './fake-api.js';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

function row(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    mediaType: 'text/plain',
    size: 2048,
    uploadedBy: 'operator',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-31T00:00:00.000Z',
    ...over,
  };
}

function setup() {
  const api = fakeApi();
  api.storedAttachments.push(
    row('att-1', 'a.log'),
    row('att-2', 'b.log', { keptAt: '2026-10-02T00:00:00.000Z', expiresAt: undefined }),
  );
  const controller = new ChatController(api);
  const last = (kind?: string) => {
    const entries = controller.store
      .getSnapshot()
      .entries.filter((e) => kind === undefined || e.kind === kind);
    return entries[entries.length - 1]?.text ?? '';
  };
  return { api, controller, last };
}

describe('コマンドの名前', () => {
  it('/files /keep /unkeep /rm は置き場。/attachments /detach（添えかけ）とは別の動作', () => {
    const actions = ['files', 'keep', 'unkeep', 'rm', 'attachments', 'detach'].map((name) => {
      const resolved = resolveCommand(`/${name} x`);
      return resolved.kind === 'command' ? resolved.spec.action : resolved.kind;
    });
    expect(actions).toEqual(['files', 'keep', 'unkeep', 'remove', 'attachments', 'detach']);
    const help = helpLines().join('\n');
    expect(help).toContain('/files');
    expect(help).toContain('置き場は /files');
  });
});

describe('/files', () => {
  it('使用量と、番号つきの行を出す（CLI の ls と同じ行）', async () => {
    const { api, controller, last } = setup();
    await controller.listFiles('');
    expect(api.storedListCalls).toEqual([{}]);
    expect(last()).toBe(
      [
        '使用量: 合計 2 件 4.0 KB（人間 2 件 4.0 KB）',
        '  [1] att-1  a.log  (text/plain, 2.0 KB)  人間  2026-10-31T00:00:00.000Z に消える  2026-10-01T00:00:00.000Z',
        '  [2] att-2  b.log  (text/plain, 2.0 KB)  人間  保存中（期限なし）  2026-10-01T00:00:00.000Z',
        '/keep・/unkeep・/rm は <番号|id> で指す（番号はこの一覧の並び）',
      ].join('\n'),
    );
  });

  it('kept / unkept で絞る。続きは more で、番号は続けて振る', async () => {
    const { api, controller, last } = setup();
    await controller.listFiles('kept');
    expect(api.storedListCalls).toEqual([{ kept: true }]);
    await controller.listFiles('unkept');
    expect(api.storedListCalls[1]).toEqual({ kept: false });
    api.storedPageSize = 1;
    await controller.listFiles('');
    expect(last()).toContain('続きがあります。続けるには /files more');
    await controller.listFiles('more');
    expect(api.storedListCalls[3]).toEqual({ cursor: '1' });
    expect(last()).toContain('[2] att-2');
    expect(last()).not.toContain('続きがあります');
  });

  it('空・不明な引数・続きが無い more・失敗', async () => {
    const { api, controller, last } = setup();
    await controller.listFiles('more');
    expect(last()).toBe('続きは無い（/files で一覧を出し直す）');
    await controller.listFiles('xyz');
    expect(last()).toBe('使い方: /files [kept|unkept|more]');
    expect(api.storedListCalls).toEqual([]);
    api.storedAttachments.length = 0;
    await controller.listFiles('');
    expect(last()).toContain('添付はありません。');
    api.storedFails = '添付の一覧を読めません（HTTP 500）';
    await controller.listFiles('');
    expect(last('error')).toBe('添付の一覧を読めません（HTTP 500）');
  });

  it('ファイル名の秘密は伏せる', async () => {
    const { api, controller, last } = setup();
    api.storedAttachments.push(row('att-3', `${TOKEN}.txt`));
    await controller.listFiles('');
    expect(last()).not.toContain(TOKEN);
  });
});

describe('/keep・/unkeep', () => {
  it('id で保存の印を付け・外す。CLI と同じ行を出す', async () => {
    const { api, controller, last } = setup();
    await controller.keepFile('att-1', true);
    expect(api.storedKeepCalls).toEqual([{ id: 'att-1', kept: true }]);
    expect(last()).toBe('[添付] a.log (text/plain, 2.0 KB) id=att-1 保存中（期限なし）');
    await controller.keepFile('att-1', false);
    expect(api.storedKeepCalls[1]).toEqual({ id: 'att-1', kept: false });
    expect(last()).toBe(
      '[添付] a.log (text/plain, 2.0 KB) id=att-1 2026-11-08T00:00:00.000Z に消える',
    );
  });

  it('番号は直前の /files の並びを引く。一覧を出す前・範囲外は API を叩かない', async () => {
    const { api, controller, last } = setup();
    await controller.keepFile('1', true);
    expect(last()).toContain('先に /files で一覧を出す');
    await controller.listFiles('');
    await controller.keepFile('9', true);
    expect(last()).toBe('番号は 1〜2（/files の一覧の並び）');
    expect(api.storedKeepCalls).toEqual([]);
    await controller.keepFile('2', false);
    expect(api.storedKeepCalls).toEqual([{ id: 'att-2', kept: false }]);
  });

  it('引数が無い・失敗（そんな添付は無い）', async () => {
    const { api, controller, last } = setup();
    await controller.keepFile('', true);
    expect(last()).toBe('使い方: /keep <番号|id>');
    await controller.keepFile('', false);
    expect(last()).toBe('使い方: /unkeep <番号|id>');
    expect(api.storedKeepCalls).toEqual([]);
    await controller.keepFile('nope', true);
    expect(last('error')).toBe('そんな添付はありません（消えた・期限切れ・id の誤り）: nope');
  });
});

describe('/rm', () => {
  it('1 度目は確認の文だけで消さない。yes を付けると消す', async () => {
    const { api, controller, last } = setup();
    await controller.listFiles('');
    await controller.removeFile('2');
    expect(api.storedRemoveCalls).toEqual([]);
    expect(last()).toBe(
      '添付を消します（保存中のものも消えます）: att-2\n  b.log\n取り消せません。消すなら /rm 2 yes',
    );
    await controller.removeFile('2 yes');
    expect(api.storedRemoveCalls).toEqual(['att-2']);
    expect(last()).toBe('att-2 を消した');
    expect(api.storedAttachments.map((a) => a.id)).toEqual(['att-1']);
  });

  it('消した番号は空けておき、別のファイルを指させない', async () => {
    const { api, controller, last } = setup();
    await controller.listFiles('');
    await controller.removeFile('1 yes');
    await controller.removeFile('1 yes');
    expect(last()).toBe('[1] はもう消した');
    expect(api.storedRemoveCalls).toEqual(['att-1']);
  });

  it('id で直接指せる。yes 以外の語・余分な語は断って消さない', async () => {
    const { api, controller, last } = setup();
    await controller.removeFile('att-1 ok');
    await controller.removeFile('att-1 yes now');
    await controller.removeFile('');
    expect(last()).toBe('使い方: /rm <番号|id>（確認のあと /rm <番号|id> yes で消す）');
    expect(api.storedRemoveCalls).toEqual([]);
    await controller.removeFile('att-1 yes');
    expect(api.storedRemoveCalls).toEqual(['att-1']);
  });

  it('失敗（そんな添付は無い・デーモンの失敗）を出す', async () => {
    const { api, controller, last } = setup();
    await controller.removeFile('nope yes');
    expect(last('error')).toBe('そんな添付はありません（消えた・期限切れ・id の誤り）: nope');
    api.storedFails = '添付を消せません（HTTP 500）';
    await controller.removeFile('att-1 yes');
    expect(last('error')).toBe('添付を消せません（HTTP 500）');
  });
});
