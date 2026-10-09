import {
  describeReportDriftMark,
  describeToolUseStall,
  describeTurnEnd,
  describeUnobservedOutcome,
  JOURNAL_ENTRY_TYPES,
  jobStatusSchema,
  USAGE_ESTIMATE_NOTICE,
  usageLayerSchema,
  usageSiteSchema,
  type Commitment,
} from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseSSEChunk,
  renderCommitments,
  renderManagerList,
  renderReport,
  renderReportLine,
  renderWaitingList,
  runSlashCommand,
  sendMessage,
  type Listed,
} from './chat.js';
import { unreadMark } from './conversations.js';
import type { Target } from './target.js';
import { captureStdout } from './test-support.js';

const confirmYes = async (): Promise<boolean> => true;

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

// `as unknown as` / `as any` を使わず、`Partial` から1段の `as` で緩める: 何を緩めたかを型名から読めるようにするため
function legacyWaiting(over: Partial<ManagerWaitingItem> = {}): ManagerWaitingItem {
  const base: Partial<ManagerWaitingItem> = {
    requestId: 'req-legacy',
    summary: '版ずれの窓からの確認',
    ...over,
  };
  return base as ManagerWaitingItem;
}

describe('renderManagerList', () => {
  it('provider の行を出さない（層は常に Claude。2026-10-07 の決定）', () => {
    expect(renderManagerList([manager()])).not.toContain('provider:');
  });

  it('読めない行が在る0件は「居ません」と言わず、居ないとは言えないと言う（#2345）', () => {
    const unreadable = [{ id: 'mgr-bad', reason: '不正な欄: status' }];
    const plain = renderManagerList([], undefined, unreadable);
    expect(plain).not.toBe('（マネージャーは1本も居ません）');
    expect(plain).toBe('（読めたマネージャーは居ません。居ないとは言えません）');
    const filtered = renderManagerList([], 'done', unreadable);
    expect(filtered).toContain('status=done に当たる読めたマネージャーは居ません');
    expect(filtered).toContain('居ないとは言えません');
  });

  it('対照: 読めない行が空配列なら、0件の文言は従来どおり（#2345）', () => {
    expect(renderManagerList([], undefined, [])).toBe('（マネージャーは1本も居ません）');
  });

  it('絞りが無い0件は「（マネージャーは1本も居ません）」のまま（#2203）', () => {
    expect(renderManagerList([])).toBe('（マネージャーは1本も居ません）');
  });

  it('status= を渡した0件は、絞りを名指しする文言になる（#2203）', () => {
    expect(renderManagerList([], 'done')).toBe(
      'status=done に当たるマネージャーは居ません（絞り込みを外せば見えるかもしれません）',
    );
  });

  it('拒否の行に「止められた後に報告が届いたか」を添える（#1455）', () => {
    const text = renderManagerList([
      manager({
        lastReportAt: '2026-09-24T07:10:00.000Z',
        denials: [{ tool: 'Bash', count: 1, lastAt: '2026-09-24T07:00:00.000Z' }],
      }),
    ]);
    expect(text).toContain('後にも報告が届いている（2026-09-24T07:10:00.000Z）');
  });

  it('確認へ上がらず止められた件数を、道具ごとに出す', () => {
    const text = renderManagerList([manager({ denials: [{ tool: 'Bash', count: 3 }] })]);

    expect(text).toContain('確認へ上がらず止められた道具');
    expect(text).toContain('Bash 3件');
    expect(text).toContain('可能性があります');
  });

  it('拒否の出所を断定せず、「まず担い手の拒否文を読ませる」案内と(b)の可能性が載る（#1289）', () => {
    const text = renderManagerList([manager({ denials: [{ tool: 'Bash', count: 1 }] })]);

    expect(text).not.toContain('。手が止まっている可能性があります');

    expect(text).toContain('手が止まっている可能性があります');
    expect(text).toContain('PreToolUse');
    expect(text).toContain('自力で抜けられることがあります');

    const guidanceAt = text.indexOf('まず担い手自身の拒否文を読ませること');
    const branchAAt = text.indexOf('(a) 器の分類器か deny 規則なら');
    expect(guidanceAt).toBeGreaterThan(-1);
    expect(guidanceAt).toBeLessThan(branchAAt);
  });

  it('状態の札は describeManagerState と同じ字面を出す（3値とも）', () => {
    expect(renderManagerList([manager({ status: 'running', live: true })])).toContain('[running]');
    expect(renderManagerList([manager({ status: 'running', live: false })])).toContain(
      '[running/セッション切断]',
    );
    expect(renderManagerList([manager({ status: 'running', live: undefined })])).toContain(
      '[running/セッション不明]',
    );
  });

  it('背景処理の完了待ちも describeManagerState と同じ字面で出す（第3引数を渡している）', () => {
    const text = renderManagerList([
      manager({
        status: 'done',
        live: true,
        awaitingBackground: {
          tasks: 3,
          withheldReports: 1,
          breakdown: 'local_agent×3',
          since: '2026-09-05T00:00:00.000Z',
        },
      }),
    ]);

    expect(text).toContain('[done/背景処理待ち×3（2026-09-05T00:00:00.000Z から）]');
    expect(renderManagerList([manager({ status: 'done', live: true })])).toContain('[done]');
    expect(renderManagerList([manager({ status: 'done', live: true })])).not.toContain(
      '背景処理待ち',
    );
  });

  it('宛先の器が黙っているときは、その判定時刻と「失われたとは限らない」を添える', () => {
    const text = renderManagerList([
      manager({ status: 'running', live: false, runnerLostSince: '2026-08-27T09:00:00.000Z' }),
    ]);

    expect(text).toContain('2026-08-27T09:00:00.000Z 以降 名乗っていない');
    expect(text).toContain('この委譲が失われたという意味ではない');
  });

  it('宛先の器が名簿から消えているときは、その印と「lost ではない」を添える。消えた時刻は出さない（#1212）', () => {
    const text = renderManagerList([
      manager({ status: 'running', live: true, runnerVanished: true }),
    ]);

    expect(text).toContain('宛先の器が名簿から消えている');
    expect(text).toContain('消えた時刻は名簿に残っていないので分からない');
    expect(text).toContain('lost で絞っても出てこない');
  });

  it('宛先の器が名簿から消えているときは、この委譲の走り始めの時刻を添える（core と揃える）', () => {
    const text = renderManagerList([
      manager({
        status: 'running',
        live: true,
        runnerVanished: true,
        startedAt: '2026-08-16T10:00:00.000Z',
      }),
    ]);

    expect(text).toContain('この委譲の走り始めは 2026-08-16T10:00:00.000Z');
  });

  it('宛先の器が名簿から消えていなければ、その行は出さない（#1212）', () => {
    const text = renderManagerList([manager({ status: 'running', live: true })]);

    expect(text).not.toContain('名簿から消えている');
  });

  it('宛先の器が黙っていなければ、その行は出さない', () => {
    const text = renderManagerList([manager({ status: 'running', live: true })]);

    expect(text).not.toContain('名乗っていない');
  });

  // 「話しかけられない」と書かない: lost 扱いの器の委譲にも send() は届くので偽。書き戻すと人間の繋ぎ直す手を塞ぐ誤誘導になる
  it('黙った器の行に「話しかけられない」と書かない（実測で偽）', () => {
    const text = renderManagerList([
      manager({ status: 'running', live: false, runnerLostSince: '2026-08-27T09:00:00.000Z' }),
    ]);

    expect(text).not.toContain('話しかけられない');
    expect(text).not.toContain('外れているので');
    expect(text).toContain('新しい委譲の宛先からは外れている');
  });

  it('黙った器の行は、送信が塞がれていないことと、戻る先が要ることを両方言う', () => {
    const text = renderManagerList([
      manager({ status: 'running', live: false, runnerLostSince: '2026-08-27T09:00:00.000Z' }),
    ]);

    expect(text).toContain('話しかけることは塞いでいない');
    expect(text).toContain('session_id');
    expect(text).toContain('届くとは限らない');
    expect(text).toContain('/msg');
    expect(text).not.toContain('runner_list');
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
    expect(text).toContain('[running]');
    expect(header).toBeLessThan(denial);
    expect(denial).toBeLessThan(waiting);
  });

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

  it('askedAt は ISO をそのまま出し、相対表現を作らない', () => {
    const text = renderManagerList([
      manager({ waiting: [waitingItem({ askedAt: '2026-08-20T01:02:03.000Z' })] }),
    ]);

    expect(text).toContain('2026-08-20T01:02:03.000Z');
    expect(text).not.toMatch(/時間前|分前|日前/);
  });

  it('kind も askedAt も無い待ちが混じっていても落ちず、種別不明として出す', () => {
    const text = renderManagerList([manager({ waiting: [legacyWaiting()] })]);

    expect(text).toContain('返事待ち');
    expect(text).toContain('種別不明');
    expect(text).not.toContain('実行許可');
    expect(text).not.toContain('質問');
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

  it('拒否の層（マネージャー／作業者／層不明）が3値のまま出る', () => {
    const text = renderManagerList([
      manager({
        denials: [
          { tool: 'Bash', count: 2, actor: 'manager' },
          { tool: 'Edit', count: 1, actor: 'worker' },
          { tool: 'Write', count: 3 },
        ],
      }),
    ]);

    expect(text).toContain('Bash 2件 [マネージャー]');
    expect(text).toContain('Edit 1件 [作業者]');
    expect(text).toContain('Write 3件 [層不明]');
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

    expect(text).toContain('Newest 16件');
    expect(text).toContain('Fourth 8件');
    expect(text).toContain('Third 4件');
    expect(text).not.toContain('Oldest');
    expect(text).not.toContain('Second 2件');
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

  it('lost には但し書きを添える（[lost] の札だけで終わらせない）', () => {
    const text = renderManagerList([manager({ status: 'lost', live: false })]);

    expect(text).toContain('[lost');
    expect(text).toContain('⚠');
    expect(text).toContain('前のセッションへ戻れなかった');
  });

  it('lost に「仕事が失われた」と書かない（観測の限界と次の一手を出す）', () => {
    const text = renderManagerList([manager({ status: 'lost', live: false })]);

    expect(text).toContain('見ているのは戻れたかどうかだけ');
    expect(text).toContain('成果が既に外へ出ている');
    expect(text).toMatch(/PR/);
  });

  it('lost 以外には但し書きを出さない', () => {
    for (const status of ['running', 'done', 'failed', 'stopped'] as const) {
      const text = renderManagerList([manager({ status })]);
      expect(text).not.toContain('前のセッションへ戻れなかった');
    }
  });

  it('stopped は done に潰れず、そのまま状態名で出る', () => {
    const stopped = renderManagerList([manager({ status: 'stopped', live: false })]);
    const done = renderManagerList([manager({ status: 'done' })]);

    expect(stopped).toContain('[stopped');
    expect(stopped).not.toContain('[done');
    expect(done).toContain('[done');
    expect(done).not.toContain('[stopped');
  });

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
    expect(text.split('\n')[1]).toContain('cwd:');
  });

  it('作成と更新を出す（別の値で、取り違えでも落ちる形にする）', () => {
    const text = renderManagerList([
      manager({ startedAt: '2026-08-16T10:00:00.000Z', updatedAt: '2026-08-17T09:30:00.000Z' }),
    ]);

    expect(text).toContain('作成: 2026-08-16T10:00:00.000Z  更新: 2026-08-17T09:30:00.000Z');
  });

  describe('直近のターンが失敗で終わったこと', () => {
    const FAILURE = {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-08-20T10:00:00.000Z',
    };

    it('SDK の語と時刻を、状態の札を置き換えずに出す', () => {
      const text = renderManagerList([manager({ status: 'done', lastFailure: FAILURE })]);

      expect(text).toContain('[done]');
      expect(text).toContain('報告ではなく失敗で終わっています');
      expect(text).toContain('billing_error');
      expect(text).toContain('assistant_error');
      expect(text).toContain('2026-08-20T10:00:00.000Z');
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

    describe('Issue #1882: 終端した status では「セッションは生きている」と言わない', () => {
      const ALIVE_CLAIM = '。セッションは生きているので、原因が解ければ話しかければ続きます';

      it('status: running（陽性対照）は文言を1文字も変えない', () => {
        const text = renderManagerList([manager({ status: 'running', lastFailure: FAILURE })]);
        expect(text).toContain(ALIVE_CLAIM);
      });

      it('status: waiting_human（陽性対照）も文言を1文字も変えない', () => {
        const text = renderManagerList([
          manager({ status: 'waiting_human', lastFailure: FAILURE }),
        ]);
        expect(text).toContain(ALIVE_CLAIM);
      });

      it('status: failed では「生きている」と言い切らない', () => {
        const text = renderManagerList([manager({ status: 'failed', lastFailure: FAILURE })]);

        expect(text).toContain('billing_error');
        expect(text).toContain('assistant_error');
        expect(text).toContain('2026-08-20T10:00:00.000Z');
        expect(text).not.toContain(ALIVE_CLAIM);
        expect(text).not.toContain('セッションは生きているので');
        expect(text).toContain('status: failed');
        expect(text).toContain('/msg');
        expect(text).toContain('届く保証は無い');
      });

      it('status: lost では「生きている」と言い切らない', () => {
        const text = renderManagerList([manager({ status: 'lost', lastFailure: FAILURE })]);

        expect(text).not.toContain(ALIVE_CLAIM);
        expect(text).not.toContain('セッションは生きているので');
        expect(text).toContain('status: lost');
        expect(text).toContain('/msg');
        expect(text).toContain('届く保証は無い');
      });

      it('status: stopped では「生きている」と言い切らず、人間・クローンが明示的に止めたと言う', () => {
        const text = renderManagerList([manager({ status: 'stopped', lastFailure: FAILURE })]);

        expect(text).not.toContain(ALIVE_CLAIM);
        expect(text).not.toContain('セッションは生きているので');
        expect(text).toContain('status: stopped');
        expect(text).toContain('人間・クローンが明示的に停止させ');
        expect(text).toContain('/msg');
        expect(text).toContain('届く保証は無い');
      });
    });

    describe('Issue #1882: lastFoldedTurn が在る回は、畳まれる前の古い材料を使わない', () => {
      it('古い lastFailure の注記を出さない（status: stopped）', () => {
        const text = renderManagerList([
          manager({
            status: 'stopped',
            lastFailure: FAILURE,
            lastFoldedTurn: { text: '畳まれた本文', at: '2026-09-01T00:00:00.000Z' },
          }),
        ]);

        expect(text).not.toContain('報告ではなく失敗で終わっています');
        expect(text).not.toContain('セッションは生きているので');
      });

      it('古い lastReport ではなく、畳まれたターンの中身をその受信時刻つきで出す', () => {
        const text = renderManagerList([
          manager({
            status: 'stopped',
            lastReport: '畳まれる前の無関係な古い本文',
            lastFoldedTurn: { text: '停止後に届いた新しい本文', at: '2026-09-01T00:00:00.000Z' },
          }),
        ]);

        expect(text).toContain('停止後に届いた新しい本文');
        expect(text).toContain('2026-09-01T00:00:00.000Z');
        expect(text).not.toContain('畳まれる前の無関係な古い本文');
        expect(text).toContain('畳まれたターンの中身');
      });
    });
  });

  describe('Issue #1883: 枠(利用上限)で止まっている（usageStoppedAt）', () => {
    it('材料が無ければ何も出さない', () => {
      const text = renderManagerList([manager({ status: 'done' })]);
      expect(text).not.toContain('枠(利用上限)');
    });

    it('生きている status（running）は「鍵が回れば続く」と言う', () => {
      const text = renderManagerList([
        manager({ status: 'running', usageStoppedAt: '2026-09-20T00:00:00.000Z' }),
      ]);
      expect(text).toContain('枠(利用上限)で止まっている（2026-09-20T00:00:00.000Z から）');
      expect(text).toContain('鍵が回ればこの委譲は続く');
    });

    it('status: failed では「セッションは生きている」と言い切らない', () => {
      const text = renderManagerList([
        manager({ status: 'failed', usageStoppedAt: '2026-09-20T00:00:00.000Z' }),
      ]);
      expect(text).toContain('status: failed');
      expect(text).not.toContain('セッションは生きているので、鍵が回れば');
      expect(text).toContain('/msg');
      expect(text).toContain('届く保証は無い');
    });

    it('status: lost では「セッションは生きている」と言い切らない', () => {
      const text = renderManagerList([
        manager({ status: 'lost', usageStoppedAt: '2026-09-20T00:00:00.000Z' }),
      ]);
      expect(text).toContain('status: lost');
      expect(text).not.toContain('セッションは生きているので、鍵が回れば');
    });

    it('status: stopped では、人間・クローンが明示的に止めたと言う', () => {
      const text = renderManagerList([
        manager({ status: 'stopped', usageStoppedAt: '2026-09-20T00:00:00.000Z' }),
      ]);
      expect(text).toContain('status: stopped');
      expect(text).toContain('人間・クローンが明示的に停止させ');
      expect(text).not.toContain('セッションは生きているので、鍵が回れば');
    });

    it('status: stopped でも、/msg で resume を試みるしかなく届く保証は無いと言う（core #1904 と揃える）', () => {
      const text = renderManagerList([
        manager({ status: 'stopped', usageStoppedAt: '2026-09-20T00:00:00.000Z' }),
      ]);
      expect(text).toContain('/msg');
      expect(text).toContain('届く保証は無い');
    });
  });

  describe('Issue #1883: セッションが failed で畳まれた落ち方（lastSystemError）', () => {
    const SYSTEM_ERROR = {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'fork',
      at: '2026-09-21T00:00:00.000Z',
    };

    it('status !== failed なら材料があっても出さない', () => {
      const text = renderManagerList([manager({ status: 'done', lastSystemError: SYSTEM_ERROR })]);
      expect(text).not.toContain('器の資源による落ち方');
    });

    it('status: failed かつ材料が在れば code/errno/syscall を出す', () => {
      const text = renderManagerList([
        manager({ status: 'failed', lastSystemError: SYSTEM_ERROR }),
      ]);
      expect(text).toContain('器の資源による落ち方で畳まれた可能性');
      expect(text).toContain('code=EAGAIN');
      expect(text).toContain('errno=-11');
      expect(text).toContain('syscall=fork');
      expect(text).toContain('2026-09-21T00:00:00.000Z');
    });

    it('status: failed だが材料が無ければ「判定できなかった」と言う', () => {
      const text = renderManagerList([manager({ status: 'failed' })]);
      expect(text).toContain('セッションは失敗で畳まれた');
      expect(text).toContain('判定できなかった');
    });
  });

  describe('Issue #1883: cgroup の pids/OOM カウンタ（lastCgroupEvents）', () => {
    it('status !== failed なら材料があっても出さない', () => {
      const text = renderManagerList([
        manager({
          status: 'done',
          lastCgroupEvents: { pidsMaxDelta: 3, oomKillDelta: 0, at: '2026-09-22T00:00:00.000Z' },
        }),
      ]);
      expect(text).not.toContain('pids 上限');
    });

    it('status: failed かつ材料が在れば回数を出す', () => {
      const text = renderManagerList([
        manager({
          status: 'failed',
          lastCgroupEvents: { pidsMaxDelta: 3, oomKillDelta: 1, at: '2026-09-22T00:00:00.000Z' },
        }),
      ]);
      expect(text).toContain('fork が pids 上限により 3 回断られた');
      expect(text).toContain('OOM kill が 1 回あった');
      expect(text).toContain('2026-09-22T00:00:00.000Z');
    });

    it('status: failed だが材料が無ければ「判定できなかった」と言う', () => {
      const text = renderManagerList([manager({ status: 'failed' })]);
      expect(text).toContain('OOM kill が起きたかは、この欄では判定できなかった');
    });
  });

  describe('Issue #2428: manager_list と同じ ⚠（ターン終了・道具の応答待ち・畳まれた回）', () => {
    const stalledTurnEnd = manager({
      lastReport: '途中経過',
      lastReportAt: '2026-09-30T00:00:00.000Z',
      turnEndReason: 'end_turn',
      turnEndedAt: '2026-09-30T00:10:00.000Z',
    });

    it('turnEndedAt が lastReportAt より新しければ、manager_list と同じ字面の ⚠ を出す', () => {
      const expected = describeTurnEnd(stalledTurnEnd);
      expect(expected).not.toBeNull();
      const text = renderManagerList([stalledTurnEnd]);
      expect(text).toContain(expected?.trimStart());
      expect(text).toContain(
        '⚠ ターンは 2026-09-30T00:10:00.000Z に end_turn で終わっているが、報告がまだ届いていない。',
      );
    });

    it('ターン終了の ⚠ は、直近の報告の行より後に出る', () => {
      const text = renderManagerList([stalledTurnEnd]);
      expect(text).toContain('直近の報告: 途中経過');
      expect(text).toContain('⚠ ターンは');
      expect(text.indexOf('直近の報告')).toBeLessThan(text.indexOf('⚠ ターンは'));
    });

    it('報告のほうが新しければ（正常な待機）出さない', () => {
      const text = renderManagerList([
        manager({
          lastReport: '報告',
          lastReportAt: '2026-09-30T00:20:00.000Z',
          turnEndReason: 'end_turn',
          turnEndedAt: '2026-09-30T00:10:00.000Z',
        }),
      ]);
      expect(text).not.toContain('ターンは');
    });

    it('デーモンが答える道具の応答待ちで waiting が空なら、manager_list と同じ字面の ⚠ を出す', () => {
      const stalled = manager({
        toolUseStallAt: '2026-09-30T00:00:00.000Z',
        toolUseStallPending: [{ id: 'toolu_1', name: 'AskUserQuestion' }],
      });
      const expected = describeToolUseStall(stalled);
      expect(expected).toContain('⚠ 道具の応答待ちのまま、誰もその応答を待っていない（矛盾）。');
      const text = renderManagerList([stalled]);
      expect(text).toContain(expected?.trimStart());
      expect(text).toContain('未応答の道具: AskUserQuestion(toolu_1)');
    });

    it('ふつうの道具を実行中なだけなら ⚠ ではなく「実行中」の注記になる', () => {
      const text = renderManagerList([
        manager({ toolUseStallPending: [{ id: 'toolu_2', name: 'Bash' }] }),
      ]);
      expect(text).toContain('道具を実行中（矛盾ではない。Issue #2173）');
      expect(text).not.toContain('⚠ 道具の応答待ち');
    });

    it('欄が無い（古い daemon）なら、何も出さない・0 も「無い」も書かない', () => {
      const text = renderManagerList([manager()]);
      expect(text).not.toContain('ターンは');
      expect(text).not.toContain('道具');
      expect(text).not.toContain('turnEnd');
      expect(text).not.toContain('toolUseStall');
    });

    it('lastUnreported が在る回は「直近の報告」ではなく「直近のターンの中身」と呼ぶ', () => {
      const text = renderManagerList([
        manager({
          lastReport: '（このターンは結果を受け取らないまま畳まれた: 途中）',
          lastUnreported: { at: '2026-09-30T00:00:00.000Z', reason: 'no-result' },
        } as Partial<ManagerListItem>),
      ]);
      expect(text).toContain('直近のターンの中身:');
      expect(text).not.toContain('直近の報告:');
    });

    it('lost は manager_list と同じ unobservedOutcome の行を出す', () => {
      const lost = manager({ status: 'lost', live: false });
      const expected = describeUnobservedOutcome(lost);
      expect(expected).not.toBeNull();
      expect(renderManagerList([lost])).toContain(expected);
    });
  });

  describe('Issue #2432: manager_list と同じ ⚠ status 食い違い（lastReportStatus）', () => {
    const now = new Date('2026-09-30T01:00:00.000Z');
    const drifted = manager({
      status: 'running',
      lastReport: '途中経過',
      lastReportAt: '2026-09-30T00:00:00.000Z',
      lastReportStatus: 'waiting_human',
    });

    it('報告が名乗った status と今の status が違えば、core の関数の戻り値と同じ印を出す', () => {
      const expected = describeReportDriftMark(drifted, now);
      expect(expected).toBe('⚠ status 食い違い（manager_report で詳細）');
      const text = renderManagerList([drifted], undefined, [], now);
      expect(text).toContain(expected);
    });

    it('印は直近の報告の行より後に出る', () => {
      const text = renderManagerList([drifted], undefined, [], now);
      expect(text).toContain('直近の報告: 途中経過');
      expect(text).toContain('⚠ status 食い違い');
      expect(text.indexOf('直近の報告')).toBeLessThan(text.indexOf('⚠ status 食い違い'));
    });

    it('食い違いが無ければ出さない', () => {
      const text = renderManagerList(
        [manager({ ...drifted, lastReportStatus: 'running' })],
        undefined,
        [],
        now,
      );
      expect(text).not.toContain('status 食い違い');
    });

    it('欄が無い（古い daemon）なら、何も出さない・0 も「無い」も書かない', () => {
      const text = renderManagerList(
        [manager({ lastReport: '途中経過', lastReportAt: '2026-09-30T00:00:00.000Z' })],
        undefined,
        [],
        now,
      );
      expect(text).not.toContain('食い違い');
      expect(text).not.toContain('lastReportStatus');
    });
  });

  describe('Issue #1883: 認証トークンの世代が分からない理由（tokenGenerationUnknownReason）', () => {
    it('材料が無ければ何も出さない', () => {
      const text = renderManagerList([manager({ status: 'running' })]);
      expect(text).not.toContain('認証トークンの世代');
    });

    it('pool-not-wired: 「このデプロイが配線していない」と言う', () => {
      const text = renderManagerList([
        manager({ status: 'running', tokenGenerationUnknownReason: 'pool-not-wired' }),
      ]);
      expect(text).toContain('このデプロイは認証トークンの世代そのものを配線していない構成');
    });

    it('not-yet-observed: 「いま何もしなくてよい」と言う', () => {
      const text = renderManagerList([
        manager({ status: 'running', tokenGenerationUnknownReason: 'not-yet-observed' }),
      ]);
      expect(text).toContain('いま何もしなくてよい');
    });

    it('reattached-across-restart: 起こし直す前にリモートを確かめるよう言い、会話以外も失われうると言う', () => {
      const text = renderManagerList([
        manager({ status: 'running', tokenGenerationUnknownReason: 'reattached-across-restart' }),
      ]);
      expect(text).toContain('デーモンの再起動をまたいで');
      expect(text).toContain(
        'まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること',
      );
      expect(text).toContain('失われるのは会話だけではない');
      // `STALE_TOKEN_RESTART_ADVICE` の逐語は生成元の外では禁止（`pnpm check:stale-token-restart-advice`）なので、CLI は言い換える
      expect(text).not.toContain('manager_start');
      expect(text).toContain('/msg');
    });

    it('生の世代番号（tokenGeneration / activeTokenGeneration）は出さない', () => {
      const text = renderManagerList([
        manager({ status: 'running', tokenGeneration: 5, activeTokenGeneration: 7 }),
      ]);
      expect(text).not.toContain('認証トークンの世代: 5');
      expect(text).not.toContain('世代 5');
      expect(text).not.toContain('世代 7');
    });
  });

  describe('Issue #1883: 429の世代ずれ判定（resetTimeSkewMatch）', () => {
    it('材料が無ければ何も出さない', () => {
      const text = renderManagerList([manager({ status: 'running' })]);
      expect(text).not.toContain('世代ずれ');
    });

    it('active: 「世代ずれではなく、待てば戻る」と言う', () => {
      const text = renderManagerList([
        manager({ status: 'running', resetTimeSkewMatch: 'active' }),
      ]);
      expect(text).toContain('世代ずれではなく、待てば戻る');
    });

    it('stale: 起こし直す前にリモートを確かめるよう言い、会話以外も失われうると言う', () => {
      const text = renderManagerList([manager({ status: 'running', resetTimeSkewMatch: 'stale' })]);
      expect(text).toContain('世代ずれの疑い');
      expect(text).toContain(
        'まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること',
      );
      expect(text).toContain('失われるのは会話だけではない');
      expect(text).not.toContain('manager_start');
    });

    it('stale かつ未push観測が在れば、それも合わせて見るよう添える', () => {
      const text = renderManagerList([
        manager({
          status: 'running',
          resetTimeSkewMatch: 'stale',
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-23T00:00:00.000Z',
            cwd: '/workspace',
            worktrees: [{ relativePath: 'repo', branch: 'fix/123' }],
          },
        }),
      ]);
      expect(text).toContain('下の「未push観測」にも最後の観測が出ている');
    });

    it('未知の値（版のずれ）でも落ちず、そのまま名乗る', () => {
      const text = renderManagerList([
        manager({
          status: 'running',
          resetTimeSkewMatch: 'future-value' as unknown as ManagerListItem['resetTimeSkewMatch'],
        }),
      ]);
      expect(text).toContain('この一覧が知らない値');
      expect(text).toContain('future-value');
    });
  });

  describe('Issue #1883: 未push観測（lastUnpushedWorkObservation）', () => {
    it('材料が無ければ何も出さない', () => {
      const text = renderManagerList([manager({ status: 'running' })]);
      expect(text).not.toContain('未push観測');
    });

    it('observed: 見つかった作業ツリーと枝名を出す', () => {
      const text = renderManagerList([
        manager({
          status: 'done',
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-24T00:00:00.000Z',
            cwd: '/workspace',
            worktrees: [{ relativePath: 'repo', branch: 'fix/123' }],
          },
        }),
      ]);
      expect(text).toContain('未push観測');
      expect(text).toContain('repo: branch=fix/123');
      expect(text).toContain('2026-09-24T00:00:00.000Z');
      expect(text).toContain('いまの状態ではない');
    });

    it('Issue #1266: 器を失っていない行は観測の source の経路を言い、source が無ければ経路不明を言う', () => {
      const closed = renderManagerList([
        manager({
          status: 'done',
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-24T00:00:00.000Z',
            source: 'closed',
            cwd: '/workspace',
            worktrees: [{ relativePath: 'repo', branch: 'fix/123' }],
          },
        }),
      ]);
      expect(closed).toContain('runner が closed を出す直前に先取り');
      expect(closed).toContain('この一覧 自身では更新されない');
      expect(closed).not.toContain('枠落ち');
      expect(closed).not.toContain('経路不明');
      const noSource = renderManagerList([
        manager({
          status: 'done',
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-24T00:00:00.000Z',
            cwd: '/workspace',
            worktrees: [{ relativePath: 'repo', branch: 'fix/123' }],
          },
        }),
      ]);
      expect(noSource).toContain('経路不明');
    });

    it('unavailable: 取れなかった理由を出す', () => {
      const text = renderManagerList([
        manager({
          status: 'done',
          lastUnpushedWorkObservation: {
            kind: 'unavailable',
            at: '2026-09-24T00:00:00.000Z',
            reason: 'git が無い',
          },
        }),
      ]);
      expect(text).toContain('未push観測');
      expect(text).toContain('取れなかった');
      expect(text).toContain('git が無い');
    });

    it('作業ツリー0本で探索の失敗も無い観測は「未push観測」の行を出さない（Issue #2970）', () => {
      const text = renderManagerList([
        manager({
          status: 'done',
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-24T00:00:00.000Z',
            cwd: '/workspace',
            worktrees: [],
          },
        }),
      ]);
      expect(text).not.toContain('未push観測');
    });

    it('0本でも読み残し（打ち切り・読み失敗）が在れば「未push観測」を出す（Issue #2970）', () => {
      for (const extra of [
        { truncatedAtCount: 50 },
        { stoppedEarly: true as const },
        { scratchRootsUnknown: '読めない' },
        { unreadableDirCount: 2 },
      ]) {
        const text = renderManagerList([
          manager({
            status: 'done',
            lastUnpushedWorkObservation: {
              kind: 'observed',
              at: '2026-09-24T00:00:00.000Z',
              cwd: '/workspace',
              worktrees: [],
              ...extra,
            },
          }),
        ]);
        expect(text, JSON.stringify(extra)).toContain('未push観測');
        expect(text, JSON.stringify(extra)).toContain('探しきっていない');
      }
    });

    it('0本の観測を stale の案内が指さない（Issue #2970）', () => {
      const empty = renderManagerList([
        manager({
          status: 'running',
          resetTimeSkewMatch: 'stale',
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-24T00:00:00.000Z',
            cwd: '/workspace',
            worktrees: [],
          },
        }),
      ]);
      expect(empty).toContain('世代ずれの疑い');
      expect(empty).not.toContain('未push観測');
    });

    it('器の入れ替えで応答不能でも、届いた観測が0本・失敗なしなら行を出さない（Issue #2970）', () => {
      const text = renderManagerList([
        manager({
          status: 'running',
          sessionMissingSince: '2026-09-24T00:00:00.000Z',
          shutdownObservationArrivedAfterSwap: true,
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-24T00:00:00.000Z',
            cwd: '/workspace',
            worktrees: [],
          },
        }),
      ]);
      expect(text).not.toContain('未push観測');
    });

    it('branch が null なら「取れなかった」と言う（隠さない）', () => {
      const text = renderManagerList([
        manager({
          status: 'done',
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-24T00:00:00.000Z',
            cwd: '/workspace',
            worktrees: [{ relativePath: 'repo', branch: null }],
          },
        }),
      ]);
      expect(text).toContain('branch=null（取れなかった）');
    });

    it('sessionMissingSince が在り、器が止まる直前の観測が届いていれば言い切る', () => {
      const text = renderManagerList([
        manager({
          status: 'running',
          sessionMissingSince: '2026-09-25T00:00:00.000Z',
          shutdownObservationArrivedAfterSwap: true,
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-25T00:00:00.000Z',
            cwd: '/workspace',
            worktrees: [{ relativePath: 'repo', branch: 'fix/1' }],
          },
        }),
      ]);
      expect(text).toContain('器が止まる直前（2026-09-25T00:00:00.000Z）の観測');
      expect(text).toContain('repo: branch=fix/1');
    });

    it('sessionMissingSince が在り、届いていなければ「届いていない」と明示する', () => {
      const text = renderManagerList([
        manager({
          status: 'running',
          sessionMissingSince: '2026-09-25T00:00:00.000Z',
          shutdownObservationArrivedAfterSwap: false,
        }),
      ]);
      expect(text).toContain('器が止まる直前の観測は届いていない');
      expect(text).toContain('未pushが無かったことを意味しない');
      expect(text).toContain('表示中の観測は無い');
    });

    it('sessionMissingSince が在り、stop 由来（Issue #1266 残り2）は shutdown ではないので「届いていない」に倒す', () => {
      const text = renderManagerList([
        manager({
          status: 'running',
          sessionMissingSince: '2026-09-25T00:00:00.000Z',
          shutdownObservationArrivedAfterSwap: false,
          lastUnpushedWorkObservation: {
            kind: 'observed',
            at: '2026-09-25T00:00:00.000Z',
            source: 'stop',
            cwd: '/workspace',
            worktrees: [],
          },
        }),
      ]);
      expect(text).toContain('器が止まる直前の観測は届いていない');
      expect(text).toContain('自動畳みが止める直前');
      expect(text).not.toContain('この一覧が知らない経路');
      expect(text).not.toContain('器が止まる直前（2026-09-25T00:00:00.000Z）の観測');
    });

    describe('「探しきれていない」の注記（4欄。PR #1896 で core が足した）', () => {
      it('4欄がどれも無ければ何も足さない（通常分岐）', () => {
        const text = renderManagerList([
          manager({
            status: 'done',
            lastUnpushedWorkObservation: {
              kind: 'observed',
              at: '2026-09-26T00:00:00.000Z',
              cwd: '/workspace',
              worktrees: [{ relativePath: 'repo', branch: 'fix/1' }],
            },
          }),
        ]);
        expect(text).not.toContain('探しきっていない');
      });

      it('truncatedAtCount が在れば「探しきっていない」と件数上限の理由を言う（通常分岐）', () => {
        const text = renderManagerList([
          manager({
            status: 'done',
            lastUnpushedWorkObservation: {
              kind: 'observed',
              at: '2026-09-26T00:00:00.000Z',
              cwd: '/workspace',
              worktrees: [{ relativePath: 'repo', branch: 'fix/1' }],
              truncatedAtCount: 50,
            },
          }),
        ]);
        expect(text).toContain('この観測は探しきっていない');
        expect(text).toContain('件数の上限（50）で打ち切った');
        expect(text).toContain('ここに無い作業ツリーが在りうる');
      });

      it('stoppedEarly / scratchRootsUnknown / unreadableDirCount も理由として言う（複数同時）', () => {
        const text = renderManagerList([
          manager({
            status: 'done',
            lastUnpushedWorkObservation: {
              kind: 'observed',
              at: '2026-09-26T00:00:00.000Z',
              cwd: '/workspace',
              worktrees: [],
              stoppedEarly: true,
              scratchRootsUnknown: '読めなかった',
              unreadableDirCount: 2,
            },
          }),
        ]);
        expect(text).toContain('期限切れで一部を調べる前に打ち切った');
        expect(text).toContain('/tmp スクラッチの起点を確かめられなかった: 読めなかった');
        expect(text).toContain('子ディレクトリの読み失敗が2件あった');
      });

      it('sessionMissingSince + 届いた分岐でも注記を足す', () => {
        const text = renderManagerList([
          manager({
            status: 'running',
            sessionMissingSince: '2026-09-27T00:00:00.000Z',
            shutdownObservationArrivedAfterSwap: true,
            lastUnpushedWorkObservation: {
              kind: 'observed',
              at: '2026-09-27T00:00:00.000Z',
              cwd: '/workspace',
              worktrees: [],
              truncatedAtCount: 10,
            },
          }),
        ]);
        expect(text).toContain('この観測は探しきっていない');
        expect(text).toContain('件数の上限（10）で打ち切った');
      });

      it('sessionMissingSince + 届いていない分岐（表示中の観測）でも注記を足す', () => {
        const text = renderManagerList([
          manager({
            status: 'running',
            sessionMissingSince: '2026-09-27T00:00:00.000Z',
            shutdownObservationArrivedAfterSwap: false,
            lastUnpushedWorkObservation: {
              kind: 'observed',
              at: '2026-09-27T00:00:00.000Z',
              cwd: '/workspace',
              worktrees: [],
              truncatedAtCount: 10,
            },
          }),
        ]);
        expect(text).toContain('この観測は探しきっていない');
        expect(text).toContain('件数の上限（10）で打ち切った');
      });

      it('unavailable には付かない（4欄は observed 側にしか無い）', () => {
        const text = renderManagerList([
          manager({
            status: 'done',
            lastUnpushedWorkObservation: {
              kind: 'unavailable',
              at: '2026-09-26T00:00:00.000Z',
              reason: 'git が無い',
            },
          }),
        ]);
        expect(text).not.toContain('探しきっていない');
      });
    });
  });
});

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
    expect(text).toContain('[1]');
    expect(text.indexOf('[1]')).toBeLessThan(text.indexOf('[2]'));
  });

  it('待ちが無ければ、そう言う（entries は空）', () => {
    const { text, entries } = renderWaitingList([manager({ waiting: [] })]);

    expect(entries).toEqual([]);
    expect(text).toContain('返事待ちのマネージャーはいません');
  });

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

