import { describe, expect, it } from 'vitest';

import { ApprovalsController, type DetailState } from './approvals-controller.js';
import { emptyForm, toggleOption } from './approvals-form.js';
import {
  answeredDateLine,
  answeredDayLine,
  approvalDocument,
  approvalListLine,
  approvalListTitle,
  approvalStatusText,
  composerPlaceholder,
} from './approvals-view.js';
import { approvalRow, fakeApi } from './fake-api.js';
import { cellWidth } from './wrap.js';

const NOW = Date.parse('2026-10-02T01:00:00.000Z');

const questions = [
  {
    id: 'q1',
    prompt: 'デプロイ先',
    options: [
      { id: 'a', label: 'Railway', recommended: true },
      { id: 'b', label: 'Fly', description: '東京リージョン' },
    ],
  },
];

function detailOf(patch: Partial<DetailState> = {}): DetailState {
  return {
    id: 'ap-1',
    approval: approvalRow('ap-1', { questions, question: '質問の全文です' }),
    missing: false,
    mode: 'read',
    form: null,
    confirm: null,
    busy: false,
    notice: null,
    noticeTone: 'info',
    error: null,
    loadedAt: NOW,
    ...patch,
  };
}

describe('一覧の 1 行', () => {
  it('設問が在れば設問の要約が先頭、無ければ質問の抜粋。改行は潰して長いものは切る', () => {
    const withQuestions = approvalListLine(
      approvalRow('ap-1', { questions, question: '一行目\n二行目' }),
      NOW,
    );
    expect(withQuestions).toContain('設問 1 件（選択肢つき）  一行目 二行目');
    const free = approvalListLine(approvalRow('ap-2', { question: 'あ'.repeat(300) }), NOW);
    expect(free).toContain(`${'あ'.repeat(120)}…`);
    expect(free).not.toContain('設問');
  });

  it('出どころ（マネージャーかクローンか）と、実行許可の印が出る', () => {
    expect(approvalListLine(approvalRow('ap-1', { jobId: 'mgr-xyz' }), NOW)).toContain('[mgr-xyz]');
    expect(approvalListLine(approvalRow('ap-1'), NOW)).toContain('[クローン]');
    expect(
      approvalListLine(
        approvalRow('ap-1', { permissionRequest: { rule: 'Bash(ls:*)', allows: [], denies: [] } }),
        NOW,
      ),
    ).toContain('[実行許可]');
  });
});

