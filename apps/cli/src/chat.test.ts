import type { Commitment } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseSSEChunk,
  renderCommitments,
  renderManagerList,
  renderReport,
  renderReportLine,
  renderWaitingList,
  runSlashCommand,
  type Listed,
} from './chat.js';
import { captureStdout } from './test-support.js';

type ManagerListItem = Parameters<typeof renderManagerList>[0][number];
type ManagerWaitingItem = ManagerListItem['waiting'][number];

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

function waitingItem(over: Partial<ManagerWaitingItem> = {}): ManagerWaitingItem {
  return {
    requestId: 'req-1',
    summary: 'これを消してよいか',
    kind: 'permission',
    askedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

/**
 * 版のずれの窓（新しいデーモンが、畳まれつつある旧 runner の `/managers` へ
 * 問い合わせる間）を模した、`kind` も `askedAt` も持たない待ち。
 *
 * **いまの型はまだ両方を必須としている。** 緩める変更（`kind?` / `askedAt?`）は
 * `packages/core` / `apps/daemon` 側で別の作業者が別コミットとして入れる
 * （このコミット単独では apps/cli しか触っていない）。型が緩むまでの間も
 * 表示側の歯を先に書けるよう、**`Partial<ManagerWaitingItem>` から
 * `ManagerWaitingItem` への1段の `as`** で緩めている（何を緩めたかが型の
 * 名前から読める。`as unknown as` や `as any` は使わない）。実行時の形は
 * 緩んだ後の型と同じ（`kind` / `askedAt` が無い1件）で、型が緩んだ後も
 * このキャストはそのまま要らなくなるだけで壊れない。
 */
function legacyWaiting(over: Partial<ManagerWaitingItem> = {}): ManagerWaitingItem {
  const base: Partial<ManagerWaitingItem> = {
    requestId: 'req-legacy',
    summary: '版ずれの窓からの確認',
    ...over,
  };
  return base as ManagerWaitingItem;
}

describe('renderManagerList', () => {
  it('確認へ上がらず止められた件数を、道具ごとに出す', () => {
    const text = renderManagerList([manager({ denials: [{ tool: 'Bash', count: 3 }] })]);

    expect(text).toContain('確認へ上がらず止められた道具');
    expect(text).toContain('Bash 3件');
    // 数えているのは拒否であって、それで止まったかは見ていない。断定しない。
    expect(text).toContain('可能性があります');
  });

  /**
   * **字面の生成元を1つに保つ。** ここは同じ意味の字面（`/セッション切断`）を
   * 自前で組んでいて、`live` を真偽値としてしか扱えなかった —— 「取れていない」
   * （`undefined`）を表せず、取れていない回まで「話しかけられる」側へ倒れていた。
   * クローンの `manager_list` と定期 tick の要約は既に
   * `describeManagerState`（`@alteroid/core`）を通している。
   */
  it('状態の札は describeManagerState と同じ字面を出す（3値とも）', () => {
    expect(renderManagerList([manager({ status: 'running', live: true })])).toContain('[running]');
    expect(renderManagerList([manager({ status: 'running', live: false })])).toContain(
      '[running/セッション切断]',
    );
    // **「取れていない」を「切断」へ畳まない。** 自前の三項演算子ではこの行が
    // `/セッション切断` になっていた（取れていないことが観測として消える）。
    expect(renderManagerList([manager({ status: 'running', live: undefined })])).toContain(
      '[running/セッション不明]',
    );
  });

  /**
   * **`live: false` の理由を、分かる分だけ名指しする。** 状態名だけだと
   * 「セッションが終わった」のか「宛先の器が消えた」のかが読めず、人間の打つ手が
   * 決まらない。**断定は「器が黙っている」までである。**
   */
  it('宛先の器が黙っているときは、その判定時刻と「失われたとは限らない」を添える', () => {
    const text = renderManagerList([
      manager({ status: 'running', live: false, runnerLostSince: '2026-08-27T09:00:00.000Z' }),
    ]);

    expect(text).toContain('2026-08-27T09:00:00.000Z 以降 名乗っていない');
    expect(text).toContain('この委譲が失われたという意味ではない');
  });

  it('宛先の器が黙っていなければ、その行は出さない', () => {
    const text = renderManagerList([manager({ status: 'running', live: true })]);

    expect(text).not.toContain('名乗っていない');
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
        waiting: [
          {
            requestId: 'req-1',
            summary: 'これを消してよいか',
            kind: 'permission',
            askedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    ]);

    const header = text.indexOf('[running]');
    const denial = text.indexOf('確認へ上がらず止められた道具');
    const waiting = text.indexOf('返事待ち');
    expect(header).toBeLessThan(denial);
    expect(denial).toBeLessThan(waiting);
  });

  /**
   * 種別が読めないと、人間は `/reply` と `/allow` のどちらを打つべきか
   * 分からない（#336、依頼者コメント）。`askedAt` が無いと「5分前か4時間前か」
   * で手が変わるのに判断できない（#323）。
   */
  it('待ちの行に kind（質問／実行許可）と askedAt（絶対時刻）を出す', () => {
    const question = renderManagerList([
      manager({
        waiting: [waitingItem({ kind: 'question', askedAt: '2026-08-20T01:02:03.000Z' })],
      }),
    ]);
    const permission = renderManagerList([
      manager({ waiting: [waitingItem({ kind: 'permission' })] }),
    ]);

    expect(question).toContain('質問');
    expect(question).toContain('2026-08-20T01:02:03.000Z');
    expect(permission).toContain('実行許可');
  });

  /**
   * 相対表現（「4時間前」）を CLI で作らない（`AGENTS.md`「時刻の扱い」）。
   * ISO をそのまま出すので、TZ を固定しなくても落ちない歯になる。
   */
  it('askedAt は ISO をそのまま出し、相対表現を作らない', () => {
    const text = renderManagerList([
      manager({ waiting: [waitingItem({ askedAt: '2026-08-20T01:02:03.000Z' })] }),
    ]);

    expect(text).toContain('2026-08-20T01:02:03.000Z');
    expect(text).not.toMatch(/時間前|分前|日前/);
  });

  /**
   * **版のずれの窓でも人間の手が残ること。** 新しいデーモンが、畳まれつつ
   * ある旧 runner の `/managers` へ問い合わせる窓があり、そちらの応答には
   * `kind` も `askedAt` も乗らない（`railway/README.md`）。落ちない・行は出る・
   * 「実行許可」と決めつけない・時刻欄は出さない、の4点を測る。
   */
  it('kind も askedAt も無い待ちが混じっていても落ちず、種別不明として出す', () => {
    const text = renderManagerList([manager({ waiting: [legacyWaiting()] })]);

    expect(text).toContain('返事待ち');
    expect(text).toContain('種別不明');
    // 分からないものを「実行許可」と決めつけない。
    expect(text).not.toContain('実行許可');
    expect(text).not.toContain('質問');
    // 取れない軸に空文字や `-` の行を作らない — `確認:` の欄そのものを出さない。
    expect(text).not.toContain('確認:');
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
    for (const status of ['running', 'done', 'failed', 'stopped'] as const) {
      const text = renderManagerList([manager({ status })]);
      expect(text).not.toContain('前のセッションへ戻れなかった');
    }
  });

  /**
   * **`stopped` は `done` に潰れない。** `manager_stop` / `DELETE /managers/:id`
   * が返す `outcome` は3種類に分かれたが、いったん `status: 'stopped'` として
   * 台帳に残った後は、この一覧が読む状態も別物のまま出なければならない
   * （`done` は待機、`stopped` は外から止められた終端）。
   */
  it('stopped は done に潰れず、そのまま状態名で出る', () => {
    const stopped = renderManagerList([manager({ status: 'stopped', live: false })]);
    const done = renderManagerList([manager({ status: 'done' })]);

    expect(stopped).toContain('[stopped');
    expect(stopped).not.toContain('[done');
    expect(done).toContain('[done');
    expect(done).not.toContain('[stopped');
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

  /** `GET /managers` が既に持っていた値を出すだけ（#208 でクローン側は既出）。 */
  it('作成と更新を出す（別の値で、取り違えでも落ちる形にする）', () => {
    const text = renderManagerList([
      manager({ startedAt: '2026-08-16T10:00:00.000Z', updatedAt: '2026-08-17T09:30:00.000Z' }),
    ]);

    expect(text).toContain('作成: 2026-08-16T10:00:00.000Z  更新: 2026-08-17T09:30:00.000Z');
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
 * `/waiting` の表示。番号と (managerId, requestId) の対応をここで一緒に
 * 作って返す（`renderCommitments` と同じ形 — 表示側と `/reply` 側で別々に
 * 並べ直すと、ずれた瞬間に人間が見ていない確認へ答えることになる）。
 */
describe('renderWaitingList', () => {
  it('番号と (managerId, requestId) を同じ順で作る', () => {
    const { text, entries } = renderWaitingList([
      manager({ managerId: 'mgr-a', waiting: [waitingItem({ requestId: 'req-a' })] }),
      manager({ managerId: 'mgr-b', waiting: [waitingItem({ requestId: 'req-b' })] }),
    ]);

    expect(entries).toEqual([
      { managerId: 'mgr-a', requestId: 'req-a' },
      { managerId: 'mgr-b', requestId: 'req-b' },
    ]);
    expect(text.indexOf('[1]')).toBeLessThan(text.indexOf('[2]'));
  });

  it('待ちが無ければ、そう言う（entries は空）', () => {
    const { text, entries } = renderWaitingList([manager({ waiting: [] })]);

    expect(entries).toEqual([]);
    expect(text).toContain('返事待ちのマネージャーはいません');
  });

  /**
   * **版のずれの窓でも落ちない。** `kind` も `askedAt` も無い待ちが混じって
   * いても、行は出る・番号は振られる・「実行許可」と決めつけない。
   */
  it('kind も askedAt も無い待ちが混じっていても落ちず、種別不明として出す', () => {
    const { text, entries } = renderWaitingList([
      manager({ managerId: 'mgr-legacy', waiting: [legacyWaiting()] }),
    ]);

    expect(entries).toEqual([{ managerId: 'mgr-legacy', requestId: 'req-legacy' }]);
    expect(text).toContain('[1]');
    expect(text).toContain('種別不明');
    expect(text).not.toContain('実行許可');
    expect(text).not.toContain('確認:');
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
      at: '2026-08-20T13:00:00.000Z',
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
    const line = renderReportLine({
      date: '2026-08-20',
      at: '2026-08-20T13:00:00.000Z',
      body: '進捗があった。',
    });

    expect(line).toContain('2026-08-20');
    expect(line).toContain('進捗があった。');
    expect(line).not.toContain('⚠');
  });

  /**
   * #214: `date` だけだと同じ日に2本あると見分けが付かない。`at` を出す。
   * ISO をそのまま出す文字列の受け渡しなので、`TZ` は結果に関与しない
   * （`Date` を作って整形し直してはいない）。
   */
  it('同じ日に2本あっても at で見分けが付く（#214）', () => {
    const morning = renderReportLine({
      date: '2026-08-20',
      at: '2026-08-20T00:30:00.000Z',
      body: '朝の分。',
    });
    const afternoon = renderReportLine({
      date: '2026-08-20',
      at: '2026-08-20T13:00:00.000Z',
      body: '午後にやり直した分。',
    });

    expect(morning).toContain('2026-08-20T00:30:00.000Z');
    expect(afternoon).toContain('2026-08-20T13:00:00.000Z');
    expect(morning).not.toBe(afternoon);
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
interface ConversationSummaryLike {
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  messages: number;
  preview: string;
}

interface ConversationMessageLike {
  id: string;
  at: string;
  role: 'inbound' | 'outbound';
  text: string;
}

interface AnswersRequest {
  answers: { id: string; answer: string }[];
}

/** `GET /approvals` が返す1件の形（`pendingApprovalSchema`）。 */
interface ApprovalLike {
  id: string;
  createdAt: string;
  question: string;
  context?: string;
  jobId?: string;
  answeredAt?: string;
}

/** `GET /schedule` が返す1件の形（`scheduleStatusSchema`）。 */
interface ScheduleEntryLike {
  kind: string;
  description: string;
  nextAt: string;
  request?: string;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
}

/** `GET /memory` が返す1件の形（`memoryDocumentMetaSchema`）。 */
interface MemoryDocLike {
  slug: string;
  title: string;
  kind: 'premise' | 'fact';
  description?: string;
  descriptionFreshness: { kind: 'fresh' | 'stale' | 'unknown' | 'absent' };
  updatedAt: string;
  createdAt: { kind: 'known'; at: string } | { kind: 'unknown' };
}

/** `GET /journal` が返す1件の形（`journalEntrySchema` の網羅はしない。テストに要る分だけ）。 */
interface JournalEntryLike {
  id: string;
  at: string;
  type: string;
  [field: string]: unknown;
}

function stubClient(
  options: {
    commitments?: Commitment[];
    closeStatus?: number;
    /** `DELETE /managers/:id` の応答。既定は「止めた」。 */
    abortStatus?: number;
    abortBody?: unknown;
    /** `GET /conversations` の応答。 */
    conversations?: ConversationSummaryLike[];
    conversationsScanned?: number;
    /** 既定 `true`（＝窓は先頭に届いている＝断り書きを出さない）。 */
    conversationsReachedStart?: boolean;
    /** 既定 `0`（＝ limit で落ちた会話は無い＝断り書きを出さない）。 */
    conversationsHiddenByLimit?: number;
    conversationsStatus?: number;
    /** `GET /conversations/:id` の応答。 */
    conversationDetailStatus?: number;
    conversationDetailBody?: {
      conversationId: string;
      messages: ConversationMessageLike[];
      scanned: number;
      reachedStart: boolean;
    };
    /** `POST /approvals/answer` の応答コード。既定は 200。 */
    approvalsAnswerStatus?: number;
    /**
     * `POST /approvals/answer` が返す `results` を、送った `answers` から作る。
     * 既定は全件 `ok: true`（1件ごとの失敗を試すテストはここを渡す）。
     */
    approvalsAnswerResults?: (
      answers: { id: string; answer: string }[],
    ) => { id: string; ok: boolean; error?: string }[];
    /** `GET /approvals` が返す一覧。既定は空。 */
    approvals?: ApprovalLike[];
    /** `GET /schedule` が返す一覧。既定は空。 */
    scheduleEntries?: ScheduleEntryLike[];
    /** `GET /memory` が返す一覧。既定は空。 */
    memoryDocuments?: MemoryDocLike[];
    /** `GET /journal` が返す一覧。既定は空。 */
    journalEntries?: JournalEntryLike[];
    /** `GET /managers` が返す一覧。既定は空（`/managers` `/waiting` `/reply` 等が使う）。 */
    managers?: ManagerListItem[];
    /** `POST /managers/:id/messages` の応答コード。既定は 200。 */
    messagesStatus?: number;
    /** `POST /managers/:id/messages` の応答本体。既定は `delivered`。 */
    messagesBody?: unknown;
    /** `GET /managers/:id/transcript` の応答コード。既定は 200。 */
    transcriptStatus?: number;
    /** `GET /managers/:id/transcript` の応答本体（生テキスト）。既定は空文字。 */
    transcriptBody?: string;
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
      $get: (args: unknown) => {
        calls.push({ route: 'GET /managers', args });
        return Promise.resolve(reply(200, { managers: options.managers ?? [] }));
      },
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
        messages: {
          $post: (args: unknown) => {
            calls.push({ route: 'POST /managers/:id/messages', args });
            return Promise.resolve(
              reply(
                options.messagesStatus ?? 200,
                options.messagesBody ?? { outcome: 'delivered', detail: '追加指示として届けた。' },
              ),
            );
          },
        },
        transcript: {
          $get: (args: unknown) => {
            calls.push({ route: 'GET /managers/:id/transcript', args });
            const status = options.transcriptStatus ?? 200;
            return Promise.resolve({
              ok: status >= 200 && status < 300,
              status,
              text: () => Promise.resolve(options.transcriptBody ?? ''),
            });
          },
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
    conversations: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /conversations', args });
        return Promise.resolve(
          reply(options.conversationsStatus ?? 200, {
            conversations: options.conversations ?? [],
            scanned: options.conversationsScanned ?? 0,
            reachedStart: options.conversationsReachedStart ?? true,
            hiddenByLimit: options.conversationsHiddenByLimit ?? 0,
          }),
        );
      },
      ':id': {
        $get: (args: unknown) => {
          calls.push({ route: 'GET /conversations/:id', args });
          const param = (args as { param: { id: string } }).param;
          return Promise.resolve(
            reply(
              options.conversationDetailStatus ?? 200,
              options.conversationDetailBody ?? {
                conversationId: param.id,
                messages: [],
                scanned: 0,
                reachedStart: true,
              },
            ),
          );
        },
      },
    },
    approvals: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /approvals', args });
        return Promise.resolve(reply(200, { approvals: options.approvals ?? [] }));
      },
      answer: {
        $post: (args: { json: AnswersRequest }) => {
          calls.push({ route: 'POST /approvals/answer', args });
          const results = (options.approvalsAnswerResults ?? defaultAnswerResults)(
            args.json.answers,
          );
          return Promise.resolve(reply(options.approvalsAnswerStatus ?? 200, { results }));
        },
      },
    },
    schedule: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /schedule', args });
        return Promise.resolve(reply(200, { entries: options.scheduleEntries ?? [] }));
      },
    },
    memory: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /memory', args });
        return Promise.resolve(reply(200, { documents: options.memoryDocuments ?? [] }));
      },
    },
    journal: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /journal', args });
        return Promise.resolve(reply(200, { entries: options.journalEntries ?? [] }));
      },
    },
  };

  return { calls, client: client as unknown as Parameters<typeof runSlashCommand>[1] };
}

function defaultAnswerResults(
  answers: { id: string; answer: string }[],
): { id: string; ok: boolean; error?: string }[] {
  return answers.map((entry) => ({ id: entry.id, ok: true }));
}

function emptyListed(): Listed {
  return { approvals: [], commitments: [], conversations: [], managers: [], waiting: [] };
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

  /**
   * 5項目のうちの「作成」。未了なら作成と更新は一致する。
   * `at` / `closedAt` / `NOW` を別々の日付にして、取り違えでも落ちる形にする。
   */
  it('未了の1件は作成と更新に同じ受け取り時刻を出す（齢の表示も残る）', () => {
    const { text } = renderCommitments([commitment({ at: '2026-08-10T00:00:00.000Z' })], NOW);

    expect(text).toContain('作成: 2026-08-10T00:00:00.000Z');
    expect(text).toContain('更新: 2026-08-10T00:00:00.000Z');
    // 齢の表示（（N前）は残っていること — ISO を足しても消えるものではない。
    expect(text).toMatch(/（\d+日前）/);
  });

  /**
   * 片付いた1件は「更新」に closedAt を出し、受け取り時刻（at）を出さない。
   * 3つの時刻（at / closedAt / NOW）をすべて別の日付にしておく——
   * `at` に取り違えても、`NOW` を出しても、この形なら落ちる。
   */
  it('片付いた1件は更新に closedAt を出す（受け取り時刻に取り違えない）', () => {
    const { text } = renderCommitments(
      [
        commitment({
          at: '2026-08-10T00:00:00.000Z',
          closedAt: '2026-08-15T00:00:00.000Z',
          closedReason: 'x',
        }),
      ],
      NOW,
    );

    expect(text).toContain('作成: 2026-08-10T00:00:00.000Z');
    expect(text).toContain('更新: 2026-08-15T00:00:00.000Z');
    expect(text).not.toContain('更新: 2026-08-10T00:00:00.000Z');
    expect(text).not.toContain(`更新: ${new Date(NOW).toISOString()}`);
  });

  it('空なら、そう言う（黙って何も出さない形にしない）', () => {
    const { text, ids } = renderCommitments([], NOW);

    expect(ids).toEqual([]);
    expect(text).toContain('引き受けたまま終わっていない仕事はありません');
  });

  /**
   * **口ごとに能力差を作らない**（`docs/PRD.md`「要件: インターフェース
   * （CLI・HTTP API・Web UI）」）。読めない行の断りは Web
   * （`apps/web/app/routes/commitments.tsx` の `UnreadableNote`）とクローン
   * （`packages/core/src/tools.ts` の `commitment_list`）に在るので、
   * CLI にも在ること（issue #296）。
   */
  it('読めない行が在れば、件数と id を断る（片付いたのではない、と明示する）', () => {
    const { text, ids } = renderCommitments([commitment({ id: 'a' })], NOW, [
      { id: 'broken-1', reason: 'origin が読めない' },
    ]);

    // 読める行はそのまま出る（断りが一覧を潰していない）。
    expect(ids).toEqual(['a']);
    expect(text).toContain('id: a');
    // 断りは件数・id・「片付いたのではない」の3つを名指しする。
    expect(text).toContain('読めない行が 1 件あります');
    expect(text).toContain('broken-1');
    expect(text).toContain('片付いたのではありません');
  });

  /**
   * **いちばん危ない状態が、いちばん安心な文言で出る形を塞ぐ。** 読める行が
   * 0件でも、読めない行が在るなら「ありません」で終わらせない（issue #296）。
   */
  it('読める行が0件でも、読めない行が在れば断りを出す（「ありません」で終わらせない）', () => {
    const { text } = renderCommitments([], NOW, [{ id: 'broken-1', reason: 'origin が読めない' }]);

    expect(text).toContain('読めない行が 1 件あります');
    expect(text).not.toContain('引き受けたまま終わっていない仕事はありません');
  });

  /** id が取れない行は件数だけに数える（行が壊れている以上、id が無いことがある）。 */
  it('id が取れない読めない行は、件数だけに数える', () => {
    const { text } = renderCommitments([], NOW, [{ reason: 'id ごと読めない' }]);

    expect(text).toContain('読めない行が 1 件あります');
    expect(text).not.toContain('id: ');
  });

  /** 0件なら何も足さない（常に出る断りは、出ていることが情報にならない）。 */
  it('読めない行が0件なら、断りを足さない', () => {
    const { text } = renderCommitments([commitment({ id: 'a' })], NOW, []);

    expect(text).not.toContain('読めない行');
  });

  /**
   * **保持上限を超えて物理削除された片付き行の断り（issue #416）。**
   *
   * `renderUnreadableNotice` と同じ理由で CLI にも出す——Web
   * （`apps/web/app/routes/commitments.tsx` の `TrimmedClosedNote`）とクローン
   * （`packages/core/src/tools.ts` の `commitment_list`）にだけ在ってここに無いと、
   * CLI で台帳を読んだ人間だけが、fs 実装が片付き行を物理削除している事実を知らない。
   */
  it('物理削除された片付き行が在れば、累計件数を断る', () => {
    const { text } = renderCommitments([commitment({ id: 'a' })], NOW, [], 3);

    expect(text).toContain('保持上限を超えて物理削除された片付き行が累計 3 件あります');
  });

  it('物理削除された片付き行が0件なら、断りを足さない', () => {
    const { text } = renderCommitments([commitment({ id: 'a' })], NOW, [], 0);

    expect(text).not.toContain('物理削除された');
  });

  it('読める行が0件でも、物理削除された片付き行が在れば断りを出す', () => {
    const { text } = renderCommitments([], NOW, [], 5);

    expect(text).toContain('保持上限を超えて物理削除された片付き行が累計 5 件あります');
    expect(text).not.toContain('引き受けたまま終わっていない仕事はありません');
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
    const listed: Listed = {
      approvals: ['approval-1'],
      commitments: [],
      conversations: [],
      managers: [],
      waiting: [],
    };

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
 * 溜まった承認待ちをまとめて答える（`POST /approvals/answer`）。
 *
 * `docs/roadmap.md` M3「溜まった保留を人間が chat / API でまとめて処理できる」の
 * 未達を塞ぐ。**`/answer`（1件・自由文）は変えない。** ここで固定するのは
 * `/answers`（複数件）が (1) 1回の呼びでまとめて送ること、(2) 1件を飛ばせる
 * こと、(3) 途中でやめられる（書いた分だけ送れる）こと、(4) 1件が駄目でも
 * 残りが進み、その失敗が id ごとに見えること、である。
 */
describe('chat の /answers（まとめて答える）', () => {
  function listedApprovals(ids: string[]): Listed {
    return { approvals: ids, commitments: [], conversations: [], managers: [], waiting: [] };
  }

  it('複数件を1回の POST /approvals/answer にまとめて送る', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed = listedApprovals(['approval-1', 'approval-2']);

    await runSlashCommand('/answers 1 allow 2 "駄目。理由は後で書く"', client, listed);

    const answerCalls = calls.filter((call) => call.route === 'POST /approvals/answer');
    expect(answerCalls).toHaveLength(1);
    const sent = (answerCalls[0]?.args as { json: AnswersRequest }).json.answers;
    expect(sent).toEqual([
      { id: 'approval-1', answer: 'allow' },
      { id: 'approval-2', answer: '駄目。理由は後で書く' },
    ]);
    const text = read();
    expect(text).toContain('[approval-1] 回答しました');
    expect(text).toContain('[approval-2] 回答しました');
  });

  /** 番号を書かなければ、その件は送られない（1件飛ばせる）。 */
  it('一覧の一部だけを番号で指せる（残りを飛ばせる）', async () => {
    captureStdout();
    const { calls, client } = stubClient();
    const listed = listedApprovals(['approval-1', 'approval-2', 'approval-3']);

    await runSlashCommand('/answers 2 allow', client, listed);

    const sent = (calls[0]?.args as { json: AnswersRequest }).json.answers;
    expect(sent).toEqual([{ id: 'approval-2', answer: 'allow' }]);
  });

  /** 一覧に無い番号は、その件だけ飛ばして残りは送る（全体を止めない）。 */
  it('一覧にない番号は飛ばす。残りは送る', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed = listedApprovals(['approval-1']);

    await runSlashCommand('/answers 9 allow 1 deny', client, listed);

    const sent = (calls[0]?.args as { json: AnswersRequest }).json.answers;
    expect(sent).toEqual([{ id: 'approval-1', answer: 'deny' }]);
    expect(read()).toContain('[9] は /approvals の一覧にありません');
  });

  /**
   * **成功件数だけを言わない。** 1件が駄目でも残りは進む設計なので、
   * どの id が通らなかったかが人間から見えなければ、まとめて処理した瞬間に
   * 取りこぼしが静かに起きる。
   */
  it('1件が失敗しても残りは進み、失敗した id が分かる', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      approvalsAnswerResults: (answers) =>
        answers.map((entry) =>
          entry.id === 'approval-2'
            ? { id: entry.id, ok: false, error: 'already answered' }
            : { id: entry.id, ok: true },
        ),
    });
    const listed = listedApprovals(['approval-1', 'approval-2']);

    await runSlashCommand('/answers 1 allow 2 deny', client, listed);

    const text = read();
    expect(text).toContain('[approval-1] 回答しました');
    expect(text).toContain('[approval-2] 回答に失敗: already answered');
  });

  /** 引数が無ければ何も送らず、使い方を示す。 */
  it('引数が無ければ何も送らない', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/answers', client, listedApprovals(['approval-1']));

    expect(calls).toEqual([]);
    expect(read()).toContain('使い方: /answers');
  });

  /** 番号と回答が対になっていない（片方だけ余る）ときは、全体を送らない。 */
  it('対になっていない入力は何も送らない（一部だけ解釈しない）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand(
      '/answers 1 allow 2',
      client,
      listedApprovals(['approval-1', 'approval-2']),
    );

    expect(calls).toEqual([]);
    expect(read()).toContain('使い方: /answers');
  });

  it('/help に /answers が載っている', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    expect(read()).toContain('/answers');
  });
});

