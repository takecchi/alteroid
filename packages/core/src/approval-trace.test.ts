import { describe, expect, it } from 'vitest';

import {
  renderApprovalTrace,
  stampAnsweredApproval,
  traceApproval,
  type ApprovalTrace,
} from './approval-trace.js';
import { journalEntrySchema, type JournalEntryInput, type PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import { CLONE_ACTOR_ID } from './usage.js';

/**
 * 承認の答えと、その後の行動を対で読む口（issue #847 の案B）の歯。
 *
 * **書く側（`clone.ts` が印を立てること）は `clone-answer-action-stamp.test.ts`
 * が持つ。** ここは (1) 印を立てる規則の1か所（`stampAnsweredApproval`）と、
 * (2) 読む側（`traceApproval`）が「対が無い」を理由ごとに分けること、(3) 古い
 * 行（印の欄が無い行）が読めること、を測る。
 */

const RENDER = { budget: 8_000, summaryLimit: 200, detailHint: '（詳細の案内）' } as const;

/** 答えの時刻より後に積まれることを保証するため、答えの時刻は少し過去にする。 */
function past(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function answered(stores: Stores, id: string): Promise<PendingApproval> {
  const approval: PendingApproval = {
    id,
    createdAt: past(2_000),
    question: `質問 ${id}`,
    answeredAt: past(1_000),
    answer: `(b) でお願いします ${id}`,
  };
  await stores.jobs.putApproval(approval);
  await stores.journal.append({ type: 'escalation', question: approval.question, approvalId: id });
  await stores.journal.append({
    type: 'escalation',
    question: approval.question,
    approvalId: id,
    answeredAt: approval.answeredAt,
    answer: approval.answer,
  });
  return approval;
}

function turnStart(id: string, stamped: boolean): JournalEntryInput {
  return {
    type: 'exchange',
    with: 'self',
    role: 'inbound',
    text: `ターンの入力: human_answer approvalId=${id}（…）\n\n[system] …`,
    ...(stamped ? { answeredApprovalId: id } : {}),
  };
}

async function trace(stores: Stores, id: string): Promise<ApprovalTrace> {
  const found = await traceApproval(stores, id);
  if (found === null) throw new Error(`承認 ${id} が引けない`);
  return found;
}

describe('stampAnsweredApproval（印を立てる規則の1か所）', () => {
  it('答えのターンなら decision / memory_update / tool_use / outbound の exchange に印が立つ', () => {
    const inputs: JournalEntryInput[] = [
      { type: 'decision', decision: 'd', grounds: 'g' },
      { type: 'memory_update', slug: 'values', cause: 'clone', summary: 's' },
      { type: 'tool_use', actor: CLONE_ACTOR_ID, tool: 'Bash' },
      { type: 'exchange', with: 'self', role: 'outbound', text: 't' },
      { type: 'exchange', with: 'human', role: 'outbound', text: 't', conversationId: 'c' },
    ];
    for (const input of inputs) {
      expect(stampAnsweredApproval(input, 'ap-1')).toMatchObject({ answeredApprovalId: 'ap-1' });
    }
  });

  it('答えのターンでなければ（null）入力をそのまま返す——契約の反対側', () => {
    const input: JournalEntryInput = { type: 'decision', decision: 'd', grounds: 'g' };
    expect(stampAnsweredApproval(input, null)).toBe(input);
    expect(stampAnsweredApproval(input, null)).not.toHaveProperty('answeredApprovalId');
  });

  it('inbound の exchange と、行動でない型（escalation など）には立てない', () => {
    const inbound: JournalEntryInput = {
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 't',
    };
    const escalation: JournalEntryInput = { type: 'escalation', question: 'q', approvalId: 'x' };
    expect(stampAnsweredApproval(inbound, 'ap-1')).not.toHaveProperty('answeredApprovalId');
    expect(stampAnsweredApproval(escalation, 'ap-1')).not.toHaveProperty('answeredApprovalId');
  });
});

describe('journalEntrySchema — answeredApprovalId は後方互換', () => {
  it('欄の無い古い行がそのまま読め、在る行は欄を落とさずに読める', () => {
    const base = { id: 'j-1', at: '2026-09-01T00:00:00.000Z' };
    const old = journalEntrySchema.parse({
      ...base,
      type: 'decision',
      decision: 'd',
      grounds: 'g',
    });
    expect(old).not.toHaveProperty('answeredApprovalId');
    for (const entry of [
      { type: 'decision', decision: 'd', grounds: 'g' },
      { type: 'memory_update', slug: 'values', cause: 'clone', summary: 's' },
      { type: 'tool_use', actor: CLONE_ACTOR_ID, tool: 'Bash' },
      { type: 'exchange', with: 'self', role: 'outbound', text: 't' },
    ]) {
      // **欄が schema に無ければ zod の既定（strip）で黙って落ちる**——書いた印が
      // 保存の口で消える形を、ここで捕まえる。
      expect(
        journalEntrySchema.parse({ ...base, ...entry, answeredApprovalId: 'ap-1' }),
      ).toHaveProperty('answeredApprovalId', 'ap-1');
    }
  });
});

describe('traceApproval — 対を読む（issue #847 の案B）', () => {
  it('知らない id は null（HTTP では 404、道具では「無い」）', async () => {
    expect(await traceApproval(createMemoryStores(), 'ap-none')).toBeNull();
  });

  it('未回答は unanswered で、「まだ答えが無い」と言う', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({ id: 'ap-q', createdAt: past(1_000), question: '聞きたい' });
    await stores.journal.append({ type: 'escalation', question: '聞きたい', approvalId: 'ap-q' });
    const found = await trace(stores, 'ap-q');
    expect(found.state).toBe('unanswered');
    expect(found.questionEntry?.type).toBe('escalation');
    expect(renderApprovalTrace(found, RENDER)).toContain('まだ答えが無い');
  });

  it('印の付いた行動だけを、答えの後から古い順に対として並べる', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-1');
    await answered(stores, 'ap-2');
    await stores.journal.append(turnStart('ap-1', true));
    await stores.journal.append({
      type: 'decision',
      decision: 'b の方針で進める',
      grounds: '人間の答え',
      answeredApprovalId: 'ap-1',
    });
    // 別の承認の行動は混ざらない（時刻が近くても id で分ける）。
    await stores.journal.append({
      type: 'decision',
      decision: '別件',
      grounds: 'g',
      answeredApprovalId: 'ap-2',
    });
    await stores.journal.append({
      type: 'tool_use',
      actor: CLONE_ACTOR_ID,
      tool: 'Bash',
      input: { command: 'git status' },
      answeredApprovalId: 'ap-1',
    });

    const found = await trace(stores, 'ap-1');
    expect(found.state).toBe('paired');
    expect(found.answerEntry?.type).toBe('escalation');
    expect(found.turnStarts).toHaveLength(1);
    expect(found.actions.map((entry) => entry.type)).toEqual(['decision', 'tool_use']);
    const text = renderApprovalTrace(found, RENDER);
    expect(text).toContain('(b) でお願いします ap-1');
    expect(text).toContain('判断: b の方針で進める');
    expect(text).toContain('道具 Bash');
    expect(text).not.toContain('別件');
    expect(text).toContain('（詳細の案内）');
  });

  /**
   * 回答経路の表示（Issue #1479）。`answeredVia` が付いた行では
   * `renderApprovalTrace` の答えの行にそれが出て、付いていない行（記録が無い
   * 古い経路）では何も足さない——「わからない」を「operator ではない」に
   * 化けさせない（`answeredViaSchema` の doc）。
   */
  it('answeredVia が付いていれば答えの行に回答経路を出す。無ければ出さない', async () => {
    const stores = createMemoryStores();
    const approval = await answered(stores, 'ap-1');
    await stores.jobs.putApproval({
      ...approval,
      answeredVia: { kind: 'account', accountId: 'acc-1' },
    });
    const found = await trace(stores, 'ap-1');
    expect(renderApprovalTrace(found, RENDER)).toContain('（回答経路: account（acc-1））');

    // `answeredVia` を持たない行（記録の無い古い経路）では何も足さない。
    const withoutVia = await answered(stores, 'ap-2');
    const foundWithoutVia = await trace(stores, 'ap-2');
    expect(withoutVia.answeredVia).toBeUndefined();
    expect(renderApprovalTrace(foundWithoutVia, RENDER)).not.toContain('回答経路');
  });

  it('印を持つ入口の後に行動が1件も無ければ no_actions で「記録されていない」と言う', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-1');
    await stores.journal.append(turnStart('ap-1', true));
    const found = await trace(stores, 'ap-1');
    expect(found.state).toBe('no_actions');
    expect(renderApprovalTrace(found, RENDER)).toContain(
      '答えの後にこの承認に紐づいた行動は記録されていない',
    );
  });

  it('入口の行が無ければ no_turn_start（「行動が無い」と同じ顔にしない）', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-1');
    const found = await trace(stores, 'ap-1');
    expect(found.state).toBe('no_turn_start');
    expect(renderApprovalTrace(found, RENDER)).toContain('ターンの入口の行が無い');
  });

  it('印の無い入口（記録を始める前の答え）は turn_before_recording で「記録していない」と言う', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-old');
    await stores.journal.append(turnStart('ap-old', false));
    await stores.journal.append({ type: 'tool_use', actor: CLONE_ACTOR_ID, tool: 'Bash' });
    const found = await trace(stores, 'ap-old');
    expect(found.state).toBe('turn_before_recording');
    expect(renderApprovalTrace(found, RENDER)).toContain('行動が無いのではなく、記録していない');
  });

  it('印を持つ入口の区間に印の無い行動が在れば unstamped_actions（記録が動いていない疑い）', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-1');
    await stores.journal.append(turnStart('ap-1', true));
    await stores.journal.append({ type: 'tool_use', actor: CLONE_ACTOR_ID, tool: 'Bash' });
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });
    // 次のターンの入口より後の行は区間の外（数えない）。
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: '次' });
    await stores.journal.append({ type: 'tool_use', actor: CLONE_ACTOR_ID, tool: 'Read' });
    const found = await trace(stores, 'ap-1');
    expect(found.state).toBe('unstamped_actions');
    expect(found.unstampedInTurn).toBe(2);
    expect(renderApprovalTrace(found, RENDER)).toContain('記録が動いていない疑い');
  });

  it('蒸留の行動は区間の中でも「印の無い行動」に数えない（並行して走りうる）', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-1');
    await stores.journal.append(turnStart('ap-1', true));
    await stores.journal.append({
      type: 'tool_use',
      actor: `${CLONE_ACTOR_ID}:distill`,
      tool: 'Read',
    });
    await stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'distill',
      summary: 's',
    });
    expect((await trace(stores, 'ap-1')).state).toBe('no_actions');
  });

  it('取り下げた件は withdrawn', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-w',
      createdAt: past(1_000),
      question: 'q',
      withdrawnAt: past(500),
      withdrawnReason: '不要になった',
    });
    expect((await trace(stores, 'ap-w')).state).toBe('withdrawn');
  });
});

