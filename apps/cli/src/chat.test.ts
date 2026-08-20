import type { Commitment } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  renderCommitments,
  renderManagerList,
  renderReport,
  renderReportLine,
  runSlashCommand,
  type Listed,
} from './chat.js';

type ManagerListItem = Parameters<typeof renderManagerList>[0][number];

function manager(over: Partial<ManagerListItem> = {}): ManagerListItem {
  return {
    managerId: 'mgr-1',
    status: 'running',
    live: true,
    cwd: '/workspace/alteroid',
    request: '一覧に拒否件数を出す',
    startedAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:05:00.000Z',
    waiting: [],
    ...over,
  };
}

describe('renderManagerList', () => {
  it('確認へ上がらず止められた件数を、道具ごとに出す', () => {
    const text = renderManagerList([manager({ denials: [{ tool: 'Bash', count: 3 }] })]);

    expect(text).toContain('確認へ上がらず止められた道具');
    expect(text).toContain('Bash 3件');
    // 数えているのは拒否であって、それで止まったかは見ていない。断定しない。
    expect(text).toContain('可能性があります');
  });

  it('拒否があっても [running] の札を置き換えない（状態に添えるだけ）', () => {
    const text = renderManagerList([
      manager({ status: 'running', denials: [{ tool: 'Bash', count: 1 }] }),
    ]);

    expect(text).toContain('[running]');
    expect(text).toContain('確認へ上がらず止められた道具');
  });

  it('拒否の行は状態の下に来る（拾い読みで状態と結びつく位置）', () => {
    const text = renderManagerList([
      manager({
        denials: [{ tool: 'Bash', count: 1 }],
        waiting: [{ requestId: 'req-1', summary: 'これを消してよいか' }],
      }),
    ]);

    const header = text.indexOf('[running]');
    const denial = text.indexOf('確認へ上がらず止められた道具');
    const waiting = text.indexOf('返事待ち');
    expect(header).toBeLessThan(denial);
    expect(denial).toBeLessThan(waiting);
  });

  it('拒否がゼロなら何も足さない（0 件だったとは言わない）', () => {
    const withoutKey = renderManagerList([manager()]);
    const withEmpty = renderManagerList([manager({ denials: [] })]);

    for (const text of [withoutKey, withEmpty]) {
      expect(text).not.toContain('確認へ上がらず止められた');
      expect(text).not.toContain('⚠');
      expect(text).toContain('[running]');
    }
  });

  it('多いときは新しい側から3種だけ出し、切った分は種類数と総件数で言う', () => {
    const text = renderManagerList([
      manager({
        denials: [
          { tool: 'Oldest', count: 1 },
          { tool: 'Second', count: 2 },
          { tool: 'Third', count: 4 },
          { tool: 'Fourth', count: 8 },
          { tool: 'Newest', count: 16 },
        ],
      }),
    ]);

    // デーモンは古い順で返す。読む側が知りたいのはいま何で止まっているか。
    expect(text).toContain('Newest 16件');
    expect(text).toContain('Fourth 8件');
    expect(text).toContain('Third 4件');
    expect(text).not.toContain('Oldest');
    expect(text).not.toContain('Second 2件');
    // 黙って落とさない。落とした分は種類数と、全体の件数で言う。
    expect(text).toContain('ほか 2 種');
    expect(text).toContain('全 31 件');
  });

  it('マネージャーごとに数え、他の行の拒否を混ぜない', () => {
    const text = renderManagerList([
      manager({ managerId: 'mgr-denied', denials: [{ tool: 'Bash', count: 2 }] }),
      manager({ managerId: 'mgr-clean' }),
    ]);

    const lines = text.split('\n');
    const denied = lines.findIndex((line) => line.includes('確認へ上がらず止められた'));
    const clean = lines.findIndex((line) => line.includes('mgr-clean'));
    expect(denied).toBeGreaterThanOrEqual(0);
    expect(denied).toBeLessThan(clean);
    expect(lines.filter((line) => line.includes('確認へ上がらず止められた'))).toHaveLength(1);
  });

  /**
   * `lost` の但し書きは、クローンの `manager_list` と Web UI には出ていたのに
   * CLI にだけ無かった。同じ状態を見て人間とクローンが違う判断をすることになる。
   */
  it('lost には但し書きを添える（[lost] の札だけで終わらせない）', () => {
    const text = renderManagerList([manager({ status: 'lost', live: false })]);

    expect(text).toContain('[lost');
    expect(text).toContain('⚠');
    expect(text).toContain('前のセッションへ戻れなかった');
  });

  /**
   * PR #60 と同じ線を CLI にも引く。観測しているのは「セッションへ戻れたか」
   * だけなので、仕事が失われたと断定しない。実際に、落ちる直前に PR をマージ
   * まで済ませていた仕事が `lost` になった例がある。
   */
  it('lost に「仕事が失われた」と書かない（観測の限界と次の一手を出す）', () => {
    const text = renderManagerList([manager({ status: 'lost', live: false })]);

    // 観測した分（戻れなかった）は言い切り、見ていない分は言い切らない。
    expect(text).toContain('見ているのは戻れたかどうかだけ');
    // 次に確かめる先。ここを削ると「戻れなかった」だけが残って断定に読める。
    expect(text).toContain('リモート');
    expect(text).toMatch(/PR/);
  });

  it('lost 以外には但し書きを出さない', () => {
    for (const status of ['running', 'done', 'failed'] as const) {
      const text = renderManagerList([manager({ status })]);
      expect(text).not.toContain('前のセッションへ戻れなかった');
    }
  });

  /**
   * 同じ関数の中で `waiting` と `lastReport` は畳んでいるのに、依頼文だけが
   * 生のまま出ていた。人間の依頼文は数千字あるので、一覧が流れて読めなくなる。
   */
  it('長い依頼文を畳む（一覧が流れない）', () => {
    const text = renderManagerList([manager({ request: 'あ'.repeat(4000) })]);

    const [header] = text.split('\n');
    expect(header).toBeDefined();
    expect(header?.length).toBeLessThan(200);
    expect(header).toContain('…');
  });

  it('依頼文の改行で行が増えない（1件が1行から始まる）', () => {
    const text = renderManagerList([manager({ request: '一行目\n二行目\n三行目' })]);

    expect(text).toContain('一行目 二行目 三行目');
    // 畳んだ結果が複数行に散らないこと（cwd が2行目に来る）
    expect(text.split('\n')[1]).toContain('cwd:');
  });

  /**
   * **直近の1ターンが「報告」ではなく失敗で終わったこと**を、状態に添えて出す。
   *
   * 直す前は `You've hit your org's monthly spend limit …` が `lastReport` に
   * そのまま入り、一覧には「直近の報告」として出ていた（`sdk-failure.ts` の doc）。
   * 台帳に `lastFailure` が付いた後も、この面が読まなければ人間には
   * 「報告が来た」としか出ない。
   */
  describe('直近のターンが失敗で終わったこと', () => {
    const FAILURE = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-08-20T10:00:00.000Z',
    };

    it('SDK の語と時刻を、状態の札を置き換えずに出す', () => {
      // 上限に当たった回もセッションは生きているので、台帳の status は `done`。
      const text = renderManagerList([manager({ status: 'done', lastFailure: FAILURE })]);

      // **札は差し替えない**（`failed` へ倒すと「もう続けられない」と読まれる）。
      expect(text).toContain('[done]');
      expect(text).toContain('報告ではなく失敗で終わっています');
      // SDK の語をそのまま。言い換えると人間が引ける手がかりが消える。
      expect(text).toContain('billing_error');
      expect(text).toContain('assistant_error');
      // いつの失敗かが無いと、今も止まっているのか昔一度失敗しただけかが読めない。
      expect(text).toContain('2026-08-20T10:00:00.000Z');
      // `status` を `failed` へ倒さなかった理由そのもの。書かないと人間が閉じる。
      expect(text).toContain('話しかければ続きます');
    });

    it('失敗で終わった回の本文を「直近の報告」と呼ばない', () => {
      const text = renderManagerList([
        manager({
          status: 'done',
          lastFailure: FAILURE,
          lastReport: '（このターンは応答を返さずに終わった: billing_error / assistant_error）',
        }),
      ]);

      expect(text).not.toContain('直近の報告');
      expect(text).toContain('直近のターンの中身');
    });

    it('失敗の行は報告の本文より上に来る（包みの内側を先に読ませない）', () => {
      const text = renderManagerList([
        manager({ status: 'done', lastFailure: FAILURE, lastReport: '包まれた本文' }),
      ]);

      const failure = text.indexOf('報告ではなく失敗で終わっています');
      const body = text.indexOf('包まれた本文');
      expect(failure).toBeGreaterThanOrEqual(0);
      expect(failure).toBeLessThan(body);
    });

    it('失敗していない回には何も足さず、報告は報告と呼ぶ', () => {
      const text = renderManagerList([
        manager({ status: 'done', lastReport: 'スキーマまで書いた' }),
      ]);

      expect(text).not.toContain('報告ではなく失敗');
      expect(text).not.toContain('⚠');
      expect(text).toContain('直近の報告: スキーマまで書いた');
    });
  });
});