/**
 * `/approvals` の一覧（PR #235）。
 *
 * 札は質問の1行目だけにしてある——改行を含む質問を全文そのまま先頭行へ出すと
 * `[1] ` の行が途中で折れ、番号と質問の対応が崩れる（クローン側は #215 で
 * 1行目を札にしてある）。**残りの行は落とさない**（CLI は人間へ返す口なので、
 * 切れば能力を削る）。
 */
describe('chat の /approvals（一覧）', () => {
  it('先頭行（[1] の行）には質問の1行目だけが乗り、2行目以降は落とさず続く', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      approvals: [
        {
          id: 'appr-1',
          createdAt: '2026-08-16T10:00:00.000Z',
          question: '1行目の質問です\n2行目の補足です\n3行目の補足です',
        },
      ],
    });

    await runSlashCommand('/approvals', client, emptyListed());

    const text = read();
    const lines = text.split('\n');
    const header = lines.find((line) => line.startsWith('  [1] '));
    // 先頭行は1行目だけ（2行目・3行目が混ざって折れていない）。
    expect(header).toBe('  [1] 1行目の質問です');
    // **札の下へインデントして続いていること。** `text.split('\n')` は元の質問に
    // 埋め込まれた改行もそのまま行に割るので、`toContain('2行目の補足です')` だけでは
    // 「全文を先頭行へ出した（インデントなし）」場合と区別できない
    // （実際、当てた変異でこの弱い形の assertion は通り抜けた）。**インデント込みの
    // 行そのもの**を見て、初めて「札の下へ続けた」ことを保証できる。
    expect(lines).toContain('      2行目の補足です');
    expect(lines).toContain('      3行目の補足です');
    // 能力を削っていないこと——2行目・3行目は出力のどこかに残っている。
    expect(text).toContain('2行目の補足です');
    expect(text).toContain('3行目の補足です');
  });

  it('作成と更新を出す（未回答なら更新は作成に一致、回答済みなら answeredAt）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      approvals: [
        { id: 'appr-open', createdAt: '2026-08-16T10:00:00.000Z', question: '未回答の質問' },
        {
          id: 'appr-answered',
          createdAt: '2026-08-14T00:00:00.000Z',
          answeredAt: '2026-08-15T00:00:00.000Z',
          question: '回答済みの質問',
        },
      ],
    });

    await runSlashCommand('/approvals', client, emptyListed());

    const text = read();
    // 未回答: 更新は作成に一致。
    expect(text).toContain(
      'id: appr-open  作成: 2026-08-16T10:00:00.000Z' + '  更新: 2026-08-16T10:00:00.000Z',
    );
    // 回答済み: 更新は answeredAt。作成（createdAt）には取り違えない。
    expect(text).toContain(
      'id: appr-answered  作成: 2026-08-14T00:00:00.000Z' + '  更新: 2026-08-15T00:00:00.000Z',
    );
    expect(text).not.toContain(
      'id: appr-answered  作成: 2026-08-14T00:00:00.000Z' + '  更新: 2026-08-14T00:00:00.000Z',
    );
  });
});

