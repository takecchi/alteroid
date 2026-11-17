import { describe, expect, it } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import { fakeManagerPool } from './manager-pool.test-support.js';
import { describeSituationParts } from './situation.js';
import { createMemoryStores, humanMessage } from './testing.js';
import {
  LAST_FAILURE_READING,
  LOST_READING,
  READING,
  RUNNER_VANISHED_READING,
  TURN_READINGS_HEADING,
  USAGE_STOPPED_READING,
  readingRef,
} from './turn-readings.js';
import type { InboxEvent } from './schema.js';

// 「いまの全体」の4つの断り（lost・直近の失敗・枠で止まった委譲・宛先の消えた委譲）は、
// 事故対策として判断の場面の隣に置いた文を毎ターン残し、引き方の説明だけをシステムプロンプトの「# 差し込みの読み方」へ移した（2026-11-17 のオーナー判断）。
// 移した文も残した文も、元の文から1文字も縮めていない・言い換えていない（north_star 禁止2）。分けただけであることを、元の全文との突き合わせで縛る。

// ── 元の全文（移す前の現行の文字列。situation.ts の LOST_NOTICE ほか。`${…}` は展開後を逐語で写した）──
const ORIGINAL_LOST =
  '**戻れなかった(lost) は「終わった」ではない。** 見ているのは「前のセッションへ戻れたか」だけで、' +
  '**成果の有無は1度も観測していない** — 落ちる前に成果が既に外へ出ていた（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）' +
  '実例がある。⟹ 誰かがそこを確かめるまで終われない。' +
  '名指しで引くなら `manager_list` に status: ["lost"] を渡す（絞りは文字数の予算より前に効くので、' +
  '古いものも本文に出る）。中身は `manager_report <managerId>` で読める。' +
  '**確かめる前に `manager_start` で起こし直さないこと** — 同じ仕事が2本になる。';

const ORIGINAL_LAST_FAILURE =
  '**直近のターンが失敗で終わっている委譲は、区分の中では見分けが付かない。** ' +
  '失敗（枠(429)など）で畳まれた回も、セッションが生きているので `status` は動かさず `done` に座る（仕様である）。' +
  '⟹ **この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。** ' +
  '名指しで引くなら `manager_list` の各行に付く ⚠（`直近のターンは報告ではなく失敗で終わっている`）を見る' +
  '——**この軸で絞る綴りは無い**（`status` の値ではない）。' +
  '中身は `manager_report <managerId>` で読める。';

const ORIGINAL_USAGE_STOPPED =
  '**枠(利用上限)で止まっている委譲は、区分の中では見分けが付かない。** ' +
  '通常は鍵が回ってこの委譲が起こし直されるまで、`done`（手が空いている）または' +
  '`running` のまま座る——セッションが生きている間は `status` を動かさない（仕様である）。' +
  '⟹ **この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。** ' +
  '**ただし、印が下りる前にセッションそのものが `failed` / `lost` / `stopped` として' +
  '畳まれることがある**（Issue #1796）——その回は `status` がそちらへ確定している。' +
  '直近のターンが失敗で終わっている委譲（上）と重なることが多いが同じ軸ではない' +
  '（あちらは失敗の理由を問わない全体、こちらは利用上限に当たった委譲だけ）。' +
  '名指しで引くなら `manager_list` の各行に付く注記（⚠ 枠(利用上限)で止まっている）を見る' +
  '（`status` も一緒に読めば、生きているか否かはその行だけで判定できる）。' +
  '絞りでは切り出せない（`status` の値ではない）。' +
  '中身は `manager_report <managerId>` で読める。';