describe('renderReport / renderReportLine', () => {
  const REASON = "You've hit your org's monthly spend limit · ask your admin to raise it";

  it('印の付いた行を「その日の日報」として出さない', () => {
    const text = renderReport({
      date: '2026-08-20',
      body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${REASON}）`,
      unavailable: REASON,
    });

    expect(text).not.toContain('── 2026-08-20 の日報 ──');
    expect(text).toContain('日報は作れなかった');
    expect(text).toContain(REASON);
    expect(text).toContain('/journal');
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
  supersedes?: string;
  supersededBy?: string;
  attachments?: { id: string; name: string; mediaType: string; size: number; sha256: string }[];
}

interface AnswersRequest {
  answers: { id: string; answer: string }[];
}

interface ApprovalLike {
  id: string;
  createdAt: string;
  question: string;
  context?: string;
  jobId?: string;
  answeredAt?: string;
  answer?: string;
  questions?: {
    id: string;
    prompt: string;
    options: { id: string; label: string; description?: string; recommended?: boolean }[];
    multiple?: boolean;
    allowOther?: boolean;
  }[];
  withdrawnAt?: string;
  withdrawnReason?: string;
  conversationId?: string;
}

interface ScheduleEntryLike {
  kind: string;
  description: string;
  nextAt: string;
  request?: string;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
}

interface MemoryDocLike {
  slug: string;
  title: string;
  kind: 'premise' | 'fact';
  description?: string;
  descriptionFreshness: { kind: 'fresh' | 'stale' | 'unknown' | 'absent' };
  updatedAt: string;
  createdAt: { kind: 'known'; at: string } | { kind: 'unknown' };
}

interface JournalEntryLike {
  id: string;
  at: string;
  type: string;
  [field: string]: unknown;
}

interface ArchiveEntryLike {
  id: string;
  sessionId: string;
  at: string;
  storedBytes: number;
  removedAt?: string;
  removedBytes?: number;
}

interface ArchiveSessionSummaryLike {
  sessionId: string;
  rows: number;
  storedBytes: number;
  maxStoredBytes: number;
  firstAt: string;
  lastAt: string;
}

function stubClient(
  options: {
    commitments?: Commitment[];
    closeStatus?: number;
    closeBody?: unknown;
    editStatus?: number;
    commitOpenStatus?: number;
    commitOpenBody?: unknown;
    editBody?: unknown;
    abortStatus?: number;
    abortBody?: unknown;
    conversations?: ConversationSummaryLike[];
    conversationsScanned?: number;
    conversationsReachedStart?: boolean;
    conversationsHiddenByLimit?: number;
    conversationsNextCursor?: string;
    conversationsStatus?: number;
    unreadCountStatus?: number;
    unreadCountBody?: unknown;
    unreadCountThrows?: Error;
    conversationDetailStatus?: number;
    conversationDetailBody?: {
      conversationId: string;
      messages: ConversationMessageLike[];
      scanned: number;
      reachedStart: boolean;
      supersededCount?: number;
    };
    approvalsAnswerStatus?: number;
    approvalsAnswerResults?: (
      answers: { id: string; answer: string }[],
    ) => { id: string; ok: boolean; error?: string }[];
    approvals?: ApprovalLike[];
    approvalsAnsweredDates?: { date: string; count: number }[];
    approvalsAnsweredDatesStatus?: number;
    approvalsAnsweredDatesBody?: unknown;
    approvalsAnsweredOnStatus?: number;
    approvalsAnsweredOnBody?: unknown;
    approvalsStatus?: number;
    approvalsUnreadable?: { id?: string; reason: string }[];
    approvalByIdStatus?: number;
    approvalByIdBody?: unknown;
    approvalTraceStatus?: number;
    approvalTraceBody?: unknown;
    scheduleEntries?: ScheduleEntryLike[];
    scheduleUnreadable?: { kind?: string; reason: string }[];
    memoryDocuments?: MemoryDocLike[];
    journalEntries?: JournalEntryLike[];
    journalByIdStatus?: number;
    usageAggregate?: unknown;
    reports?: { date: string; at: string; body: string; unavailable?: string }[];
    managers?: ManagerListItem[];
    managersStatus?: number;
    managersBody?: unknown;
    managersUnreadable?: { id?: string; reason: string }[];
    messagesStatus?: number;
    messagesBody?: unknown;
    transcriptStatus?: number;
    transcriptBody?: string;
    archiveEntries?: ArchiveEntryLike[];
    archiveSessions?: ArchiveSessionSummaryLike[];
    archiveReadStatus?: number;
    archiveReadBody?: string;
    archiveRemoveStatus?: number;
    archiveRemoveBody?: unknown;
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
        const status = options.managersStatus ?? 200;
        // 失敗のときは一覧を返さない: `{ managers: [] }` を返すと、失敗の枝が「0件」として素通りしても緑になる
        return Promise.resolve(
          reply(
            status,
            status === 200
              ? {
                  managers: options.managers ?? [],
                  ...(options.managersUnreadable === undefined
                    ? {}
                    : { unreadable: options.managersUnreadable }),
                }
              : (options.managersBody ?? { error: 'status に知らない値が入っている: runing' }),
          ),
        );
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
    events: {
      $post: (args: unknown) => {
        calls.push({ route: 'POST /events', args });
        return Promise.resolve(reply(200, { id: 'evt-1' }));
      },
    },
    commitments: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /commitments', args });
        return Promise.resolve(reply(200, { entries: options.commitments ?? [] }));
      },
      $post: (args: unknown) => {
        calls.push({ route: 'POST /commitments', args });
        const status = options.commitOpenStatus ?? 200;
        return Promise.resolve(reply(status, status === 200 ? {} : (options.commitOpenBody ?? {})));
      },
      ':id': {
        close: {
          $post: (args: unknown) => {
            calls.push({ route: 'POST /commitments/:id/close', args });
            const status = options.closeStatus ?? 200;
            return Promise.resolve(reply(status, status === 200 ? {} : (options.closeBody ?? {})));
          },
        },
        $patch: (args: unknown) => {
          calls.push({ route: 'PATCH /commitments/:id', args });
          const status = options.editStatus ?? 200;
          return Promise.resolve(reply(status, options.editBody ?? (status === 200 ? {} : {})));
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
            ...(options.conversationsNextCursor === undefined
              ? {}
              : { nextCursor: options.conversationsNextCursor }),
          }),
        );
      },
      'unread-count': {
        $get: () => {
          if (options.unreadCountThrows !== undefined)
            return Promise.reject(options.unreadCountThrows);
          return Promise.resolve(
            reply(
              options.unreadCountStatus ?? 200,
              options.unreadCountBody ?? { count: 0, capped: false },
            ),
          );
        },
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
                supersededCount: 0,
              },
            ),
          );
        },
      },
    },
    approvals: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /approvals', args });
        if (
          options.approvalsAnsweredOnStatus !== undefined &&
          (args as { query?: { answeredOn?: string } }).query?.answeredOn !== undefined
        ) {
          return Promise.resolve(
            reply(options.approvalsAnsweredOnStatus, options.approvalsAnsweredOnBody),
          );
        }
        return Promise.resolve(
          reply(options.approvalsStatus ?? 200, {
            approvals: options.approvals ?? [],
            ...(options.approvalsUnreadable === undefined
              ? {}
              : { unreadable: options.approvalsUnreadable }),
          }),
        );
      },
      'answered-dates': {
        $get: (args: unknown) => {
          calls.push({ route: 'GET /approvals/answered-dates', args });
          return Promise.resolve(
            reply(
              options.approvalsAnsweredDatesStatus ?? 200,
              options.approvalsAnsweredDatesBody ?? { dates: options.approvalsAnsweredDates ?? [] },
            ),
          );
        },
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
      ':id': {
        $get: (args: { param: { id: string } }) => {
          calls.push({ route: 'GET /approvals/:id', args });
          if (options.approvalByIdStatus !== undefined) {
            return Promise.resolve(reply(options.approvalByIdStatus, options.approvalByIdBody));
          }
          const found = (options.approvals ?? []).find((entry) => entry.id === args.param.id);
          return Promise.resolve(
            found === undefined
              ? reply(404, { error: 'not found' })
              : reply(200, { approval: found, settledOn: null }),
          );
        },
        answer: {
          $post: (args: unknown) => {
            calls.push({ route: 'POST /approvals/:id/answer', args });
            return Promise.resolve(reply(200, { ok: true }));
          },
        },
        trace: {
          $get: (args: unknown) => {
            calls.push({ route: 'GET /approvals/:id/trace', args });
            return Promise.resolve(
              reply(
                options.approvalTraceStatus ?? 404,
                options.approvalTraceBody ?? { error: 'not found' },
              ),
            );
          },
        },
      },
    },
    schedule: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /schedule', args });
        return Promise.resolve(
          reply(200, {
            entries: options.scheduleEntries ?? [],
            ...(options.scheduleUnreadable === undefined
              ? {}
              : { unreadable: options.scheduleUnreadable }),
          }),
        );
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
      ':id': {
        $get: (args: { param: { id: string } }) => {
          calls.push({ route: 'GET /journal/:id', args });
          if (options.journalByIdStatus !== undefined) {
            return Promise.resolve(reply(options.journalByIdStatus, { error: 'x' }));
          }
          const found = (options.journalEntries ?? []).find((e) => e.id === args.param.id);
          return Promise.resolve(
            found === undefined ? reply(404, { error: 'not found' }) : reply(200, found),
          );
        },
      },
    },
    usage: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /usage', args });
        return Promise.resolve(
          reply(
            200,
            options.usageAggregate ?? {
              since: null,
              notice: USAGE_ESTIMATE_NOTICE,
              account: { state: 'unknown' },
              unrecordedManagers: [],
            },
          ),
        );
      },
    },
    reports: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /reports', args });
        return Promise.resolve(reply(200, { reports: options.reports ?? [] }));
      },
    },
    archive: {
      $get: (args: unknown) => {
        calls.push({ route: 'GET /archive', args });
        return Promise.resolve(reply(200, { entries: options.archiveEntries ?? [] }));
      },
      sessions: {
        $get: (args: unknown) => {
          calls.push({ route: 'GET /archive/sessions', args });
          return Promise.resolve(reply(200, { sessions: options.archiveSessions ?? [] }));
        },
      },
      ':id': {
        $get: (args: unknown) => {
          calls.push({ route: 'GET /archive/:id', args });
          const status = options.archiveReadStatus ?? 200;
          return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            text: () => Promise.resolve(options.archiveReadBody ?? ''),
          });
        },
        $delete: (args: unknown) => {
          calls.push({ route: 'DELETE /archive/:id', args });
          const status = options.archiveRemoveStatus ?? 200;
          return Promise.resolve(
            reply(
              status,
              options.archiveRemoveBody ??
                (status === 200
                  ? { ok: true, id: 'sess-1.jsonl', bytes: 1, alreadyRemoved: false }
                  : {}),
            ),
          );
        },
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
  return {
    approvals: [],
    commitments: [],
    conversations: [],
    managers: [],
    managerAnchors: {},
    waiting: [],
    messages: [],
    messagesConversationId: null,
    messageAttachments: {},
    messageTexts: {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderCommitments', () => {
  it('番号と id を同じ順で作る（表示と /done が別のものを指さない）', () => {
    const { text, ids } = renderCommitments(
      [commitment({ id: 'a' }), commitment({ id: 'b' }), commitment({ id: 'c' })],
      NOW,
    );

    expect(ids).toEqual(['a', 'b', 'c']);
    expect(text).toContain('[1]');
    expect(text).toContain('id: a');
    expect(text.indexOf('[1]')).toBeLessThan(text.indexOf('[2]'));
    expect(text.indexOf('id: a')).toBeLessThan(text.indexOf('id: b'));
    expect(text.indexOf('id: b')).toBeLessThan(text.indexOf('id: c'));
  });

  it('起点と齢を出す（急ぎ方を決める材料はこの2つしかない）', () => {
    const { text } = renderCommitments([commitment({ origin: 'human', source: 'conv-1' })], NOW);

    expect(text).toContain('起点: 人間(conv-1)');
    expect(text).toContain('2026-08-16T12:00:00.000Z');
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
    expect(text).toContain('PR #99 をマージした');
  });

  it('長い本文を畳む（一覧が流れない）', () => {
    const { text } = renderCommitments([commitment({ body: 'あ'.repeat(4000) })], NOW);

    const [header] = text.split('\n');
    expect(header).toBeDefined();
    expect(header?.length).toBeLessThan(200);
    expect(header).toContain('…');
  });

  it('未了の1件は作成と更新に同じ受け取り時刻を出す（齢の表示も残る）', () => {
    const { text } = renderCommitments([commitment({ at: '2026-08-10T00:00:00.000Z' })], NOW);

    expect(text).toContain('作成: 2026-08-10T00:00:00.000Z');
    expect(text).toContain('更新: 2026-08-10T00:00:00.000Z');
    expect(text).toMatch(/（\d+日前）/);
  });

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

  it('読めない行が在れば、件数と id を断る（片付いたのではない、と明示する）', () => {
    const { text, ids } = renderCommitments([commitment({ id: 'a' })], NOW, [
      { id: 'broken-1', reason: 'origin が読めない' },
    ]);

    expect(ids).toEqual(['a']);
    expect(text).toContain('id: a');
    expect(text).toContain('読めない行が 1 件あります');
    expect(text).toContain('broken-1');
    expect(text).toContain('片付いたのではありません');
  });

  it('読める行が0件でも、読めない行が在れば断りを出す（「ありません」で終わらせない）', () => {
    const { text } = renderCommitments([], NOW, [{ id: 'broken-1', reason: 'origin が読めない' }]);

    expect(text).toContain('読めない行が 1 件あります');
    expect(text).not.toContain('引き受けたまま終わっていない仕事はありません');
  });

  it('id が取れない読めない行は、件数だけに数える', () => {
    const { text } = renderCommitments([], NOW, [{ reason: 'id ごと読めない' }]);

    expect(text).toContain('読めない行が 1 件あります');
    expect(text).not.toContain('id: ');
  });

  it('読めない行が0件なら、断りを足さない', () => {
    const { text } = renderCommitments([commitment({ id: 'a' })], NOW, []);

    expect(text).not.toContain('読めない行');
  });

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

  it('/commit は 404 のときだけ従来の文言を出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({ commitOpenStatus: 404, commitOpenBody: {} });

    await runSlashCommand('/commit 週明けに設計を見直す', client, emptyListed(), 'conv-7');

    expect(read()).toContain('台帳に積めませんでした');
  });

  it('/commit は 404 以外はサーバの理由（{ error }）をそのまま出す', async () => {
    const serverError = captureStdout();
    const { client: serverErrorClient } = stubClient({
      commitOpenStatus: 500,
      commitOpenBody: { error: '台帳への書き込みが失敗した（issue #2172 のテスト用）' },
    });
    await runSlashCommand(
      '/commit 週明けに設計を見直す',
      serverErrorClient,
      emptyListed(),
      'conv-7',
    );
    const serverErrorText = serverError();
    vi.restoreAllMocks();

    const badRequest = captureStdout();
    const { client: badRequestClient } = stubClient({
      commitOpenStatus: 400,
      commitOpenBody: { error: 'body の形が不正（issue #2172 のテスト用）' },
    });
    await runSlashCommand(
      '/commit 週明けに設計を見直す',
      badRequestClient,
      emptyListed(),
      'conv-7',
    );
    const badRequestText = badRequest();

    expect(serverErrorText).toContain('台帳への書き込みが失敗した（issue #2172 のテスト用）');
    expect(badRequestText).toContain('body の形が不正（issue #2172 のテスト用）');
    expect(serverErrorText).not.toContain('台帳に積めませんでした');
    expect(badRequestText).not.toContain('台帳に積めませんでした');
  });

  it('/done は番号を id へ引き直し、書かれた理由を送る', async () => {
    captureStdout();
    const { calls, client } = stubClient({
      commitments: [commitment({ id: 'cmt-1' }), commitment({ id: 'cmt-2' })],
    });
    const listed = emptyListed();

    await runSlashCommand('/commitments', client, listed);
    await runSlashCommand('/done 2 片付けた', client, listed);

    const close = calls.find((call) => call.route === 'POST /commitments/:id/close');
    expect(close).toBeDefined();
    expect((close?.args as { param: { id: string } }).param).toEqual({ id: 'cmt-2' });
    expect((close?.args as { json: { reason: string } }).json.reason).toBe('片付けた');
  });

  it('/done は理由が無い・空白だけなら何も送らず、使い方と理由が要る旨を出す（#3143）', async () => {
    const out = captureStdout();
    const { calls, client } = stubClient({ commitments: [commitment({ id: 'cmt-1' })] });
    const listed = emptyListed();

    await runSlashCommand('/commitments', client, listed);
    await runSlashCommand('/done 1', client, listed);
    await runSlashCommand('/done 1    ', client, listed);

    expect(calls.some((call) => call.route === 'POST /commitments/:id/close')).toBe(false);
    expect(out()).toContain('使い方: /done <番号|id> <理由>');
    expect(out()).toContain('理由が要ります');
  });

  it('/event は本文が JSON ならその値を、読めなければ文字列を、空なら空文字列を送る（#3146）', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/event ci {"a":1}', client, emptyListed());
    await runSlashCommand('/event ci [1,"x"]', client, emptyListed());
    await runSlashCommand('/event ci 42', client, emptyListed());
    await runSlashCommand('/event ci ビルドが  落ちた', client, emptyListed());
    await runSlashCommand('/event ci {"a":1', client, emptyListed());
    await runSlashCommand('/event ci', client, emptyListed());

    const sent = calls
      .filter((call) => call.route === 'POST /events')
      .map((call) => (call.args as { json: unknown }).json);
    expect(sent).toEqual([
      { source: 'ci', payload: { a: 1 } },
      { source: 'ci', payload: [1, 'x'] },
      { source: 'ci', payload: 42 },
      { source: 'ci', payload: 'ビルドが  落ちた' },
      { source: 'ci', payload: '{"a":1' },
      { source: 'ci', payload: '' },
    ]);
  });

  it('/event は source が無ければ何も送らず、使い方を出す', async () => {
    const out = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/event', client, emptyListed());

    expect(calls.some((call) => call.route === 'POST /events')).toBe(false);
    expect(out()).toContain('使い方: /event');
  });

  it('/commit-edit は番号を id へ引き直し、新しい本文を PATCH で送る（#1058）', async () => {
    captureStdout();
    const { calls, client } = stubClient({
      commitments: [commitment({ id: 'cmt-1' }), commitment({ id: 'cmt-2' })],
    });
    const listed = emptyListed();

    await runSlashCommand('/commitments', client, listed);
    await runSlashCommand('/commit-edit 2 言い直した本文', client, listed);

    const edit = calls.find((call) => call.route === 'PATCH /commitments/:id');
    expect(edit).toBeDefined();
    expect((edit?.args as { param: { id: string } }).param).toEqual({ id: 'cmt-2' });
    expect((edit?.args as { json: { body: string } }).json.body).toBe('言い直した本文');
  });

  // 断りの文面は CLI が持たない: 403 の本文はサーバが origin を名指しして理由と出口まで書いているので、言い換えると案内が消える
  it('/commit-edit は断られた理由をサーバの文言のまま出す（言い換えない。#1058）', async () => {
    const out = captureStdout();
    const { client } = stubClient({
      commitments: [commitment({ id: 'cmt-1' })],
      editStatus: 403,
      editBody: {
        error:
          "cmt-1 は origin:'self' で、クローンやマネージャーが立てた行は人間からは直せない（この行はクローンが自分で載せたもの。チャットでクローンに頼めば直せる——クローンには commitment_edit が在る）",
      },
    });
    const listed = emptyListed();

    await runSlashCommand('/commitments', client, listed);
    await runSlashCommand('/commit-edit 1 直したい', client, listed);

    expect(out()).toContain("origin:'self'");
    expect(out()).toContain('commitment_edit');
  });

  it('/commit-edit は本文が無ければ何も送らず、使い方を出す', async () => {
    const out = captureStdout();
    const { calls, client } = stubClient({ commitments: [commitment({ id: 'cmt-1' })] });
    const listed = emptyListed();

    await runSlashCommand('/commitments', client, listed);
    await runSlashCommand('/commit-edit 1', client, listed);

    expect(calls.some((call) => call.route === 'PATCH /commitments/:id')).toBe(false);
    expect(out()).toContain('使い方');
  });

  describe('/commitment（1件を全文で）', () => {
    const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const LONG = `長い依頼。${'あ'.repeat(200)}\n2行目の末尾`;

    it('番号で引くと、本文も片付けた理由も切らずに全文で出す。片付けた行も引ける', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({
        commitments: [
          commitment({ id: 'cmt-1' }),
          commitment({
            id: 'cmt-2',
            body: LONG,
            closedAt: '2026-08-17T00:00:00.000Z',
            closedReason: `${'い'.repeat(200)}\n理由の末尾`,
            closedBy: 'human',
          }),
        ],
      });
      const listed = emptyListed();

      await runSlashCommand('/commitments all', client, listed);
      const listing = read();
      expect(listing).not.toContain('2行目の末尾');
      await runSlashCommand('/commitment 2', client, listed);

      const text = read().slice(listing.length);
      expect(text).toContain('cmt-2');
      expect(text).toContain('あ'.repeat(200));
      expect(text).toContain('2行目の末尾');
      expect(text).toContain('い'.repeat(200));
      expect(text).toContain('理由の末尾');
      expect(text).toContain('closedBy: human');
      expect(calls.at(-1)).toEqual({
        route: 'GET /commitments',
        args: { query: { includeClosed: 'true' } },
      });
    });

    it('id でも引ける。一覧に無かった行（窓の外の片付けた行）も引く', async () => {
      const read = captureStdout();
      const { client } = stubClient({ commitments: [commitment({ id: 'cmt-9', body: LONG })] });

      await runSlashCommand('/commitment cmt-9', client, emptyListed());

      expect(read()).toContain('2行目の末尾');
    });

    it('伏せ字を一覧と同じく掛ける（本文にも片付けた理由にも）', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        commitments: [
          commitment({
            id: 'cmt-s',
            body: `トークンは ${SECRET} です\n続き`,
            closedAt: '2026-08-17T00:00:00.000Z',
            closedReason: `理由 ${SECRET}`,
          }),
        ],
      });

      await runSlashCommand('/commitment cmt-s', client, emptyListed());

      const text = read();
      expect(text).toContain('続き');
      expect(text).not.toContain(SECRET);
    });

    it('無い id は、無いと言う。番号が一覧に無ければ台帳を引かない', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({ commitments: [] });

      await runSlashCommand('/commitment nope', client, emptyListed());
      expect(read()).toContain('台帳に nope は見つかりません');

      const before = calls.length;
      await runSlashCommand('/commitment 3', client, emptyListed());
      expect(read()).toContain('[3] は /commitments の一覧にありません');
      expect(calls).toHaveLength(before);
    });

    it('引数が無い・多いときは使い方を言い、/help に載る', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({});

      await runSlashCommand('/commitment', client, emptyListed());
      await runSlashCommand('/commitment a b', client, emptyListed());
      expect(read()).toContain('使い方: /commitment <番号|id>');
      expect(calls).toEqual([]);

      const help = captureStdout();
      await runSlashCommand('/help', client, emptyListed());
      expect(help()).toContain('/commitment <番号|id>');
    });
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

  it('/done は 409（既に片付いている）と 404（id が無い）を別の言葉で返す', async () => {
    const conflict = captureStdout();
    const { client: conflictClient } = stubClient({
      commitments: [commitment({ id: 'cmt-1' })],
      closeStatus: 409,
    });
    const listedConflict = emptyListed();
    await runSlashCommand('/commitments', conflictClient, listedConflict);
    await runSlashCommand('/done 1 片付けた', conflictClient, listedConflict);
    const conflictText = conflict();
    vi.restoreAllMocks();

    const missing = captureStdout();
    const { client: missingClient } = stubClient({
      commitments: [commitment({ id: 'cmt-1' })],
      closeStatus: 404,
    });
    const listedMissing = emptyListed();
    await runSlashCommand('/commitments', missingClient, listedMissing);
    await runSlashCommand('/done 1 片付けた', missingClient, listedMissing);
    const missingText = missing();

    expect(conflictText).toContain('既に片付いています');
    expect(missingText).toContain('台帳にありません');
    expect(conflictText).not.toContain('台帳にありません');
    expect(missingText).not.toContain('既に片付いています');
  });

  it('/done は 404/409 以外はサーバの理由（{ error }）をそのまま出す', async () => {
    const serverError = captureStdout();
    const { client: serverErrorClient } = stubClient({
      commitments: [commitment({ id: 'cmt-1' })],
      closeStatus: 500,
      closeBody: { error: '台帳の書き込みが失敗した（issue #2172 のテスト用）' },
    });
    const listedServerError = emptyListed();
    await runSlashCommand('/commitments', serverErrorClient, listedServerError);
    await runSlashCommand('/done 1 片付けた', serverErrorClient, listedServerError);
    const serverErrorText = serverError();
    vi.restoreAllMocks();

    const badRequest = captureStdout();
    const { client: badRequestClient } = stubClient({
      commitments: [commitment({ id: 'cmt-1' })],
      closeStatus: 400,
      closeBody: { error: '理由が長すぎる（issue #2172 のテスト用）' },
    });
    const listedBadRequest = emptyListed();
    await runSlashCommand('/commitments', badRequestClient, listedBadRequest);
    await runSlashCommand('/done 1 片付けた', badRequestClient, listedBadRequest);
    const badRequestText = badRequest();

    expect(serverErrorText).toContain('台帳の書き込みが失敗した（issue #2172 のテスト用）');
    expect(badRequestText).toContain('理由が長すぎる（issue #2172 のテスト用）');
    expect(serverErrorText).not.toContain('記録できませんでした');
    expect(badRequestText).not.toContain('記録できませんでした');
  });

  it('/done は承認待ちの番号を掴まない（覚え場所が別であること）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed: Listed = {
      ...emptyListed(),
      approvals: ['approval-1'],
    };

    await runSlashCommand('/done 1 片付けた', client, listed);

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

describe('chat の設問つきの承認待ち（issue #2525）', () => {
  const approval: ApprovalLike = {
    id: 'ap-q',
    createdAt: '2026-10-02T00:00:00.000Z',
    question: 'デプロイ先を決めたい',
    questions: [
      {
        id: 'target',
        prompt: 'デプロイ先は？',
        options: [
          { id: 'railway', label: 'Railway', recommended: true, description: '既存の基盤' },
          { id: 'fly', label: 'Fly.io' },
        ],
      },
      {
        id: 'notify',
        prompt: '通知先',
        multiple: true,
        allowOther: false,
        options: [
          { id: 'slack', label: 'Slack' },
          { id: 'mail', label: 'メール' },
        ],
      },
    ],
  };
  const listedOne = (): Listed => ({ ...emptyListed(), approvals: ['ap-q'] });
  const sentJson = (calls: { route: string; args: unknown }[]) =>
    (calls.find((call) => call.route === 'POST /approvals/:id/answer')?.args as {
      param: { id: string };
      json: unknown;
    }) ?? null;

  it('/approvals は設問を件数だけで出す（選択肢の本文は出さない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({ approvals: [approval] });

    await runSlashCommand('/approvals', client, emptyListed());

    const text = read();
    expect(text).toContain('設問 2 件');
    expect(text).toContain('/approval 1');
    expect(text).not.toContain('Railway');
  });

  it('/approval は設問と選択肢（推奨・単一/複数・その他・id）を全部出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({ approvals: [approval] });

    await runSlashCommand('/approval 1', client, listedOne());

    const text = read();
    expect(text).toContain('Q1 [id=target] デプロイ先は？（単一選択・その他を書ける）');
    expect(text).toContain('(a) [id=railway] Railway［推奨］ — 既存の基盤');
    expect(text).toContain('Q2 [id=notify] 通知先（複数選択可・その他は書けない）');
    expect(text).toContain('--select');
  });

  it('/approval <id> は id で1件引く口（GET /approvals/:id）を1回だけ呼ぶ（全件は読まない）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ approvals: [approval] });

    await runSlashCommand('/approval ap-q', client, emptyListed());

    expect(calls.map((call) => call.route)).toEqual(['GET /approvals/:id']);
    expect((calls[0]?.args as { param: { id: string } }).param).toEqual({ id: 'ap-q' });
    expect(read()).toContain('Q1 [id=target] デプロイ先は？');
  });

  it('/approval <番号> は今までどおり、一覧の並びから id を引いて全件から探す', async () => {
    captureStdout();
    const { calls, client } = stubClient({ approvals: [approval] });

    await runSlashCommand('/approval 1', client, listedOne());

    expect(calls.map((call) => call.route)).toEqual(['GET /approvals']);
    expect((calls[0]?.args as { query: unknown }).query).toEqual({
      order: 'asc',
      pending: 'false',
    });
  });

  it('/approval <id>: 404 は見つかりませんでした。他の失敗（409・500）は、見つからないとは言わず読めなかったと言う', async () => {
    const readMissing = captureStdout();
    const missing = stubClient({ approvals: [] });
    await runSlashCommand('/approval nope', missing.client, emptyListed());
    expect(readMissing()).toContain('見つかりませんでした');

    for (const status of [409, 500]) {
      const read = captureStdout();
      const failed = stubClient({
        approvalByIdStatus: status,
        approvalByIdBody: { error: '読めない行' },
      });
      await runSlashCommand('/approval ap-q', failed.client, emptyListed());
      const text = read();
      expect(text, String(status)).toContain('承認待ちを読めませんでした');
      expect(text, String(status)).not.toContain('見つかりませんでした');
    }
  });

  it('/answer --select / --other は selections として送る（補足の自由文も併用できる）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ approvals: [approval] });

    await runSlashCommand(
      '/answer 1 --select target=railway --select notify=slack,mail --other target="ただし 来週" 金曜は避けたい',
      client,
      listedOne(),
    );

    expect(sentJson(calls)).toEqual({
      param: { id: 'ap-q' },
      json: {
        selections: [
          { questionId: 'target', optionIds: ['railway'], other: 'ただし 来週' },
          { questionId: 'notify', optionIds: ['slack', 'mail'] },
        ],
        answer: '金曜は避けたい',
      },
    });
    expect(read()).toContain('回答しました');
  });

  it('--select=q=a の形・補足なし・その他だけ、も送れる', async () => {
    captureStdout();
    const { calls, client } = stubClient({ approvals: [approval] });

    await runSlashCommand(
      '/answer ap-q --select=target=fly --other=notify=x=y',
      client,
      listedOne(),
    );

    expect(sentJson(calls)?.json).toEqual({
      selections: [
        { questionId: 'target', optionIds: ['fly'] },
        { questionId: 'notify', optionIds: [], other: 'x=y' },
      ],
    });
  });

  it('形の崩れた --select は送らずに使い方を出す', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ approvals: [approval] });

    await runSlashCommand('/answer 1 --select target', client, listedOne());
    await runSlashCommand('/answer 1 --other', client, listedOne());

    expect(sentJson(calls)).toBeNull();
    expect(read()).toContain('--select は --select <設問id>=');
  });

  it('--select を書かない /answer は今までどおり、残り全部を自由文として送る', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/answer 1 railway で  お願い', client, listedOne());

    expect(sentJson(calls)?.json).toEqual({ answer: 'railway で  お願い' });
  });

  it('設問の無い承認待ちには、--select / --other の字面があっても自由文のまま送る（#2583）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({
      approvals: [{ ...approval, questions: undefined }],
    });

    await runSlashCommand('/answer 1 git の --select は "使わない"', client, listedOne());
    await runSlashCommand('/answer 1 --other a=b を試した', client, listedOne());

    const sent = calls
      .filter((call) => call.route === 'POST /approvals/:id/answer')
      .map((call) => (call.args as { json: unknown }).json);
    expect(sent).toEqual([
      { answer: 'git の --select は "使わない"' },
      { answer: '--other a=b を試した' },
    ]);
    expect(read()).not.toContain('使い方');
  });

  it('承認待ちを取れなかったら、自由文として送らずに失敗を言って止まる（#2583）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ approvals: [approval], approvalsStatus: 500 });

    await runSlashCommand('/answer 1 --select target=railway', client, listedOne());

    expect(sentJson(calls)).toBeNull();
    expect(read()).toContain('回答を送っていません');
  });

  it('/answer <id> --select は id で1件引く口（GET /approvals/:id）を1回だけ呼び、全件は読まない。番号は従来どおり全件', async () => {
    captureStdout();
    const byId = stubClient({ approvals: [approval] });
    await runSlashCommand('/answer ap-q --select target=railway', byId.client, emptyListed());
    expect(byId.calls.filter((c) => c.route.startsWith('GET')).map((c) => c.route)).toEqual([
      'GET /approvals/:id',
    ]);
    expect(sentJson(byId.calls)?.param).toEqual({ id: 'ap-q' });

    const byNumber = stubClient({ approvals: [approval] });
    await runSlashCommand('/answer 1 --select target=railway', byNumber.client, listedOne());
    expect(byNumber.calls.filter((c) => c.route.startsWith('GET')).map((c) => c.route)).toEqual([
      'GET /approvals',
    ]);
  });

  it('/answer <id> --select: 404 は見つからなかった、409・500 は読めなかったと言い、どちらも送らない', async () => {
    const readMissing = captureStdout();
    const missing = stubClient({ approvals: [] });
    await runSlashCommand('/answer nope --select a=b', missing.client, emptyListed());
    expect(readMissing()).toContain('見つからなかった');
    expect(sentJson(missing.calls)).toBeNull();

    for (const status of [409, 500]) {
      const read = captureStdout();
      const failed = stubClient({ approvalByIdStatus: status, approvalByIdBody: { error: 'x' } });
      await runSlashCommand('/answer ap-q --select a=b', failed.client, emptyListed());
      const text = read();
      expect(text, String(status)).toContain('承認待ちを読めなかったので、回答を送っていません');
      expect(text, String(status)).not.toContain('見つからなかった');
      expect(sentJson(failed.calls), String(status)).toBeNull();
    }
  });

  it('一覧に居ても取ってきた中に無ければ、送らずに言って止まる（#2583）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ approvals: [] });

    await runSlashCommand('/answer 1 --select target=railway', client, listedOne());

    expect(sentJson(calls)).toBeNull();
    expect(read()).toContain('見つからなかった');
  });

  it('--select を書かない /answer は承認待ちを取りに行かない', async () => {
    captureStdout();
    const { calls, client } = stubClient({ approvals: [approval] });

    await runSlashCommand('/answer 1 ok', client, listedOne());

    expect(calls.some((call) => call.route === 'GET /approvals')).toBe(false);
  });
});

describe('chat の /answers（まとめて答える）', () => {
  function listedApprovals(ids: string[]): Listed {
    return { ...emptyListed(), approvals: ids };
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

  it('一覧の一部だけを番号で指せる（残りを飛ばせる）', async () => {
    captureStdout();
    const { calls, client } = stubClient();
    const listed = listedApprovals(['approval-1', 'approval-2', 'approval-3']);

    await runSlashCommand('/answers 2 allow', client, listed);

    const sent = (calls[0]?.args as { json: AnswersRequest }).json.answers;
    expect(sent).toEqual([{ id: 'approval-2', answer: 'allow' }]);
  });

  it('一覧にない番号は飛ばす。残りは送る', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed = listedApprovals(['approval-1']);

    await runSlashCommand('/answers 9 allow 1 deny', client, listed);

    const sent = (calls[0]?.args as { json: AnswersRequest }).json.answers;
    expect(sent).toEqual([{ id: 'approval-1', answer: 'deny' }]);
    expect(read()).toContain('[9] は /approvals の一覧にありません');
  });

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

  it('引数が無ければ何も送らない', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/answers', client, listedApprovals(['approval-1']));

    expect(calls).toEqual([]);
    expect(read()).toContain('使い方: /answers');
  });

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

describe('chat の /approval-trace', () => {
  const base = {
    approval: {
      id: 'appr-1',
      createdAt: '2026-09-24T00:00:00.000Z',
      question: '本番へ出してよいか',
      answeredAt: '2026-09-24T01:00:00.000Z',
      answer: '(b) でお願いします',
    },
    questionEntry: null,
    answerEntry: null,
    turnStarts: [],
    actionsOmitted: 0,
    unstampedInTurn: 0,
    scanned: 3,
    truncated: false,
  };

  it('印を持つ行動を全文で出す（長くても切らない）', async () => {
    const read = captureStdout();
    const long = 'x'.repeat(1_000);
    const { client, calls } = stubClient({
      approvalTraceStatus: 200,
      approvalTraceBody: {
        ...base,
        state: 'paired',
        actions: [
          {
            type: 'decision',
            id: 'j-1',
            at: '2026-09-24T01:00:01.000Z',
            decision: `b に沿って進めた ${long}`,
            grounds: '人間の答え',
            answeredApprovalId: 'appr-1',
          },
        ],
      },
    });

    await runSlashCommand('/approval-trace appr-1', client, emptyListed());

    const text = read();
    expect(calls).toContainEqual({
      route: 'GET /approvals/:id/trace',
      args: { param: { id: 'appr-1' } },
    });
    expect(text).toContain('(b) でお願いします');
    expect(text).toContain(`判断: b に沿って進めた ${long}`);
  });

  it('対が無ければ理由を出す（記録を始める前の答え）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      approvalTraceStatus: 200,
      approvalTraceBody: { ...base, state: 'turn_before_recording', actions: [] },
    });
    await runSlashCommand('/approval-trace appr-1', client, emptyListed());
    expect(read()).toContain('行動が無いのではなく、記録していない');
  });

  it('知らない id は「ありません」', async () => {
    const read = captureStdout();
    const { client } = stubClient();
    await runSlashCommand('/approval-trace nope', client, emptyListed());
    expect(read()).toContain('承認 nope はありません');
  });
});

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
    expect(header).toBe('  [1] 1行目の質問です');
    // インデント込みの行を見る: `toContain('2行目の補足です')` だけでは、全文を先頭行へ出した場合と区別できない
    expect(lines).toContain('      2行目の補足です');
    expect(lines).toContain('      3行目の補足です');
    expect(text).toContain('2行目の補足です');
    expect(text).toContain('3行目の補足です');
  });

  it('読めない承認待ちが在るとき、件数と id を出す。読めた行は今までどおり番号つきで出る（#2298）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      approvals: [{ id: 'appr-1', createdAt: '2026-08-16T10:00:00.000Z', question: '読める質問' }],
      approvalsUnreadable: [
        { id: 'appr-bad', reason: '不正な欄: createdAt' },
        { reason: '不正な行' },
      ],
    });
    const listed = emptyListed();

    await runSlashCommand('/approvals', client, listed);

    const text = read();
    expect(text).toContain('  [1] 読める質問');
    expect(text).toContain('読めない承認待ちが 2 件あります（id: appr-bad）');
    expect(text).toContain('壊れた行であって、回答済み・取り下げ済みではありません');
    expect(listed.approvals).toEqual(['appr-1']);
  });

  it('読めた承認待ちが0件でも、読めない行が在れば「ありません」とだけ言わない。0件のときは何も出さない（#2298）', async () => {
    const read = captureStdout();
    const only = stubClient({
      approvalsUnreadable: [{ id: 'appr-bad', reason: '不正な欄: createdAt' }],
    });
    await runSlashCommand('/approvals', only.client, emptyListed());
    const text = read();
    expect(text).toContain('（読めた承認待ちはありません）');
    expect(text).not.toContain('（承認待ちはありません）');
    expect(text).toContain('appr-bad');

    const none = stubClient({});
    await runSlashCommand('/approvals', none.client, emptyListed());
    const textNone = read().slice(text.length);
    expect(textNone).toContain('（承認待ちはありません）');
    expect(textNone).not.toContain('読めない');
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
    expect(text).toContain(
      'id: appr-open  作成: 2026-08-16T10:00:00.000Z' + '  更新: 2026-08-16T10:00:00.000Z',
    );
    expect(text).toContain(
      'id: appr-answered  作成: 2026-08-14T00:00:00.000Z' + '  更新: 2026-08-15T00:00:00.000Z',
    );
    expect(text).not.toContain(
      'id: appr-answered  作成: 2026-08-14T00:00:00.000Z' + '  更新: 2026-08-14T00:00:00.000Z',
    );
  });

  it('会話が紐づいていれば id と /conversation の案内を出し、無ければ機構が無いと出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      approvals: [
        {
          id: 'appr-with-conv',
          createdAt: '2026-08-16T10:00:00.000Z',
          question: '会話ありの質問',
          conversationId: 'conv-42',
        },
        {
          id: 'appr-without-conv',
          createdAt: '2026-08-16T10:00:00.000Z',
          question: '会話なしの質問',
        },
      ],
    });

    await runSlashCommand('/approvals', client, emptyListed());

    const text = read();
    const lines = text.split('\n');
    // `lines` の中で1回ずつしか出ていないことまで見る: `toContain` だけでは、両方の行が両方の承認の下に出る形を見逃す
    expect(
      lines.filter((line) => line === '      会話: conv-42（/conversation conv-42 で読めます）'),
    ).toHaveLength(1);
    expect(
      lines.filter(
        (line) =>
          line ===
          '      会話: 紐づいていない（マネージャー発・内部ターンには紐づけられる会話が存在しない）',
      ),
    ).toHaveLength(1);
  });

  describe('/approvals answered（#3239: 決着した日ごとに見る）', () => {
    const answered = {
      id: 'appr-a',
      createdAt: '2026-09-30T00:00:00.000Z',
      question: '夜のリリースを待つか\n2行目は一覧に出さない',
      answeredAt: '2026-09-30T10:00:00.000Z',
      answer: '待たない',
    };
    const withdrawn = {
      id: 'appr-w',
      createdAt: '2026-09-30T00:00:00.000Z',
      question: '取り下げた確認',
      withdrawnAt: '2026-09-30T05:00:00.000Z',
      withdrawnReason: '自分で答えを見つけた',
    };

    it('日付なしは answered-dates を呼び、日付と件数を返された順（新しい日が上）に出す', async () => {
      const read = captureStdout();
      const { client, calls } = stubClient({
        approvalsAnsweredDates: [
          { date: '2026-09-30', count: 3 },
          { date: '2026-09-29', count: 1 },
        ],
      });

      await runSlashCommand('/approvals answered', client, emptyListed());

      const call = calls.find((c) => c.route === 'GET /approvals/answered-dates');
      expect((call?.args as { query: Record<string, unknown> }).query).toEqual({ limit: '14' });
      const text = read();
      expect(text.indexOf('2026-09-30  3 件')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('2026-09-30  3 件')).toBeLessThan(text.indexOf('2026-09-29  1 件'));
      expect(calls.some((c) => c.route === 'GET /approvals')).toBe(false);
    });

    it('limit= と before= を渡せる。ちょうど limit 件なら続きがあるかもしれないと言う', async () => {
      const read = captureStdout();
      const { client, calls } = stubClient({
        approvalsAnsweredDates: [{ date: '2026-09-29', count: 1 }],
      });

      await runSlashCommand('/approvals answered limit=1 before=2026-09-30', client, emptyListed());

      const call = calls.find((c) => c.route === 'GET /approvals/answered-dates');
      expect((call?.args as { query: Record<string, unknown> }).query).toEqual({
        limit: '1',
        beforeDate: '2026-09-30',
      });
      expect(read()).toContain('直近 1 件のみ表示している');
    });

    it('日付つきは answeredOn だけを渡す（pending・order は付けない）', async () => {
      captureStdout();
      const { client, calls } = stubClient({ approvals: [answered] });

      await runSlashCommand('/approvals answered 2026-09-30', client, emptyListed());

      const call = calls.find((c) => c.route === 'GET /approvals');
      expect((call?.args as { query: Record<string, unknown> }).query).toEqual({
        answeredOn: '2026-09-30',
      });
    });

    it('その日の件を返された順に、抜粋だけで出す。取り下げ済みは取り下げと分かる', async () => {
      const read = captureStdout();
      const { client } = stubClient({ approvals: [answered, withdrawn] });

      await runSlashCommand('/approvals answered 2026-09-30', client, emptyListed());

      const text = read();
      expect(text).toContain('2026-09-30 に決着した承認 2 件');
      expect(text.indexOf('appr-a')).toBeLessThan(text.indexOf('appr-w'));
      expect(text).toContain('回答済み  夜のリリースを待つか 2行目は一覧に出さない');
      expect(text).toContain('回答: 待たない');
      expect(text).toContain('取り下げ済み  取り下げた確認');
      expect(text).toContain('取り下げた理由: 自分で答えを見つけた');
      expect(text).toContain('/approval <id>');
    });

    it('一覧は全文を載せない（長い問い・答えは切る）', async () => {
      const read = captureStdout();
      const long = 'あ'.repeat(500);
      const { client } = stubClient({
        approvals: [{ ...answered, question: long, answer: long }],
      });

      await runSlashCommand('/approvals answered 2026-09-30', client, emptyListed());

      expect(read()).not.toContain(long);
    });

    it('番号は振らず、未回答の一覧（listed.approvals）を書き換えない', async () => {
      const read = captureStdout();
      const { client } = stubClient({ approvals: [answered] });
      const listed = { ...emptyListed(), approvals: ['keep-1', 'keep-2'] };

      await runSlashCommand('/approvals answered 2026-09-30', client, listed);

      expect(listed.approvals).toEqual(['keep-1', 'keep-2']);
      expect(read()).not.toMatch(/\[1\]/);
    });

    it('その日に無ければ「ありません」、日付が不正（400）ならデーモンの言葉をそのまま出す', async () => {
      const read = captureStdout();
      const empty = stubClient({ approvals: [] });
      await runSlashCommand('/approvals answered 2026-09-01', empty.client, emptyListed());
      expect(read()).toContain('（2026-09-01 に決着した承認はありません）');

      const read2 = captureStdout();
      const bad = stubClient({
        approvalsAnsweredOnStatus: 400,
        approvalsAnsweredOnBody: { error: 'answeredOn は YYYY-MM-DD で指定する' },
      });
      await runSlashCommand('/approvals answered 2026-02-30', bad.client, emptyListed());
      const text = read2();
      expect(text).toContain('answeredOn は YYYY-MM-DD で指定する');
      expect(text).not.toContain('ありません');
    });

    it('取得に失敗したのを「ありません」と言わない（目次・その日の件の両方）', async () => {
      const read = captureStdout();
      const dates = stubClient({
        approvalsAnsweredDatesStatus: 500,
        approvalsAnsweredDatesBody: { error: 'boom' },
      });
      await runSlashCommand('/approvals answered', dates.client, emptyListed());
      expect(read()).not.toContain('まだありません');
      expect(read()).toContain('読めませんでした');
    });

    it('help に載っている', async () => {
      const read = captureStdout();
      const { client } = stubClient();
      await runSlashCommand('/help', client, emptyListed());
      expect(read()).toContain('/approvals answered <YYYY-MM-DD>');
    });
  });

  describe('/approvals all（issue #963: 取り下げ済み・回答済みも見る）', () => {
    it('引数無しの /approvals は pending を渡さない（既定の挙動を変えない）', async () => {
      captureStdout();
      const { client, calls } = stubClient({ approvals: [] });

      await runSlashCommand('/approvals', client, emptyListed());

      const call = calls.find((c) => c.route === 'GET /approvals');
      const query = (call?.args as { query: Record<string, unknown> }).query;
      expect(query.pending).toBeUndefined();
    });

    it('/approvals all は pending=false を渡す', async () => {
      captureStdout();
      const { client, calls } = stubClient({ approvals: [] });

      await runSlashCommand('/approvals all', client, emptyListed());

      const call = calls.find((c) => c.route === 'GET /approvals');
      const query = (call?.args as { query: Record<string, unknown> }).query;
      expect(query.pending).toBe('false');
    });

    it('取り下げ済みの状態と理由を出す（回答済みとは別の文言）', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        approvals: [
          {
            id: 'appr-withdrawn',
            createdAt: '2026-08-16T10:00:00.000Z',
            question: '取り下げられた質問',
            withdrawnAt: '2026-08-16T11:00:00.000Z',
            withdrawnReason: '自分で答えを見つけた',
          },
        ],
      });

      await runSlashCommand('/approvals all', client, emptyListed());

      const text = read();
      expect(text).toContain('状態: 取り下げ済み（2026-08-16T11:00:00.000Z）');
      expect(text).toContain('取り下げた理由: 自分で答えを見つけた');
      expect(text).not.toContain('状態: 回答済み');
    });

    it('理由の記録が無い取り下げでも空で終わらない', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        approvals: [
          {
            id: 'appr-withdrawn-no-reason',
            createdAt: '2026-08-16T10:00:00.000Z',
            question: '質問',
            withdrawnAt: '2026-08-16T11:00:00.000Z',
          },
        ],
      });

      await runSlashCommand('/approvals all', client, emptyListed());

      expect(read()).toContain('取り下げた理由: （理由の記録なし）');
    });

    it('回答済みの状態と回答本文を出す（取り下げとは別の文言）', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        approvals: [
          {
            id: 'appr-answered',
            createdAt: '2026-08-16T10:00:00.000Z',
            question: '答えの付いた質問',
            answeredAt: '2026-08-16T11:00:00.000Z',
            answer: 'はい、進めてよい',
          },
        ],
      });

      await runSlashCommand('/approvals all', client, emptyListed());

      const text = read();
      expect(text).toContain('状態: 回答済み（2026-08-16T11:00:00.000Z）');
      expect(text).toContain('回答: はい、進めてよい');
      expect(text).not.toContain('状態: 取り下げ済み');
    });
  });
});

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

  it('読めない継続中の依頼が在るとき、件数と kind を出す。読めた行は今までどおり出る（#2343）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      scheduleEntries: [
        { kind: 'daily-report', description: '日報', nextAt: '2026-08-20T00:00:00.000Z' },
      ],
      scheduleUnreadable: [{ kind: 'broken-1', reason: '不正な欄: spec' }, { reason: '不正な行' }],
    });

    await runSlashCommand('/schedule', client, emptyListed());

    const text = read();
    expect(text).toContain('daily-report');
    expect(text).toContain('読めない継続中の依頼が 2 件あります（kind: broken-1）');
    expect(text).toContain('壊れた行であって、消された依頼ではありません');
    expect(text).toContain('/unschedule <kind>');
  });

  it('読めた定期ジョブが0件でも、読めない行が在れば「仕込まれていません」とだけ言わない。0件のときは何も出さない（#2343）', async () => {
    const read = captureStdout();
    const only = stubClient({
      scheduleUnreadable: [{ kind: 'broken-1', reason: '不正な欄: spec' }],
    });
    await runSlashCommand('/schedule', only.client, emptyListed());
    const text = read();
    expect(text).toContain('（読めた定期ジョブは仕込まれていません）');
    expect(text).not.toContain('（定期ジョブは仕込まれていません）');
    expect(text).toContain('broken-1');

    const none = stubClient({});
    await runSlashCommand('/schedule', none.client, emptyListed());
    const textNone = read().slice(text.length);
    expect(textNone).toContain('（定期ジョブは仕込まれていません）');
    expect(textNone).not.toContain('読めない');
  });
});

describe('chat の /schedule-show', () => {
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const LONG = `長い依頼。${'あ'.repeat(200)}\n2行目の末尾 ${SECRET}`;
  const entries: ScheduleEntryLike[] = [
    {
      kind: 'follow-up',
      description: '継続中の依頼',
      nextAt: '2026-08-20T00:00:00.000Z',
      request: LONG,
      createdAt: '2026-08-15T00:00:00.000Z',
    },
    { kind: 'daily-report', description: '日報', nextAt: '2026-08-20T00:00:00.000Z' },
  ];

  it('依頼を切らずに全文で出し、伏せ字を掛ける。値の無い欄は出さない', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ scheduleEntries: entries });

    await runSlashCommand('/schedule-show follow-up', client, emptyListed());

    const text = read();
    expect(text).toContain('follow-up');
    expect(text).toContain('あ'.repeat(200));
    expect(text).toContain('2行目の末尾');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('createdAt: 2026-08-15T00:00:00.000Z');
    expect(text).not.toContain('undefined');
    expect(calls.map((call) => call.route)).toEqual(['GET /schedule']);
  });

  it('既定の定期ジョブ（依頼を持たない）も引ける', async () => {
    const read = captureStdout();
    const { client } = stubClient({ scheduleEntries: entries });

    await runSlashCommand('/schedule-show daily-report', client, emptyListed());

    expect(read()).toContain('description: 日報');
  });

  it('無い kind は無いと言い、読めない行は「無い」と言わない（#2343）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      scheduleEntries: entries,
      scheduleUnreadable: [{ kind: 'broken-1', reason: '不正な欄: spec' }],
    });

    await runSlashCommand('/schedule-show nope', client, emptyListed());
    const first = read();
    expect(first).toContain('nope という定期ジョブはありません');

    await runSlashCommand('/schedule-show broken-1', client, emptyListed());
    const text = read().slice(first.length);
    expect(text).toContain('broken-1 は在るが読めない形で入っている');
    expect(text).not.toContain('broken-1 という定期ジョブはありません');
  });

  it('kind が無い・多いときは使い方を言い、/help に載る', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({});

    await runSlashCommand('/schedule-show', client, emptyListed());
    await runSlashCommand('/schedule-show a b', client, emptyListed());
    expect(read()).toContain('使い方: /schedule-show <kind>');
    expect(calls).toEqual([]);

    const help = captureStdout();
    await runSlashCommand('/help', client, emptyListed());
    expect(help()).toContain('/schedule-show <kind>');
  });
});

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

  // `q=` はサーバへ投げる: 画面側・CLI 側で捨てると「出していないだけ」の層ができる
  it('q= をそのまま GET /journal のクエリへ渡す', async () => {
    captureStdout();
    const { calls, client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal q=トマト', client, emptyListed());

    expect(calls).toEqual([
      { route: 'GET /journal', args: { query: { limit: '20', q: 'トマト' } } },
    ]);
  });

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

  describe('/journal-show', () => {
    const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const LONG = `長い判断の理由。${'あ'.repeat(200)}\n2行目の末尾`;

    it('全欄を全文で出す（一覧の80字では切れない）', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({
        journalEntries: [
          {
            id: 'j-9',
            at: '2026-08-16T10:00:00.000Z',
            type: 'decision',
            decision: '自分で決めた',
            grounds: LONG,
          },
        ],
      });

      await runSlashCommand('/journal-show j-9', client, emptyListed());

      const text = read();
      expect(text).toContain('id: j-9');
      expect(text).toContain('あ'.repeat(200));
      expect(text).toContain('2行目の末尾');
      expect(text).toContain('自分で決めた');
      expect(calls).toEqual([{ route: 'GET /journal/:id', args: { param: { id: 'j-9' } } }]);
    });

    it('伏せ字を一覧と同じく掛ける（秘密は出ない）', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        journalEntries: [
          {
            id: 'j-s',
            at: '2026-08-16T10:00:00.000Z',
            type: 'exchange',
            text: `トークンは ${SECRET} です\n続き`,
          },
        ],
      });

      await runSlashCommand('/journal-show j-s', client, emptyListed());

      const text = read();
      expect(text).toContain('続き');
      expect(text).not.toContain(SECRET);
    });

    it('無い id は、無いと言う', async () => {
      const read = captureStdout();
      const { client } = stubClient({ journalEntries: [] });

      await runSlashCommand('/journal-show nope', client, emptyListed());

      expect(read()).toContain('日誌 nope は無い');
    });

    it('在るが読めない行（409）は「無い」と言わない', async () => {
      const read = captureStdout();
      const { client } = stubClient({ journalByIdStatus: 409 });

      await runSlashCommand('/journal-show bad-1', client, emptyListed());

      const text = read();
      expect(text).toContain('読めない形');
      expect(text).not.toContain('は無い');
    });

    it('id が無ければ使い方を言い、/help に載る', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({});

      await runSlashCommand('/journal-show', client, emptyListed());
      expect(read()).toContain('使い方: /journal-show <id>');
      expect(calls).toEqual([]);

      const help = captureStdout();
      await runSlashCommand('/help', client, emptyListed());
      expect(help()).toContain('/journal-show <id>');
    });
  });

  it('q= を渡さない既存の呼びは1文字も変わらない', async () => {
    captureStdout();
    const { calls, client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal 5', client, emptyListed());

    expect(calls).toEqual([{ route: 'GET /journal', args: { query: { limit: '5' } } }]);
  });

  it('q= で0件なら、探す対象に入っていない欄が在ることまで言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({ journalEntries: [] });

    await runSlashCommand('/journal q=ナス', client, emptyListed());

    const text = read();
    expect(text).toContain('「ナス」に当たる日誌はありません');
    expect(text).toContain('tool_use の input');
    expect(text).toContain(
      'tool_use の input・worker_wait・turn_usage・context_usage・inbox_flow・github_observation',
    );
    expect(text).not.toContain('日誌はまだ空');
  });

  describe('type=（issue #2073）', () => {
    it('type= をそのまま GET /journal のクエリへ渡す', async () => {
      captureStdout();
      const { calls, client } = stubClient({ journalEntries: [] });

      await runSlashCommand('/journal type=decision', client, emptyListed());

      expect(calls).toEqual([
        { route: 'GET /journal', args: { query: { limit: '20', type: 'decision' } } },
      ]);
    });

    it('カンマ区切りの複数種別をそのまま渡す', async () => {
      captureStdout();
      const { calls, client } = stubClient({ journalEntries: [] });

      await runSlashCommand('/journal type=decision,tool_use', client, emptyListed());

      expect(calls).toEqual([
        { route: 'GET /journal', args: { query: { limit: '20', type: 'decision,tool_use' } } },
      ]);
    });

    // デーモンへ問い合わせないことまで確かめる: 投げてから断ると、CLI 側の検査が死んでいてもデーモンの断りの文言で緑になる
    it('知らない type= はデーモンへ投げず、使える値を並べて断る', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({ journalEntries: [] });

      await runSlashCommand('/journal type=nonsense', client, emptyListed());

      expect(calls).toEqual([]);
      const text = read();
      expect(text).toContain('nonsense');
      for (const type of JOURNAL_ENTRY_TYPES) expect(text).toContain(type);
    });

    it('件数・type=・q= を併用しても、それぞれ正しく解ける', async () => {
      captureStdout();
      const { calls, client } = stubClient({ journalEntries: [] });

      await runSlashCommand('/journal 50 type=decision q=a b', client, emptyListed());

      expect(calls).toEqual([
        {
          route: 'GET /journal',
          args: { query: { limit: '50', type: 'decision', q: 'a b' } },
        },
      ]);
    });

    it('type= が先頭に来ても件数を誤読しない', async () => {
      captureStdout();
      const { calls, client } = stubClient({ journalEntries: [] });

      await runSlashCommand('/journal type=decision 50', client, emptyListed());

      expect(calls).toEqual([
        { route: 'GET /journal', args: { query: { limit: '50', type: 'decision' } } },
      ]);
    });

    it('type= だけで絞って0件なら、絞り込みのせいだと言う（「日誌はまだ空」ではない）', async () => {
      const read = captureStdout();
      const { client } = stubClient({ journalEntries: [] });

      await runSlashCommand('/journal type=decision', client, emptyListed());

      const text = read();
      expect(text).toContain('type=decision');
      expect(text).toContain('絞り込みを外せば');
      expect(text).not.toContain('日誌はまだ空');
    });

    it('type= と q= を併用して0件なら、両方の絞り込みを言う', async () => {
      const read = captureStdout();
      const { client } = stubClient({ journalEntries: [] });

      await runSlashCommand('/journal type=decision q=ナス', client, emptyListed());

      const text = read();
      expect(text).toContain('type=decision に絞った上で');
      expect(text).toContain('「ナス」に当たる日誌はありません');
    });

    it('/help に type= と、使える種別の全値が載っている', async () => {
      const read = captureStdout();
      const { client } = stubClient();

      await runSlashCommand('/help', client, emptyListed());

      const text = read();
      expect(text).toContain('/journal [件数] [type=');
      for (const type of JOURNAL_ENTRY_TYPES) expect(text).toContain(type);
    });
  });

  it('返った件数が上限（既定20件）ちょうどなら、これより古いかもしれないと言う', async () => {
    const read = captureStdout();
    const journalEntries = Array.from({ length: 20 }, (_, index) => ({
      id: `j-${index}`,
      at: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      type: 'decision',
      decision: `判断 ${index}`,
    }));
    const { client } = stubClient({ journalEntries });

    await runSlashCommand('/journal', client, emptyListed());

    expect(read()).toContain('直近 20 件のみ表示している。これより古い日誌があるかもしれない。');
  });

  it('上限に達していなければ、その断りは出さない（雑音にしない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      journalEntries: [{ id: 'j-1', at: '2026-08-16T10:00:00.000Z', type: 'decision' }],
    });

    await runSlashCommand('/journal', client, emptyListed());

    expect(read()).not.toContain('これより古い日誌があるかもしれない');
  });

  describe('issue #2016 — worker_wait / turn_usage / context_usage / inbox_flow の要約', () => {
    it('worker_wait は空欄ではなく、待った内訳を出す', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        journalEntries: [
          {
            id: 'j-ww',
            at: '2026-09-01T00:00:00.000Z',
            type: 'worker_wait',
            openedAt: '2026-08-31T23:00:00.000Z',
            tasks: 3,
            turns: 10,
            byCause: { input: 1, notification: 2, continuation: 7 },
            toolless: 4,
            notifications: 2,
            submits: 1,
            settled: true,
          },
        ],
      });

      await runSlashCommand('/journal', client, emptyListed());

      const text = read();
      expect(text).toContain('[worker_wait]');
      expect(text).toContain('作業者 3 体を待つあいだに 10 ターン');
      expect(text).toContain('自己継続 7');
      expect(text).toContain('道具を1つも動かしていない');
      expect(text).not.toMatch(/\[worker_wait\]\s*\n/);
    });

    it('turn_usage は空欄ではなく、cache read/write を出す', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        journalEntries: [
          {
            id: 'j-tu',
            at: '2026-09-01T00:05:00.000Z',
            type: 'turn_usage',
            layer: 'clone',
            site: 'session',
            managerId: 'clone',
            models: {
              'claude-fable-5': {
                inputTokens: 10,
                outputTokens: 20,
                cacheReadInputTokens: 120,
                cacheCreationInputTokens: 40,
                webSearchRequests: 0,
                costUsd: 0.5,
              },
            },
          },
        ],
      });

      await runSlashCommand('/journal', client, emptyListed());

      const text = read();
      expect(text).toContain('[turn_usage]');
      expect(text).toContain('read=120');
      expect(text).toContain('write=40');
      expect(text).not.toMatch(/\[turn_usage\]\s*\n/);
    });

    it('context_usage は空欄ではなく、成否と文脈占有を出す', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        journalEntries: [
          {
            id: 'j-cu',
            at: '2026-09-01T00:10:00.000Z',
            type: 'context_usage',
            layer: 'manager',
            site: 'session',
            managerId: 'mgr-1',
            turnSucceeded: false,
            contextUsage: { percentage: 42, totalTokens: 1000 },
          },
        ],
      });

      await runSlashCommand('/journal', client, emptyListed());

      const text = read();
      expect(text).toContain('[context_usage]');
      expect(text).toContain('ターン失敗');
      expect(text).toContain('文脈 42%');
      expect(text).not.toMatch(/\[context_usage\]\s*\n/);
    });

    it('inbox_flow は空欄ではなく、到着/配達/消し込み/滞留の4軸を出す', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        journalEntries: [
          {
            id: 'j-if',
            at: '2026-09-01T00:15:00.000Z',
            type: 'inbox_flow',
            windowStartedAt: '2026-09-01T00:00:00.000Z',
            arrived: { total: 5, byType: [] },
            delivered: { total: 4, byType: [] },
            settled: { total: 3, byType: [] },
            pending: { count: 2, oldestAt: '2026-09-01T00:00:00.000Z' },
          },
        ],
      });

      await runSlashCommand('/journal', client, emptyListed());

      const text = read();
      expect(text).toContain('[inbox_flow]');
      expect(text).toContain('到着5');
      expect(text).toContain('配達4');
      expect(text).toContain('消し込み3');
      expect(text).toContain('滞留2');
      expect(text).not.toMatch(/\[inbox_flow\]\s*\n/);
    });

    it('github_observation は空欄ではなく、repo・観測者・件数を出す。failed は理由を出し数を作らない（#2245）', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        journalEntries: [
          {
            id: 'j-go1',
            at: '2026-09-01T00:00:00.000Z',
            type: 'github_observation',
            observedBy: 'clone',
            repo: 'a/b',
            query: 'q',
            result: { status: 'ok', openIssues: 12, openPulls: 0, truncated: true },
          },
          {
            id: 'j-go2',
            at: '2026-09-01T00:01:00.000Z',
            type: 'github_observation',
            observedBy: 'mgr-1',
            repo: 'a/c',
            query: 'q',
            result: { status: 'failed', reason: 'gh: HTTP 502' },
          },
        ],
      });

      await runSlashCommand('/journal', client, emptyListed());

      const text = read();
      expect(text).toContain(
        'a/b（観測者 clone） open Issue 12 件 / open PR 0 件（limit に達した。下限）',
      );
      expect(text).toContain('a/c（観測者 mgr-1） 取れなかった: gh: HTTP 502');
      expect(text).not.toMatch(/\[github_observation\]\s*\n/);
      const failedLine = text.split('\n').find((l) => l.includes('a/c')) ?? '';
      expect(failedLine).not.toMatch(/open Issue|open PR/);
    });

    it('github_observation の CI: ci があれば内訳、ciUnavailable は理由、無ければ「観測していない」。0 と読ませない（#2549）', async () => {
      const read = captureStdout();
      const base = { type: 'github_observation', observedBy: 'clone', query: 'q' };
      const okR = { status: 'ok', openIssues: 1, openPulls: 2, truncated: false };
      const { client } = stubClient({
        journalEntries: [
          {
            ...base,
            id: 'j-ci1',
            at: '2026-09-01T00:00:00.000Z',
            repo: 'a/withci',
            result: {
              ...okR,
              ci: { pulls: 2, success: 1, failure: 1, pending: 0, checks: '必須チェックだけ' },
            },
          },
          {
            ...base,
            id: 'j-ci2',
            at: '2026-09-01T00:01:00.000Z',
            repo: 'a/unavail',
            result: { ...okR, ciUnavailable: 'HTTP 403' },
          },
          {
            ...base,
            id: 'j-ci3',
            at: '2026-09-01T00:02:00.000Z',
            repo: 'a/old',
            result: okR,
          },
        ],
      });

      await runSlashCommand('/journal', client, emptyListed());

      const lines = read().split('\n');
      const line = (repo: string) => lines.find((l) => l.includes(repo)) ?? '';
      expect(line('a/withci')).toContain('success 1 / failure 1 / pending 0');
      expect(line('a/withci')).toContain('必須チェックだけ');
      expect(line('a/unavail')).toContain('CI: 取れなかった — HTTP 403');
      expect(line('a/old')).toContain('CI: 観測していない');
      expect(line('a/old')).not.toMatch(/success|failure|pending/);
    });

    it('（陰性）escalation の要約は従来どおり素の質問文のまま変わらない', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        journalEntries: [
          {
            id: 'j-esc',
            at: '2026-09-01T00:20:00.000Z',
            type: 'escalation',
            approvalId: 'ap-1',
            question: '進めてよいですか？',
          },
        ],
      });

      await runSlashCommand('/journal', client, emptyListed());

      const text = read();
      expect(text).toContain('進めてよいですか？');
      expect(text).not.toContain('確認: ');
      expect(text).not.toContain('回答済: ');
    });

    it('（陰性）decision と tool_use の要約は従来どおり', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        journalEntries: [
          {
            id: 'j-dec',
            at: '2026-09-01T00:25:00.000Z',
            type: 'decision',
            decision: 'この案で進める',
            grounds: '費用が見合う',
          },
          {
            id: 'j-tool',
            at: '2026-09-01T00:26:00.000Z',
            type: 'tool_use',
            actor: 'clone',
            tool: 'memory_write',
          },
        ],
      });

      await runSlashCommand('/journal', client, emptyListed());

      const text = read();
      expect(text).toContain('この案で進める');
      expect(text).not.toContain('費用が見合う');
      expect(text).toContain('memory_write');
    });
  });
});

describe('chat の /usage（issue #2079）', () => {
  it('token= を GET /usage の tokenId へそのまま渡す（alteroid usage --token と同じ受け渡し）', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/usage token=tok-1', client, emptyListed());

    expect(calls).toEqual([{ route: 'GET /usage', args: { query: { tokenId: 'tok-1' } } }]);
  });

  it('from= / to= / manager= / layer= / site= / token= を併用してもそのまま渡す', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand(
      '/usage from=2026-08-01 to=2026-08-14 manager=mgr-1 layer=clone site=session token=tok-1',
      client,
      emptyListed(),
    );

    expect(calls).toEqual([
      {
        route: 'GET /usage',
        args: {
          query: {
            from: '2026-08-01',
            to: '2026-08-14',
            managerId: 'mgr-1',
            layer: 'clone',
            site: 'session',
            tokenId: 'tok-1',
          },
        },
      },
    ]);
  });

  it('/help に layer= / site= / token= と、使える layer / site の全値が載っている', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    const text = read();
    expect(text).toContain('[layer=');
    expect(text).toContain('[site=');
    expect(text).toContain('[token=');
    for (const layer of usageLayerSchema.options) expect(text).toContain(layer);
    for (const site of usageSiteSchema.options) expect(text).toContain(site);
  });

  it('to が from より前なら、renderUsage の出力の前に注記を書く', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      usageAggregate: {
        rows: [],
        turnRows: [],
        since: '2026-08-01T00:00:00.000Z',
        layersSince: '2026-08-01T00:00:00.000Z',
        tokensSince: '2026-08-01T00:00:00.000Z',
        beforeLedger: false,
        beforeLayers: false,
        beforeTokens: false,
        notice: USAGE_ESTIMATE_NOTICE,
        account: { state: 'unknown' },
        unrecordedManagers: [],
      },
    });

    await runSlashCommand('/usage from=2026-09-10 to=2026-09-01', client, emptyListed());

    const text = read();
    expect(
      text.startsWith(
        'to（2026-09-01）が from（2026-09-10）より前なので、この範囲には1日も入らない\n',
      ),
    ).toBe(true);
    expect(text).toContain('その範囲には記録が無い。');
  });

  it('to と from が同じ日なら注記を書かない', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      usageAggregate: {
        rows: [],
        turnRows: [],
        since: '2026-08-01T00:00:00.000Z',
        layersSince: '2026-08-01T00:00:00.000Z',
        tokensSince: '2026-08-01T00:00:00.000Z',
        beforeLedger: false,
        beforeLayers: false,
        beforeTokens: false,
        notice: USAGE_ESTIMATE_NOTICE,
        account: { state: 'unknown' },
        unrecordedManagers: [],
      },
    });

    await runSlashCommand('/usage from=2026-09-01 to=2026-09-01', client, emptyListed());

    expect(read()).not.toContain('より前なので');
  });
});

describe('chat の /reports（一覧）', () => {
  it('返った件数が上限（既定14件）ちょうどなら、これより古いかもしれないと言う', async () => {
    const read = captureStdout();
    const reports = Array.from({ length: 14 }, (_, index) => ({
      date: `2026-06-${String(index + 1).padStart(2, '0')}`,
      at: `2026-06-${String(index + 1).padStart(2, '0')}T22:00:00.000Z`,
      body: `${index} 日目の進捗`,
    }));
    const { client } = stubClient({ reports });

    await runSlashCommand('/reports', client, emptyListed());

    expect(read()).toContain('直近 14 件のみ表示している。これより古い日報があるかもしれない。');
  });

  it('上限に達していなければ、その断りは出さない（雑音にしない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      reports: [{ date: '2026-06-01', at: '2026-06-01T22:00:00.000Z', body: '進捗' }],
    });

    await runSlashCommand('/reports', client, emptyListed());

    expect(read()).not.toContain('これより古い日報があるかもしれない');
  });

  it('件数を指定したときも、その上限ちょうどで断りが出る', async () => {
    const read = captureStdout();
    const reports = Array.from({ length: 5 }, (_, index) => ({
      date: `2026-06-${String(index + 1).padStart(2, '0')}`,
      at: `2026-06-${String(index + 1).padStart(2, '0')}T22:00:00.000Z`,
      body: `${index} 日目の進捗`,
    }));
    const { client } = stubClient({ reports });

    await runSlashCommand('/reports 5', client, emptyListed());

    expect(read()).toContain('直近 5 件のみ表示している。これより古い日報があるかもしれない。');
  });
});

describe('chat の /stop', () => {
  it('id を指定すると、その1本だけを止める', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/stop mgr-1', client, emptyListed(), null, undefined, confirmYes);

    expect(calls).toEqual([
      { route: 'DELETE /managers/:id', args: { param: { id: 'mgr-1' }, json: {} } },
    ]);
    expect(read()).toContain('stopped: mgr-1 を止めた');
  });

  it('理由を書けば、そのまま送る（日誌に「なぜ」が残る）', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand(
      '/stop mgr-1 同じ issue に2本立っている',
      client,
      emptyListed(),
      null,
      undefined,
      confirmYes,
    );

    expect(calls[0]?.args).toEqual({
      param: { id: 'mgr-1' },
      json: { reason: '同じ issue に2本立っている' },
    });
  });

  it('理由を書かなければ、空文字を送らない（書き忘れと区別が付かなくなる）', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/stop mgr-1    ', client, emptyListed(), null, undefined, confirmYes);

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

    await runSlashCommand('/stop mgr-none', client, emptyListed(), null, undefined, confirmYes);

    const text = read();
    expect(text).toContain('見つかりませんでした');
    expect(text).not.toContain('stopped');
  });

  it('404 以外はサーバの理由（{ error }）をそのまま出し、「見つかりません」とは言わない', async () => {
    const serverError = captureStdout();
    const { client: serverErrorClient } = stubClient({
      abortStatus: 500,
      abortBody: { error: '委譲の停止が失敗した（issue #2172 のテスト用）' },
    });
    await runSlashCommand(
      '/stop mgr-1',
      serverErrorClient,
      emptyListed(),
      null,
      undefined,
      confirmYes,
    );
    const serverErrorText = serverError();
    vi.restoreAllMocks();

    const badRequest = captureStdout();
    const { client: badRequestClient } = stubClient({
      abortStatus: 400,
      abortBody: { error: '理由が長すぎる（issue #2172 のテスト用）' },
    });
    await runSlashCommand(
      '/stop mgr-1',
      badRequestClient,
      emptyListed(),
      null,
      undefined,
      confirmYes,
    );
    const badRequestText = badRequest();

    expect(serverErrorText).toContain('委譲の停止が失敗した（issue #2172 のテスト用）');
    expect(badRequestText).toContain('理由が長すぎる（issue #2172 のテスト用）');
    expect(serverErrorText).not.toContain('見つかりませんでした');
    expect(badRequestText).not.toContain('見つかりませんでした');
  });

  it('/help に載っている（隠れた口を作らない）', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    expect(read()).toContain('/stop ');
  });

  it('/managers の番号でも指せる（既存の id 直書きは壊れていない）', async () => {
    const { calls, client } = stubClient();
    const listed: Listed = { ...emptyListed(), managers: ['mgr-a', 'mgr-b'] };
    captureStdout();

    await runSlashCommand('/stop 2', client, listed, null, undefined, confirmYes);

    expect(calls).toEqual([
      { route: 'DELETE /managers/:id', args: { param: { id: 'mgr-b' }, json: {} } },
    ]);
  });
});

describe('chat の /conversations と /conversation', () => {
  it('/conversations は未読のある会話の行に、conversations list と同じ未読の印を付ける（#3219）', async () => {
    const read = captureStdout();
    const row = (conversationId: string, unreadCount?: number) => ({
      conversationId,
      startedAt: '2026-08-16T10:00:00.000Z',
      updatedAt: '2026-08-16T10:05:00.000Z',
      messages: 4,
      preview: 'p',
      ...(unreadCount === undefined ? {} : { unreadCount }),
    });
    const { client } = stubClient({
      conversations: [row('conv-unread', 3), row('conv-read', 0), row('conv-unknown')],
    });

    await runSlashCommand('/conversations', client, emptyListed());

    const lines = read().split('\n');
    expect(lines.find((l) => l.includes('conv-unread'))?.endsWith(unreadMark(3))).toBe(true);
    expect(lines.find((l) => l.includes('conv-read'))).not.toContain('未読');
    expect(lines.find((l) => l.includes('conv-unknown'))).not.toContain('未読');
  });

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
    expect(text).toContain('作成: 2026-08-16T10:00:00.000Z');
    expect(text).toContain('更新: 2026-08-16T10:05:00.000Z');
    expect(text).toContain('137');
    expect(text).toContain('/conversation <番号|id>');
    expect(text).toContain('alteroid conversations list --scan');
    expect(text).toContain('--limit');
    expect(text).not.toContain('先頭には届いていない');
    expect(text).not.toContain('…ほか');
  });

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
    expect(text).not.toContain('limit=<N> を増やせば');
    expect(text).not.toContain('先頭には届いていない');
  });

  it('/conversations は cursor=<…> をそのまま渡す', async () => {
    captureStdout();
    const { calls, client } = stubClient({ conversations: [] });

    await runSlashCommand('/conversations cursor=abc.DEF_-1=', client, emptyListed());

    expect(calls).toEqual([
      { route: 'GET /conversations', args: { query: { cursor: 'abc.DEF_-1=' } } },
    ]);
  });

  it('/conversations は nextCursor が在れば、続きの打ち方を出す', async () => {
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
      conversationsNextCursor: 'next-token',
    });

    await runSlashCommand('/conversations', client, emptyListed());

    const text = read();
    expect(text).toContain('続きを読むには: /conversations cursor=next-token');
    expect(text).not.toContain('limit=<N> を増やせば');
  });

  it('/conversations は nextCursor が無ければ、続きの案内を出さない', async () => {
    const read = captureStdout();
    const { client } = stubClient({ conversations: [], conversationsScanned: 5 });

    await runSlashCommand('/conversations', client, emptyListed());

    expect(read()).not.toContain('続きを読むには');
  });

  it('/conversations は空でも、そう言う（黙って何も出さない形にしない）', async () => {
    const read = captureStdout();
    const { client } = stubClient({ conversations: [], conversationsScanned: 5000 });

    await runSlashCommand('/conversations', client, emptyListed());

    const text = read();
    expect(text).toContain('会話はまだありません');
    expect(text).toContain('5000');
    expect(text).toContain('判定できません');
    expect(text).toContain('alteroid conversations list --scan');
  });

  describe('未読の総数の1行（alteroid conversations list と同じ fetchUnreadTotalLine）', () => {
    it('未読のある会話の総数を出す（一覧の外の分も含む）', async () => {
      const read = captureStdout();
      const { client } = stubClient({ unreadCountBody: { count: 7, capped: false } });
      await runSlashCommand('/conversations', client, emptyListed());
      expect(read()).toContain('未読のある会話 7 件');
      expect(read()).not.toContain('取れませんでした');
    });

    it('capped のときは下限として「N 件以上」と言う', async () => {
      const read = captureStdout();
      const { client } = stubClient({ unreadCountBody: { count: 99, capped: true } });
      await runSlashCommand('/conversations', client, emptyListed());
      expect(read()).toContain('未読のある会話 99 件以上');
    });

    it('総数が 500 でも一覧は出し、取れなかったと1行で言う', async () => {
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
        unreadCountStatus: 500,
      });
      await runSlashCommand('/conversations', client, emptyListed());
      const text = read();
      expect(text).toContain('conv-1');
      expect(text).toContain('未読のある会話の総数は取れませんでした（HTTP 500）');
      expect(text).not.toMatch(/未読のある会話 \d+ 件/);
    });

    it('古いデーモン（404）でも一覧は出し、口が無いと言う', async () => {
      const read = captureStdout();
      const { client } = stubClient({ unreadCountStatus: 404 });
      await runSlashCommand('/conversations', client, emptyListed());
      const text = read();
      expect(text).toContain('会話はまだありません');
      expect(text).toContain('古い版');
    });

    it('通信が途切れて総数だけ失敗しても、一覧は出す', async () => {
      const read = captureStdout();
      const { client } = stubClient({ unreadCountThrows: new Error('socket hang up') });
      await runSlashCommand('/conversations', client, emptyListed());
      const text = read();
      expect(text).toContain('会話はまだありません');
      expect(text).toContain('取れませんでした（socket hang up）');
    });
  });

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

  it('/conversation は承認待ち・台帳の番号を掴まない（覚え場所が別であること）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed: Listed = {
      ...emptyListed(),
      approvals: ['approval-1'],
      commitments: ['cmt-1'],
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

  describe('/conversation — その会話のターンから積まれた承認（#3261）', () => {
    const detail = {
      conversationId: 'conv-1',
      messages: [
        { id: 'm1', at: '2026-10-06T10:00:00.000Z', role: 'inbound' as const, text: 'どうする？' },
        {
          id: 'm2',
          at: '2026-10-06T10:04:00.000Z',
          role: 'outbound' as const,
          text: 'A案で進めます',
        },
      ],
      scanned: 10,
      reachedStart: true,
    };

    it('承認を時刻順の位置に1行で出し、回答のあとの返答は承認の後ろに並ぶ', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({
        conversationDetailBody: detail,
        approvals: [
          {
            id: 'abcdef12-3456',
            createdAt: '2026-10-06T10:01:00.000Z',
            question: 'A案とB案のどちらにしますか？',
            answeredAt: '2026-10-06T10:03:00.000Z',
            answer: 'A案',
          },
        ],
      });

      await runSlashCommand('/conversation conv-1', client, emptyListed());

      const approvalCall = calls.find((call) => call.route === 'GET /approvals');
      expect(approvalCall?.args).toEqual({
        query: { conversationId: 'conv-1', pending: 'false', order: 'asc' },
      });
      const text = read();
      const line =
        '? [2026-10-06T10:01:00.000Z] 確認（承認待ち abcdef12）: A案とB案のどちらにしますか？ ' +
        '→ 回答済み（2026-10-06T10:03:00.000Z）: A案';
      expect(text).toContain(line);
      expect(text.indexOf('どうする？')).toBeLessThan(text.indexOf(line));
      expect(text.indexOf(line)).toBeLessThan(text.indexOf('A案で進めます'));
    });

    it('承認を取れなくても会話は出し、取れなかったことを言う（unreadable も言う）', async () => {
      const read = captureStdout();
      const failing = stubClient({ conversationDetailBody: detail, approvalsStatus: 500 });
      await runSlashCommand('/conversation conv-1', failing.client, emptyListed());
      const failed = read();
      expect(failed).toContain('A案で進めます');
      expect(failed).toContain('この会話の承認待ちは取れませんでした');

      const unreadable = stubClient({
        conversationDetailBody: detail,
        approvalsUnreadable: [{ id: 'bad-1', reason: 'x' }],
      });
      await runSlashCommand('/conversation conv-1', unreadable.client, emptyListed());
      expect(read()).toContain('読めない承認待ちが 1 件');
    });

    it('承認の行には /edit の番号を振らない', async () => {
      captureStdout();
      const listed = emptyListed();
      const { client } = stubClient({
        conversationDetailBody: detail,
        approvals: [{ id: 'ap-0000001', createdAt: '2026-10-06T10:01:00.000Z', question: 'q' }],
      });
      await runSlashCommand('/conversation conv-1', client, listed);
      expect(listed.messages).toEqual(['m1']);
    });
  });

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
    expect(text).toContain('/edit <番号|id>');
  });

  it('チャットの編集で畳まれた版があれば、付けなくても件数を言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      conversationDetailBody: {
        conversationId: 'conv-1',
        messages: [{ id: 'm2', at: '2026-08-16T10:02:00.000Z', role: 'inbound', text: '直した文' }],
        scanned: 5,
        reachedStart: true,
        supersededCount: 1,
      },
    });

    await runSlashCommand('/conversation conv-1', client, emptyListed());

    expect(read()).toContain('畳まれた版が 1 件ある');
  });

  it('畳まれた版が0件なら、その注記は出ない', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      conversationDetailBody: {
        conversationId: 'conv-1',
        messages: [
          { id: 'm1', at: '2026-08-16T10:00:00.000Z', role: 'inbound', text: '設計どうする？' },
        ],
        scanned: 5,
        reachedStart: true,
        supersededCount: 0,
      },
    });

    await runSlashCommand('/conversation conv-1', client, emptyListed());

    expect(read()).not.toContain('畳まれた版が');
  });

  it('includeSuperseded=true で畳まれた発言も出し、置き換え関係が読める', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({
      conversationDetailBody: {
        conversationId: 'conv-1',
        messages: [
          {
            id: 'm1',
            at: '2026-08-16T10:00:00.000Z',
            role: 'inbound',
            text: '元の文',
            supersededBy: 'm3',
          },
          {
            id: 'm2',
            at: '2026-08-16T10:01:00.000Z',
            role: 'outbound',
            text: '元の応答',
            supersededBy: 'm3',
          },
          {
            id: 'm3',
            at: '2026-08-16T10:02:00.000Z',
            role: 'inbound',
            text: '直した文',
            supersedes: 'm1',
          },
        ],
        scanned: 5,
        reachedStart: true,
        supersededCount: 2,
      },
    });
    const listed = emptyListed();

    await runSlashCommand('/conversation conv-1 includeSuperseded=true', client, listed);

    const query = calls.find((call) => call.route === 'GET /conversations/:id')?.args as {
      query: Record<string, string>;
    };
    expect(query.query.includeSuperseded).toBe('true');
    const text = read();
    expect(text).toContain('元の文');
    expect(text).toContain('畳まれた版 → m3 に置き換えられた');
    expect(text).toContain('編集後の発言 — m1 を置き換えた');
    expect(listed.messages).toEqual(['m3']);
  });
});

describe('chat の /edit（送信済みの自分の発言を編集する）', () => {
  const target: Target = {
    baseUrl: 'http://127.0.0.1:4517',
    headers: { authorization: 'Bearer token' },
    remote: false,
    note: null,
  };

  let originalFetch: typeof fetch;
  let sent: { url: string; body: unknown }[];

  function stubEditFetch(reply: { status: number; body?: unknown }): void {
    originalFetch = globalThis.fetch;
    sent = [];
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (!url.endsWith('/chat')) return Promise.resolve(new Response('{}', { status: 404 }));
      sent.push({ url, body });
      const ok = reply.status >= 200 && reply.status < 300;
      const text = ok ? 'event: done\ndata: {"type":"done"}\n\n' : JSON.stringify(reply.body);
      return Promise.resolve(
        new Response(text, {
          status: reply.status,
          headers: { 'content-type': ok ? 'text/event-stream' : 'application/json' },
        }),
      );
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function conversationWithMessages() {
    return stubClient({
      conversationDetailBody: {
        conversationId: 'conv-1',
        messages: [
          { id: 'm1', at: '2026-08-16T10:00:00.000Z', role: 'inbound', text: '前の文' },
          { id: 'm2', at: '2026-08-16T10:01:00.000Z', role: 'outbound', text: '応答' },
        ],
        scanned: 5,
        reachedStart: true,
        supersededCount: 0,
      },
    });
  }

  it('番号を id へ解決し、supersedes 付きで POST /chat を叩く', async () => {
    stubEditFetch({ status: 200 });
    const { client } = conversationWithMessages();
    const listed = emptyListed();
    captureStdout();

    await runSlashCommand('/conversation conv-1', client, listed);
    expect(listed.messages).toEqual(['m1']);
    await runSlashCommand('/edit 1 直した文', client, listed, null, target);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/chat');
    expect(sent[0]?.body).toEqual({
      text: '直した文',
      conversationId: 'conv-1',
      supersedes: 'm1',
      clientMessageId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
    });
  });

  it('添付つきの発言を編集すると、新しい版にも元の添付の id を付けて送る（#3630。Web の #3399 と同じ）', async () => {
    stubEditFetch({ status: 200 });
    const attachment = (id: string) => ({
      id,
      name: `${id}.csv`,
      mediaType: 'text/csv',
      size: 12,
      sha256: 'x',
    });
    const { client } = stubClient({
      conversationDetailBody: {
        conversationId: 'conv-1',
        messages: [
          {
            id: 'm1',
            at: '2026-08-16T10:00:00.000Z',
            role: 'inbound',
            text: 'この表を見て',
            attachments: [attachment('att-1'), attachment('att-2')],
          },
          { id: 'm3', at: '2026-08-16T10:02:00.000Z', role: 'inbound', text: '添付なし' },
        ],
        scanned: 2,
        reachedStart: true,
        supersededCount: 0,
      },
    });
    const listed = emptyListed();
    const read = captureStdout();

    await runSlashCommand('/conversation conv-1', client, listed);
    expect(read()).toContain('att-1');
    await runSlashCommand('/edit 1 合計だけ出して', client, listed, null, target);
    await runSlashCommand('/edit 2 添付は付けない', client, listed, null, target);

    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toMatchObject({ supersedes: 'm1', attachments: ['att-1', 'att-2'] });
    expect(sent[1]?.body).not.toHaveProperty('attachments');
  });

  it('id をそのまま指しても解決する（番号を経由しなくてよい）', async () => {
    stubEditFetch({ status: 200 });
    const { client } = conversationWithMessages();
    const listed = emptyListed();
    captureStdout();

    await runSlashCommand('/conversation conv-1', client, listed);
    await runSlashCommand('/edit m1 直した文', client, listed, null, target);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ supersedes: 'm1' });
  });

  it('クローンの応答を指すと（id を直に打っても）、サーバの理由がそのまま出る', async () => {
    stubEditFetch({
      status: 400,
      body: { error: 'supersedes はクローンの応答ではなく人間の発言だけを指せる' },
    });
    const { client } = conversationWithMessages();
    const listed = emptyListed();
    const read = captureStdout();

    await runSlashCommand('/conversation conv-1', client, listed);
    expect(listed.messages).toEqual(['m1']);

    await runSlashCommand('/edit m2 それでも編集を試す', client, listed, null, target);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ supersedes: 'm2' });
    expect(read()).toContain('クローンの応答ではなく人間の発言だけを指せる');
  });

  it('番号が /conversation の一覧に無ければ、送らずに案内する', async () => {
    stubEditFetch({ status: 200 });
    const { client } = conversationWithMessages();
    const listed = emptyListed();
    const read = captureStdout();

    await runSlashCommand('/conversation conv-1', client, listed);
    await runSlashCommand('/edit 9 直した文', client, listed, null, target);

    expect(sent).toHaveLength(0);
    expect(read()).toContain('一覧にありません');
  });

  it('まだ /conversation を開いていなければ、先に開くよう案内する', async () => {
    stubEditFetch({ status: 200 });
    const read = captureStdout();

    await runSlashCommand(
      '/edit m1 直した文',
      {} as unknown as Parameters<typeof runSlashCommand>[1],
      emptyListed(),
      null,
      target,
    );

    expect(sent).toHaveLength(0);
    expect(read()).toContain('/conversation');
  });

  it('本文が無ければ使い方を出す', async () => {
    stubEditFetch({ status: 200 });
    const read = captureStdout();

    await runSlashCommand(
      '/edit 1',
      {} as unknown as Parameters<typeof runSlashCommand>[1],
      emptyListed(),
      null,
      target,
    );

    expect(sent).toHaveLength(0);
    expect(read()).toContain('使い方: /edit');
  });
});

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

  it('/managers の直後に /reply 1 を打っても、マネージャーの id が requestId として使われない', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient();
    const listed: Listed = { ...emptyListed(), managers: ['mgr-a', 'mgr-b'] };

    await runSlashCommand('/reply 1 わかりました', client, listed);

    expect(calls.filter((call) => call.route === 'POST /managers/:id/messages')).toEqual([]);
    expect(read()).toContain('/waiting の一覧にありません');
  });

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

describe('chat の /managers が読めない委譲を「居ない」と言わない（#2345）', () => {
  it('読めない行が在れば、読めた一覧の後に断りを出す。本文は出さない', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      managers: [manager({ managerId: 'mgr-ok' })],
      managersUnreadable: [{ id: 'mgr-bad', reason: '不正な欄: status' }, { reason: '不正な行' }],
    });

    await runSlashCommand('/managers', client, emptyListed());

    const out = read();
    expect(out).toContain('mgr-ok');
    expect(out).toContain('⚠ 読めない委譲が 2 件あります（id: mgr-bad）');
    expect(out).toContain('居ないのでも、畳まれたのでもありません');
    expect(out).not.toContain('不正な欄');
  });

  it('読めた行が0件でも「マネージャーは1本も居ません」と言わない', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      managers: [],
      managersUnreadable: [{ id: 'mgr-bad', reason: '不正な欄: status' }],
    });

    await runSlashCommand('/managers', client, emptyListed());

    const out = read();
    expect(out).not.toContain('マネージャーは1本も居ません');
    expect(out).toContain('居ないとは言えません');
    expect(out).toContain('読めない委譲が 1 件あります');
  });

  it('対照: 鍵が無ければ（0件）、断りは出ず、0件の文言は従来どおり', async () => {
    const read = captureStdout();
    const { client } = stubClient({ managers: [] });

    await runSlashCommand('/managers', client, emptyListed());

    const out = read();
    expect(out).toContain('（マネージャーは1本も居ません）');
    expect(out).not.toContain('読めない');
  });
});

describe('chat の /managers の絞り込みと窓（#670）', () => {
  // `toEqual({})` で締める: デーモンは生のクエリの有無で opt-in を判定するので、`{ status: undefined }` を渡すと opt-in に倒れうる
  it('引数なしの /managers は、クエリを1つも渡さない（既定は現状維持）', async () => {
    captureStdout();
    const { calls, client } = stubClient({ managers: [manager()] });

    await runSlashCommand('/managers', client, emptyListed());

    expect(calls.filter((call) => call.route === 'GET /managers')).toEqual([
      { route: 'GET /managers', args: { query: {} } },
    ]);
  });

  it('status= と limit= をそのままデーモンへ渡す', async () => {
    captureStdout();
    const { calls, client } = stubClient({ managers: [manager()] });

    await runSlashCommand('/managers status=running,waiting_human limit=20', client, emptyListed());

    expect(calls.filter((call) => call.route === 'GET /managers')).toEqual([
      {
        route: 'GET /managers',
        args: { query: { status: 'running,waiting_human', limit: '20' } },
      },
    ]);
  });

  it('status= で絞った0件は、絞りを名指しする文言になる（#2203）', async () => {
    const read = captureStdout();
    const { client } = stubClient({ managers: [] });

    await runSlashCommand('/managers status=done', client, emptyListed());

    const text = read();
    expect(text).toContain(
      'status=done に当たるマネージャーは居ません（絞り込みを外せば見えるかもしれません）',
    );
    expect(text).not.toContain('（マネージャーは1本も居ません）');
  });

  // デーモンへ問い合わせないことまで確かめる: 投げてから断ると、CLI 側の検査が死んでいても 400 の文言で緑になる
  it('知らない status= はデーモンへ投げず、使える値を並べて断る', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ managers: [manager()] });

    await runSlashCommand('/managers status=runing', client, emptyListed());

    expect(calls.filter((call) => call.route === 'GET /managers')).toEqual([]);
    const text = read();
    expect(text).toContain('runing');
    expect(text).toContain('waiting_human');
    expect(text).toContain('stopped');
  });

  it('after=<番号> を、直前の一覧の startedAt と組にして渡す', async () => {
    captureStdout();
    const { calls, client } = stubClient({
      managers: [
        manager({ managerId: 'mgr-a', startedAt: '2026-09-01T00:00:00.000Z' }),
        manager({ managerId: 'mgr-b', startedAt: '2026-08-31T00:00:00.000Z' }),
      ],
    });
    const listed = emptyListed();

    await runSlashCommand('/managers limit=2', client, listed);
    await runSlashCommand('/managers limit=2 after=2', client, listed);

    const gets = calls.filter((call) => call.route === 'GET /managers');
    expect(gets[1]).toEqual({
      route: 'GET /managers',
      args: {
        query: {
          limit: '2',
          afterId: 'mgr-b',
          afterStartedAt: '2026-08-31T00:00:00.000Z',
        },
      },
    });
  });

  it('after=<id> でも指せる（番号だけの口にしない）', async () => {
    captureStdout();
    const { calls, client } = stubClient({
      managers: [manager({ managerId: 'mgr-a', startedAt: '2026-09-01T00:00:00.000Z' })],
    });
    const listed = emptyListed();

    await runSlashCommand('/managers limit=1', client, listed);
    await runSlashCommand('/managers limit=1 after=mgr-a', client, listed);

    const gets = calls.filter((call) => call.route === 'GET /managers');
    expect(gets[1]).toEqual({
      route: 'GET /managers',
      args: {
        query: { limit: '1', afterId: 'mgr-a', afterStartedAt: '2026-09-01T00:00:00.000Z' },
      },
    });
  });

  it('直前の一覧に無い after= は、デーモンへ投げずに断る', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ managers: [manager({ managerId: 'mgr-a' })] });

    await runSlashCommand('/managers after=mgr-zzz', client, emptyListed());

    expect(calls.filter((call) => call.route === 'GET /managers')).toEqual([]);
    expect(read()).toContain('直前の /managers の一覧にありません');
  });

  it('錨は毎回の一覧で作り直す（前の一覧の行を起点にできない）', async () => {
    const read = captureStdout();
    const first = stubClient({ managers: [manager({ managerId: 'mgr-old' })] });
    const listed = emptyListed();
    await runSlashCommand('/managers', first.client, listed);
    expect(listed.managerAnchors).toEqual({ 'mgr-old': '2026-08-16T10:00:00.000Z' });

    const second = stubClient({ managers: [manager({ managerId: 'mgr-new' })] });
    await runSlashCommand('/managers', second.client, listed);

    expect(listed.managerAnchors).toEqual({ 'mgr-new': '2026-08-16T10:00:00.000Z' });
    read();

    const third = stubClient({ managers: [manager()] });
    await runSlashCommand('/managers after=mgr-old', third.client, listed);
    expect(third.calls.filter((call) => call.route === 'GET /managers')).toEqual([]);
  });

  it('limit 件ちょうど返ったら、その事実と続きの打ち方（status= 込み）を出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      managers: [manager({ managerId: 'mgr-a' }), manager({ managerId: 'mgr-b' })],
    });

    await runSlashCommand('/managers status=running limit=2', client, emptyListed());

    const text = read();
    expect(text).toContain('limit=2 件ちょうど返った');
    expect(text).toContain('/managers status=running limit=2 after=2');
  });

  it('limit に届かなければ注記を出さない（終端を黙って作らない側の裏）', async () => {
    const read = captureStdout();
    const { client } = stubClient({ managers: [manager()] });

    await runSlashCommand('/managers limit=5', client, emptyListed());

    expect(read()).not.toContain('ちょうど返った');
  });

  it('limit= 無しなら、件数が一致しても注記を出さない', async () => {
    const read = captureStdout();
    const { client } = stubClient({ managers: [manager()] });

    await runSlashCommand('/managers', client, emptyListed());

    expect(read()).not.toContain('ちょうど返った');
  });

  it('デーモンの 400 の本文をそのまま出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      managersStatus: 400,
      managersBody: {
        error: 'afterId/afterStartedAt が指す行が見当たらない（mgr-x / 2026-09-01）',
      },
    });
    const listed: Listed = {
      ...emptyListed(),
      managers: ['mgr-x'],
      managerAnchors: { 'mgr-x': '2026-09-01T00:00:00.000Z' },
    };

    await runSlashCommand('/managers after=mgr-x', client, listed);

    expect(read()).toContain('afterId/afterStartedAt が指す行が見当たらない');
  });

  it('本文が読めない失敗では、状態コードを言う', async () => {
    const read = captureStdout();
    const { client } = stubClient({ managersStatus: 503, managersBody: { oops: true } });

    await runSlashCommand('/managers', client, emptyListed());

    expect(read()).toContain('HTTP 503');
  });

  it('失敗しても、直前の一覧の番号と錨を捨てない', async () => {
    captureStdout();
    const { client } = stubClient({ managersStatus: 400 });
    const listed: Listed = {
      ...emptyListed(),
      managers: ['mgr-a'],
      managerAnchors: { 'mgr-a': '2026-09-01T00:00:00.000Z' },
    };

    await runSlashCommand('/managers status=runing', client, listed);

    expect(listed.managers).toEqual(['mgr-a']);
    expect(listed.managerAnchors).toEqual({ 'mgr-a': '2026-09-01T00:00:00.000Z' });
  });

  // `/waiting` は絞らない: waiting が空でない行の status が必ず waiting_human とは確かめていないので、絞ると答えれば進む確認が黙って消えうる
  it('/help に status= / limit= / after= と、使える status の全値が載っている', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    const text = read();
    expect(text).toContain('/managers [status=');
    expect(text).toContain('limit=<N>');
    expect(text).toContain('after=<番号|id>');
    for (const status of jobStatusSchema.options) expect(text).toContain(status);
  });

  it('/waiting は status も窓も渡さない', async () => {
    captureStdout();
    const { calls, client } = stubClient({
      managers: [manager({ waiting: [waitingItem()] })],
    });

    await runSlashCommand('/waiting', client, emptyListed());

    expect(calls.filter((call) => call.route === 'GET /managers')).toEqual([
      { route: 'GET /managers', args: { query: {} } },
    ]);
  });
});

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

  it('待ちが1件以上あるヒントに、/allow /deny が [番号|requestId]（省略可）と、1本だけなら番号無しの案内を持つ', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      managers: [manager({ waiting: [waitingItem()] })],
    });

    await runSlashCommand('/waiting', client, emptyListed());

    const text = read();
    expect(text).toContain('/allow /deny [番号|requestId] [理由]');
    expect(text).toContain('1本だけなら番号無しでも打てます');
  });
});

// `requestId` も `decision` も付けない: 確認待ちのときに追加指示が回答として消費されてしまうため
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

  it('404 なら見つからないと言い、それ以外はサーバの理由をそのまま出す', async () => {
    const notFound = captureStdout();
    const { client: notFoundClient } = stubClient({
      messagesStatus: 404,
      messagesBody: { error: 'そんな id は無い' },
    });
    await runSlashCommand('/msg mgr-none 明日までに終わらせて', notFoundClient, emptyListed());
    const notFoundText = notFound();
    vi.restoreAllMocks();

    const serverError = captureStdout();
    const { client: serverErrorClient } = stubClient({
      messagesStatus: 500,
      messagesBody: { error: '追加指示の配送が失敗した（issue #2172 のテスト用）' },
    });
    await runSlashCommand('/msg mgr-1 明日までに終わらせて', serverErrorClient, emptyListed());
    const serverErrorText = serverError();
    vi.restoreAllMocks();

    const badRequest = captureStdout();
    const { client: badRequestClient } = stubClient({
      messagesStatus: 400,
      messagesBody: { error: '本文が長すぎる（issue #2172 のテスト用）' },
    });
    await runSlashCommand('/msg mgr-1 明日までに終わらせて', badRequestClient, emptyListed());
    const badRequestText = badRequest();

    expect(notFoundText).toContain('見つかりませんでした');
    expect(serverErrorText).toContain('追加指示の配送が失敗した（issue #2172 のテスト用）');
    expect(badRequestText).toContain('本文が長すぎる（issue #2172 のテスト用）');
    expect(serverErrorText).not.toContain('見つかりませんでした');
    expect(badRequestText).not.toContain('見つかりませんでした');
  });
});

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

  // 推測しない: 同じ `requestId` を複数のマネージャーが持つことは否定できないので、2件以上見つかったらどちらへも送らず両方の `managerId` を出す
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

  it('404 なら見つからないと言い、それ以外はサーバの理由をそのまま出す', async () => {
    const listed: Listed = {
      ...emptyListed(),
      waiting: [{ managerId: 'mgr-a', requestId: 'req-1' }],
    };

    const notFound = captureStdout();
    const { client: notFoundClient } = stubClient({
      messagesStatus: 404,
      messagesBody: { error: 'そんな id は無い' },
    });
    await runSlashCommand('/reply 1 了解です', notFoundClient, listed);
    const notFoundText = notFound();
    vi.restoreAllMocks();

    const serverError = captureStdout();
    const { client: serverErrorClient } = stubClient({
      messagesStatus: 500,
      messagesBody: { error: '回答の配送が失敗した（issue #2172 のテスト用）' },
    });
    await runSlashCommand('/reply 1 了解です', serverErrorClient, listed);
    const serverErrorText = serverError();
    vi.restoreAllMocks();

    const badRequest = captureStdout();
    const { client: badRequestClient } = stubClient({
      messagesStatus: 400,
      messagesBody: { error: '本文が長すぎる（issue #2172 のテスト用）' },
    });
    await runSlashCommand('/reply 1 了解です', badRequestClient, listed);
    const badRequestText = badRequest();

    expect(notFoundText).toContain('見つかりませんでした');
    expect(serverErrorText).toContain('回答の配送が失敗した（issue #2172 のテスト用）');
    expect(badRequestText).toContain('本文が長すぎる（issue #2172 のテスト用）');
    expect(serverErrorText).not.toContain('見つかりませんでした');
    expect(badRequestText).not.toContain('見つかりませんでした');
  });
});

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

  it('引数ありは、404 なら見つからないと言い、それ以外はサーバの理由をそのまま出す', async () => {
    const listed: Listed = {
      ...emptyListed(),
      waiting: [{ managerId: 'mgr-a', requestId: 'req-1' }],
    };

    const notFound = captureStdout();
    const { client: notFoundClient } = stubClient({
      messagesStatus: 404,
      messagesBody: { error: 'そんな id は無い' },
    });
    await runSlashCommand('/allow 1', notFoundClient, listed);
    const notFoundText = notFound();
    vi.restoreAllMocks();

    const serverError = captureStdout();
    const { client: serverErrorClient } = stubClient({
      messagesStatus: 500,
      messagesBody: { error: '許可の配送が失敗した（issue #2172 のテスト用）' },
    });
    await runSlashCommand('/allow 1', serverErrorClient, listed);
    const serverErrorText = serverError();
    vi.restoreAllMocks();

    const badRequest = captureStdout();
    const { client: badRequestClient } = stubClient({
      messagesStatus: 400,
      messagesBody: { error: '理由が長すぎる（issue #2172 のテスト用）' },
    });
    await runSlashCommand('/deny 1 だめです', badRequestClient, listed);
    const badRequestText = badRequest();

    expect(notFoundText).toContain('見つかりませんでした');
    expect(serverErrorText).toContain('許可の配送が失敗した（issue #2172 のテスト用）');
    expect(badRequestText).toContain('理由が長すぎる（issue #2172 のテスト用）');
    expect(serverErrorText).not.toContain('見つかりませんでした');
    expect(badRequestText).not.toContain('見つかりませんでした');
  });

  it('引数なしは、404 なら見つからないと言い、それ以外はサーバの理由をそのまま出す', async () => {
    const managers = [
      manager({ managerId: 'mgr-solo', waiting: [waitingItem({ requestId: 'req-solo' })] }),
    ];

    const notFound = captureStdout();
    const { client: notFoundClient } = stubClient({
      managers,
      messagesStatus: 404,
      messagesBody: { error: 'そんな id は無い' },
    });
    await runSlashCommand('/allow', notFoundClient, emptyListed());
    const notFoundText = notFound();
    vi.restoreAllMocks();

    const serverError = captureStdout();
    const { client: serverErrorClient } = stubClient({
      managers,
      messagesStatus: 500,
      messagesBody: { error: '許可の配送が失敗した（issue #2172 のテスト用）' },
    });
    await runSlashCommand('/allow', serverErrorClient, emptyListed());
    const serverErrorText = serverError();

    expect(notFoundText).toContain('見つかりませんでした');
    expect(serverErrorText).toContain('許可の配送が失敗した（issue #2172 のテスト用）');
    expect(serverErrorText).not.toContain('見つかりませんでした');
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

  it('/help の /allow /deny が [番号|requestId]（省略可）の形と、番号無しの説明を持つ', async () => {
    const read = captureStdout();
    const { client } = stubClient();

    await runSlashCommand('/help', client, emptyListed());

    const text = read();
    expect(text).toContain('/allow [番号|requestId]');
    expect(text).toContain('/deny  [番号|requestId]');
    expect(text).toContain('番号・requestId を省くと');
    expect(text).toContain('返事待ちのマネージャーが1本だけ');
    expect(text).toContain('2本以上なら送らずに候補を出す');
  });
});

describe('parseSSEChunk', () => {
  it('コメント行だけの塊は読み飛ばす（デーモンの heartbeat を画面に出さない）', () => {
    expect(parseSSEChunk(': hb')).toBeNull();
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

describe('chat の /approvals（並びを実装によらず揃える）', () => {
  it('order=asc を明示して呼ぶ。窓（limit / cursor）は作らない', async () => {
    captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand('/approvals', client, emptyListed());

    const listCalls = calls.filter((call) => call.route === 'GET /approvals');
    expect(listCalls).toHaveLength(1);
    const query = (listCalls[0]?.args as { query: Record<string, unknown> }).query;
    expect(query.order).toBe('asc');
    // 窓は作らない: 送ると頁が切れる側へ倒れ、窓の大きさの未決を黙って埋めることになる
    expect(query.limit).toBeUndefined();
    expect(query.cursor).toBeUndefined();
  });
});

describe('chat の /archive', () => {
  it('一覧に大きさ(storedBytes)と時刻(at)を出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      archiveEntries: [
        {
          id: 'sess-1-2026-08-20T00-00-00-000Z.jsonl',
          sessionId: 'sess-1',
          at: '2026-08-20T00:00:00.000Z',
          storedBytes: 1234,
        },
      ],
    });

    await runSlashCommand('/archive', client, emptyListed());

    const text = read();
    expect(text).toContain('sess-1-2026-08-20T00-00-00-000Z.jsonl');
    expect(text).toContain('1234バイト');
    expect(text).toContain('2026-08-20T00:00:00.000Z');
  });

  it('本文が削除済み(removedAt あり)の行にはその旨を出す', async () => {
    const read = captureStdout();
    const { client } = stubClient({
      archiveEntries: [
        {
          id: 'sess-2-2026-08-20T00-00-00-000Z.jsonl',
          sessionId: 'sess-2',
          at: '2026-08-20T00:00:00.000Z',
          storedBytes: 0,
          removedAt: '2026-08-21T00:00:00.000Z',
          removedBytes: 999,
        },
      ],
    });

    await runSlashCommand('/archive', client, emptyListed());

    expect(read()).toContain('本文は削除済み');
  });

  it('/archive sessions は sessionId ごとの行数・使用量を出す（⭐ 依頼の動機そのもの）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({
      archiveSessions: [
        {
          sessionId: 'sess-repeated',
          rows: 68,
          storedBytes: 999,
          maxStoredBytes: 500,
          firstAt: '2026-08-01T00:00:00.000Z',
          lastAt: '2026-08-20T00:00:00.000Z',
        },
      ],
    });

    await runSlashCommand('/archive sessions', client, emptyListed());

    const text = read();
    expect(text).toContain('sess-repeated');
    expect(text).toContain('行数: 68');
    expect(text).toContain('999バイト');
    expect(text).toContain('500バイト');
    expect(calls.map((call) => call.route)).toContain('GET /archive/sessions');
    expect(calls.map((call) => call.route)).not.toContain('GET /archive');
  });

  it('/archive <id> は本文を出す（従来どおり）', async () => {
    const read = captureStdout();
    const { calls, client } = stubClient({ archiveReadBody: 'RAW LOG\n' });

    await runSlashCommand('/archive sess-1-xyz.jsonl', client, emptyListed());

    expect(read()).toContain('RAW LOG');
    expect(calls.map((call) => call.route)).toContain('GET /archive/:id');
  });

  describe('/archive remove', () => {
    it('引数なしは使い方を出すだけで叩かない', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient();

      await runSlashCommand('/archive remove', client, emptyListed());

      expect(read()).toContain('使い方');
      expect(calls.map((call) => call.route)).not.toContain('DELETE /archive/:id');
    });

    it('消せたら結果（バイト数）を出す。理由を付けずに叩く', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({
        archiveRemoveBody: { ok: true, id: 'sess-1.jsonl', bytes: 1234, alreadyRemoved: false },
      });

      await runSlashCommand(
        '/archive remove sess-1.jsonl',
        client,
        emptyListed(),
        null,
        undefined,
        confirmYes,
      );

      expect(read()).toContain('消しました');
      expect(read()).toContain('1234バイト');
      const call = calls.find((entry) => entry.route === 'DELETE /archive/:id');
      expect(call).toBeDefined();
      const args = call?.args as { param: { id: string }; query: Record<string, unknown> };
      expect(args.param.id).toBe('sess-1.jsonl');
      expect(args.query).toStrictEqual({});
    });

    it('消したバイト数には、置き場で解放した量ではないという単位の断りが付く（#2074）', async () => {
      for (const alreadyRemoved of [false, true]) {
        const read = captureStdout();
        const { client } = stubClient({
          archiveRemoveBody: { ok: true, id: 'sess-1.jsonl', bytes: 1234, alreadyRemoved },
        });

        await runSlashCommand(
          '/archive remove sess-1.jsonl',
          client,
          emptyListed(),
          null,
          undefined,
          confirmYes,
        );

        expect(read(), `alreadyRemoved=${String(alreadyRemoved)}`).toContain(
          '置き場で解放した量ではなく',
        );
        expect(read(), `alreadyRemoved=${String(alreadyRemoved)}`).toContain('storedBytes');
      }
    });

    it('前から消されていた（alreadyRemoved）はその旨を出す', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        archiveRemoveBody: { ok: true, id: 'sess-1.jsonl', bytes: 1234, alreadyRemoved: true },
      });

      await runSlashCommand(
        '/archive remove sess-1.jsonl',
        client,
        emptyListed(),
        null,
        undefined,
        confirmYes,
      );

      expect(read()).toContain('前から消されていました');
    });

    it('無い id は 404。「消した」とは言わない', async () => {
      const read = captureStdout();
      const { client } = stubClient({ archiveRemoveStatus: 404 });

      await runSlashCommand(
        '/archive remove no-such-id.jsonl',
        client,
        emptyListed(),
        null,
        undefined,
        confirmYes,
      );

      const text = read();
      expect(text).toContain('その生ログはありません');
      expect(text).not.toContain('消しました');
    });

    it('走行中マネージャーの退避は409。サーバの断り文言と、理由付きで打ち直す案内を出す', async () => {
      const read = captureStdout();
      const { client } = stubClient({
        archiveRemoveStatus: 409,
        archiveRemoveBody: {
          error:
            '走行中のマネージャー mgr-1 の退避なので消せない（overrideReason クエリ引数に理由を書けば通せる）',
        },
      });

      await runSlashCommand(
        '/archive remove sess-1.jsonl',
        client,
        emptyListed(),
        null,
        undefined,
        confirmYes,
      );

      const text = read();
      expect(text).toContain('走行中のマネージャー mgr-1 の退避なので消せない');
      expect(text).toContain('/archive remove sess-1.jsonl <理由>');
      expect(text).not.toContain('消しました');
    });

    it('404・409 以外はサーバの理由（{ error }）をそのまま出す', async () => {
      const serverError = captureStdout();
      const { client: serverErrorClient } = stubClient({
        archiveRemoveStatus: 500,
        archiveRemoveBody: { error: '生ログの削除が失敗した（archive remove のテスト用）' },
      });
      await runSlashCommand(
        '/archive remove sess-1.jsonl',
        serverErrorClient,
        emptyListed(),
        null,
        undefined,
        confirmYes,
      );
      const serverErrorText = serverError();
      vi.restoreAllMocks();

      const badRequest = captureStdout();
      const { client: badRequestClient } = stubClient({
        archiveRemoveStatus: 400,
        archiveRemoveBody: { error: 'overrideReason が長すぎる（archive remove のテスト用）' },
      });
      await runSlashCommand(
        '/archive remove sess-1.jsonl',
        badRequestClient,
        emptyListed(),
        null,
        undefined,
        confirmYes,
      );
      const badRequestText = badRequest();

      expect(serverErrorText).toContain('生ログの削除が失敗した（archive remove のテスト用）');
      expect(badRequestText).toContain('overrideReason が長すぎる（archive remove のテスト用）');
      expect(serverErrorText).not.toContain('消せませんでした');
      expect(badRequestText).not.toContain('消せませんでした');
    });

    it('理由を付けて打ち直すと overrideReason を送り、override した旨を出す', async () => {
      const read = captureStdout();
      const { calls, client } = stubClient({
        archiveRemoveBody: {
          ok: true,
          id: 'sess-1.jsonl',
          bytes: 1234,
          alreadyRemoved: false,
          override: { managerId: 'mgr-1', reason: '本番障害の調査で緊急に消す必要があった' },
        },
      });

      await runSlashCommand(
        '/archive remove sess-1.jsonl 本番障害の調査で緊急に消す必要があった',
        client,
        emptyListed(),
        null,
        undefined,
        confirmYes,
      );

      const text = read();
      expect(text).toContain('override');
      expect(text).toContain('mgr-1');
      expect(text).toContain('本番障害の調査で緊急に消す必要があった');
      const call = calls.find((entry) => entry.route === 'DELETE /archive/:id');
      const args = call?.args as { query: Record<string, unknown> };
      expect(args.query).toStrictEqual({
        overrideReason: '本番障害の調査で緊急に消す必要があった',
      });
    });
  });
});

describe('戻せない操作の確認（REPL。#3141）', () => {
  const declined = async (): Promise<boolean> => false;

  it.each([
    ['/stop mgr-1', 'DELETE /managers/:id'],
    ['/archive remove sess-1.jsonl', 'DELETE /archive/:id'],
  ])('%s: 確認で承認しなければ、叩かずにやめる', async (line, route) => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand(line, client, emptyListed(), null, undefined, declined);

    expect(calls.some((entry) => entry.route === route)).toBe(false);
    expect(read()).not.toContain('消しました');
  });

  it.each([
    ['/stop mgr-1', 'DELETE /managers/:id'],
    ['/archive remove sess-1.jsonl', 'DELETE /archive/:id'],
  ])('%s: 確認の口が渡されていなければ、確認できないので叩かない', async (line, route) => {
    const read = captureStdout();
    const { calls, client } = stubClient();

    await runSlashCommand(line, client, emptyListed());

    expect(calls.some((entry) => entry.route === route)).toBe(false);
    expect(read()).toContain('何も変更していません');
  });

  it('確認の文は、何が戻らないかを言う（止める対象・消す対象を含む）', async () => {
    captureStdout();
    const { client } = stubClient();
    const summaries: string[] = [];
    const record = async (summary: string): Promise<boolean> => {
      summaries.push(summary);
      return false;
    };

    await runSlashCommand('/stop mgr-1', client, emptyListed(), null, undefined, record);
    await runSlashCommand(
      '/archive remove sess-1.jsonl',
      client,
      emptyListed(),
      null,
      undefined,
      record,
    );

    expect(summaries[0]).toContain('mgr-1');
    expect(summaries[1]).toContain('sess-1.jsonl');
    expect(summaries[1]).toContain('戻りません');
  });
});

describe('chat の既読（返答を表示したとき）', () => {
  const target: Target = {
    baseUrl: 'http://127.0.0.1:4517',
    headers: { authorization: 'Bearer token' },
    remote: false,
    note: null,
  };
  let originalFetch: typeof fetch;
  let requests: { method: string; url: string; body: unknown }[];

  function stubFetch(sse: string, readStatus = 200): void {
    originalFetch = globalThis.fetch;
    requests = [];
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const raw = init?.body ?? (input instanceof Request ? input.body : undefined);
      requests.push({ method, url, body: typeof raw === 'string' ? JSON.parse(raw) : undefined });
      const json = (body: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (url.endsWith('/chat')) {
        return Promise.resolve(
          new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      }
      if (url.endsWith('/read')) {
        return readStatus === 200
          ? json({ readThrough: 't', unreadCount: 0 })
          : json({ error: '既読にできない理由' }, readStatus);
      }
      return json({
        conversationId: 'c1',
        messages: [
          { id: 'm1', at: 't1', role: 'inbound', text: '質問' },
          { id: 'm2', at: 't2', role: 'outbound', text: '答え' },
        ],
        scanned: 2,
        reachedStart: true,
        supersededCount: 0,
      });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const frame = (name: string, data: unknown) =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const reply =
    frame('open', { conversationId: 'c1' }) +
    frame('text', { text: '答え\n' }) +
    frame('done', { type: 'done' });
  const readRequests = () => requests.filter((r) => r.url.endsWith('/read'));

  it('返答が done まで表示されたら、取り直した最後の発言の id で既読にする', async () => {
    stubFetch(reply);
    captureStdout();
    const id = await sendMessage(target, '質問', null);
    expect(id).toBe('c1');
    expect(readRequests()).toEqual([
      {
        method: 'POST',
        url: 'http://127.0.0.1:4517/conversations/c1/read',
        body: { through: 'm2' },
      },
    ]);
  });

  it('done が来ない（接続が切れた）なら既読にしない', async () => {
    stubFetch(frame('open', { conversationId: 'c1' }) + frame('text', { text: '途中' }));
    captureStdout();
    await sendMessage(target, '質問', null);
    expect(requests.filter((r) => !r.url.endsWith('/chat'))).toEqual([]);
  });

  it('error で終わったら既読にしない', async () => {
    stubFetch(reply + frame('error', { message: '失敗' }));
    captureStdout();
    await sendMessage(target, '質問', null);
    expect(requests.filter((r) => !r.url.endsWith('/chat'))).toEqual([]);
  });

  it('既読の要求が失敗しても、返答は残り会話 id も返り、1 行だけ知らせる', async () => {
    stubFetch(reply, 500);
    const read = captureStdout();
    const id = await sendMessage(target, '質問', null);
    expect(id).toBe('c1');
    const text = read();
    expect(text).toContain('答え');
    expect(text).toContain('この会話を既読にできませんでした');
    expect(text).toContain('既読にできない理由');
  });
});

describe('chat のスラッシュコマンドは、知らないキー・空の値・使わない語を使い方の誤りとして断る', () => {
  it.each([
    ['/usage mgr=abc', '/usage', 'mgr='],
    ['/usage form=2026-10-01', '/usage', 'form='],
    ['/usage manager=', '/usage', 'manager='],
    ['/usage foo', '/usage', 'foo'],
    ['/managers statuss=failed', '/managers', 'statuss='],
    ['/managers limit=', '/managers', 'limit='],
    ['/managers after=', '/managers', 'after='],
    ['/managers foo', '/managers', 'foo'],
    ['/conversations limt=5', '/conversations', 'limt='],
    ['/conversations limit=', '/conversations', 'limit='],
    ['/conversations foo', '/conversations', 'foo'],
    ['/conversation c1 scn=5', '/conversation', 'scn='],
    ['/conversation c1 scan=', '/conversation', 'scan='],
    ['/conversation c1 foo', '/conversation', 'foo'],
    ['/journal 50 foo', '/journal', 'foo'],
    ['/journal limt=5', '/journal', 'limt='],
    ['/journal type=', '/journal', 'type='],
    ['/journal q=', '/journal', 'q='],
    ['/approvals foo', '/approvals', 'foo'],
    ['/approvals all foo', '/approvals', 'foo'],
    ['/approvals answered limt=3', '/approvals', 'limt='],
    ['/approvals answered limit=', '/approvals', 'limit='],
  ])(
    '%s は何も実行せず、誤りの語と使えるものを言い、失敗として知らせる',
    async (line, command, culprit) => {
      const read = captureStdout();
      const { calls, client } = stubClient();
      const reasons: string[] = [];

      const result = await runSlashCommand(
        line,
        client,
        emptyListed(),
        null,
        undefined,
        undefined,
        (reason) => reasons.push(reason),
      );

      expect(result).toBe('ok');
      expect(calls).toEqual([]);
      const text = read();
      expect(text).toContain(culprit);
      expect(text).toContain('使えるのは');
      expect(reasons).toEqual([`使い方の誤り（${command}）`]);
    },
  );

  it('値の中の = は値として残す（/conversations cursor= は不透明な継続点を受ける）', async () => {
    captureStdout();
    const { calls, client } = stubClient({ conversations: [], conversationsScanned: 0 });

    await runSlashCommand('/conversations cursor=abc==', client, emptyListed());

    expect(calls).toEqual([{ route: 'GET /conversations', args: { query: { cursor: 'abc==' } } }]);
  });

  it('知らない layer= の値も、使い方の誤りとして失敗を知らせる', async () => {
    captureStdout();
    const { calls, client } = stubClient();
    const reasons: string[] = [];

    await runSlashCommand(
      '/usage layer=nonsense',
      client,
      emptyListed(),
      null,
      undefined,
      undefined,
      (reason) => reasons.push(reason),
    );

    expect(calls).toEqual([]);
    expect(reasons).toEqual(['使い方の誤り（/usage）']);
  });
});