/**
 * `/schedule`（継続中の依頼の一覧、PR #235）。
 *
 * 既定の仕込み（日報・発意 tick）は「作成という出来事が存在しない」ので、
 * `createdAt` が無い。**空欄や `undefined` にしないこと**——探しに行く人が出る。
 */
describe('chat の /schedule', () => {
  it('仕込まれた依頼は概要と作成・更新を出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      scheduleEntries: [
        {
          kind: 'follow-up',
          description: '継続中の依頼',
          nextAt: '2026-08-20T00:00:00.000Z',
          request: 'PR #99 の続きを見る',
          createdAt: '2026-08-15T00:00:00.000Z',
          updatedAt: '2026-08-16T00:00:00.000Z',
        },
      ],
    });

    await runSlashCommand('/schedule', client, emptyListed());

    const text = read();
    expect(text).toContain('依頼: PR #99 の続きを見る');
    expect(text).toContain('作成: 2026-08-15T00:00:00.000Z  更新: 2026-08-16T00:00:00.000Z');
  });

  it('既定の仕込み（createdAt が無い）は「無し」と言葉で出す（undefined を出さない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      scheduleEntries: [
        { kind: 'daily-report', description: '日報', nextAt: '2026-08-20T00:00:00.000Z' },
      ],
    });

    await runSlashCommand('/schedule', client, emptyListed());

    const text = read();
    expect(text).toContain(
      '作成・更新: 無し（コードに書かれた既定の仕込みで、仕込まれた記録がありません）',
    );
    expect(text).not.toContain('undefined');
  });
});