const ORIGINAL_RUNNER_VANISHED =
  '**宛先の runner が名簿から entry ごと消えている委譲は、`manager_list status: ["lost"]` の絞りでは見えない。** ' +
  '`lost` が数えているのは「resume を試して前のセッションへ戻れなかった」と確かめた事実だけで、' +
  'これは器（runner）が黙って名簿から entry ごと消えたのに `status` は `running` のまま残っているものである' +
  '（`isLive()` は動かしていない。宛先を失っていても `sessionId` が残っていれば' +
  '`manager_send` で resume を試せることがある）。' +
  '⟹ **必ず「走行中」の内側に座る**（区分とは足し合わせない）。' +
  '名指しで引くなら `manager_list` の各行に付く注記（⚠ 宛先の runner が名簿から消えている）を見る' +
  '——絞りでは切り出せない（`status` の値ではない）。' +
  '中身は `manager_report <managerId>` で読める。';

// ── 毎ターン残す文（逐語）──
const KEPT_LOST =
  '**戻れなかった(lost) は「終わった」ではない。** 見ているのは「前のセッションへ戻れたか」だけで、**成果の有無は1度も観測していない** — 落ちる前に成果が既に外へ出ていた（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）実例がある。⟹ 誰かがそこを確かめるまで終われない。' +
  '**確かめる前に `manager_start` で起こし直さないこと** — 同じ仕事が2本になる。';
const KEPT_LAST_FAILURE =
  '**直近のターンが失敗で終わっている委譲は、区分の中では見分けが付かない。** ' +
  '⟹ **この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。** ';
const KEPT_USAGE_STOPPED =
  '**枠(利用上限)で止まっている委譲は、区分の中では見分けが付かない。** ' +
  '⟹ **この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。** ';
const KEPT_RUNNER_VANISHED =
  '**宛先の runner が名簿から entry ごと消えている委譲は、`manager_list status: ["lost"]` の絞りでは見えない。** ' +
  '⟹ **必ず「走行中」の内側に座る**（区分とは足し合わせない）。';

const NOTICES = [
  {
    part: 'lostNotice',
    name: READING.lost,
    original: ORIGINAL_LOST,
    kept: KEPT_LOST,
    moved: LOST_READING,
  },
  {
    part: 'lastFailureNotice',
    name: READING.lastFailure,
    original: ORIGINAL_LAST_FAILURE,
    kept: KEPT_LAST_FAILURE,
    moved: LAST_FAILURE_READING,
  },
  {
    part: 'usageStoppedNotice',
    name: READING.usageStopped,
    original: ORIGINAL_USAGE_STOPPED,
    kept: KEPT_USAGE_STOPPED,
    moved: USAGE_STOPPED_READING,
  },
  {
    part: 'runnerVanishedNotice',
    name: READING.runnerVanished,
    original: ORIGINAL_RUNNER_VANISHED,
    kept: KEPT_RUNNER_VANISHED,
    moved: RUNNER_VANISHED_READING,
  },
] as const;

const AT = new Date().toISOString();

function summary(id: string, extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: id,
    status: 'done',
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: AT,
    updatedAt: AT,
    waiting: [],
    ...extra,
  } as ManagerSummary;
}

// 4つの断りがすべて出る状態: lost 1・直近の失敗 1・枠で止まった 1・宛先の消えた 1
const MANAGERS: ManagerSummary[] = [
  summary('mgr-lost', { status: 'lost', live: false }),
  summary('mgr-failed', {
    lastFailure: { code: 'api_error_status/429', via: 'result', at: AT },
  } as Partial<ManagerSummary>),
  summary('mgr-usage', { usageStoppedAt: AT } as Partial<ManagerSummary>),
  summary('mgr-vanished', {
    status: 'running',
    runnerVanished: true,
  } as Partial<ManagerSummary>),
];

// 文の単位: 「。」の直後で切る。ただし「。** 」（強調の閉じ）は閉じと空白までを前の文に含め、次の強調の開き（「。**ただし」）の手前では切る。
// 残す文と移す文を別々に切って、元の全文を切ったものと集合として一致するかを見る（並びは問わない）
const sentencesOf = (text: string): string[] =>
  text.split(/(?<=。)(?!\*\* )|(?<=。\*\* )/).filter((sentence) => sentence !== '');

function keptOf(part: string): string {
  const line = describeSituationParts({ managers: MANAGERS, runners: [] }).find(
    (p) => p.name === part,
  )?.line;
  expect(line, `${part} が出ていない`).toBeDefined();
  return line ?? '';
}

