import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createTimedPool, type PgTimeoutEvent } from './pg-timeouts.js';

/**
 * `pg-timeouts.ts` の `sqlHeadOf`（期限切れの知らせに載せる SQL の頭）の切り詰めを、外から縛る。
 * 前処理と上限を固定する歯。
 *
 * `sqlHeadOf`: 空白を畳んで trim → `clipWithEllipsis`（コードポイントで 120）。
 * 寄せる前は UTF-16 の `.length` で数えて孤立サロゲートが残り、絵文字だけの SQL は上限が実質半分だった。寄せて直った。
 * export されていないので、答えを返さない偽のサーバーに問い合わせを打ち、期限切れの知らせ（`onTimeout` の `sql`）で見る。
 *
 * 期待の値は、寄せる前の出力（`vitest -u` で生成して目で確かめた）から、補助面の文字に関わる行だけを手で直した。
 * 長い文字列は、長さ（UTF-16 の u と コードポイントの cp）・頭・尻・孤立サロゲートの有無で表す。
 */

const SQL_HEAD_CHARS = 120;

function shape(text: string | undefined): string {
  if (text === undefined) return 'undefined';
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
  const points = [...text];
  return (
    `${String(text.length)}u/${String(points.length)}cp ` +
    `head=${JSON.stringify(points.slice(0, 4).join(''))} tail=${JSON.stringify(points.slice(-4).join(''))}` +
    (lone ? ' LONE-SURROGATE' : '')
  );
}

const FAMILY = '👨‍👩‍👧';

function inputsFor(limit: number): Record<string, string> {
  return {
    '手前 a×(L-1)': 'a'.repeat(limit - 1),
    'ちょうど a×L': 'a'.repeat(limit),
    '1 超 a×(L+1)': 'a'.repeat(limit + 1),
    'ちょうど あ×L': 'あ'.repeat(limit),
    '1 超 あ×(L+1)': 'あ'.repeat(limit + 1),
    'a×(L-1)+😀（L cp・L+1 u）': `${'a'.repeat(limit - 1)}😀`,
    'a×(L-1)+😀+b（切り口が対の真ん中）': `${'a'.repeat(limit - 1)}😀b`,
    'a×(L-2)+😀+bb（対が切り口の手前に収まる）': `${'a'.repeat(limit - 2)}😀bb`,
    'a×(L-1)+😀😀': `${'a'.repeat(limit - 1)}😀😀`,
    '😀×L': '😀'.repeat(limit),
    '😀×(L+1)': '😀'.repeat(limit + 1),
    'a×(L-3)+家族(ZWJ)+z': `${'a'.repeat(limit - 3)}${FAMILY}z`,
    'a×(L-1)+é(結合)+x': `${'a'.repeat(limit - 1)}éx`,
    '改行を挟む a\\nb': 'a\nb',
    '前後に空白と改行 + a×L': ` \n ${'a'.repeat(limit)} \n`,
    'a×(L-1)+改行+b×5': `${'a'.repeat(limit - 1)}\n${'b'.repeat(5)}`,
    空文字: '',
    空白だけ: '  \n ',
  };
}

// 起動の挨拶には答えるが、問い合わせ（`Q`）には一切答えない偽のサーバー
function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const READY = message('Z', Buffer.from('I', 'latin1'));
const AUTH_OK = message('R', Buffer.from([0, 0, 0, 0]));

async function startSilentPg(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk: Buffer) => {
      if (started) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      if (buffered.length < buffered.readInt32BE(0)) return;
      started = true;
      socket.write(Buffer.concat([AUTH_OK, READY]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('偽のサーバーの番地が取れない');
  return {
    url: `postgres://u:p@127.0.0.1:${String(address.port)}/db`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sqlHeads(inputs: Record<string, string>): Promise<Record<string, string>> {
  const fake = await startSilentPg();
  cleanups.push(fake.close);
  const events: PgTimeoutEvent[] = [];
  const pool = createTimedPool({
    connectionString: fake.url,
    connectTimeoutMs: 2_000,
    queryTimeoutMs: 20,
    onTimeout: (event) => events.push(event),
  });
  cleanups.push(() => pool.end().catch(() => undefined));
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(inputs)) {
    events.length = 0;
    await pool.query(text).catch(() => undefined);
    expect(events).toHaveLength(1);
    out[name] = shape(events[0]?.sql);
  }
  return out;
}

describe('sqlHeadOf（pg-timeouts.ts）: 空白を畳んで trim・コードポイントで 120', () => {
  it('各入力の結果（期限切れの知らせの sql）', async () => {
    expect(await sqlHeads(inputsFor(SQL_HEAD_CHARS))).toMatchInlineSnapshot(`
      {
        "1 超 a×(L+1)": "121u/121cp head="aaaa" tail="aaa…"",
        "1 超 あ×(L+1)": "121u/121cp head="ああああ" tail="あああ…"",
        "a×(L-1)+é(結合)+x": "121u/121cp head="aaaa" tail="aae…"",
        "a×(L-1)+改行+b×5": "121u/121cp head="aaaa" tail="aa …"",
        "a×(L-1)+😀+b（切り口が対の真ん中）": "122u/121cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀😀": "122u/121cp head="aaaa" tail="aa😀…"",
        "a×(L-1)+😀（L cp・L+1 u）": "121u/120cp head="aaaa" tail="aaa😀"",
        "a×(L-2)+😀+bb（対が切り口の手前に収まる）": "122u/121cp head="aaaa" tail="a😀b…"",
        "a×(L-3)+家族(ZWJ)+z": "123u/121cp head="aaaa" tail="👨‍👩…"",
        "ちょうど a×L": "120u/120cp head="aaaa" tail="aaaa"",
        "ちょうど あ×L": "120u/120cp head="ああああ" tail="ああああ"",
        "前後に空白と改行 + a×L": "120u/120cp head="aaaa" tail="aaaa"",
        "手前 a×(L-1)": "119u/119cp head="aaaa" tail="aaaa"",
        "改行を挟む a\\nb": "3u/3cp head="a b" tail="a b"",
        "空文字": "0u/0cp head="" tail=""",
        "空白だけ": "0u/0cp head="" tail=""",
        "😀×(L+1)": "241u/121cp head="😀😀😀😀" tail="😀😀😀…"",
        "😀×L": "240u/120cp head="😀😀😀😀" tail="😀😀😀😀"",
      }
    `);
  });

  it('文字列でなく { text } の設定で打っても同じ切り方', async () => {
    const fake = await startSilentPg();
    cleanups.push(fake.close);
    const events: PgTimeoutEvent[] = [];
    const pool = createTimedPool({
      connectionString: fake.url,
      connectTimeoutMs: 2_000,
      queryTimeoutMs: 20,
      onTimeout: (event) => events.push(event),
    });
    cleanups.push(() => pool.end().catch(() => undefined));
    await pool.query({ text: `${'a'.repeat(SQL_HEAD_CHARS - 1)}😀b` }).catch(() => undefined);
    expect(shape(events[0]?.sql)).toMatchInlineSnapshot(`"122u/121cp head="aaaa" tail="aa😀…""`);
  });
});