/**
 * `chat` の `/memory`（`alteroid memory list` とは別の重複実装）。
 *
 * **同じ `GET /memory` を見ながら、ここは slug と title しか出していなかった。**
 * #235 はトップレベルの `alteroid memory list`（`memory.ts`）に5項目を揃えたが、
 * `chat` の中のこの一覧は直っていなかった——同じ記憶を同じセッションの中で
 * 違う答えで出す形になっていた。
 */
describe('chat の /memory', () => {
  it('概要・作成・更新を出す（alteroid memory list と同じ言葉）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      memoryDocuments: [
        {
          slug: 'values',
          title: '価値観',
          kind: 'premise',
          description: '判断の基準',
          descriptionFreshness: { kind: 'fresh' },
          createdAt: { kind: 'known', at: '2026-08-10T00:00:00.000Z' },
          updatedAt: '2026-08-15T00:00:00.000Z',
        },
      ],
    });

    await runSlashCommand('/memory', client, emptyListed());

    const text = read();
    expect(text).toContain('values');
    expect(text).toContain('価値観');
    // `alteroid memory list`（`memory.ts`）と同じ形。新しい言い方を発明しない。
    expect(text).toContain('作成: 2026-08-10T00:00:00.000Z / 更新: 2026-08-15T00:00:00.000Z');
    expect(text).toContain('判断の基準');
  });

  it('createdAt が unknown なら「不明」と出す（空欄にしない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      memoryDocuments: [
        {
          slug: 'runbook',
          title: '定点観測',
          kind: 'fact',
          descriptionFreshness: { kind: 'absent' },
          createdAt: { kind: 'unknown' },
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      ],
    });

    await runSlashCommand('/memory', client, emptyListed());

    const text = read();
    expect(text).toContain('作成: 不明 / 更新: 2026-08-12T00:00:00.000Z');
    expect(text).not.toContain('undefined');
  });

  it('記憶がまだ空なら、そう言う（既存の挙動を壊さない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({ memoryDocuments: [] });

    await runSlashCommand('/memory', client, emptyListed());

    expect(read()).toContain('記憶はまだ空');
  });
});