describe('「いまの全体」の4つの断りは、残す文と移す文に分かれ、合わせると元の全文になる', () => {
  for (const { part, name, original, kept, moved } of NOTICES) {
    it(`⭐ 〈${name}〉: 残す文 ＋ 移す文は、元の全文の文の集合と1文字も違わない`, () => {
      const rendered = keptOf(part);
      expect(rendered.endsWith(readingRef(name))).toBe(true);
      const keptWithoutRef = rendered.slice(0, rendered.length - readingRef(name).length);
      expect(keptWithoutRef).toBe(kept);
      // 逐語で縮めていない・言い換えていない: 文の集合が一致し、文字数も一致する
      const split = [...sentencesOf(keptWithoutRef), ...sentencesOf(moved)];
      expect(split.toSorted()).toEqual(sentencesOf(original).toSorted());
      expect(keptWithoutRef.length + moved.length).toBe(original.length);
      // 重ならない: 残す文は移す文を含まず、移す文は残す文を含まない
      expect(keptWithoutRef).not.toContain(moved);
    });
  }

  it('断りが出る条件は変わらない（本数が 0 なら1文字も出ない）', () => {
    const parts = describeSituationParts({
      managers: [summary('mgr-ok', { status: 'running' })],
      runners: [],
    }).map((p) => p.name);
    for (const { part } of NOTICES) expect(parts).not.toContain(part);
    const lines = describeSituationParts({ managers: MANAGERS, runners: [] });
    expect(lines.map((p) => p.name)).toEqual(expect.arrayContaining(NOTICES.map((n) => n.part)));
  });
});

const inputsOf = (s: Setup): string[] => (s.calls[0] as FakeCall | undefined)?.inputs ?? [];
async function turn(s: Setup, event: InboxEvent): Promise<string> {
  const before = inputsOf(s).length;
  s.clone.post(event);
  await waitFor(() => inputsOf(s).length > before, `${event.type} の入力`);
  await waitFor(
    async () => (await s.stores.journal.list({ types: ['turn_timing'] })).length > before,
    `${event.type} のターンの終わり`,
  );
  return inputsOf(s)[before] ?? '';
}

function pool(): ManagerPool {
  return fakeManagerPool({
    list: () => Promise.resolve(MANAGERS),
    runners: (): Promise<RunnerFleetOverview> =>
      Promise.resolve({
        runners: [],
        unassigned: [],
        daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
      }),
  });
}

describe('本物のクローンのターンで、残す文は毎ターンの入力に在り、移す文はシステムプロンプトにだけ在る', () => {
  it('⭐ 人間の発言のターンも報告のターンも同じ', { timeout: 60_000 }, async () => {
    const s = setup(() => 'わかった', createMemoryStores(), {}, {}, { managers: pool() });
    const inputs = {
      human: await turn(s, humanMessage('人間の発言の本文')),
      report: await turn(s, {
        type: 'manager_message',
        id: 'evt-report',
        at: new Date().toISOString(),
        managerId: 'mgr-failed',
        kind: 'report',
        text: '報告の本文',
      }),
    };
    const systemPrompt = (s.calls[0] as FakeCall).options.systemPrompt;
    const prompt = typeof systemPrompt === 'string' ? systemPrompt : JSON.stringify(systemPrompt);

    expect(prompt).toContain(TURN_READINGS_HEADING);
    for (const { name, kept, moved } of NOTICES) {
      for (const [kind, input] of Object.entries(inputs)) {
        expect(input, `${kind}: 〈${name}〉の残す文`).toContain(kept + readingRef(name));
        expect(input, `${kind}: 〈${name}〉の移す文が入力に出ている`).not.toContain(moved);
      }
      // 参照が指す項が、節に見出しつきで在り、移す文の全文を持つ
      expect(prompt, `〈${name}〉の項`).toContain(`## 〈${name}〉 `);
      expect(prompt, `〈${name}〉の移す文`).toContain(moved);
    }
  });
});
