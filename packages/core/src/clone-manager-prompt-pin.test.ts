import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { AttachmentRef } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// マネージャーからの一件（`manager_message`）を1件ずつ受けたターンで、モデルへ渡る「マネージャーの節」を全文で固定する。
// `clone.ts` の `#handle` の `manager_message` の枝は、添付つきの報告とそれ以外で `managerPrompt` を2か所で呼んでいる。
// 2か所を1つにまとめる前に、いまの出力（添付の行の有無・画像・確認の生死の分岐・許可確認の畳み）をここで固定する。

const MANAGER_ID = 'mgr-pin';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface Boot {
  clone: CloneHost;
  stores: Stores;
  inputs: string[];
  images: string[][];
}

function boot(): Boot {
  const inputs: string[] = [];
  const images: string[][] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          const blocks = content as { type: string; text?: string; source?: { data: string } }[];
          inputs.push(
            blocks
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join(''),
          );
          images.push(blocks.filter((b) => b.type === 'image').map((b) => b.source?.data ?? ''));
        } else {
          inputs.push(String(content));
          images.push([]);
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: `uuid-result-${String(inputs.length)}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      // 使用量を返す: 実際の器と同じく文脈の使用量が取れる形で走らせるため（`clone-confirmation-full-text-by-default.test.ts` と同じ形）
      getContextUsage: async () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  // `rq-live` だけが「いま待たれている」確認（`managers.list()` の `waiting`）。`rq-gone` は待たれていない
  const now = new Date().toISOString();
  const managers = {
    list: async () => [
      {
        managerId: MANAGER_ID,
        status: 'running',
        live: true,
        cwd: '/work',
        request: '依頼',
        startedAt: now,
        updatedAt: now,
        waiting: [{ requestId: 'rq-live', kind: 'question', askedAt: now, summary: 's' }],
      },
    ],
    runners: async () => ({
      runners: [],
      unassigned: [],
      daemonRevision: { status: 'unknown', reason: 't' },
    }),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: async () => undefined,
    runningManagerOwning: () => undefined,
    restore: async () => [],
    resumeStoppedByUsage: async () => [],
    reattachRunner: async () => undefined,
    probeTurnEnds: async () => undefined,
    flushWithheldReports: async () => undefined,
    settleStalledUsageWakes: async () => [],
    renotifyStalledDenials: async () => undefined,
    stop: async () => undefined,
  } as never;

  const stores = createMemoryStores();
  const clone = createClone({
    // 束ね待ちは切る（`clone-test-harness.ts` の `setup` と同じ）: 単発の件を1ターンずつ観測するため
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn: fn,
    env: {},
    managers,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, stores, inputs, images };
}

async function put(
  stores: Stores,
  name: string,
  mediaType: string,
  bytes: Uint8Array,
): Promise<AttachmentRef> {
  const meta = await stores.attachments.put({ name, mediaType, bytes });
  return {
    id: meta.id,
    name: meta.name,
    mediaType: meta.mediaType,
    size: meta.size,
    sha256: meta.sha256,
  };
}

let seq = 0;

/** 先客のターンを1本走らせた器へ、マネージャーの一件を1件ずつ届け、そのターンの入力の番号を返す。 */
async function deliver(s: Boot, event: Record<string, unknown>): Promise<number> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    id: `evt-pin-${String(seq)}`,
    at: new Date().toISOString(),
    type: 'manager_message',
    managerId: MANAGER_ID,
    ...event,
  } as never);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return before;
}

async function booted(): Promise<Boot> {
  const s = boot();
  s.clone.post(humanMessage('先客'));
  await waitFor(() => s.inputs.length === 1, '先客のターン');
  return s;
}

/**
 * 入力のうち、マネージャーの節（`[system] マネージャー … ` の行から末尾まで）だけを返す。
 * 経過の句（「受け取ってから…経過」）と受け取った時刻は実時間で揺れるので、そこだけ印に置き換える。添付の id と sha256 も、試験で置いた値を印に置き換える。
 */
function managerSection(input: string, refs: readonly AttachmentRef[] = []): string {
  const start = input.lastIndexOf('[system] マネージャー ');
  expect(start, 'マネージャーの節が入力に無い').toBeGreaterThanOrEqual(0);
  let section = input.slice(start);
  section = section.replace(
    /受け取ってから.+?経過（受け取った時刻: [^）]+）。/u,
    '受け取ってから<経過>経過（受け取った時刻: <時刻>）。',
  );
  refs.forEach((ref, index) => {
    section = section.split(ref.id).join(`<id${String(index)}>`);
    section = section.split(ref.sha256).join(`<sha${String(index)}>`);
  });
  return section;
}

describe('マネージャーの一件を1件ずつ受けたターンの、マネージャーの節を全文で固定する（managerPrompt を1か所にまとめる前の歯）', () => {
  describe('報告', () => {
    it('添付の無い報告: 添付の行も画像も無い', async () => {
      const s = await booted();
      const at = await deliver(s, { kind: 'report', text: '報告の本文' });
      expect(managerSection(s.inputs[at] ?? '')).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（報告）

        報告の本文

        受け取ってから<経過>経過（受け取った時刻: <時刻>）。
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）

        続きが要るなら \`manager_send\` で指示を出し、要らないなら何もしなくてよい。
        学びや判断の基準になったことがあれば記憶へ移すこと。"
      `);
      expect(s.images[at]).toEqual([]);
      await s.clone.stop();
    }, 15_000);

    it('文字のファイルを添えた報告: 添付の行が本文の前に1行入る。画像は渡らない', async () => {
      const s = await booted();
      const txt = await put(s.stores, 'log.txt', 'text/plain', new TextEncoder().encode('hello'));
      const at = await deliver(s, { kind: 'report', text: '報告の本文', attachments: [txt] });
      expect(managerSection(s.inputs[at] ?? '', [txt])).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（報告）

        [添付] id=<id0> name=log.txt type=text/plain size=5 sha256=<sha0> （attachment_fetch で取り出して Read で開ける）

        報告の本文

        受け取ってから<経過>経過（受け取った時刻: <時刻>）。
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）

        続きが要るなら \`manager_send\` で指示を出し、要らないなら何もしなくてよい。
        学びや判断の基準になったことがあれば記憶へ移すこと。"
      `);
      expect(s.images[at]).toEqual([]);
      await s.clone.stop();
    }, 15_000);

    it('画像を添えた報告: 添付の行が入り、画像としても1枚渡る', async () => {
      const s = await booted();
      const png = await put(s.stores, 'shot.png', 'image/png', PNG);
      const at = await deliver(s, { kind: 'report', text: '報告の本文', attachments: [png] });
      expect(managerSection(s.inputs[at] ?? '', [png])).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（報告）

        [添付] id=<id0> name=shot.png type=image/png size=12 sha256=<sha0>（画像として渡した） （attachment_fetch で取り出して Read で開ける）

        報告の本文

        受け取ってから<経過>経過（受け取った時刻: <時刻>）。
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）

        続きが要るなら \`manager_send\` で指示を出し、要らないなら何もしなくてよい。
        学びや判断の基準になったことがあれば記憶へ移すこと。"
      `);
      expect(s.images[at]).toEqual([Buffer.from(PNG).toString('base64')]);
      await s.clone.stop();
    }, 15_000);

    it('受け取れなかった添付だけの報告: 受け取れなかった行が本文の前に入る。画像は渡らない', async () => {
      const s = await booted();
      const at = await deliver(s, {
        kind: 'report',
        text: '報告の本文',
        rejectedAttachments: [{ name: 'big.bin', reason: 'sha256 が申告と合わない' }],
      });
      expect(managerSection(s.inputs[at] ?? '')).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（報告）

        [添付を受け取れなかった] name=big.bin 理由=sha256 が申告と合わない

        報告の本文

        受け取ってから<経過>経過（受け取った時刻: <時刻>）。
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）

        続きが要るなら \`manager_send\` で指示を出し、要らないなら何もしなくてよい。
        学びや判断の基準になったことがあれば記憶へ移すこと。"
      `);
      expect(s.images[at]).toEqual([]);
      await s.clone.stop();
    }, 15_000);
  });

  describe('質問', () => {
    it('いま待たれている質問（requestId が waiting に在る）', async () => {
      const s = await booted();
      const at = await deliver(s, { kind: 'question', text: '質問の本文', requestId: 'rq-live' });
      expect(managerSection(s.inputs[at] ?? '')).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（質問）
        質問の本文
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）
        返事をするまで mgr-pin のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。
        記憶に根拠があるなら自分で決めて \`manager_send\`（managerId: "mgr-pin", requestId: "rq-live"）で返し、その判断を \`journal_write\` に残せ。
        根拠が無いなら \`ask_human\` に managerId: "mgr-pin", requestId: "rq-live" を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。（宛先を添えないと、人間が答えてもこの仕事を再開できない）"
      `);
      await s.clone.stop();
    }, 15_000);

    it('もう待たれていない質問（requestId が waiting に無い）', async () => {
      const s = await booted();
      const at = await deliver(s, { kind: 'question', text: '質問の本文', requestId: 'rq-gone' });
      expect(managerSection(s.inputs[at] ?? '')).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（質問）

        質問の本文

        この確認はもう待たれていない（既に解決したか、マネージャーが終わっている）。答え直す必要は無い。
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）"
      `);
      await s.clone.stop();
    }, 15_000);

    it('待たれているか分からない質問（台帳に無いマネージャー）', async () => {
      const s = await booted();
      const at = await deliver(s, {
        kind: 'question',
        text: '質問の本文',
        requestId: 'rq-live',
        managerId: 'mgr-elsewhere',
      });
      expect(managerSection(s.inputs[at] ?? '')).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-elsewhere から届いた。（質問）
        質問の本文
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）
        返事をするまで mgr-elsewhere のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。
        記憶に根拠があるなら自分で決めて \`manager_send\`（managerId: "mgr-elsewhere", requestId: "rq-live"）で返し、その判断を \`journal_write\` に残せ。
        根拠が無いなら \`ask_human\` に managerId: "mgr-elsewhere", requestId: "rq-live" を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。（宛先を添えないと、人間が答えてもこの仕事を再開できない）"
      `);
      await s.clone.stop();
    }, 15_000);

    it('requestId の無い質問', async () => {
      const s = await booted();
      const at = await deliver(s, { kind: 'question', text: '質問の本文' });
      expect(managerSection(s.inputs[at] ?? '')).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（質問）
        質問の本文
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）
        返事をするまで mgr-pin のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。
        記憶に根拠があるなら自分で決めて \`manager_send\`（managerId: "mgr-pin"）で返し、その判断を \`journal_write\` に残せ。
        根拠が無いなら \`ask_human\` に managerId: "mgr-pin" を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。（宛先を添えないと、人間が答えてもこの仕事を再開できない）"
      `);
      await s.clone.stop();
    }, 15_000);
  });

  describe('実行の許可確認', () => {
    it('同じ会話の1回目も2回目も応じ方は全文', async () => {
      const s = await booted();
      const first = await deliver(s, {
        kind: 'permission',
        text: '許可の本文',
        requestId: 'rq-live',
      });
      const second = await deliver(s, {
        kind: 'permission',
        text: '許可の本文',
        requestId: 'rq-live',
      });
      expect(managerSection(s.inputs[first] ?? '')).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（実行の許可確認）
        許可の本文
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）
        返事をするまで mgr-pin のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。
        記憶に根拠があるなら自分で決めて \`manager_send\`（managerId: "mgr-pin", requestId: "rq-live"）で返し、その判断を \`journal_write\` に残せ。
        許可確認なので \`decision\` に allow / deny を明示すること。
        根拠が無いなら \`ask_human\` に managerId: "mgr-pin", requestId: "rq-live" を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。（宛先を添えないと、人間が答えてもこの仕事を再開できない）"
      `);
      expect(managerSection(s.inputs[second] ?? '')).toMatchInlineSnapshot(`
        "[system] マネージャー mgr-pin から届いた。（実行の許可確認）
        許可の本文
        起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）
        返事をするまで mgr-pin のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。
        記憶に根拠があるなら自分で決めて \`manager_send\`（managerId: "mgr-pin", requestId: "rq-live"）で返し、その判断を \`journal_write\` に残せ。
        許可確認なので \`decision\` に allow / deny を明示すること。
        根拠が無いなら \`ask_human\` に managerId: "mgr-pin", requestId: "rq-live" を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。（宛先を添えないと、人間が答えてもこの仕事を再開できない）"
      `);
      await s.clone.stop();
    }, 15_000);
  });
});