describe('詳細の本文', () => {
  it('読む画面: 質問の全文・設問の表示（core の describeQuestionLines）が出る', () => {
    const doc = approvalDocument(detailOf(), 80);
    const text = doc.rows.map((r) => r.text).join('\n');
    expect(text).toContain('質問の全文です');
    expect(text).toContain('Q1 [id=q1] デプロイ先（単一選択・その他を書ける）');
    expect(text).toContain('[id=a] Railway［推奨］');
    expect(text).toContain('[id=b] Fly — 東京リージョン');
    expect(doc.focusRow).toBeNull();
  });

  it('どの行も端末の幅を越えない（全角は 2 セル）', () => {
    const detail = detailOf({
      approval: approvalRow('ap-1', {
        questions,
        question: 'これはとても長い質問の文章です。'.repeat(8),
        context: 'context '.repeat(30),
      }),
    });
    for (const width of [40, 80]) {
      for (const row of approvalDocument(detail, width).rows) {
        expect(cellWidth(row.text)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('フォーム: カーソル行に印が付き、選んだ選択肢は埋まる。複数選択は [x]', () => {
    const q = questions[0];
    if (q === undefined) throw new Error('fixture');
    const form = { ...toggleOption(emptyForm(1), q, 'b') };
    const doc = approvalDocument(detailOf({ mode: 'form', form }), 80);
    const lines = doc.rows.map((r) => r.text);
    const focus = doc.focusRow;
    expect(focus).not.toBeNull();
    expect(lines[focus ?? -1]).toContain('❯ (●) b) Fly — 東京リージョン');
    expect(lines.find((l) => l.includes('Railway'))).toContain('( ) a) Railway［推奨］');
    expect(lines.some((l) => l.includes('その他: （Space で書く）'))).toBe(true);
    expect(lines.some((l) => l.includes('補足（任意）'))).toBe(true);

    const multi = [{ ...q, multiple: true }];
    const multiDoc = approvalDocument(
      detailOf({
        approval: approvalRow('ap-1', { questions: multi }),
        mode: 'form',
        form: toggleOption(emptyForm(0), multi[0] ?? q, 'a'),
      }),
      80,
    );
    expect(multiDoc.rows.some((r) => r.text.includes('[x] a) Railway'))).toBe(true);
  });

  it('allowOther が false の設問には「その他」の行が無い', () => {
    const closed = [
      { ...(questions[0] ?? { id: 'q', prompt: 'p', options: [] }), allowOther: false },
    ];
    const doc = approvalDocument(
      detailOf({
        approval: approvalRow('ap-1', { questions: closed }),
        mode: 'form',
        form: emptyForm(),
      }),
      80,
    );
    expect(doc.rows.some((r) => r.text.includes('その他'))).toBe(false);
  });

  it('確認: 畳んだ文をそのまま出し、未回答が在れば警告する', () => {
    const doc = approvalDocument(
      detailOf({
        mode: 'confirm',
        confirm: { preview: 'Q1 デプロイ先: 未回答', unanswered: 1 },
      }),
      80,
    );
    const text = doc.rows.map((r) => r.text).join('\n');
    expect(text).toContain('この内容で答える?');
    expect(text).toContain('Q1 デプロイ先: 未回答');
    expect(text).toContain('答えていない設問が 1 件ある');
  });

  it('回答済み・取り下げ済みはその旨と回答/理由を出し、答える案内は出さない', () => {
    const answered = approvalDocument(
      detailOf({
        approval: approvalRow('ap-1', { answeredAt: '2026-10-02T02:00:00.000Z', answer: '済み' }),
      }),
      80,
    )
      .rows.map((r) => r.text)
      .join('\n');
    expect(answered).toContain('[回答済み] ap-1');
    expect(answered).toContain('済み');
    expect(answered).not.toContain('a で');
    const withdrawn = approvalDocument(
      detailOf({
        approval: approvalRow('ap-1', { withdrawnAt: '2026-10-02T02:00:00.000Z' }),
      }),
      80,
    )
      .rows.map((r) => r.text)
      .join('\n');
    expect(withdrawn).toContain('[取り下げ済み] ap-1');
    expect(withdrawn).toContain('（理由の記録なし）');
  });
});

describe('最下行と入力欄', () => {
  it('確認 > 操作の結果 > 取り直しの失敗 > 窓の外 の順', () => {
    expect(approvalStatusText(detailOf({ mode: 'confirm', notice: 'x' }), 3).text).toContain(
      'y で送る',
    );
    expect(approvalStatusText(detailOf({ notice: '結果' }), 0)).toEqual({
      text: '結果',
      tone: 'dim',
    });
    expect(approvalStatusText(detailOf({ notice: '✗ 400', noticeTone: 'warn' }), 0).tone).toBe(
      'warn',
    );
    expect(approvalStatusText(detailOf({ error: '失敗' }), 3).text).toContain('取り直せなかった');
    expect(approvalStatusText(detailOf(), 3).text).toContain('あと 3 行');
    expect(approvalStatusText(detailOf(), 0).text).toBe(' ');
    expect(approvalStatusText(detailOf({ approval: null, missing: true }), 0).text).toContain(
      '見つからない',
    );
  });

  it('操作の結果が残っていても、取り直しの失敗と窓の外の行数を隠さない（#3368）', () => {
    // notice は詳細を閉じるまで消えない。後ろの状態を隠すと、取り直しが止まっていても健全に見える。
    expect(approvalStatusText(detailOf({ notice: '結果', error: '失敗' }), 0)).toEqual({
      text: '結果 · ⚠ 取り直せなかった: 失敗',
      tone: 'warn',
    });
    expect(approvalStatusText(detailOf({ notice: '結果' }), 3)).toEqual({
      text: '結果 · ↓ あと 3 行',
      tone: 'dim',
    });
    expect(approvalStatusText(detailOf({ notice: '結果', error: '失敗' }), 3)).toEqual({
      text: '結果 · ⚠ 取り直せなかった: 失敗 · ↓ あと 3 行',
      tone: 'warn',
    });
  });

  it('入力欄のプレースホルダは、いま何を書く欄かを言う', () => {
    expect(composerPlaceholder(detailOf({ busy: true }))).toBe('送信中…');
    expect(composerPlaceholder(detailOf())).toContain('a で答える');
    // 回答済み・取り下げ済みはもう答えられないので、a を案内しない。
    const settled = composerPlaceholder(
      detailOf({ approval: approvalRow('ap-1', { answeredAt: '2026-09-30T10:00:00.000Z' }) }),
    );
    expect(settled).not.toContain('a で答える');
    expect(settled).toContain('答えられない');
    expect(composerPlaceholder(detailOf({ mode: 'form', form: emptyForm(2) }))).toContain(
      '「その他」',
    );
    expect(composerPlaceholder(detailOf({ mode: 'form', form: emptyForm(3) }))).toContain('補足');
    expect(
      composerPlaceholder(
        detailOf({
          approval: approvalRow('ap-1'),
          mode: 'form',
          form: emptyForm(0),
        }),
      ),
    ).toContain('回答を書く');
  });
});

describe('一覧の見出し', () => {
  it('初回の読み込みが失敗したときは、0 件と言わず「空ではない」と言う', async () => {
    const api = fakeApi();
    const controller = new ApprovalsController(api);
    api.approvalRows = [approvalRow('a')];
    // 最初の呼びで失敗させる。
    api.listApprovals = () => Promise.reject(new Error('繋がらない'));
    await controller.reload();
    const list = controller.store.getSnapshot().list;
    expect(list.status).toBe('error');
    const title = approvalListTitle(list);
    expect(title).toContain('空ではない');
    expect(title).not.toContain('0 件');
  });

  it('読めて 0 件なら件数を言う', () => {
    const list = { ...new ApprovalsController(fakeApi()).store.getSnapshot().list };
    expect(approvalListTitle({ ...list, status: 'ready' })).toContain('未回答 0 件');
  });
});

describe('回答済みの一覧の行（#3340）', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z');

  it('日付の行は日付と件数', () => {
    expect(answeredDateLine({ date: '2026-09-30', count: 3 })).toBe('2026-09-30  3 件');
  });

  it('回答済みは状態・答えの抜粋、取り下げ済みは取り下げと理由。全文は載せない', () => {
    const long = 'あ'.repeat(300);
    const a = answeredDayLine(
      approvalRow('ap-a', {
        question: `問い\n二行目${long}`,
        answeredAt: '2026-09-30T10:00:00.000Z',
        answer: long,
      }),
      now,
    );
    expect(a).toContain('回答済み');
    expect(a).toContain('ap-a');
    expect(a).toContain('回答: ');
    expect(a).not.toContain('\n');
    expect(a).not.toContain(long);

    const w = answeredDayLine(
      approvalRow('ap-w', {
        withdrawnAt: '2026-09-30T05:00:00.000Z',
        withdrawnReason: '自分で答えを見つけた',
      }),
      now,
    );
    expect(w).toContain('取り下げ済み');
    expect(w).not.toContain('回答済み');
    expect(w).toContain('取り下げた理由: 自分で答えを見つけた');
    expect(
      answeredDayLine(approvalRow('ap-w2', { withdrawnAt: '2026-09-30T05:00:00.000Z' }), now),
    ).toContain('（理由の記録なし）');
  });
});