/**
 * `chat` の `/journal`。全 variant が `id` を持つのに、一覧では1度も
 * 出ていなかった。日誌の1件を後から名指しで辿る手がかりが無かった。
 */
describe('chat の /journal', () => {
  it('id を出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      journalEntries: [
        { id: 'j-1', at: '2026-08-16T10:00:00.000Z', type: 'exchange', text: '設計の相談' },
      ],
    });

    await runSlashCommand('/journal', client, emptyListed());

    const text = read();
    expect(text).toContain('設計の相談');
    expect(text).toContain('id: j-1');
  });

  it('空なら、そう言う（既存の挙動を壊さない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal', client, emptyListed());

    expect(read()).toContain('日誌はまだ空');
  });

  /**
   * `q=`（本文を語で探す。issue #250）。**サーバへ投げる** —— 画面側・CLI 側で
   * 捨てると「出していないだけ」の層ができる（`journal.tsx` の逐語と同じ判断）。
   */
  it('q= をそのまま GET /journal のクエリへ渡す', async () => {
    captureStdout();
    const { calls, client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal q=トマト', client, emptyListed());

    expect(calls).toEqual([
      { route: 'GET /journal', args: { query: { limit: '20', q: 'トマト' } } },
    ]);
  });

  /**
   * **`q=` は行末までを1つの語として取る**（`parseJournalSearchTokens`）。
   * 行は空白で割られてから渡ってくるので、ここを詰めないと空白を含む語で
   * 探せない（＝「語で探す」口として使いものにならない）。
   */
  it('q= の値に空白が含まれていても1つの語として渡す', async () => {
    captureStdout();
    const { calls, client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal q=トマト の 水やり', client, emptyListed());

    expect(calls).toEqual([
      { route: 'GET /journal', args: { query: { limit: '20', q: 'トマト の 水やり' } } },
    ]);
  });

  it('件数と q= を併用できる（件数は従来どおり位置引数）', async () => {
    captureStdout();
    const { calls, client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal 50 q=トマト', client, emptyListed());

    expect(calls).toEqual([
      { route: 'GET /journal', args: { query: { limit: '50', q: 'トマト' } } },
    ]);
  });

  it('q= を渡さない既存の呼びは1文字も変わらない', async () => {
    captureStdout();
    const { calls, client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal 5', client, emptyListed());

    expect(calls).toEqual([{ route: 'GET /journal', args: { query: { limit: '5' } } }]);
  });

  /**
   * **0件のとき「無い」で終わらせない。** `q` の照合対象に入っていない欄
   * （`tool_use` の `input` 等）が在るので、黙ると「日誌にその語は無い」と
   * 読める（AGENTS.md「静かに失敗する道具」）。
   */
  it('q= で0件なら、探す対象に入っていない欄が在ることまで言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal q=ナス', client, emptyListed());

    const text = read();
    expect(text).toContain('「ナス」に当たる日誌はありません');
    expect(text).toContain('tool_use の input');
    expect(text).not.toContain('日誌はまだ空');
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

  /**
   * `/managers` の番号でも指せる（#336）。既存の「id を直接書く」使い方
   * （上のテスト群）は壊していないことも、この block 全体が裏取りしている。
   */
  it('/managers の番号でも指せる（既存の id 直書きは壊れていない）', async () => {
    const { calls, client } = stubClient();
    const listed: Listed = { ...emptyListed(), managers: ['mgr-a', 'mgr-b'] };
    captureStdout();

    await runSlashCommand('/stop 2', client, listed);

    expect(calls).toEqual([
      { route: 'DELETE /managers/:id', args: { param: { id: 'mgr-b' }, json: {} } },
    ]);
  });
});

/**
 * chat から会話の履歴へ到達できること（`GET /conversations` /
 * `GET /conversations/:id`）。Web はどちらも使っているのに、CLI からは
 * 0件だった（`apps/cli/src` に `conversations` という文字列が無かった）。
 *
 * **黙って打ち切らないこと自体を確かめる。** `scanned` は常に出す必要があり、
 * `reachedStart` が偽なら「無い」ではなく「判定できない」と言う必要がある。
 */
describe('chat の /conversations と /conversation', () => {
  it('/conversations は一覧と、遡った件数（scanned）を出す', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({
      conversations: [
        {
          conversationId: 'conv-1',
          startedAt: '2026-08-16T10:00:00.000Z',
          updatedAt: '2026-08-16T10:05:00.000Z',
          messages: 4,
          preview: '設計の相談',
        },
      ],
      conversationsScanned: 137,
    });

    await runSlashCommand('/conversations', client, emptyListed());

    expect(calls).toEqual([{ route: 'GET /conversations', args: { query: {} } }]);
    const text = read();
    expect(text).toContain('conv-1');
    expect(text).toContain('設計の相談');
    // #214: 作成（startedAt）は元から応答に在り、ここが出していなかっただけ。
    expect(text).toContain('作成: 2026-08-16T10:00:00.000Z');
    expect(text).toContain('更新: 2026-08-16T10:05:00.000Z');
    // scanned が無いと、返ってきた件数が「これで全部」に見えてしまう。
    expect(text).toContain('137');
    expect(text).toContain('/conversation <番号|id>');
    // 打ち切られているかもしれないなら、広げる手の在り処（サブコマンド面）を示す。
    expect(text).toContain('alteroid conversations list --scan');
    expect(text).toContain('--limit');
    // **不在の側を必ず測る。** `reachedStart: true` / `hiddenByLimit: 0`
    // （既定）のときに断り書きが出ていたら、常時出ている注意書きになって
    // 意味が消える（#418 の裏返し）。
    expect(text).not.toContain('先頭には届いていない');
    expect(text).not.toContain('…ほか');
  });

  /**
   * **#418 の裏返し。** `GET /conversations` は `scan` の窓に加えて `limit`
   * でも黙って会話数を切っていた（画面・CLI どちらも言っていなかった）。
   * `reachedStart` は窓が先頭に届いたか、`hiddenByLimit` は窓の中で `limit`
   * に収まらず落とした数——サーバとクローンの道具（`conversation_read` の
   * `hiddenByLimit`）は既に言っているので、chat 側だけが黙っていると端末
   * では気づけない。
   */
  it('/conversations は reachedStart が偽なら、先頭に届いていないと言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      conversations: [
        {
          conversationId: 'conv-1',
          startedAt: '2026-08-16T10:00:00.000Z',
          updatedAt: '2026-08-16T10:05:00.000Z',
          messages: 4,
          preview: '設計の相談',
        },
      ],
      conversationsScanned: 2000,
      conversationsReachedStart: false,
    });

    await runSlashCommand('/conversations', client, emptyListed());

    const text = read();
    expect(text).toContain('先頭には届いていない');
    // hiddenByLimit は既定の0なので、こちらは出ない（2つは別の条件）。
    expect(text).not.toContain('…ほか');
  });

  it('/conversations は hiddenByLimit が正なら、省いた件数を言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      conversations: [
        {
          conversationId: 'conv-1',
          startedAt: '2026-08-16T10:00:00.000Z',
          updatedAt: '2026-08-16T10:05:00.000Z',
          messages: 4,
          preview: '設計の相談',
        },
      ],
      conversationsScanned: 137,
      conversationsHiddenByLimit: 3,
    });

    await runSlashCommand('/conversations', client, emptyListed());

    const text = read();
    expect(text).toContain('…ほか 3 件は省略');
    expect(text).toContain('limit=<N> を増やせば');
    // reachedStart は既定の真なので、こちらは出ない（2つは別の条件）。
    expect(text).not.toContain('先頭には届いていない');
  });

  it('/conversations は空でも、そう言う（黙って何も出さない形にしない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({ conversations: [], conversationsScanned: 5000 });

    await runSlashCommand('/conversations', client, emptyListed());

    const text = read();
    expect(text).toContain('会話はまだありません');
    // **0件でも scanned を出す。** ここで打ち切ると「本当に無い」のか「窓の外に
    // 残っている（判定できない）」のかが人間から区別できなくなる（#108 / #109
    // が塞いだ「黙って打ち切る」の再導入）。サブコマンド面（`conversations.ts`
    // の `renderConversationsList`）は0件でも scanned を出しており、chat 側
    // だけ省くと同じ CLI の中に非対称ができる。
    expect(text).toContain('5000');
    expect(text).toContain('判定できません');
    // **0件のときも、広げる手の在り処を示す。** 手そのものは chat に無くて
    // よいが、在り処が分からないと、人間は広げる必要があることにすら気づけない。
    expect(text).toContain('alteroid conversations list --scan');
  });

  /**
   * **chat からも窓を広げられる。** `/usage from=… to=…` と同じ `key=value` の
   * 形（`parseUsageFilters` と同じ慣習）で `limit=` / `scan=` を渡せるように
   * してある。サブコマンド面（`alteroid conversations list --limit --scan`）の
   * 下位互換ではなく、chat からも同じクエリへ届く。
   */
  it('/conversations は limit= / scan= を渡すと、そのままクエリへ乗る', async () => {
    captureStdout();
    const { calls, client } = stubClient({ conversations: [], conversationsScanned: 0 });

    await runSlashCommand('/conversations limit=5 scan=9000', client, emptyListed());

    expect(calls).toEqual([
      { route: 'GET /conversations', args: { query: { limit: '5', scan: '9000' } } },
    ]);
  });

  it('/conversation は scan= を渡すと、そのままクエリへ乗る', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/conversation conv-xyz scan=9000', client, emptyListed());

    const detail = calls.find((call) => call.route === 'GET /conversations/:id');
    expect(detail?.args).toEqual({ param: { id: 'conv-xyz' }, query: { scan: '9000' } });
  });

  it('/conversation は番号を id へ引き直す（/conversations の並びと同じ列で覚える）', async () => {
    captureStdout();
    const { calls, client } = stubClient({
      conversations: [
        {
          conversationId: 'conv-a',
          startedAt: '2026-08-16T10:00:00.000Z',
          updatedAt: '2026-08-16T10:05:00.000Z',
          messages: 1,
          preview: '1本目',
        },
        {
          conversationId: 'conv-b',
          startedAt: '2026-08-17T10:00:00.000Z',
          updatedAt: '2026-08-17T10:05:00.000Z',
          messages: 1,
          preview: '2本目',
        },
      ],
    });
    const listed = emptyListed();

    await runSlashCommand('/conversations', client, listed);
    await runSlashCommand('/conversation 2', client, listed);

    const detail = calls.find((call) => call.route === 'GET /conversations/:id');
    expect(detail).toBeDefined();
    expect((detail?.args as { param: { id: string } }).param).toEqual({ id: 'conv-b' });
  });

  /**
   * 承認待ち・台帳の番号を会話の番号として引かないこと（`Listed` を別フィールド
   * に分けた理由そのもの — 混ざると人間が見ていないものを読みに行く）。
   */
  it('/conversation は承認待ち・台帳の番号を掴まない（覚え場所が別であること）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed: Listed = {
      approvals: ['approval-1'],
      commitments: ['cmt-1'],
      conversations: [],
      managers: [],
      waiting: [],
    };

    await runSlashCommand('/conversation 1', client, listed);

    expect(calls).toEqual([]);
    expect(read()).toContain('/conversations の一覧にありません');
  });

  it('/conversation は id をそのまま指せる（番号を経由しなくてよい）', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/conversation conv-xyz', client, emptyListed());

    const detail = calls.find((call) => call.route === 'GET /conversations/:id');
    expect((detail?.args as { param: { id: string } }).param).toEqual({ id: 'conv-xyz' });
  });

  it('/conversation は発言を古い順に出し、先頭まで届いたかを言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      conversationDetailBody: {
        conversationId: 'conv-1',
        messages: [
          { id: 'm1', at: '2026-08-16T10:00:00.000Z', role: 'inbound', text: '設計どうする？' },
          { id: 'm2', at: '2026-08-16T10:01:00.000Z', role: 'outbound', text: 'こう考えている' },
        ],
        scanned: 42,
        reachedStart: true,
      },
    });

    await runSlashCommand('/conversation conv-1', client, emptyListed());

    const text = read();
    const human = text.indexOf('設計どうする？');
    const clone = text.indexOf('こう考えている');
    expect(human).toBeGreaterThanOrEqual(0);
    expect(human).toBeLessThan(clone);
    expect(text).toContain('42');
    expect(text).toContain('先頭まで届きました');
  });

  /**
   * **「無い」と「判定できない」を混ぜない。** `messages` が空でも `reachedStart`
   * が偽なら、それは発言が無かったのではなく窓の外にあるかもしれない、である。
   */
  it('/conversation は reachedStart が偽なら「無い」と言わず、判定できないと言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      conversationDetailBody: {
        conversationId: 'conv-1',
        messages: [],
        scanned: 2000,
        reachedStart: false,
      },
    });

    await runSlashCommand('/conversation conv-1', client, emptyListed());

    const text = read();
    expect(text).toContain('判定できません');
    expect(text).not.toContain('発言はありません');
    // **打ち切られているなら、広げる手の在り処を示す。** 文言だけでなく
    // `--scan` とサブコマンド名（`alteroid conversations show`）が実際に
    // 出ることまで見る — でないと在り処が消えても緑のまま通ってしまう。
    expect(text).toContain('alteroid conversations show --scan');
  });

  it('/conversation は 404（遡り切れたうえで無い）なら、そう言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      conversationDetailStatus: 404,
      conversationDetailBody: undefined,
    });

    await runSlashCommand('/conversation conv-missing', client, emptyListed());

    expect(read()).toContain('そんな会話はありません: conv-missing');
  });

  it('/conversation は id が無ければ使い方を出す', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/conversation', client, emptyListed());

    expect(calls).toEqual([]);
    expect(read()).toContain('使い方: /conversation');
  });

  it('/help に両方載っている（入口の等価性）', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    const text = read();
    expect(text).toContain('/conversations');
    expect(text).toContain('/conversation <番号|id>');
  });
});