/**
 * 日報の行は、**日報が書けなかった印**であることがある（`schema.ts` の
 * `unavailable`）。人間の面でその本文を素で出すと、実際に起きた壊れ方
 * （日報の本文が丸ごと `You've hit your org's monthly spend limit …` だった）が
 * そのまま再現する。
 */
describe('renderReport / renderReportLine', () => {
  const REASON = "You've hit your org's monthly spend limit · ask your admin to raise it";

  it('印の付いた行を「その日の日報」として出さない', () => {
    const text = renderReport({
      date: '2026-08-20',
      body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${REASON}）`,
      unavailable: REASON,
    });

    // 日報の見出しのまま出すと、人間はエラー文をその日のまとめとして読む。
    expect(text).not.toContain('── 2026-08-20 の日報 ──');
    expect(text).toContain('日報は作れなかった');
    // 理由は言い換えない（人間が SDK の文言で検索できること）。
    expect(text).toContain(REASON);
    // 「記録ごと消えた」と読まれないように、降りる先を名指しする。
    expect(text).toContain('/journal');
    // 書けていないだけなので、本物を作り直す道があることも言う。
    expect(text).toContain('/run daily_report');
  });

  it('印が無ければ本文をそのまま日報として出す', () => {
    const text = renderReport({ date: '2026-08-20', body: '## 今日やったこと\n進捗があった。' });

    expect(text).toContain('── 2026-08-20 の日報 ──');
    expect(text).toContain('進捗があった。');
    expect(text).not.toContain('作れなかった');
  });

  it('一覧の行でも、印の付いた行を本文の抜粋で出さない', () => {
    const line = renderReportLine({
      date: '2026-08-20',
      body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${REASON}）`,
      unavailable: REASON,
    });

    expect(line).toContain('2026-08-20');
    expect(line).toContain('日報なし');
    // 一覧は日付が並ぶだけの面なので、印が無いと「日報がある日」と同じ顔になる。
    expect(line).toContain('⚠');
    expect(line).not.toContain('この日の日報は作れなかった。日誌から直接辿ること');
  });

  it('一覧の行は、印が無ければこれまでどおり本文の抜粋である', () => {
    const line = renderReportLine({ date: '2026-08-20', body: '進捗があった。' });

    expect(line).toContain('2026-08-20');
    expect(line).toContain('進捗があった。');
    expect(line).not.toContain('⚠');
  });
});

