import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  PeerRolloutMirror,
  resolveRolloutFile,
  type PeerRolloutKey,
} from './runner-peer-rollout.js';

const THREAD = '0199c0a1-2b3c-7d4e-8f50-123456789abc';
const CHILD_THREAD = '0199c0a1-ffff-7d4e-8f50-000000000000';
const REL = `2026/10/25/rollout-2026-10-25T09-00-00-${THREAD}.jsonl`;
const SECRET = 'sk-test-secret-credential-value';
const line = (ordinal: number, text = 'x') =>
  `${JSON.stringify({ timestamp: '2026-10-25T09:00:00.000Z', ordinal, type: 'response_item', payload: { text } })}\n`;

let codexHome: string;
let rollout: string;
let mirrored: { key: PeerRolloutKey & { subpath: string }; entries: unknown[] }[];
let notes: string[];
let mainKey: PeerRolloutKey | undefined;
let mirror: PeerRolloutMirror;

const KEY: PeerRolloutKey = { projectKey: 'proj-key', sessionId: 'sess-1' };

beforeEach(async () => {
  codexHome = await makeTempDir('peer-rollout-home-');
  rollout = join(codexHome, 'sessions', REL);
  await mkdir(join(codexHome, 'sessions', '2026/10/25'), { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), `{"OPENAI_API_KEY":"${SECRET}"}\n`);
  await writeFile(join(codexHome, 'config.toml'), `token = "${SECRET}"\n`);
  mirrored = [];
  notes = [];
  mainKey = KEY;
  mirror = new PeerRolloutMirror({
    codexHome: () => codexHome,
    mainKey: () => mainKey,
    mirror: (key, entries) => mirrored.push({ key, entries }),
    note: (text) => notes.push(text),
  });
});

const start = (location: string | undefined = rollout, resumed = false) =>
  mirror.track({
    peerId: 'peer-aaaa',
    provider: 'codex',
    threadId: THREAD,
    transcriptLocation: location,
    resumed,
  });
const allEntries = () => mirrored.flatMap((item) => item.entries);

describe('PeerRolloutMirror: 増えた行だけを peers/<peerId> へ預ける', () => {
  it('止まるたびに、読み済みの位置から増えた行だけを載せる（メタの行は最初の1回だけ）', async () => {
    await writeFile(rollout, line(0) + line(1));
    await start();
    await mirror.collect('peer-aaaa');
    expect(allEntries()).toHaveLength(3);
    expect(allEntries()[0]).toEqual({
      type: 'alteroid_peer_meta',
      provider: 'codex',
      threadId: THREAD,
      relPath: REL,
    });
    expect(mirrored[0]?.key).toEqual({ ...KEY, subpath: 'peers/peer-aaaa' });

    mirrored.length = 0;
    await appendFile(rollout, line(2) + line(3));
    await mirror.collect('peer-aaaa');
    expect(allEntries().map((entry) => (entry as { ordinal: number }).ordinal)).toEqual([2, 3]);

    mirrored.length = 0;
    await mirror.collect('peer-aaaa');
    expect(mirrored).toEqual([]);
  });

  it('改行で終わっていない書きかけの行は読まず、書き終わってから読む', async () => {
    await writeFile(rollout, line(0) + line(1).slice(0, 20));
    await start();
    await mirror.collect('peer-aaaa');
    expect(allEntries().filter((entry) => 'ordinal' in (entry as object))).toHaveLength(1);

    mirrored.length = 0;
    await appendFile(rollout, line(1).slice(20));
    await mirror.collect('peer-aaaa');
    expect(allEntries().map((entry) => (entry as { ordinal: number }).ordinal)).toEqual([1]);
  });

  it('主の記録の鍵が分かる前は預けずに溜め、分かったら預ける', async () => {
    mainKey = undefined;
    await writeFile(rollout, line(0));
    await start();
    await mirror.collect('peer-aaaa');
    expect(mirrored).toEqual([]);

    mainKey = KEY;
    mirror.flushBuffered();
    await mirror.collectAll();
    expect(allEntries()).toHaveLength(2);
    expect(mirrored[0]?.key.sessionId).toBe('sess-1');
  });

  it('続きから起こした回は、いまのファイルの終わりから読む（置き直した分を預け直さない）', async () => {
    await writeFile(rollout, line(0) + line(1));
    await start(rollout, true);
    await mirror.collect('peer-aaaa');
    expect(mirrored).toEqual([]);

    await appendFile(rollout, line(2));
    await mirror.collect('peer-aaaa');
    expect(allEntries().map((entry) => (entry as { ordinal?: number }).ordinal)).toEqual([
      undefined,
      2,
    ]);
  });

  it('記録がまだ作られていない（最初のターンで作られる）peer も、できてから預ける。断ったとは数えない', async () => {
    await start();
    await mirror.collect('peer-aaaa');
    expect(mirrored).toEqual([]);
    expect(notes).toEqual([]);

    await writeFile(rollout, line(0));
    await mirror.collect('peer-aaaa');
    expect(allEntries()).toHaveLength(2);
  });

  it('子スレッド（別の thread の rollout）は預けない: 読むのは親の thread の記録だけ', async () => {
    const child = join(
      codexHome,
      'sessions',
      `2026/10/25/rollout-2026-10-25T09-00-01-${CHILD_THREAD}.jsonl`,
    );
    await writeFile(child, line(0, 'child-secret-work'));
    await writeFile(rollout, line(0, 'parent'));
    await start();
    await appendFile(child, line(1, 'child-more'));
    await mirror.collectAll();
    expect(JSON.stringify(allEntries())).toContain('parent');
    expect(JSON.stringify(allEntries())).not.toContain('child');
  });

  it('畳んだ後は読まない（closeAfterCollecting が最後の分を預けてから止める）', async () => {
    await writeFile(rollout, line(0));
    await start();
    await mirror.closeAfterCollecting();
    expect(allEntries()).toHaveLength(2);
    mirrored.length = 0;
    await appendFile(rollout, line(1));
    await mirror.collect('peer-aaaa');
    expect(mirrored).toEqual([]);
  });
});