/**
 * `/managers` の一覧に番号を振る（#336）。`/manager` `/stop` `/msg` がこの
 * 並びを引く。`/waiting` の並びとは独立の連番であること（`Listed` を
 * `managers` / `waiting` の別フィールドに分けた理由そのもの）も、ここと
 * `/reply` の該当テストの両方で裏取りする。
 */
describe('chat の /managers（番号付き一覧）', () => {
  it('一覧に番号を振り、listed.managers を積む', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      managers: [manager({ managerId: 'mgr-a' }), manager({ managerId: 'mgr-b' })],
    });
    const listed = emptyListed();

    await runSlashCommand('/managers', client, listed);

    const text = read();
    expect(text).toContain('[1] mgr-a');
    expect(text).toContain('[2] mgr-b');
    expect(listed.managers).toEqual(['mgr-a', 'mgr-b']);
  });

  /**
   * **`/managers` の番号は `/waiting` の番号と混ざらない。** `listed.managers`
   * に値が在っても、`/reply` `/allow` `/deny` はそれを見ない（`listed.waiting`
   * だけを引く）——1本にまとめていたら、ここでマネージャーの id が requestId
   * として送られてしまう。
   */
  it('/managers の直後に /reply 1 を打っても、マネージャーの id が requestId として使われない', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed: Listed = { ...emptyListed(), managers: ['mgr-a', 'mgr-b'] };

    await runSlashCommand('/reply 1 わかりました', client, listed);

    expect(calls.filter((call) => call.route === 'POST /managers/:id/messages')).toEqual([]);
    expect(read()).toContain('/waiting の一覧にありません');
  });

  /**
   * 上のテストは `listed` を直接組み立てるので、`/managers` の実装（番号を
   * 振る側）を1バイトも通らない——番号の置き場を混ぜる変異を `/managers` の
   * 中に仕込んでも、このテストだけでは検出できない（実測、変異試験で確認
   * 済み）。**`/managers` を実際に呼んで、その結果 `listed.waiting` が
   * 触られていないことまで確かめる。**
   */
  it('/managers を実際に呼んでも、listed.waiting は書き換わらない', async () => {
    captureStdout();
    const { client } = stubClient({
      managers: [manager({ managerId: 'mgr-a' }), manager({ managerId: 'mgr-b' })],
    });
    const listed = emptyListed();

    await runSlashCommand('/managers', client, listed);

    expect(listed.waiting).toEqual([]);
  });
});

