import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { ApprovalsController } from './approvals-controller.js';
import { ApprovalList, approvalDocument, approvalListLine } from './approvals-view.js';
import { ConversationPicker } from './components.js';
import {
  approvalRow,
  fakeApi,
  journalEntry,
  managerRow,
  memoryDoc,
  memoryRow,
} from './fake-api.js';
import { JournalController } from './journal-controller.js';
import { journalListLine } from './journal-format.js';
import { JournalDetailHead, JournalList } from './journal-view.js';
import { ManagersController } from './managers-controller.js';
import {
  DetailStatusRow,
  ManagerDetailHead,
  ManagerList,
  detailStatusText,
  managerListLine,
} from './managers-view.js';
import { MemoryController } from './memory-controller.js';
import {
  MemoryDetailHead,
  MemoryList,
  memoryDescriptionLine,
  memoryTitleLine,
} from './memory-view.js';
import { renderFullscreen } from './test-helpers.js';

/**
 * 外から来た文字列の制御文字（BEL・BS・NUL・`\r`・C1 の U+009B）が、掃除を通らずに端末へ
 * 抜けないことを測る。Ink が自分で落とすものには頼らない: 描いた全フレームの生の書き込みを調べる。
 * 新しいテストに実時間の待ちは無い（描画は同期、操作は await するだけ）。
 */
const CSI8 = String.fromCharCode(0x9b);
/** 掃除すると `abcdef` になる。 */
const EVIL = `a\u0007b\u0008c\u0000d\re${CSI8}2Jf`;
const CLEAN = 'abcdef';

// eslint-disable-next-line no-control-regex -- 制御文字の検出そのものが目的
const CONTROL = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f-\u009f\r]/;

/** Ink が自分で書く SGR / CSI を除いた、全フレームの書き込み。 */
function written(stdout: { frames: string[] }): string {
  return (
    stdout.frames
      // eslint-disable-next-line no-control-regex -- Ink 自身の装飾を除く
      .map((f) => f.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''))
      .join('\n')
  );
}

function expectNoControl(text: string): void {
  expect(text).not.toMatch(CONTROL);
}

function draw(element: Parameters<typeof renderFullscreen>[0]): string {
  const { app, stdout, lastFrame } = renderFullscreen(element, 24, 160);
  const frame = lastFrame();
  const raw = written(stdout);
  app.unmount();
  expectNoControl(raw);
  return frame;
}

describe('記憶の一覧と詳細', () => {
  it('title・slug・kind・要旨・更新の欄の制御文字を端末へ出さない', async () => {
    const api = fakeApi();
    api.memoryRows = [
      memoryRow(`s${EVIL}`, {
        title: `t${EVIL}`,
        kind: `k${EVIL}` as never,
        description: `d${EVIL}`,
        updatedAt: `u${EVIL}`,
      }),
    ];
    api.memoryDocs[`s${EVIL}`] = {
      ...memoryDoc(`s${EVIL}`, '本文'),
      updatedAt: `u${EVIL}`,
    };
    const controller = new MemoryController(api, { debounceMs: 5 });
    await controller.loadList();
    const state = controller.store.getSnapshot();
    const row = state.rows[0]!;
    expectNoControl(memoryTitleLine(row, 0));
    expectNoControl(memoryDescriptionLine(row));
    const list = draw(createElement(MemoryList, { state, height: 8 }));
    expect(list).toContain(`t${CLEAN}`);
    expect(list).toContain(`d${CLEAN}`);

    await controller.open(row.slug, row);
    const detail = controller.store.getSnapshot().detail!;
    const head = draw(createElement(MemoryDetailHead, { detail }));
    expect(head).toContain(`s${CLEAN}`);
    expect(head).toContain(`t${CLEAN}`);
  });
});