// ---------------------------------------------------------------------------
// 引き受けたまま終わっていない仕事の台帳
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-08-19T12:00:00.000Z');

function commitment(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'cmt-1',
    at: '2026-08-16T12:00:00.000Z',
    origin: 'human',
    body: 'ドキュメントの誤りを直す',
    ...over,
  };
}

/**
 * 台帳の経路だけを持つ偽のクライアント。
 *
 * **応答の形は自分で名乗っている。** 本物の `hc<AppType>` が同じものを返すことは
 * ここでは確かめられない（`runSlashCommand` の型を通す時点で cast している）ので、
 * 経路と応答の形が実在することを保証しているのは**型検査のほう**である。ここで
 * 固定するのは「どの経路へ、どんな引数で行くか」だけ。
 */
function stubClient(
  options: {
    commitments?: Commitment[];
    closeStatus?: number;
    /** `DELETE /managers/:id` の応答。既定は「止めた」。 */
    abortStatus?: number;
    abortBody?: unknown;
  } = {},
) {
  const calls: { route: string; args: unknown }[] = [];
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });

  const client = {
    managers: {
      ':id': {
        $delete: (args: unknown) => {
          calls.push({ route: 'DELETE /managers/:id', args });
          return Promise.resolve(
            reply(
              options.abortStatus ?? 200,
              options.abortBody ?? { outcome: 'stopped', detail: 'mgr-1 を止めた' },
            ),
          );
        },
      },
    },
    commitments: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /commitments', args });
        return Promise.resolve(reply(200, { entries: options.commitments ?? [] }));
      },
      $post: (args: unknown) => {
        calls.push({ route: 'POST /commitments', args });
        return Promise.resolve(reply(200, {}));
      },
      ':id': {
        close: {
          $post: (args: unknown) => {
            calls.push({ route: 'POST /commitments/:id/close', args });
            return Promise.resolve(reply(options.closeStatus ?? 200, {}));
          },
        },
      },
    },
  };

  return { calls, client: client as unknown as Parameters<typeof runSlashCommand>[1] };
}