/**
 * マネージャーの返事待ち一覧。`/approvals` のマネージャー版（#336）。
 */
describe('chat の /waiting', () => {
  it('複数マネージャーの待ちを1つの連番にし、kind と askedAt を出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      managers: [
        manager({
          managerId: 'mgr-a',
          waiting: [
            waitingItem({
              requestId: 'req-a',
              kind: 'question',
              askedAt: '2026-08-20T01:00:00.000Z',
              summary: '質問A',
            }),
          ],
        }),
        manager({
          managerId: 'mgr-b',
          waiting: [waitingItem({ requestId: 'req-b', kind: 'permission', summary: '許可B' })],
        }),
      ],
    });
    const listed = emptyListed();

    await runSlashCommand('/waiting', client, listed);

    const text = read();
    expect(text).toContain('[1]');
    expect(text).toContain('[2]');
    expect(text).toContain('質問');
    expect(text).toContain('実行許可');
    expect(text).toContain('2026-08-20T01:00:00.000Z');
    expect(listed.waiting).toEqual([
      { managerId: 'mgr-a', requestId: 'req-a' },
      { managerId: 'mgr-b', requestId: 'req-b' },
    ]);
  });

  it('返事待ちが無ければ、そう言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({ managers: [manager({ waiting: [] })] });

    await runSlashCommand('/waiting', client, emptyListed());

    expect(read()).toContain('返事待ちのマネージャーはいません');
  });

  /**
   * **版のずれの窓でも人間の手が残ること。** `kind` も `askedAt` も持たない
   * 待ちが混じっていても、番号は振られ、その番号で `/reply` が答えられる。
   */
  it('kind も askedAt も無い待ちにも番号が振られ、/reply で答えられる', async () => {
    const { calls, client } = stubClient({
      managers: [manager({ managerId: 'mgr-legacy', waiting: [legacyWaiting()] })],
    });
    const listed = emptyListed();
    captureStdout();

    await runSlashCommand('/waiting', client, listed);
    expect(listed.waiting).toEqual([{ managerId: 'mgr-legacy', requestId: 'req-legacy' }]);

    await runSlashCommand('/reply 1 了解しました', client, listed);
    const sent = calls.find((call) => call.route === 'POST /managers/:id/messages');
    expect(sent?.args).toEqual({
      param: { id: 'mgr-legacy' },
      json: { text: '了解しました', requestId: 'req-legacy' },
    });
  });
});

/**
 * 追加指示。**質問への回答（`/reply`）とは別のコマンドである。**
 *
 * `requestId` も `decision` も付けない——これが無いと、マネージャーが確認を
 * 待っているときに追加指示が回答として消費されてしまい、#313 と同じ形の
 * 穴が CLI に開く（`packages/core/src/manager.ts` の `send` の doc）。
 */
describe('chat の /msg（追加指示）', () => {
  it('requestId も decision も送らない', async () => {
    const { calls, client } = stubClient();
    const listed: Listed = { ...emptyListed(), managers: ['mgr-a'] };
    captureStdout();

    await runSlashCommand('/msg 1 明日までに終わらせて', client, listed);

    expect(calls).toEqual([
      {
        route: 'POST /managers/:id/messages',
        args: { param: { id: 'mgr-a' }, json: { text: '明日までに終わらせて' } },
      },
    ]);
  });

  it('/managers の番号でも id 直書きでも指せる', async () => {
    const { calls, client } = stubClient();
    captureStdout();

    await runSlashCommand('/msg mgr-raw 直接 id を書いた', client, emptyListed());

    expect(calls[0]?.args).toEqual({
      param: { id: 'mgr-raw' },
      json: { text: '直接 id を書いた' },
    });
  });

  it('本文が無ければ何も送らず、使い方を出す', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/msg 1', client, emptyListed());

    expect(calls).toEqual([]);
    expect(read()).toContain('使い方: /msg');
  });
});

/**
 * マネージャーの質問（`AskUserQuestion`）に、人間が自分の言葉で答える。
 * `requestId` だけを添え、`decision` は付けない（質問には許可/拒否の意思が
 * 無い——`apps/web` の `QuestionWaitingRow` と同じ約束）。
 */
