import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OWNER_RECORDABLE_TASK_TYPES } from './runner.js';

/**
 * **「背景処理の所有者を控えられるのは `Bash` だけ」という前提が、いまも現物と一致するか**
 * を測る（#570 / #861）。
 *
 * ## ⛔ この歯の向き —— いま緑で、前提が黙って変わったら赤
 *
 * `runner.ts` の `OWNER_RECORDABLE_TASK_TYPES` は「所有者を**引けないのが正常**」を
 * 判定する基準である。基準が緩すぎれば正常な状態に「計器が壊れた」という診断が出て、
 * きつすぎれば本当に壊れた回が無音になる。**どちらも、コードを1行も触らずに
 * SDK 側の変化だけで起こりうる。** だからここは実装ではなく**インストール済みの型定義**
 * に当てる。
 *
 * **赤くなったときに何を疑うかは、各 `it` の失敗メッセージに1行で書いてある。**
 * 直し方は「名簿を現物へ合わせる」か「`#recordBackgroundTaskOwner` が読むキーを増やす」の
 * どちらかで、**歯のほうを緩めるのは最後の手段である**（緩めた瞬間に、この歯は
 * 何も測らなくなる）。
 *
 * ## ⚠️ この歯が覆わないもの
 *
 * 測っているのは**型定義に現れる変化**までである。型はそのままで実物のフック JSON だけが
 * 変わる回（SDK の doc と実装がずれる回。#570 が `owned_by_subagent` で実際に踏んだ形）は
 * ここでは捕まらない —— `runner-stop.test.ts` の同じ断りと同じ限界である。
 * **そして `type` の友好名（`'shell'` など）が実物のフックでどう出るかは、この repo では
 * 一度も実測していない**（#570 の生 JSON に `type=shell` が在るのが唯一の根拠）。
 */

const require = createRequire(import.meta.url);

function sdkToolsTypes(): { path: string; version: string; text: string } {
  const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const dir = dirname(entry);
  const path = `${dir}/sdk-tools.d.ts`;
  if (!existsSync(path)) {
    // **黙って緑にしない。**「0件だった」と「走らなかった」を混ぜない
    // （`scripts/check-sdk-quotes.mjs` と同じ作法）。
    throw new Error(
      `同梱の sdk-tools.d.ts が無い（${path}）。先に \`pnpm install\` を走らせたか。`,
    );
  }
  let version = '不明';
  try {
    version = String(JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version ?? '不明');
  } catch {
    // 版が読めなくても検査は成り立つ（当てる先は型定義の本文である）。
  }
  return { path, version, text: readFileSync(path, 'utf8') };
}

const sdk = sdkToolsTypes();

/**
 * `export interface X` / `export type X =` の塊を名前つきで切り出す。
 *
 * **次の `export` が始まるまで**を1つの塊として扱う（この `.d.ts` は最上位が平坦で、
 * 塊のあいだに他の宣言が挟まらない）。波括弧を数えないのは、`AgentOutput` のような
 * 共用体（`|` で `{…}` が並ぶ）も1つの塊として拾いたいためである。
 */
function declarationBlocks(source: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = source.split('\n');
  let name: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (name !== null) blocks.set(name, buffer.join('\n'));
    name = null;
    buffer = [];
  };
  for (const line of lines) {
    const header = /^export (?:interface|type) ([A-Za-z_$][\w$]*)/.exec(line);
    if (header !== null) {
      flush();
      name = header[1] ?? null;
      buffer = [line];
      continue;
    }
    if (line.startsWith('export ')) flush();
    if (name !== null) buffer.push(line);
  }
  flush();
  return blocks;
}

const BLOCKS = declarationBlocks(sdk.text);

/** その塊が `name` という欄を宣言しているか（`name?: …` も含む）。 */
function declares(block: string, name: string): boolean {
  return new RegExp(`^\\s*${name}\\??:`, 'm').test(block);
}

/** その欄を宣言している塊の名前を、現れた順に全部返す。 */
function declaredBy(field: string): string[] {
  return [...BLOCKS].filter(([, block]) => declares(block, field)).map(([n]) => n);
}

describe(`背景処理の所有者を控えられる道具の名簿（SDK ${sdk.version} の型定義に当てる）`, () => {
  it('`backgroundTaskId` を返す出力は `BashOutput` ただ1つである', () => {
    expect(
      declaredBy('backgroundTaskId'),
      '赤の意味: 背景処理の id を `backgroundTaskId` で返す道具が `Bash` 以外にも現れた（または `BashOutput` から消えた）。' +
        '⟹ `runner.ts` の `#recordBackgroundTaskOwner` が読むキーと、`OWNER_RECORDABLE_TASK_TYPES` の名簿を見直すこと。',
    ).toEqual(['BashOutput']);
  });

  it('名簿の件数は、`backgroundTaskId` を返す出力の件数と一致する', () => {
    expect(
      OWNER_RECORDABLE_TASK_TYPES.size,
      '赤の意味: 名簿と現物の件数がずれた。名簿は「所有者を**引ける**種類」だけを持つ約束で、' +
        '引けない種類（`monitor` / `workflow` / `subagent`）をここへ足してはいけない。',
    ).toBe(declaredBy('backgroundTaskId').length);
    expect(
      [...OWNER_RECORDABLE_TASK_TYPES],
      '赤の意味: 名簿の中身が `shell` から変わった。`BackgroundTaskSummary.type` の友好名と食い違っていないか確かめること。',
    ).toEqual(['shell']);
  });

  it('`Monitor` / `Workflow` は `taskId` で返し、`backgroundTaskId` を持たない', () => {
    for (const name of ['MonitorOutput', 'WorkflowOutput']) {
      const block = BLOCKS.get(name) ?? '';
      expect(
        block,
        `赤の意味: ${name} が型定義から消えた（道具が無くなったか改名された）。`,
      ).not.toBe('');
      expect(
        declares(block, 'taskId'),
        `赤の意味: ${name} が id を返すキーを変えた。所有者を引ける側へ移ったなら名簿に足す判断が要る。`,
      ).toBe(true);
      expect(
        declares(block, 'backgroundTaskId'),
        `赤の意味: ${name} が \`backgroundTaskId\` を返すようになった。⟹ 所有者を控えられるので、` +
          '`#recordBackgroundTaskOwner` と名簿の両方を広げること（診断の対象に戻る）。',
      ).toBe(false);
    }
  });

  it('`Task`（`AgentOutput`）は `agentId` と `taskId` で返し、`backgroundTaskId` を持たない', () => {
    const block = BLOCKS.get('AgentOutput') ?? '';
    expect(
      block,
      '赤の意味: AgentOutput が型定義から消えた（`Task` の出力の形が変わった）。',
    ).not.toBe('');
    // 同期委譲は `agentId`、遠隔（`status: "remote_launched"`）は `taskId`。
    expect(declares(block, 'agentId')).toBe(true);
    expect(
      declares(block, 'taskId'),
      '赤の意味: 遠隔の `Task` が id を返すキーを変えた。`OWNER_RECORDABLE_TASK_TYPES` の doc の表を直すこと。',
    ).toBe(true);
    expect(
      declares(block, 'backgroundTaskId'),
      '赤の意味: `Task` が `backgroundTaskId` を返すようになった。⟹ PR #594 が置いた `subagent` の除外そのものが要らなくなる。',
    ).toBe(false);
  });
});