describe('approval_trace（クローンの道具）', () => {
  it('同じ読み口を通り、知らない id には「無い」と答える', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-1');
    await stores.journal.append(turnStart('ap-1', true));
    await stores.journal.append({
      type: 'decision',
      decision: '答えに沿って進めた',
      grounds: 'g',
      answeredApprovalId: 'ap-1',
    });
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'approval_trace');
    if (!found) throw new Error('approval_trace という道具が無い');
    const call = async (id: string) => {
      const result = await found.handler({ id } as never, {});
      return (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
    };
    const reply = await call('ap-1');
    expect(reply).toContain('判断: 答えに沿って進めた');
    expect(reply).toContain('journal_read id=');
    expect(await call('ap-none')).toContain('承認 ap-none は無い');
  });

  it('行動が多くても予算で切り、切ったことと件数を言う', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-1');
    await stores.journal.append(turnStart('ap-1', true));
    for (let i = 0; i < 200; i += 1) {
      await stores.journal.append({
        type: 'tool_use',
        actor: CLONE_ACTOR_ID,
        tool: 'Bash',
        input: { command: `echo ${'x'.repeat(150)} ${i}` },
        answeredApprovalId: 'ap-1',
      });
    }
    const text = renderApprovalTrace(await trace(stores, 'ap-1'), RENDER);
    expect(text.length).toBeLessThan(12_000);
    expect(text).toContain('200 件');
    expect(text).toMatch(/…ほか \d+ 件は省略/);
  });
});