describe('chat の /reply（質問への回答）', () => {
  it('requestId を添えて送り、decision を送らない', async () => {
    const { calls, client } = stubClient();
    const listed: Listed = {
      ...emptyListed(),
      waiting: [{ managerId: 'mgr-a', requestId: 'req-1' }],
    };
    captureStdout();

    await runSlashCommand('/reply 1 明日で大丈夫です', client, listed);

    expect(calls).toEqual([
      {
        route: 'POST /managers/:id/messages',
        args: {
          param: { id: 'mgr-a' },
          json: { text: '明日で大丈夫です', requestId: 'req-1' },
        },
      },
    ]);
  });

  it('/waiting を先に打っていなくても、生の requestId で宛先を引ける', async () => {
    const { calls, client } = stubClient({
      managers: [manager({ managerId: 'mgr-z', waiting: [waitingItem({ requestId: 'req-z' })] })],
    });
    const listed = emptyListed();
    captureStdout();

    await runSlashCommand('/reply req-z 了解です', client, listed);

    const sent = calls.find((call) => call.route === 'POST /managers/:id/messages');
    expect(sent?.args).toEqual({
      param: { id: 'mgr-z' },
      json: { text: '了解です', requestId: 'req-z' },
    });
    expect(calls.some((call) => call.route === 'GET /managers')).toBe(true);
  });

  /**
   * **推測しない。** 同じ `requestId` を複数のマネージャーが持つことは、
   * `requestId` が SDK 側の識別子である以上、原理的には否定できない
   * （`AGENTS.md`「踏みやすい地雷」）。見つかったものが2件以上なら、
   * どちらへも送らず両方の `managerId` を出す。
   */
  it('同じ requestId を2本のマネージャーが待っていたら、どちらへも送らない', async () => {
    const { calls, client } = stubClient({
      managers: [
        manager({ managerId: 'mgr-a', waiting: [waitingItem({ requestId: 'req-dup' })] }),
        manager({ managerId: 'mgr-b', waiting: [waitingItem({ requestId: 'req-dup' })] }),
      ],
    });
    const listed = emptyListed();
    const read = captureStdout();

    await runSlashCommand('/reply req-dup 許可します', client, listed);

    expect(calls.filter((call) => call.route === 'POST /managers/:id/messages')).toEqual([]);
    const text = read();
    expect(text).toContain('mgr-a');
    expect(text).toContain('mgr-b');
  });

  it('待っているマネージャーが居なければ、そう言う（推測しない）', async () => {
    const { calls, client } = stubClient({ managers: [] });
    const read = captureStdout();

    await runSlashCommand('/reply req-none 了解', client, emptyListed());

    expect(calls.filter((call) => call.route === 'POST /managers/:id/messages')).toEqual([]);
    expect(read()).toContain('待っているマネージャーは居ません');
  });
});

/**
 * 実行許可の確認に答える。`decision`（`allow`/`deny`）を添える点が `/reply`
 * との違いで、`/reply` `/allow` `/deny` は宛先の解決（`/waiting` の番号・
 * 生の requestId）を共有している。
 */
describe('chat の /allow /deny（実行許可への回答）', () => {
  it('/allow は decision: allow を、理由省略時は既定の文言で送る', async () => {
    const { calls, client } = stubClient();
    const listed: Listed = {
      ...emptyListed(),
      waiting: [{ managerId: 'mgr-a', requestId: 'req-1' }],
    };
    captureStdout();

    await runSlashCommand('/allow 1', client, listed);

    expect(calls).toEqual([
      {
        route: 'POST /managers/:id/messages',
        args: {
          param: { id: 'mgr-a' },
          json: { text: '許可する', requestId: 'req-1', decision: 'allow' },
        },
      },
    ]);
  });

  it('/deny は decision: deny を、書いた理由をそのまま添えて送る', async () => {
    const { calls, client } = stubClient();
    const listed: Listed = {
      ...emptyListed(),
      waiting: [{ managerId: 'mgr-a', requestId: 'req-1' }],
    };
    captureStdout();

    await runSlashCommand('/deny 1 危険な操作なので', client, listed);

    expect(calls).toEqual([
      {
        route: 'POST /managers/:id/messages',
        args: {
          param: { id: 'mgr-a' },
          json: { text: '危険な操作なので', requestId: 'req-1', decision: 'deny' },
        },
      },
    ]);
  });

  /**
   * **宛先を書かずに decision だけ送る形。** `managerId` は URL が要求する
   * ので完全な省略はできないが、CLI 側で候補を絞らない——返事待ちの
   * マネージャーが1本だけなら、その1本へ decision だけを渡す（requestId は
   * 付けない。デーモンの `#choosePending` がその1本の中で解く）。
   */
  it('引数なしで、返事待ちが1本だけなら decision だけを送る（requestId は付けない）', async () => {
    const { calls, client } = stubClient({
      managers: [
        manager({ managerId: 'mgr-solo', waiting: [waitingItem({ requestId: 'req-solo' })] }),
      ],
    });
    const listed = emptyListed();
    captureStdout();

    await runSlashCommand('/allow', client, listed);

    expect(calls.filter((call) => call.route === 'POST /managers/:id/messages')).toEqual([
      {
        route: 'POST /managers/:id/messages',
        args: { param: { id: 'mgr-solo' }, json: { text: '許可する', decision: 'allow' } },
      },
    ]);
  });

  it('引数なしで返事待ちのマネージャーが2本以上なら、どちらへも送らない', async () => {
    const { calls, client } = stubClient({
      managers: [
        manager({ managerId: 'mgr-a', waiting: [waitingItem({ requestId: 'req-a' })] }),
        manager({ managerId: 'mgr-b', waiting: [waitingItem({ requestId: 'req-b' })] }),
      ],
    });
    const listed = emptyListed();
    const read = captureStdout();

    await runSlashCommand('/allow', client, listed);

    expect(calls.filter((call) => call.route === 'POST /managers/:id/messages')).toEqual([]);
    const text = read();
    expect(text).toContain('mgr-a');
    expect(text).toContain('mgr-b');
  });

  it('/help に /msg /reply /allow /deny /waiting が載っている（隠れた口を作らない）', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    const text = read();
    expect(text).toContain('/msg ');
    expect(text).toContain('/reply ');
    expect(text).toContain('/allow ');
    expect(text).toContain('/deny');
    expect(text).toContain('/waiting');
  });
});

/**
 * **デーモンの heartbeat が `alteroid chat` を壊さないことを固定する。**
 *
 * デーモンは無音死の掃除のため SSE にコメント行（`: hb`）を周期的に流す
 * （`packages/core/src/sse-heartbeat.ts`）。SSE の仕様上クライアントは捨ててよい行で、
 * この CLI は `data:` が1本も無い塊を `null`（読み飛ばし）にすることで捨てている。
 * **「たまたま捨てている」ではなく、捨てることが保証されている状態にする。**
 */
describe('parseSSEChunk', () => {
  it('コメント行だけの塊は読み飛ばす（デーモンの heartbeat を画面に出さない）', () => {
    expect(parseSSEChunk(': hb')).toBeNull();
    // 前後に空行が付いた形でも同じ（`readSSE` の切り方に依らない）
    expect(parseSSEChunk('')).toBeNull();
    expect(parseSSEChunk(':')).toBeNull();
  });

  it('コメント行が同じ塊に混ざっても、イベントの中身を壊さない', () => {
    const parsed = parseSSEChunk(': hb\nevent: text\ndata: {"type":"text","text":"やあ"}');

    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('text');
    expect(parsed?.json<{ text: string }>()?.text).toBe('やあ');
  });

  it('ふつうのイベントはこれまでどおり読める（上の2件が緩めでないことの裏取り）', () => {
    const parsed = parseSSEChunk('event: done\ndata: {"type":"done"}');

    expect(parsed?.name).toBe('done');
    expect(parsed?.json<{ type: string }>()?.type).toBe('done');
  });
});
