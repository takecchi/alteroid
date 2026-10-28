import { describe, expect, it } from 'vitest';

import { buildActivityDigest } from './digest.js';
import { DigestSessionDelta } from './digest-session-delta.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// 定期の tick の継続中の依頼の行の畳み（`foldStandingRows`）は「会話で最後に全文で出した版と同じ」を畳む。
// 道具（schedule_create・schedule_remove・schedule_list）が会話に別の版を載せたら、その kind の控えを捨てる（ToolContext.forgetStandingRow）。
// 道具を通さない外からの書き換え（人間の API）は控えを動かせないので、道具で見た版へ戻されても全文で出ることを見る

const KIND = 'weekly-review';
const OTHER_KIND = 'other-job';
const REQUEST_A = `A の依頼。${'説明が続く。'.repeat(10)}`;
const REQUEST_B = `B の依頼。${'別の説明が続く。'.repeat(10)}`;
const FOLD_HEAD = '件は、この会話で最後に全文で出した版と1字も変わっていない: ';

function harness() {
  const stores = createMemoryStores();
  const delta = new DigestSessionDelta();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => 'conv-1',
    workConversationId: () => 'conv-1',
    forgetStandingRow: (kind: string) => delta.forgetStandingRow(kind),
    keepStandingRowIfSame: (kind: string, row: string) => delta.keepStandingRowIfSame(kind, row),
  });
  const call = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    const found = tools.find((entry) => entry.name === tool);
    if (!found) throw new Error(`${tool} が無い`);
    const result = await found.handler(args as never, { _meta: {} });
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
  const put = (kind: string, request: string) =>
    stores.schedules.put({
      kind,
      spec: { type: 'daily', at: '09:00' },
      request,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
  /** 定期の tick の入力を組み、押し込めたことにする（確定）。 */
  const timerInput = async (): Promise<string> => {
    const digest = await buildActivityDigest(
      stores,
      { since: new Date(Date.now() - 86_400_000) },
      undefined,
      undefined,
      { shape: 'counts' },
    );
    const folded = delta.foldStandingRows(digest);
    delta.commit();
    return folded;
  };
  return { stores, delta, call, put, timerInput };
}

describe('道具で継続中の依頼の版を見た・変えたら、定期の tick の畳みの控えを捨てる', () => {
  it('控え: 道具を通さずに B → A と変わっても、前に全文で出した A と同じなら畳む（基準の確認）', async () => {
    const h = harness();
    await h.put(KIND, REQUEST_A);
    await h.put(OTHER_KIND, 'other');
    const first = await h.timerInput();
    expect(first).toContain(`- ${KIND}（`);
    await h.put(KIND, REQUEST_B);
    await h.put(KIND, REQUEST_A);
    const second = await h.timerInput();
    expect(second).not.toContain(`\n- ${KIND}（`);
    expect(second).toContain(FOLD_HEAD);
  });

  it('⭐ schedule_create で B に書き換えた後、外から A に戻されたら、次の定期の tick は A を全文で出す', async () => {
    const h = harness();
    await h.put(KIND, REQUEST_A);
    await h.put(OTHER_KIND, 'other');
    await h.timerInput();

    const reply = await h.call('schedule_create', {
      kind: KIND,
      request: REQUEST_B,
      dailyAt: '09:00',
    });
    expect(reply).toContain('置き換えた');
    await h.put(KIND, REQUEST_A);
    const next = await h.timerInput();

    expect(next).toContain(`\n- ${KIND}（`);
    expect(next).toContain(REQUEST_A);
    // 触っていない kind の行は畳んだまま
    expect(next).not.toContain(`\n- ${OTHER_KIND}（`);
    expect(next).toContain(`${FOLD_HEAD}${OTHER_KIND}`);
  });

  it('⭐ schedule_list（kind 指定）で B を見た後、外から A に戻されたら、次の定期の tick は A を全文で出す', async () => {
    const h = harness();
    await h.put(KIND, REQUEST_A);
    await h.timerInput();

    await h.put(KIND, REQUEST_B);
    expect(await h.call('schedule_list', { kind: KIND })).toContain('B の依頼');
    await h.put(KIND, REQUEST_A);
    const next = await h.timerInput();

    expect(next).toContain(`\n- ${KIND}（`);
    expect(next).not.toContain(FOLD_HEAD);
  });

  it('⭐ schedule_list（一覧）で見た後も、外から版が戻されたら全文で出す', async () => {
    const h = harness();
    await h.put(KIND, REQUEST_A);
    await h.timerInput();

    await h.put(KIND, REQUEST_B);
    expect(await h.call('schedule_list', {})).toContain('B の依頼');
    await h.put(KIND, REQUEST_A);
    const next = await h.timerInput();

    expect(next).toContain(`\n- ${KIND}（`);
  });

  // schedule_list は畳んだ行が引き直しに指す道具。見せた版が控え（最後に全文で出した版）と同じなら、会話の上の全文と食い違わないので控えを残す。
  // 呼ぶたびに全 kind の控えを捨てると、一覧を頻繁に呼ぶ会話で畳みが効かなくなる。違う版・控えの無い kind は、従来どおり捨てる（安全側）
  it('⭐ schedule_list（一覧・kind 指定）で、控えと同じ版を見せた kind は控えが残り、次の定期の tick で畳まれる', async () => {
    const h = harness();
    await h.put(KIND, REQUEST_A);
    await h.put(OTHER_KIND, 'other');
    await h.timerInput();

    expect(await h.call('schedule_list', {})).toContain('A の依頼');
    expect(await h.call('schedule_list', { kind: OTHER_KIND })).toContain('other');
    const next = await h.timerInput();

    expect(next).not.toContain(`\n- ${KIND}（`);
    expect(next).not.toContain(`\n- ${OTHER_KIND}（`);
    expect(next).toContain(`2 ${FOLD_HEAD}${OTHER_KIND}・${KIND}`);
  });

  it('⭐ schedule_list で控えと違う版を見せた kind だけ控えが捨てられ、同じ版の別の kind は触らない', async () => {
    const h = harness();
    await h.put(KIND, REQUEST_A);
    await h.put(OTHER_KIND, 'other');
    await h.timerInput();

    // 外から A → B に変わった後に一覧を呼ぶ。一覧は B を見せるので、控え（A）のままにすると、B → A と戻されたとき A を「前回と同じ」と畳んでしまう
    await h.put(KIND, REQUEST_B);
    expect(await h.call('schedule_list', {})).toContain('B の依頼');
    await h.put(KIND, REQUEST_A);
    const next = await h.timerInput();

    expect(next).toContain(`\n- ${KIND}（`);
    expect(next).toContain(REQUEST_A);
    // 見せた版が控えと同じ other-job は畳んだまま
    expect(next).not.toContain(`\n- ${OTHER_KIND}（`);
    expect(next).toContain(`${FOLD_HEAD}${OTHER_KIND}`);
  });

  it('⭐ schedule_remove で外した後、同じ kind が A で作り直されたら、次の定期の tick は A を全文で出す', async () => {
    const h = harness();
    await h.put(KIND, REQUEST_A);
    await h.timerInput();

    expect(await h.call('schedule_remove', { kind: KIND })).toContain('外した');
    await h.put(KIND, REQUEST_A);
    const next = await h.timerInput();

    expect(next).toContain(`\n- ${KIND}（`);
  });
});

describe('DigestSessionDelta: 自発の tick（renderDigest）で畳んだ行も、控えを会話の上の版に揃える', () => {
  const row = (request: string) =>
    `- ${KIND}（毎日 09:00）${request}\n  前回動いた時刻: （まだ一度も動いていない）`;
  const digestOf = (request: string) =>
    [
      '期間: x',
      '',
      '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）',
      row(request),
    ].join('\n');
  const at = new Date('2026-10-28T00:00:00.000Z');

  it('⭐ 控えが B を指しているとき、自発の tick が「前回から変わらない」A の行を畳んだら、控えの B を捨てる', () => {
    const delta = new DigestSessionDelta();
    // 自発の tick が A を全文で出す（控えは A）
    delta.renderDigest(digestOf('A'), at);
    delta.commit();
    // 定期の tick が B を全文で出す（控えは B に置き換わる）
    delta.foldStandingRows(digestOf('B'));
    delta.commit();
    // 自発の tick は前回（A）から変わらないので畳む。会話でいちばん新しい全文は定期の B
    delta.renderDigest(digestOf('A'), at);
    delta.commit();
    // 人間が B に戻した → 控えが B のままだと畳んでしまう
    const folded = delta.foldStandingRows(digestOf('B'));
    expect(folded).toContain(`- ${KIND}（`);
  });

  it('控えが同じ版を指しているなら、自発の tick が畳んでも控えは残る（畳みは続く）', () => {
    const delta = new DigestSessionDelta();
    delta.renderDigest(digestOf('A'), at);
    delta.commit();
    delta.renderDigest(digestOf('A'), at);
    delta.commit();
    const folded = delta.foldStandingRows(digestOf('A'));
    expect(folded).not.toContain(`- ${KIND}（`);
    expect(folded).toContain('1 件は、この会話で最後に全文で出した版と');
  });

  it('forgetStandingRow は、押し込む前（staged）の控えも捨てる', () => {
    const delta = new DigestSessionDelta();
    delta.foldStandingRows(digestOf('A'));
    delta.forgetStandingRow(KIND);
    delta.commit();
    expect(delta.foldStandingRows(digestOf('A'))).toContain(`- ${KIND}（`);
  });
});