describe('委譲の一覧と詳細・追加指示の通知', () => {
  const row = (): ReturnType<typeof managerRow> =>
    managerRow(`mgr-${EVIL}`, {
      request: `依頼${EVIL}`,
      cwd: `/w${EVIL}`,
      startedAt: `s${EVIL}`,
      runnerLostSince: `r${EVIL}`,
      lastFailure: { code: `c${EVIL}`, via: 'x', at: `f${EVIL}` },
    });

  it('一覧の行・詳細の頭・注記の制御文字を端末へ出さない', async () => {
    const api = fakeApi();
    api.managerRows = [row()];
    const controller = new ManagersController(api, { debounceMs: 5 });
    await controller.loadList();
    const list = controller.store.getSnapshot().list;
    expectNoControl(managerListLine(list.items[0]!, 0));
    draw(createElement(ManagerList, { list, height: 8 }));

    await controller.open(list.items[0]!.managerId, list.items[0]!);
    const detail = controller.store.getSnapshot().detail!;
    const head = draw(createElement(ManagerDetailHead, { detail }));
    expect(head).toContain(`/w${CLEAN}`);
    expect(head).toContain(`c${CLEAN}`);
  });

  it('追加指示の通知（outcome: detail）の制御文字を端末へ出さない', async () => {
    const api = fakeApi();
    api.managerRows = [managerRow('mgr-1')];
    api.sendManagerMessage = () => Promise.resolve({ outcome: `o${EVIL}`, detail: `d${EVIL}` });
    const controller = new ManagersController(api, { debounceMs: 5 });
    await controller.open('mgr-1', null);
    await controller.sendMessage('続き');
    const detail = controller.store.getSnapshot().detail!;
    expect(detail.notice).toBe(`o${CLEAN}: d${CLEAN}`);
    // 状態の側にも掃除を通らない文字列が入っていても、描く直前で落ちる。
    const status = detailStatusText({ ...detail, notice: `n${EVIL}` }, 0);
    expectNoControl(status.text);
    draw(createElement(DetailStatusRow, { text: `n${EVIL}`, tone: 'dim' }));
  });
});

describe('日誌の詳細の見出し・一覧の行', () => {
  it('type・id・at の制御文字を端末へ出さない', async () => {
    const api = fakeApi();
    api.journalEntries = [
      journalEntry(`id${EVIL}`, `ty${EVIL}` as never, `2026-10-02T00:00:00.000Z${EVIL}`, {}),
    ];
    const controller = new JournalController(api);
    await controller.load();
    const state = controller.store.getSnapshot();
    const entry = state.entries[0]!;
    expectNoControl(journalListLine(entry, 0));
    const head = draw(createElement(JournalDetailHead, { entry, now: 0 }));
    expect(head).toContain(`ty${CLEAN}`);
    expect(head).toContain(`id${CLEAN}`);
    draw(createElement(JournalList, { state, height: 10, live: 'live' }));
  });
});

describe('同じ形の他の画面', () => {
  it('承認待ちの一覧・詳細（id・出どころ・時刻・unreadable）', async () => {
    const api = fakeApi();
    api.approvalRows = [
      approvalRow(`ap-${EVIL}`, { jobId: `job-${EVIL}`, createdAt: `c${EVIL}`, question: '質問' }),
    ];
    api.unreadableApprovals = [{ id: `bad${EVIL}`, reason: 'x' }];
    const controller = new ApprovalsController(api, { debounceMs: 5 });
    await controller.reload();
    const list = controller.store.getSnapshot().list;
    expectNoControl(approvalListLine(list.items[0]!, 0));
    draw(createElement(ApprovalList, { list, height: 8 }));
    await controller.open(list.items[0]!.id, list.items[0]!);
    const detail = controller.store.getSnapshot().detail!;
    for (const r of approvalDocument(detail, 100).rows) expectNoControl(r.text);
  });

  it('会話の履歴の preview', () => {
    const frame = draw(
      createElement(ConversationPicker, {
        status: 'ready',
        items: [
          {
            conversationId: 'c1',
            startedAt: '2026-10-02T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
            messages: 1,
            preview: `p${EVIL}`,
          },
        ],
        scanned: 1,
        reachedStart: true,
        hiddenByLimit: 0,
        selected: 0,
        height: 6,
        now: 0,
      }),
    );
    expect(frame).toContain(`p${CLEAN}`);
  });
});
