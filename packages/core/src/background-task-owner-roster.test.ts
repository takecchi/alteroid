import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OWNER_RECORDABLE_TASK_TYPES } from './runner.js';

const require = createRequire(import.meta.url);

function sdkToolsTypes(): { path: string; version: string; text: string } {
  const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const dir = dirname(entry);
  const path = `${dir}/sdk-tools.d.ts`;
  if (!existsSync(path)) {
    throw new Error(
      `同梱の sdk-tools.d.ts が無い（${path}）。先に \`pnpm install\` を走らせたか。`,
    );
  }
  let version = '不明';
  try {
    version = String(JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version ?? '不明');
  } catch {
    // 版が読めなくても検査は成り立つ
  }
  return { path, version, text: readFileSync(path, 'utf8') };
}

const sdk = sdkToolsTypes();

// 波括弧を数えない: `AgentOutput` のような共用体（`|` で `{…}` が並ぶ）も1つの塊として拾うため
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

function declares(block: string, name: string): boolean {
  return new RegExp(`^\\s*${name}\\??:`, 'm').test(block);
}

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