function emptyListed(): Listed {
  return { approvals: [], commitments: [] };
}

/** 端末へ書いたものを集める。後始末は `afterEach` の `restoreAllMocks`。 */
function captureStdout(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderCommitments', () => {
  /**
   * 番号を表示側と `/done` 側で別々に作ると、ずれた瞬間に**人間が見ていないもの**を
   * 閉じる。だから対応は1か所で作って返す。
   */
  it('番号と id を同じ順で作る（表示と /done が別のものを指さない）', () => {
    const { text, ids } = renderCommitments(
      [commitment({ id: 'a' }), commitment({ id: 'b' }), commitment({ id: 'c' })],
      NOW,
    );

    expect(ids).toEqual(['a', 'b', 'c']);
    expect(text.indexOf('[1]')).toBeLessThan(text.indexOf('[2]'));
    expect(text.indexOf('id: a')).toBeLessThan(text.indexOf('id: b'));
    expect(text.indexOf('id: b')).toBeLessThan(text.indexOf('id: c'));
  });

  /**
   * 器は優先度も締切も持たない（`schema.ts` の `commitmentSchema`）。人間が
   * 急ぎ方を決める材料は「いつ受け取ったか」と「どこから来たか」だけである。
   */
  it('起点と齢を出す（急ぎ方を決める材料はこの2つしかない）', () => {
    const { text } = renderCommitments([commitment({ origin: 'human', source: 'conv-1' })], NOW);

    expect(text).toContain('起点: 人間(conv-1)');
    expect(text).toContain('2026-08-16T12:00:00.000Z');
    // 受け取ってから3日。ISO だけだと読むたびに引き算をさせることになる。
    expect(text).toContain('3日前');
  });

  it('片付いたものには印と、何をもって閉じたかを添える', () => {
    const { text } = renderCommitments(
      [
        commitment({
          closedAt: '2026-08-18T12:00:00.000Z',
          closedReason: 'PR #99 をマージした',
        }),
      ],
      NOW,
    );

    expect(text).toContain('✓');
    expect(text).toContain('片付けた: 2026-08-18T12:00:00.000Z');
    // 「閉じた」だけを残すと、人間が後から否定できない。
    expect(text).toContain('PR #99 をマージした');
  });

  it('長い本文を畳む（一覧が流れない）', () => {
    const { text } = renderCommitments([commitment({ body: 'あ'.repeat(4000) })], NOW);

    const [header] = text.split('\n');
    expect(header).toBeDefined();
    expect(header?.length).toBeLessThan(200);
    expect(header).toContain('…');
  });

  it('空なら、そう言う（黙って何も出さない形にしない）', () => {
    const { text, ids } = renderCommitments([], NOW);

    expect(ids).toEqual([]);
    expect(text).toContain('引き受けたまま終わっていない仕事はありません');
  });
});