// 読むのは「CODEX_HOME/sessions/ の下の rollout-…<threadId>.jsonl」だけ。資格のファイルは読まない・預けない
describe('PeerRolloutMirror: 資格のファイルを読まない守り', () => {
  const expectNotRead = async (location: string | undefined, reason: RegExp) => {
    await mirror.track({
      peerId: 'peer-aaaa',
      provider: 'codex',
      threadId: THREAD,
      transcriptLocation: location,
      resumed: false,
    });
    await mirror.collect('peer-aaaa');
    expect(mirrored).toEqual([]);
    expect(JSON.stringify(notes)).toMatch(reason);
    expect(JSON.stringify(mirrored)).not.toContain(SECRET);
  };

  it('transcriptLocation が auth.json を指していたら、読まずに note を残して預けない', async () => {
    await expectNotRead(join(codexHome, 'auth.json'), /ファイル名が rollout-/);
  });

  it('config.toml も同じ', async () => {
    await expectNotRead(join(codexHome, 'config.toml'), /ファイル名が rollout-/);
  });

  it('sessions の下でも、名前が rollout-…<threadId>.jsonl でなければ読まない', async () => {
    const odd = join(codexHome, 'sessions', 'auth.json');
    await writeFile(odd, SECRET);
    await expectNotRead(odd, /ファイル名が rollout-/);
  });

  it('sessions の外にある rollout 風の名前のファイルは読まない', async () => {
    const outside = join(codexHome, `rollout-x-${THREAD}.jsonl`);
    await writeFile(outside, line(0, SECRET));
    await expectNotRead(outside, /sessions\/ の下ではない/);
  });

  it('sessions の中の symlink が外（資格）を指していたら、実体で見て読まない', async () => {
    const link = join(codexHome, 'sessions', `rollout-x-${THREAD}.jsonl`);
    await symlink(join(codexHome, 'auth.json'), link);
    await expectNotRead(link, /sessions\/ の下ではない/);
  });

  it('sessions の中の symlink の先が sessions の下でも、実体の名前が rollout でなければ読まない', async () => {
    const real = join(codexHome, 'sessions', 'secret.txt');
    await writeFile(real, SECRET);
    const link = join(codexHome, 'sessions', `rollout-x-${THREAD}.jsonl`);
    await symlink(real, link);
    await expectNotRead(link, /実体のファイル名/);
  });

  it('sessions の下の日付のディレクトリが外を指す symlink なら、外の rollout は読まない', async () => {
    const outside = await makeTempDir('peer-rollout-outside-');
    const name = `rollout-x-${THREAD}.jsonl`;
    await writeFile(join(outside, name), line(0, SECRET));
    await symlink(outside, join(codexHome, 'sessions', 'linked'));
    await expectNotRead(join(codexHome, 'sessions', 'linked', name), /sessions\/ の下ではない/);
  });

  it('記録の置き場を名乗らなかった・NUL を含むときも預けない', async () => {
    await expectNotRead(undefined, /名乗らなかった/);
    expect((await resolveRolloutFile(codexHome, `${rollout}\0`, THREAD)).ok).toBe(false);
  });

  it('対照: sessions の下の rollout-…<threadId>.jsonl は通り、sessions からの相対パスを返す', async () => {
    await writeFile(rollout, line(0));
    const resolved = await resolveRolloutFile(codexHome, rollout, THREAD);
    expect(resolved).toMatchObject({ ok: true, relPath: REL });
  });
});