describe('chat の台帳コマンド', () => {
  /**
   * 既定で片付けたものまで出すと、未了が埋もれる。逆に `all` を出せないと
   * 「何を片付けたか」が chat から読めなくなる（器は行を消さない）。
   */
  it('/commitments は既定で未了だけを求め、all のときだけ片付けたものも求める', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ commitments: [commitment({ id: 'cmt-x' })] });

    await runSlashCommand('/commitments', client, emptyListed());
    await runSlashCommand('/commitments all', client, emptyListed());

    expect(calls.map((call) => call.route)).toEqual(['GET /commitments', 'GET /commitments']);
    expect(calls[0]?.args).toEqual({ query: {} });
    expect(calls[1]?.args).toEqual({ query: { includeClosed: 'true' } });
    expect(read()).toContain('id: cmt-x');
  });

  /**
   * 人間が `/commit` で積んだものは「人間から来た」ものであり、どの会話で
   * 引き受けたかまで残らないと、後で経緯へ戻れない（`Commitment.source`）。
   */
  it('/commit は本文と、いまの会話 id を台帳へ送る', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/commit 週明けに設計を見直す', client, emptyListed(), 'conv-7');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      route: 'POST /commitments',
      args: { json: { body: '週明けに設計を見直す', source: 'conv-7' } },
    });
  });

  it('/commit は会話が始まっていなければ source を付けない（嘘の出どころを埋めない）', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/commit 週明けに設計を見直す', client, emptyListed(), null);

    expect(calls[0]?.args).toEqual({ json: { body: '週明けに設計を見直す' } });
  });

  it('/commit は本文が無ければ何も送らず、使い方を出す', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/commit', client, emptyListed(), 'conv-7');

    expect(calls).toEqual([]);
    expect(read()).toContain('使い方: /commit');
  });

  /**
   * 番号で引けないと、人間が UUID を写す作業をすることになる（`/answer` と同じ理由）。
   * 理由が空のまま閉じると「閉じた」という事実だけが残り、人間が後から否定できない。
   */
  it('/done は番号を id へ引き直し、理由を書かなくても何をもって閉じたかを残す', async () => {
    captureStdout();
    const { calls, client } = stubClient({
      commitments: [commitment({ id: 'cmt-1' }), commitment({ id: 'cmt-2' })],
    });
    const listed = emptyListed();

    await runSlashCommand('/commitments', client, listed);
    await runSlashCommand('/done 2', client, listed);

    const close = calls.find((call) => call.route === 'POST /commitments/:id/close');
    expect(close).toBeDefined();
    expect((close?.args as { param: { id: string } }).param).toEqual({ id: 'cmt-2' });
    const { reason } = (close?.args as { json: { reason: string } }).json;
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain('/done');
  });

  it('/done は書かれた理由をそのまま送る', async () => {
    captureStdout();
    const { calls, client } = stubClient({ commitments: [commitment({ id: 'cmt-1' })] });
    const listed = emptyListed();

    await runSlashCommand('/commitments', client, listed);
    await runSlashCommand('/done 1 PR #99 をマージした', client, listed);

    const close = calls.find((call) => call.route === 'POST /commitments/:id/close');
    expect((close?.args as { json: { reason: string } }).json.reason).toBe('PR #99 をマージした');
  });

  /**
   * 「既に片付いている」と「そんな id は無い」は次の一手が違う（前者は何もしなくて
   * よく、後者は一覧を取り直す必要がある）。1つに畳むと、人間はどちらか分からない。
   */
  it('/done は 409（既に片付いている）と 404（id が無い）を別の言葉で返す', async () => {
    const conflict = captureStdout();
    const { client: conflictClient } = stubClient({
      commitments: [commitment({ id: 'cmt-1' })],
      closeStatus: 409,
    });
    const listedConflict = emptyListed();
    await runSlashCommand('/commitments', conflictClient, listedConflict);
    await runSlashCommand('/done 1', conflictClient, listedConflict);
    const conflictText = conflict();
    vi.restoreAllMocks();

    const missing = captureStdout();
    const { client: missingClient } = stubClient({
      commitments: [commitment({ id: 'cmt-1' })],
      closeStatus: 404,
    });
    const listedMissing = emptyListed();
    await runSlashCommand('/commitments', missingClient, listedMissing);
    await runSlashCommand('/done 1', missingClient, listedMissing);
    const missingText = missing();

    expect(conflictText).toContain('既に片付いています');
    expect(missingText).toContain('台帳にありません');
    expect(conflictText).not.toContain('台帳にありません');
    expect(missingText).not.toContain('既に片付いています');
  });

  /**
   * `/approvals` と `/commitments` はどちらも「番号で指す一覧」なので、覚え場所を
   * 1本にすると混ざったことに人間が気づく手がかりが無い。
   */
  it('/done は承認待ちの番号を掴まない（覚え場所が別であること）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed: Listed = { approvals: ['approval-1'], commitments: [] };

    await runSlashCommand('/done 1', client, listed);

    expect(calls).toEqual([]);
    expect(read()).toContain('/commitments の一覧にありません');
  });

  it('/help に台帳の3つが載っている（入口の等価性）', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    const text = read();
    expect(text).toContain('/commitments');
    expect(text).toContain('/commit ');
    expect(text).toContain('/done ');
  });
});

/**
 * 委譲を**止める**手が CLI にもあること。
 *
 * PRD「インターフェース」は3面（CLI・HTTP API・Web UI）で同じことができると
 * 書いており、起こせることの列挙に「委譲の停止」がある。読めるのに止められない面が
 * あると、その面の人間は器ごと落とすしかなくなる — **関係の無い仕事まで道連れに
 * なる**ので、それは代替手段ではない（`DELETE /managers/:id` の description が
 * 書いている、この口の存在理由そのもの）。
 */
describe('chat の /stop', () => {
  it('id を指定すると、その1本だけを止める', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/stop mgr-1', client, emptyListed());

    expect(calls).toEqual([
      { route: 'DELETE /managers/:id', args: { param: { id: 'mgr-1' }, json: {} } },
    ]);
    // 器の応答をそのまま出す（「止めた」と言い換えない）。
    expect(read()).toContain('stopped: mgr-1 を止めた');
  });

  it('理由を書けば、そのまま送る（日誌に「なぜ」が残る）', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/stop mgr-1 同じ issue に2本立っている', client, emptyListed());

    expect(calls[0]?.args).toEqual({
      param: { id: 'mgr-1' },
      json: { reason: '同じ issue に2本立っている' },
    });
  });

  it('理由を書かなければ、空文字を送らない（書き忘れと区別が付かなくなる）', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    // 余分な空白だけを渡しても、`reason` は付かない。
    await runSlashCommand('/stop mgr-1    ', client, emptyListed());

    expect(calls[0]?.args).toEqual({ param: { id: 'mgr-1' }, json: {} });
  });

  it('id が無ければ何も送らず、使い方を出す', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/stop', client, emptyListed());

    expect(calls).toEqual([]);
    expect(read()).toContain('使い方: /stop');
  });

  it('居ないマネージャーなら、止めたとは言わない', async () => {
    const read = captureStdout();
    const { client } = stubClient({ abortStatus: 404, abortBody: { error: 'そんな id は無い' } });

    await runSlashCommand('/stop mgr-none', client, emptyListed());

    const text = read();
    expect(text).toContain('見つかりませんでした');
    expect(text).not.toContain('stopped');
  });

  it('/help に載っている（隠れた口を作らない）', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    expect(read()).toContain('/stop ');
  });
});
