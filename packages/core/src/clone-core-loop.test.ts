import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  query as sdkQuery,
  Options,
  Query,
  SDKMessage,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  ALWAYS_REDELIVER,
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  CLONE_PERMISSION_MODE_ENV_KEY,
  createClone,
  placedClonePermissionMode,
  resolveCloneModel,
  resolveClonePermissionMode,
} from './clone.js';
import { EXCHANGE_KIND_REPLY_PREFIX } from './exchange-kind.js';
import { conversationMessages, readConversationWindow } from './conversation.js';
import { clearRecentTracesForTesting, recentDroppedTraces } from './dropped-record.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { CLONE_ACTOR_ID, isCloneActor } from './usage.js';
import {
  createCloneMcpServer,
  createCloneTools,
  MCP_INPUT_VALIDATION_ERROR_MARKER,
  qualifiedToolName,
} from './tools.js';
import type { ToolContext } from './tools.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import {
  fakeSdk,
  setup,
  wireEvents,
  waitFor,
  waitForExpect,
  waitForDone,
  isTerminal,
  memoryCardOutlineLines,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン', () => {
  it('人間の発言に応答し、往復が日誌に残る', async () => {
    const s = setup(() => 'こんにちは');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const shown = s.events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(shown).toBe('こんにちは');

    const exchanges = await s.stores.journal.list({ types: ['exchange'], with: ['human'] });
    expect(exchanges.map((e) => (e as { role: string }).role)).toEqual(['outbound', 'inbound']);

    await s.clone.stop();
  });

  it('層とモデル帯の対応、道具の配置を固定する（北極星の不変条件）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { options } = s.calls[0] as FakeCall;
    expect(options.model).toBe(CLONE_MODEL);
    expect(CLONE_MODEL).toBe('opus');
    expect(options.tools).toBeUndefined();
    expect(options.allowedTools).toContain('mcp__alteroid__memory_write');
    expect(options.allowedTools).toContain('mcp__alteroid__ask_human');
    expect(options.mcpServers).toHaveProperty('alteroid');
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.permissionMode).toBe('auto');
    expect(options.maxTurns).toBeUndefined();

    await s.clone.stop();
  });

  it('自分の手で使った道具は日誌に残る（自作ツールは重ねて残さない）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

    await hook(
      { tool_name: 'Bash', tool_input: { command: 'git log --oneline -3' } } as never,
      undefined,
      {} as never,
    );
    await hook(
      { tool_name: 'mcp__alteroid__memory_write', tool_input: { slug: 'values' } } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.map((entry) => (entry as { tool: string }).tool)).toEqual(['Bash']);
    expect((entries[0] as { actor: string }).actor).toBe(CLONE_ACTOR_ID);
    expect((entries[0] as { input: unknown }).input).toEqual({
      command: 'git log --oneline -3',
    });

    await s.clone.stop();
  });

  it('サブエージェントの中の道具実行は、自分で叩いた分と区別して残る', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

    await hook(
      { tool_name: 'Read', tool_input: { file_path: '/a' } } as never,
      undefined,
      {} as never,
    );
    await hook(
      {
        tool_name: 'Grep',
        tool_input: { pattern: 'x' },
        // SDK: 「Use this field (not agent_type) to distinguish subagent calls」[sdk-verbatim BaseHookInput.agent_id]
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
      } as never,
      undefined,
      {} as never,
    );
    await hook(
      { tool_name: 'Glob', tool_input: {}, agent_id: 'sub-2' } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    const byTool = new Map(
      entries.map((entry) => [
        (entry as { tool: string }).tool,
        (entry as { actor: string }).actor,
      ]),
    );
    expect(byTool.get('Read')).toBe(CLONE_ACTOR_ID);
    expect(byTool.get('Grep')).toBe('clone:sub:general-purpose');
    expect(byTool.get('Glob')).toBe('clone:sub:(不明)');
    for (const actor of byTool.values()) expect(isCloneActor(actor)).toBe(true);

    await s.clone.stop();
  });

  it('道具の名前が読めなくても、記録を落とさない（監査の穴を静かに空けない）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ tool_input: { any: 1 } } as never, undefined, {} as never);

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.map((entry) => (entry as { tool: string }).tool)).toEqual(['(不明な道具)']);

    await s.clone.stop();
  });

  it('自作ツールでも「読む」道具は日誌に残る（自前では跡を残さないので、重ねないと消える）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

    await hook(
      {
        tool_name: qualifiedToolName('memory_read'),
        tool_input: { slug: 'values' },
      } as never,
      undefined,
      {} as never,
    );
    await hook(
      {
        tool_name: qualifiedToolName('journal_read'),
        tool_input: { limit: 10 },
      } as never,
      undefined,
      {} as never,
    );
    await hook(
      {
        tool_name: qualifiedToolName('conversation_read'),
        tool_input: { window: 5 },
      } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    const byTool = new Map(
      entries.map((entry) => [
        (entry as { tool: string }).tool,
        (entry as { input: unknown }).input,
      ]),
    );
    expect(new Set(byTool.keys())).toEqual(
      new Set([
        qualifiedToolName('memory_read'),
        qualifiedToolName('journal_read'),
        qualifiedToolName('conversation_read'),
      ]),
    );
    expect(byTool.get(qualifiedToolName('memory_read'))).toEqual({ slug: 'values' });
    expect(byTool.get(qualifiedToolName('journal_read'))).toEqual({ limit: 10 });
    expect(byTool.get(qualifiedToolName('conversation_read'))).toEqual({ window: 5 });

    await s.clone.stop();
  });

  it('名簿に無い未知の自作ツールは、安全側（残す側）へ倒れる', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

    await hook(
      {
        tool_name: qualifiedToolName('future_tool'),
        tool_input: { any: 1 },
      } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.map((entry) => (entry as { tool: string }).tool)).toEqual([
      qualifiedToolName('future_tool'),
    ]);

    await s.clone.stop();
  });

  it('蒸留のサイドクエリの道具実行も日誌に残る（別セッションだと分かる形で）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0] as FakeCall;
    const dir = await makeTempDir('alteroid-distill-audit-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
    await preCompact(
      { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );

    const side = s.calls.at(-1) as FakeCall;
    expect(side).not.toBe(main);
    const hook = side.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('蒸留側に PostToolUse フックが無い');
    await hook(
      { tool_name: 'Write', tool_input: { file_path: '/a' } } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    const write = entries.find((entry) => (entry as { tool: string }).tool === 'Write');
    expect((write as { actor: string } | undefined)?.actor).toBe('clone:distill');
    expect(isCloneActor('clone:distill')).toBe(true);

    await s.clone.stop();
  });

  it('失敗した道具呼び出しは tool_use として残り、outcome: "failed" と error が読める', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');

    await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        error: 'exit code 1: 認証に失敗した',
      } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.length).toBe(1);
    const entry = entries[0] as {
      actor: string;
      tool: string;
      outcome?: string;
      error?: string;
    };
    expect(entry.tool).toBe('Bash');
    expect(entry.actor).toBe(CLONE_ACTOR_ID);
    expect(entry.outcome).toBe('failed');
    expect(entry.error).toBe('exit code 1: 認証に失敗した');

    await s.clone.stop();
  });

  it('⭐ 陰性対照: 成功した道具呼び出しには outcome も error も付かない（従来どおり）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

    await hook(
      { tool_name: 'Bash', tool_input: { command: 'git log --oneline -3' } } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.length).toBe(1);
    const entry = entries[0] as { outcome?: string; error?: string };
    expect(entry.outcome).toBeUndefined();
    expect(entry.error).toBeUndefined();

    await s.clone.stop();
  });

  it('中断された道具呼び出しは outcome: "interrupted" と読める（失敗とは別の印）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');

    await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'sleep 999' },
        error: 'aborted',
        is_interrupt: true,
      } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.length).toBe(1);
    expect((entries[0] as { outcome?: string }).outcome).toBe('interrupted');

    await s.clone.stop();
  });

  it('is_interrupt が欠けている失敗は "interrupted" ではなく "failed" 側へ倒れる', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');

    await hook(
      { tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1' } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect((entries[0] as { outcome?: string }).outcome).toBe('failed');

    await s.clone.stop();
  });

  it('蒸留のサイドクエリで失敗した道具呼び出しも日誌に残る（別セッションだと分かる形で）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0] as FakeCall;
    const dir = await makeTempDir('alteroid-distill-failure-audit-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
    await preCompact(
      { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );

    const side = s.calls.at(-1) as FakeCall;
    expect(side).not.toBe(main);
    const hook = side.options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('蒸留側に PostToolUseFailure フックが無い');
    await hook(
      {
        tool_name: qualifiedToolName('memory_write'),
        tool_input: { slug: 'values' },
        error: 'ストアに書けなかった',
      } as never,
      undefined,
      {} as never,
    );
    await hook(
      { tool_name: 'Write', tool_input: { file_path: '/a' }, error: 'ENOSPC' } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    const memoryWrite = entries.find(
      (entry) => (entry as { tool: string }).tool === qualifiedToolName('memory_write'),
    );
    expect(memoryWrite).toBeUndefined();

    const write = entries.find((entry) => (entry as { tool: string }).tool === 'Write');
    expect((write as { actor: string } | undefined)?.actor).toBe('clone:distill');
    expect((write as { outcome?: string } | undefined)?.outcome).toBe('failed');
    expect((write as { error?: string } | undefined)?.error).toBe('ENOSPC');

    await s.clone.stop();
  });

  it('自作ツール（自前で日誌へ書く側）の失敗は、成功と同じ規則で除かれる', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');

    await hook(
      {
        tool_name: qualifiedToolName('memory_write'),
        tool_input: { slug: 'values' },
        error: 'ストアに書けなかった',
      } as never,
      undefined,
      {} as never,
    );

    expect(await s.stores.journal.list({ types: ['tool_use'] })).toEqual([]);

    await s.clone.stop();
  });

  it('自作ツールでも「読む」道具（TRACELESS 側）の失敗は残る', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');

    await hook(
      {
        tool_name: qualifiedToolName('memory_read'),
        tool_input: { slug: 'values' },
        error: 'not found',
      } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.length).toBe(1);
    expect((entries[0] as { outcome?: string }).outcome).toBe('failed');

    await s.clone.stop();
  });

  it('道具の名前が読めない失敗でも、記録を落とさない（監査の穴を静かに空けない）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');

    await hook({ tool_input: { any: 1 }, error: '???' } as never, undefined, {} as never);

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.map((entry) => (entry as { tool: string }).tool)).toEqual(['(不明な道具)']);
    expect((entries[0] as { outcome?: string }).outcome).toBe('failed');

    await s.clone.stop();
  });

  it('error が上限を超えると切り詰められ、切り詰めたと分かる合図が付く', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');

    const huge = 'エラー詳細:'.repeat(2000);
    await hook(
      { tool_name: 'Bash', tool_input: { command: 'x' }, error: huge } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    const error = (entries[0] as { error?: string }).error;
    expect(error).toBeDefined();
    expect(error).toMatch(/省略/);
    expect(error!.length).toBeLessThan(huge.length);
    expect(error!.length).toBeLessThan(1000);

    await s.clone.stop();
  });

  describe('検証で落ちた自作ツールの呼び出しも tool_use として残る（Issue #1338 残件1）', () => {
    it('journal_write の decision が欠けた回は tool_use(outcome: "failed") として残り、self_dropped にも跡が残る', async () => {
      clearRecentTracesForTesting();
      const s = setup();
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

      await hook(
        {
          tool_name: qualifiedToolName('journal_write'),
          tool_input: { grounds: 'ある根拠のテキスト' },
          tool_response: {
            content: [
              {
                type: 'text',
                text:
                  `MCP error -32602: ${MCP_INPUT_VALIDATION_ERROR_MARKER}journal_write: ` +
                  '[{"code":"invalid_type","expected":"string","path":["decision"],' +
                  '"message":"引数が届いていない（received undefined）"}]',
              },
            ],
            isError: true,
          },
        } as never,
        undefined,
        {} as never,
      );

      const entries = await s.stores.journal.list({ types: ['tool_use'] });
      expect(entries.length).toBe(1);
      const entry = entries[0] as {
        actor: string;
        tool: string;
        outcome?: string;
        error?: string;
        input?: unknown;
      };
      expect(entry.tool).toBe(qualifiedToolName('journal_write'));
      expect(entry.actor).toBe(CLONE_ACTOR_ID);
      expect(entry.outcome).toBe('failed');
      expect(entry.input).toEqual({ grounds: 'ある根拠のテキスト' });
      expect(entry.error).toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);

      const traces = recentDroppedTraces();
      expect(traces.some((line) => line.includes('判断そのもの（journal_write）'))).toBe(true);
      expect(traces.some((line) => line.includes('fields=decision'))).toBe(true);

      await s.clone.stop();
    });

    it('他の自作ツール（memory_write）の検証落ちも tool_use として残る（self_dropped は journal_write だけの扱い）', async () => {
      clearRecentTracesForTesting();
      const s = setup();
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

      await hook(
        {
          tool_name: qualifiedToolName('memory_write'),
          tool_input: { slug: 'values', content: '本文' },
          tool_response: {
            content: [
              {
                type: 'text',
                text:
                  `MCP error -32602: ${MCP_INPUT_VALIDATION_ERROR_MARKER}memory_write: ` +
                  '[{"code":"invalid_type","expected":"string","path":["summary"],"message":"x"}]',
              },
            ],
            isError: true,
          },
        } as never,
        undefined,
        {} as never,
      );

      const entries = await s.stores.journal.list({ types: ['tool_use'] });
      expect(entries.length).toBe(1);
      const entry = entries[0] as { tool: string; outcome?: string; input?: unknown };
      expect(entry.tool).toBe(qualifiedToolName('memory_write'));
      expect(entry.outcome).toBe('failed');
      expect(entry.input).toEqual({ slug: 'values', content: '本文' });

      const traces = recentDroppedTraces();
      expect(traces.some((line) => line.includes('判断そのもの'))).toBe(false);

      await s.clone.stop();
    });

    it('⭐ 陰性対照: 自前で日誌へ書く道具の正常な成功は、tool_response が在っても二重に残さない', async () => {
      const s = setup();
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

      await hook(
        {
          tool_name: qualifiedToolName('memory_write'),
          tool_input: { slug: 'values', content: '本文', summary: '要約' },
          tool_response: {
            content: [{ type: 'text', text: '記憶に書いた（values）。' }],
            isError: false,
          },
        } as never,
        undefined,
        {} as never,
      );

      expect(await s.stores.journal.list({ types: ['tool_use'] })).toEqual([]);

      await s.clone.stop();
    });

    it('🔴 profile_write の検証落ちでは、値（script）が日誌のどこにも写らない（秘密を運ぶ道具）', async () => {
      clearRecentTracesForTesting();
      const s = setup();
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

      const SECRET_MARK = 'かえって-秘密-印-ABCDEF123456';
      await hook(
        {
          tool_name: qualifiedToolName('profile_write'),
          tool_input: { script: `export TOKEN=${SECRET_MARK}` },
          tool_response: {
            content: [
              {
                type: 'text',
                text:
                  `MCP error -32602: ${MCP_INPUT_VALIDATION_ERROR_MARKER}profile_write: ` +
                  '[{"code":"invalid_type","expected":"string","path":["summary"],"message":"x"}]',
              },
            ],
            isError: true,
          },
        } as never,
        undefined,
        {} as never,
      );

      const entries = await s.stores.journal.list({ types: ['tool_use'] });
      expect(entries.length).toBe(1);
      const entry = entries[0] as {
        tool: string;
        outcome?: string;
        input?: unknown;
        error?: string;
      };
      expect(entry.tool).toBe(qualifiedToolName('profile_write'));
      expect(entry.outcome).toBe('failed');
      expect(entry.input).toBeUndefined();
      expect(entry.error).not.toContain(SECRET_MARK);
      expect(entry.error).toContain('summary');

      expect(JSON.stringify(entries)).not.toContain(SECRET_MARK);

      const traces = recentDroppedTraces();
      expect(traces.some((line) => line.includes(SECRET_MARK))).toBe(false);

      await s.clone.stop();
    });

    it('陽性対照: 秘密を運ばない道具（memory_write）では、同じ目印の値がそのまま入力に残る', async () => {
      const s = setup();
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

      const MARK = 'かえって-秘密-印-ABCDEF123456';
      await hook(
        {
          tool_name: qualifiedToolName('memory_write'),
          tool_input: { slug: 'values', content: MARK },
          tool_response: {
            content: [
              {
                type: 'text',
                text:
                  `MCP error -32602: ${MCP_INPUT_VALIDATION_ERROR_MARKER}memory_write: ` +
                  '[{"code":"invalid_type","expected":"string","path":["summary"],"message":"x"}]',
              },
            ],
            isError: true,
          },
        } as never,
        undefined,
        {} as never,
      );

      const entries = await s.stores.journal.list({ types: ['tool_use'] });
      expect(entries.length).toBe(1);
      expect((entries[0] as { input?: unknown }).input).toEqual({
        slug: 'values',
        content: MARK,
      });
      expect(JSON.stringify(entries)).toContain(MARK);

      await s.clone.stop();
    });
  });

  it('確認へ上がらず止められた道具は日誌に残る。生の合図と result で二重に書かない', async () => {
    const denial = { tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'git push' } };
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => [
        {
          type: 'system',
          subtype: 'permission_denied',
          ...denial,
          decision_reason: '分類器が止めた',
          decision_reason_type: 'classifier',
          message: 'Bash is not allowed right now',
        } as unknown as SDKMessage,
      ],
      permissionDenials: () => [denial],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(1);
    const text = (denied[0] as { text: string }).text;
    expect(text).toContain('Bash');
    expect(text).toContain('分類: classifier');
    expect(text).toContain('理由: 分類器が止めた');
    expect(text).toContain('モデルへの拒否文: Bash is not allowed right now');
    expect(text).toContain('auto');
    expect(await s.stores.journal.list({ types: ['tool_use'] })).toEqual([]);

    await s.clone.stop();
  });

  it('確認へ上がらず止められた道具の分類・拒否文が欠けているときは作り物を出さず省く', async () => {
    const denial = { tool_name: 'Bash', tool_use_id: 'tu-2', tool_input: { command: 'git push' } };
    const s = setup(undefined, createMemoryStores(), {
      permissionDenials: () => [denial],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(1);
    const text = (denied[0] as { text: string }).text;
    expect(text).toContain('Bash');
    expect(text).not.toContain('分類:');
    expect(text).not.toContain('理由:');
    expect(text).not.toContain('モデルへの拒否文:');
    expect(text).not.toContain('（）');

    await s.clone.stop();
  });

  it('拒否の層（クローン本体／作業者／どちらの層か不明）が日誌の文言に出る', async () => {
    const mainThread = { tool_name: 'Bash', tool_use_id: 'tu-main', tool_input: { command: 'ls' } };
    const subAgent = {
      tool_name: 'Write',
      tool_use_id: 'tu-sub',
      tool_input: { file_path: '/a' },
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
    };
    const resultOnly = { tool_name: 'Edit', tool_use_id: 'tu-result' };
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => [
        { type: 'system', subtype: 'permission_denied', ...mainThread } as unknown as SDKMessage,
        { type: 'system', subtype: 'permission_denied', ...subAgent } as unknown as SDKMessage,
      ],
      permissionDenials: () => [resultOnly],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(3);
    const texts = denied.map((entry) => (entry as { text: string }).text);

    const mainText = texts.find((t) => t.includes('Bash'));
    expect(mainText).toContain('クローン本体');
    expect(mainText).not.toContain('作業者');

    const subText = texts.find((t) => t.includes('Write'));
    expect(subText).toContain('作業者');
    expect(subText).toContain('general-purpose');

    const resultText = texts.find((t) => t.includes('Edit'));
    expect(resultText).toContain('どちらの層か不明');
    expect(resultText).not.toContain('クローン本体');
    expect(resultText).not.toContain('作業者');

    await s.clone.stop();
  });

  it('live だけの拒否は「入力の形」が空にならず、入力が無い理由が載る（C1）', async () => {
    const denial = { tool_name: 'Bash', tool_use_id: 'tu-c1' };
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => [
        { type: 'system', subtype: 'permission_denied', ...denial } as unknown as SDKMessage,
      ],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(1);
    const text = (denied[0] as { text: string }).text;
    expect(text).toContain('入力の形: 入力は付いていない（走行中の合図には入力の欄が無い。');

    await s.clone.stop();
  });

  it('result だけの拒否は入力の形（欄・先頭の語・長さ）が日誌に載る（C2）', async () => {
    const denial = {
      tool_name: 'Bash',
      tool_use_id: 'tu-c2',
      tool_input: { command: 'git push origin main' },
    };
    const s = setup(undefined, createMemoryStores(), {
      permissionDenials: () => [denial],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(1);
    const text = (denied[0] as { text: string }).text;
    expect(text).toContain('入力の形: 欄=command');
    expect(text).toContain('先頭の語=git');
    expect(text).toMatch(/chars=\d+/);

    await s.clone.stop();
  });

  it('live→result（同じ tool_use_id）では、拒否の行のあとに形だけの行がもう1本増える（C3）', async () => {
    const bare = { tool_name: 'Bash', tool_use_id: 'tu-c3' };
    const withInput = {
      tool_name: 'Bash',
      tool_use_id: 'tu-c3',
      tool_input: { command: 'rm -rf /tmp/x' },
    };
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => [
        { type: 'system', subtype: 'permission_denied', ...bare } as unknown as SDKMessage,
      ],
      permissionDenials: () => [withInput],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const exchanges = await s.stores.journal.list({ types: ['exchange'] });
    const denialLines = exchanges.filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denialLines.length).toBe(1);

    const laterLines = exchanges.filter((entry) =>
      (entry as { text: string }).text.includes('ターン終わりの記録（合図の出所: result）に'),
    );
    expect(laterLines.length).toBe(1);
    const laterText = (laterLines[0] as { text: string }).text;
    expect(laterText).toContain('欄=command');
    expect(laterText).toContain('先頭の語=rm');

    await s.clone.stop();
  });

  it('live→result→result でも、追記の行は1本のまま増えない（C4）', async () => {
    const bare = { tool_name: 'Bash', tool_use_id: 'tu-c4' };
    const withInput = {
      tool_name: 'Bash',
      tool_use_id: 'tu-c4',
      tool_input: { command: 'curl https://example.com' },
    };
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => [
        { type: 'system', subtype: 'permission_denied', ...bare } as unknown as SDKMessage,
      ],
      permissionDenials: () => [withInput, withInput],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const exchanges = await s.stores.journal.list({ types: ['exchange'] });
    const laterLines = exchanges.filter((entry) =>
      (entry as { text: string }).text.includes('ターン終わりの記録（合図の出所: result）に'),
    );
    expect(laterLines.length).toBe(1);

    await s.clone.stop();
  });

  it('result→live の順では、行は1本のまま増えない（C5）', async () => {
    const withInput = {
      tool_name: 'Bash',
      tool_use_id: 'tu-c5',
      tool_input: { command: 'git push' },
    };
    const bare = { tool_name: 'Bash', tool_use_id: 'tu-c5' };
    let beforeAssistantCalls = 0;
    let permissionDenialCalls = 0;
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => {
        beforeAssistantCalls += 1;
        return beforeAssistantCalls === 2
          ? [{ type: 'system', subtype: 'permission_denied', ...bare } as unknown as SDKMessage]
          : [];
      },
      permissionDenials: () => {
        permissionDenialCalls += 1;
        return permissionDenialCalls === 1 ? [withInput] : undefined;
      },
    });

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    let denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(1);

    s.events.length = 0;
    s.clone.post(humanMessage('2回目'));
    await waitForDone(s.events);

    denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(1);
    const laterLines = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('ターン終わりの記録（合図の出所: result）に'),
    );
    expect(laterLines.length).toBe(0);

    await s.clone.stop();
  });

  it('入力に秘密が入っていても、日誌のどの行にも値そのものは現れない（C6・秘密の歯）', async () => {
    const secretCommand = 'TOKEN=ghp_XXXXXXXXXXXX curl "https://api.example.com/?token=s3cr3t"';
    const bare = { tool_name: 'Bash', tool_use_id: 'tu-c6' };
    const withSecret = {
      tool_name: 'Bash',
      tool_use_id: 'tu-c6',
      tool_input: { command: secretCommand },
    };
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => [
        { type: 'system', subtype: 'permission_denied', ...bare } as unknown as SDKMessage,
      ],
      permissionDenials: () => [withSecret],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const exchanges = await s.stores.journal.list({ types: ['exchange'] });
    const joined = exchanges.map((entry) => (entry as { text?: string }).text ?? '').join('\n');
    expect(joined).not.toContain('ghp_XXXXXXXXXXXX');
    expect(joined).not.toContain('s3cr3t');
    expect(joined).not.toContain('TOKEN=');

    await s.clone.stop();
  });

  it('権限モードの既定は人間が開く Claude Code と同じ（auto）。置けるのは人間だけ', () => {
    expect(resolveClonePermissionMode({})).toBe('auto');
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '' })).toBe('auto');
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '   ' })).toBe('auto');
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '  default  ' })).toBe(
      'default',
    );
    expect(() => resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: 'strict' })).toThrow(
      /ALTEROID_CLONE_PERMISSION_MODE/,
    );
  });

  it('置かれたかどうかは「既定と違うか」では言い換えられない（起動時の告知の材料）', () => {
    expect(placedClonePermissionMode({})).toBeNull();
    expect(placedClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '  ' })).toBeNull();
    expect(placedClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: ' auto ' })).toBe('auto');
    expect(placedClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: 'strict' })).toBe('strict');
  });

  it('人間が置いた権限モードが実際にセッションへ渡る', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      {},
      {
        [CLONE_PERMISSION_MODE_ENV_KEY]: 'default',
      },
    );

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect((s.calls[0] as FakeCall).options.permissionMode).toBe('default');

    await s.clone.stop();
  });

  it('モデル帯の既定は環境変数で動かない。空・空白は既定に落ちる', () => {
    expect(resolveCloneModel({})).toBe(CLONE_MODEL);
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: '' })).toBe(CLONE_MODEL);
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: '   ' })).toBe(CLONE_MODEL);
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: 'opus' })).toBe('opus');
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: '  opus  ' })).toBe('opus');
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: 'まだ無いモデル' })).toBe('まだ無いモデル');
  });

  it('差し替えた帯は本セッションと蒸留のサイドクエリの両方に効く', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { [CLONE_MODEL_ENV_KEY]: 'opus' });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0] as FakeCall;
    expect(main.options.model).toBe('opus');

    const dir = await makeTempDir('alteroid-clone-model-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');

    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const side = s.calls.at(-1) as FakeCall;
    expect(side).not.toBe(main);
    expect(side.options.model).toBe('opus');
    expect(side.options.tools).toBeUndefined();
    expect(side.options.settingSources).toEqual(['user', 'project', 'local']);
    expect(side.options.permissionMode).toBe('auto');
    expect(side.options.permissionMode).toBe(main.options.permissionMode);

    await s.clone.stop();
  });

  it('記憶をシステムプロンプトに載せる。人間が書き換えれば次の会話に反映される（受け入れ基準3）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 人間が手で書いた方針\n\n方針の中身\n');

    const s = setup(undefined, stores);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const before = await memoryCardOutlineLines(stores, 'values');
    const firstPrompt = String((s.calls[0] as FakeCall).options.systemPrompt);
    for (const line of before) expect(firstPrompt).toContain(line);
    await s.clone.stop();

    await stores.persona.write(
      'values',
      '# 人間が手で書いた方針\n\n方針の中身\n\n## あとから足した節\n\n追記\n',
    );
    const after = await memoryCardOutlineLines(stores, 'values');

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);

    const secondPrompt = String((second.calls[0] as FakeCall).options.systemPrompt);
    for (const line of after) expect(secondPrompt).toContain(line);
    for (const line of before) expect(secondPrompt).not.toContain(line);

    await second.clone.stop();
  });

  it('セッション id を覚え、次の起動で resume に渡す（再起動しても同じ人格）', async () => {
    const stores = createMemoryStores();

    const first = setup(undefined, stores);
    first.clone.post(humanMessage('やあ'));
    await waitForDone(first.events);
    await first.clone.stop();

    expect(await stores.sessions.getCloneSessionId()).toBe('sess-fake');
    expect((first.calls[0] as FakeCall).options.resume).toBeUndefined();

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);

    expect((second.calls[0] as FakeCall).options.resume).toBe('sess-fake');

    await second.clone.stop();
  });

  describe('resume する前にセッションの大きさを測る（#1283 の OOM）', () => {
    function bootCloneForResumeBudget(
      stores: Stores,
      sessionStore: SessionStore,
    ): { clone: CloneHost; events: ChatStreamEvent[]; calls: { resume: string | undefined }[] } {
      const calls: { resume: string | undefined }[] = [];
      const fn = ((params: { prompt: unknown; options?: Options }) => {
        calls.push({ resume: params.options?.resume });
        async function* generate(): AsyncGenerator<SDKMessage, void> {
          if (params.options?.resume !== undefined && params.options.sessionStore !== undefined) {
            await params.options.sessionStore.load({
              projectKey: 'proj',
              sessionId: params.options.resume,
            });
          }
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-fake',
            uuid: 'uuid-init',
          } as unknown as SDKMessage;
          for await (const message of params.prompt as AsyncIterable<{
            message: { content: unknown };
          }>) {
            void message;
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'ok' }] },
              parent_tool_use_id: null,
              session_id: 'sess-fake',
              uuid: 'uuid-assistant',
            } as unknown as SDKMessage;
            yield {
              type: 'result',
              subtype: 'success',
              result: 'ok',
              session_id: 'sess-fake',
              uuid: 'uuid-result',
            } as unknown as SDKMessage;
          }
        }
        const generator = generate();
        return Object.assign(generator, {
          close: () => undefined,
          interrupt: async () => undefined,
        }) as unknown as Query;
      }) as unknown as typeof sdkQuery;

      const clone = createClone({
        stores,
        queryFn: fn,
        sessionStore,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
        ]),
        redeliveryGate: ALWAYS_REDELIVER,
      });
      const { events } = wireEvents(clone, 'conv-1');
      return { clone, events, calls };
    }

    function fakeSdkSessionStore(): SessionStore & { load: ReturnType<typeof vi.fn> } {
      return {
        append: async () => undefined,
        load: vi.fn(async () => null),
      };
    }

    async function selfOutboundTexts(stores: Stores): Promise<string[]> {
      const rows = await stores.journal.list({ types: ['exchange'] });
      return rows
        .filter(
          (entry) =>
            entry.type === 'exchange' && entry.with === 'self' && entry.role === 'outbound',
        )
        .map((entry) => (entry.type === 'exchange' ? entry.text : ''));
    }

    const OVER_BUDGET_BYTES = 600 * 1024 * 1024;
    const UNDER_BUDGET_BYTES = 100;

    it('⭐ 予算を超えたセッションは resume せず、SDK の load() も呼ばれない（本丸）', async () => {
      const stores = createMemoryStores();
      await stores.sessions.setCloneSessionId('sess-huge');
      await stores.sessions.setProjectKey('proj');

      const measureSize = vi.fn(async () => OVER_BUDGET_BYTES);
      const tail: NonNullable<Stores['sessionTranscriptTail']> = {
        readTail: async () => null,
        measureSize,
      };
      const sessionStore = fakeSdkSessionStore();
      const { clone, events, calls } = bootCloneForResumeBudget(
        { ...stores, sessionTranscriptTail: tail },
        sessionStore,
      );

      clone.post(humanMessage('起動する'));
      await waitForDone(events);
      await clone.stop();

      expect(measureSize).toHaveBeenCalledWith({ projectKey: 'proj', sessionId: 'sess-huge' });
      expect(calls[0]?.resume).toBeUndefined();
      expect(sessionStore.load).not.toHaveBeenCalled();
    });

    it('予算内なら従来どおり resume する（SDK の load() も呼ばれる）', async () => {
      const stores = createMemoryStores();
      await stores.sessions.setCloneSessionId('sess-small');
      await stores.sessions.setProjectKey('proj');

      const measureSize = vi.fn(async () => UNDER_BUDGET_BYTES);
      const tail: NonNullable<Stores['sessionTranscriptTail']> = {
        readTail: async () => null,
        measureSize,
      };
      const sessionStore = fakeSdkSessionStore();
      const { clone, events, calls } = bootCloneForResumeBudget(
        { ...stores, sessionTranscriptTail: tail },
        sessionStore,
      );

      clone.post(humanMessage('起動する'));
      await waitForDone(events);
      await clone.stop();

      expect(calls[0]?.resume).toBe('sess-small');
      expect(sessionStore.load).toHaveBeenCalledWith({
        projectKey: 'proj',
        sessionId: 'sess-small',
      });
    });

    it('生ログの預け先が無い（fs 構成相当）ときは測れないので従来どおり resume する', async () => {
      const stores = createMemoryStores();
      await stores.sessions.setCloneSessionId('sess-fs');
      await stores.sessions.setProjectKey('proj');

      const sessionStore = fakeSdkSessionStore();
      const { clone, events, calls } = bootCloneForResumeBudget(stores, sessionStore);

      clone.post(humanMessage('起動する'));
      await waitForDone(events);
      await clone.stop();

      expect(calls[0]?.resume).toBe('sess-fs');
      expect(sessionStore.load).toHaveBeenCalledWith({
        projectKey: 'proj',
        sessionId: 'sess-fs',
      });
      expect(await selfOutboundTexts(stores)).not.toEqual(
        expect.arrayContaining([expect.stringContaining('大きすぎる')]),
      );
    });

    it('実装が「測れない」と申告した（null）ときも従来どおり resume する', async () => {
      const stores = createMemoryStores();
      await stores.sessions.setCloneSessionId('sess-unmeasurable');
      await stores.sessions.setProjectKey('proj');

      const measureSize = vi.fn(async () => null);
      const tail: NonNullable<Stores['sessionTranscriptTail']> = {
        readTail: async () => null,
        measureSize,
      };
      const sessionStore = fakeSdkSessionStore();
      const { clone, events, calls } = bootCloneForResumeBudget(
        { ...stores, sessionTranscriptTail: tail },
        sessionStore,
      );

      clone.post(humanMessage('起動する'));
      await waitForDone(events);
      await clone.stop();

      expect(calls[0]?.resume).toBe('sess-unmeasurable');
      expect(sessionStore.load).toHaveBeenCalledWith({
        projectKey: 'proj',
        sessionId: 'sess-unmeasurable',
      });
    });

    it('測る呼び出し自体が失敗したときも従来どおり resume する（判定できないときは能力を削らない側へ倒す）', async () => {
      const stores = createMemoryStores();
      await stores.sessions.setCloneSessionId('sess-error');
      await stores.sessions.setProjectKey('proj');

      const measureSize = vi.fn(async () => {
        throw new Error('DB が一時的に不調');
      });
      const tail: NonNullable<Stores['sessionTranscriptTail']> = {
        readTail: async () => null,
        measureSize,
      };
      const sessionStore = fakeSdkSessionStore();
      const { clone, events, calls } = bootCloneForResumeBudget(
        { ...stores, sessionTranscriptTail: tail },
        sessionStore,
      );

      const lines = await captureStderr(async () => {
        clone.post(humanMessage('起動する'));
        await waitForDone(events);
        await clone.stop();
      });

      expect(calls[0]?.resume).toBe('sess-error');
      expect(sessionStore.load).toHaveBeenCalledWith({
        projectKey: 'proj',
        sessionId: 'sess-error',
      });
      expect(lines.join('')).toContain('resume 前のセッションの大きさの計測を記録できませんでした');
    });

    it('予算を超えて resume しなかったとき、日誌に実測バイト数と予算が残る（数を捨てない）', async () => {
      const stores = createMemoryStores();
      await stores.sessions.setCloneSessionId('sess-huge-2');
      await stores.sessions.setProjectKey('proj');

      const measureSize = vi.fn(async () => OVER_BUDGET_BYTES);
      const tail: NonNullable<Stores['sessionTranscriptTail']> = {
        readTail: async () => null,
        measureSize,
      };
      const sessionStore = fakeSdkSessionStore();
      const { clone, events } = bootCloneForResumeBudget(
        { ...stores, sessionTranscriptTail: tail },
        sessionStore,
      );

      clone.post(humanMessage('起動する'));
      await waitForDone(events);
      await clone.stop();

      const texts = await selfOutboundTexts(stores);
      const line = texts.find((text) => text.includes('sess-huge-2'));
      expect(line).toBeDefined();
      expect(line).toContain(String(OVER_BUDGET_BYTES));
      expect(line).toContain('resume');
    });
  });

  it('会話終了で蒸留を促す（蒸留は生存条件であって付加機能ではない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[0]?.endsWith('価値観を伝える')).toBe(true);
    expect(inputs[1]).toContain('記憶へ移すべきものがあるか確認せよ');

    await s.clone.stop();
  });

  it('承認待ちへの回答は受信箱を通ってクローンに届く', async () => {
    const s = setup((input) =>
      input.includes('承認待ちにしていた質問に人間が答えた') ? '承認への返答' : 'わかった',
    );
    await s.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これを送ってよいか',
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const eventsBeforeAnswer = s.events.length;
    await s.clone.answerApproval('ap-1', 'よい');

    expect((await s.stores.jobs.listApprovals({ pendingOnly: true })).entries).toEqual([]);

    await waitFor(
      () => (s.calls[0] as FakeCall).inputs.some((input) => input.includes('よい')),
      '承認への回答「よい」がクローンの入力に届く',
    );

    await waitFor(async () => {
      const entries = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
      return entries.some(
        (entry) =>
          entry.type === 'exchange' &&
          entry.role === 'outbound' &&
          entry.text === `${EXCHANGE_KIND_REPLY_PREFIX}承認への返答`,
      );
    }, '承認への返答が日誌（exchange）に積まれる');
    const entries = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
    const reply = entries.find(
      (entry) =>
        entry.type === 'exchange' &&
        entry.role === 'outbound' &&
        entry.text === `${EXCHANGE_KIND_REPLY_PREFIX}承認への返答`,
    );
    if (reply === undefined || reply.type !== 'exchange') {
      throw new Error('回答ターンの返答が日誌に見つからない');
    }
    expect(reply.with).toBe('self');
    expect(reply.conversationId).toBeUndefined();
    expect(s.events.length).toBe(eventsBeforeAnswer);

    await s.clone.stop();
  });

  describe('answerApproval の回答経路の記録（issue #1479）', () => {
    it('via を渡すと、承認待ちの器・日誌・ターン入力の3か所すべてに answeredVia が付く', async () => {
      const s = setup((input) =>
        input.includes('承認待ちにしていた質問') ? 'わかった' : 'わかった',
      );
      await s.stores.jobs.putApproval({
        id: 'ap-via-1',
        createdAt: new Date().toISOString(),
        question: 'これを進めてよいか',
      });

      await s.clone.answerApproval('ap-via-1', 'よい', { kind: 'account', accountId: 'acc-1' });

      const approval = await s.stores.jobs.getApproval('ap-via-1');
      expect(approval?.answeredVia).toEqual({ kind: 'account', accountId: 'acc-1' });

      await waitFor(async () => {
        const escalations = await s.stores.journal.list({ types: ['escalation'], limit: 100 });
        return escalations.some(
          (entry) => entry.type === 'escalation' && entry.answeredVia !== undefined,
        );
      }, '回答経路つきの escalation 行が日誌に積まれる');
      const escalations = await s.stores.journal.list({ types: ['escalation'], limit: 100 });
      const answered = escalations.find(
        (entry) => entry.type === 'escalation' && entry.approvalId === 'ap-via-1',
      );
      if (answered === undefined || answered.type !== 'escalation') {
        throw new Error('回答の escalation 行が日誌に見つからない');
      }
      expect(answered.answeredVia).toEqual({ kind: 'account', accountId: 'acc-1' });

      await waitFor(
        () =>
          (s.calls[0] as FakeCall | undefined)?.inputs.some((input) =>
            input.includes('回答経路:'),
          ) ?? false,
        '回答経路の1行がクローンのターン入力に届く',
      );
      const turnInput = (s.calls[0] as FakeCall).inputs.find((input) =>
        input.includes('回答経路:'),
      );
      expect(turnInput).toContain('回答経路: account（acc-1）');

      await s.clone.stop();
    });

    it('via を渡さないと、器・日誌・ターン入力のどこにも answeredVia / 回答経路 が付かない', async () => {
      const s = setup();
      await s.stores.jobs.putApproval({
        id: 'ap-via-2',
        createdAt: new Date().toISOString(),
        question: 'これを進めてよいか',
      });

      await s.clone.answerApproval('ap-via-2', 'よい');

      const approval = await s.stores.jobs.getApproval('ap-via-2');
      expect(approval?.answeredVia).toBeUndefined();

      await waitFor(
        () =>
          (s.calls[0] as FakeCall | undefined)?.inputs.some((input) => input.includes('よい')) ??
          false,
        '回答「よい」がクローンの入力に届く',
      );
      const escalations = await s.stores.journal.list({ types: ['escalation'], limit: 100 });
      const answered = escalations.find(
        (entry) => entry.type === 'escalation' && entry.approvalId === 'ap-via-2',
      );
      expect(answered && answered.type === 'escalation' ? answered.answeredVia : undefined).toBe(
        undefined,
      );
      const turnInput = (s.calls[0] as FakeCall).inputs.find((input) => input.includes('よい'));
      expect(turnInput).not.toContain('回答経路:');

      await s.clone.stop();
    });
  });

  describe('answerApproval の許可の記録（issue #863「許可をコードではなくデータにする」）', () => {
    const PERMISSION_REQUEST_APPROVAL = {
      id: 'ap-perm-1',
      createdAt: new Date().toISOString(),
      question: '以降 Bash(gh release edit:*) を聞かずに通してよいか',
      permissionRequest: {
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit', 'gh release edit --draft'],
        denies: ['gh release edit; rm -rf /'],
      },
    };

    it('account 経路＋定型文ちょうどなら許可を記録する', async () => {
      const s = setup();
      await s.stores.jobs.putApproval(PERMISSION_REQUEST_APPROVAL);

      await s.clone.answerApproval('ap-perm-1', '許可します', {
        kind: 'account',
        accountId: 'acc-1',
      });

      const grants = await s.stores.permissionGrants.list();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit', 'gh release edit --draft'],
        denies: ['gh release edit; rm -rf /'],
        approvalId: 'ap-perm-1',
        answer: '許可します',
        route: { principalKind: 'account', accountId: 'acc-1' },
      });
      expect(grants[0]?.revokedAt).toBeUndefined();

      await s.clone.stop();
    });

    it('operator 経路では記録しない', async () => {
      const s = setup();
      await s.stores.jobs.putApproval(PERMISSION_REQUEST_APPROVAL);

      await s.clone.answerApproval('ap-perm-1', '許可します', {
        kind: 'operator',
        auth: 'operator-token',
      });

      expect(await s.stores.permissionGrants.list()).toHaveLength(0);

      await s.clone.stop();
    });

    it('経路を渡さなければ記録しない（既定は不許可）', async () => {
      const s = setup();
      await s.stores.jobs.putApproval(PERMISSION_REQUEST_APPROVAL);

      await s.clone.answerApproval('ap-perm-1', '許可します');

      expect(await s.stores.permissionGrants.list()).toHaveLength(0);

      await s.clone.stop();
    });

    it.each([['許可します。'], ['いいよ'], ['許可する'], [' 許可します 前後以外に空白']])(
      '定型文とちょうど一致しない回答「%s」では記録しない',
      async (answer) => {
        const s = setup();
        await s.stores.jobs.putApproval(PERMISSION_REQUEST_APPROVAL);

        await s.clone.answerApproval('ap-perm-1', answer, {
          kind: 'account',
          accountId: 'acc-1',
        });

        expect(await s.stores.permissionGrants.list()).toHaveLength(0);

        await s.clone.stop();
      },
    );

    it('前後の空白だけは trim して定型文と比べる', async () => {
      const s = setup();
      await s.stores.jobs.putApproval(PERMISSION_REQUEST_APPROVAL);

      await s.clone.answerApproval('ap-perm-1', '  許可します  ', {
        kind: 'account',
        accountId: 'acc-1',
      });

      expect(await s.stores.permissionGrants.list()).toHaveLength(1);

      await s.clone.stop();
    });

    it('permissionRequest を持たない普通の ask_human の回答では、何も記録しない', async () => {
      const s = setup();
      await s.stores.jobs.putApproval({
        id: 'ap-plain-1',
        createdAt: new Date().toISOString(),
        question: '本番に出してよいか',
      });

      await s.clone.answerApproval('ap-plain-1', '許可します', {
        kind: 'account',
        accountId: 'acc-1',
      });

      expect(await s.stores.permissionGrants.list()).toHaveLength(0);

      await s.clone.stop();
    });

    it('記録しなかった理由は日誌（decision）に残る', async () => {
      const s = setup();
      await s.stores.jobs.putApproval(PERMISSION_REQUEST_APPROVAL);

      await s.clone.answerApproval('ap-perm-1', '許可します', {
        kind: 'operator',
        auth: 'disabled',
      });

      const decisions = await s.stores.journal.list({ types: ['decision'] });
      expect(
        decisions.some(
          (entry) => entry.type === 'decision' && entry.decision.includes('許可を記録しなかった'),
        ),
      ).toBe(true);

      await s.clone.stop();
    });

    it('記録した事実も日誌（decision）に残る', async () => {
      const s = setup();
      await s.stores.jobs.putApproval(PERMISSION_REQUEST_APPROVAL);

      await s.clone.answerApproval('ap-perm-1', '許可します', {
        kind: 'account',
        accountId: 'acc-1',
      });

      const decisions = await s.stores.journal.list({ types: ['decision'] });
      expect(
        decisions.some(
          (entry) => entry.type === 'decision' && entry.decision.includes('許可を記録した'),
        ),
      ).toBe(true);

      await s.clone.stop();
    });
  });

  describe('PreToolUse フックが人間の承認した Bash 許可を消費する（issue #863）', () => {
    async function hookOf(s: Setup) {
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
      const hook = (s.calls[0] as FakeCall).options.hooks?.PreToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
      return hook;
    }

    const GRANT = {
      id: 'grant-1',
      rule: 'Bash(gh release edit:*)',
      allows: ['gh release edit'],
      denies: ['gh release edit; rm -rf /'],
      approvalId: 'ap-1',
      answer: '許可します',
      grantedAt: '2026-01-01T00:00:00.000Z',
      route: { principalKind: 'account' as const, accountId: 'acc-1' },
    };

    it('有効な許可に一致すれば allow を返し、lastUsedAt を進める', async () => {
      const s = setup();
      await s.stores.permissionGrants.put(GRANT);
      const hook = await hookOf(s);

      const result = (await hook(
        { tool_name: 'Bash', tool_input: { command: 'gh release edit --draft' } } as never,
        undefined,
        {} as never,
      )) as {
        continue: true;
        hookSpecificOutput?: { permissionDecision?: string };
      };

      expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
      const stored = await s.stores.permissionGrants.get('grant-1');
      expect(stored?.lastUsedAt).toBeDefined();

      await s.clone.stop();
    });

    it('一致しないコマンドには何も決めない（deny しない）', async () => {
      const s = setup();
      await s.stores.permissionGrants.put(GRANT);
      const hook = await hookOf(s);

      const result = (await hook(
        { tool_name: 'Bash', tool_input: { command: 'gh issue edit' } } as never,
        undefined,
        {} as never,
      )) as { continue: true; hookSpecificOutput?: unknown };

      expect(result.hookSpecificOutput).toBeUndefined();

      await s.clone.stop();
    });

    it('区切り文字入りのコマンドには何も決めない', async () => {
      const s = setup();
      await s.stores.permissionGrants.put(GRANT);
      const hook = await hookOf(s);

      const result = (await hook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'gh release edit --draft; rm -rf /' },
        } as never,
        undefined,
        {} as never,
      )) as { continue: true; hookSpecificOutput?: unknown };

      expect(result.hookSpecificOutput).toBeUndefined();

      await s.clone.stop();
    });

    it('取り消し後は、毎回引き直すので次の呼び出しから何も決めない', async () => {
      const s = setup();
      await s.stores.permissionGrants.put(GRANT);
      const hook = await hookOf(s);

      const before = (await hook(
        { tool_name: 'Bash', tool_input: { command: 'gh release edit' } } as never,
        undefined,
        {} as never,
      )) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(before.hookSpecificOutput?.permissionDecision).toBe('allow');

      await s.stores.permissionGrants.put({ ...GRANT, revokedAt: '2026-01-02T00:00:00.000Z' });

      const after = (await hook(
        { tool_name: 'Bash', tool_input: { command: 'gh release edit' } } as never,
        undefined,
        {} as never,
      )) as { hookSpecificOutput?: unknown };
      expect(after.hookSpecificOutput).toBeUndefined();

      await s.clone.stop();
    });

    it('人間の取り消しが、#onPreToolUse の list() と put() の間に割り込んでも消えない（lost update）', async () => {
      const base = createMemoryStores();
      let interrupt: (() => Promise<void>) | undefined;
      const stores: Stores = {
        ...base,
        permissionGrants: {
          ...base.permissionGrants,
          async list() {
            const grants = await base.permissionGrants.list();
            if (interrupt) {
              const fire = interrupt;
              interrupt = undefined;
              await fire();
            }
            return grants;
          },
        },
      };
      const s = setup(undefined, stores);
      await s.stores.permissionGrants.put(GRANT);
      const hook = await hookOf(s);

      interrupt = async () => {
        const current = await base.permissionGrants.get('grant-1');
        if (current === null) throw new Error('grant-1 が見当たらない');
        await base.permissionGrants.put({ ...current, revokedAt: '2026-01-02T00:00:00.000Z' });
      };

      await hook(
        { tool_name: 'Bash', tool_input: { command: 'gh release edit' } } as never,
        undefined,
        {} as never,
      );

      const stored = await base.permissionGrants.get('grant-1');
      expect(stored?.revokedAt).toBeDefined();
    });

    it('list() の後に人間の取り消しが完了していたら、同じ呼び出しでもその許可では通さない', async () => {
      const base = createMemoryStores();
      const stores: Stores = {
        ...base,
        permissionGrants: {
          ...base.permissionGrants,
          async list() {
            const grants = await base.permissionGrants.list();
            await base.permissionGrants.revoke('grant-1', '2026-01-02T00:00:00.000Z');
            return grants;
          },
        },
      };
      const s = setup(undefined, stores);
      await base.permissionGrants.put(GRANT);
      const hook = await hookOf(s);

      const result = (await hook(
        { tool_name: 'Bash', tool_input: { command: 'gh release edit' } } as never,
        undefined,
        {} as never,
      )) as { hookSpecificOutput?: { permissionDecision?: string } };

      expect((await base.permissionGrants.get('grant-1'))?.revokedAt).toBeDefined();
      expect(result.hookSpecificOutput?.permissionDecision).not.toBe('allow');
      expect((await base.permissionGrants.get('grant-1'))?.lastUsedAt).toBeUndefined();

      await s.clone.stop();
    });

    it('markUsed() が例外を投げても通す。ただし stderr へ跡を残し、rule は載せない', async () => {
      const base = createMemoryStores();
      await base.permissionGrants.put(GRANT);
      const stores: Stores = {
        ...base,
        permissionGrants: {
          ...base.permissionGrants,
          async markUsed(): Promise<boolean> {
            throw new Error('SCRATCH でも確認した意図的な store 障害');
          },
        },
      };
      const s = setup(undefined, stores);
      const hook = await hookOf(s);

      let result!: { hookSpecificOutput?: { permissionDecision?: string } };
      const lines = await captureStderr(async () => {
        result = (await hook(
          { tool_name: 'Bash', tool_input: { command: 'gh release edit' } } as never,
          undefined,
          {} as never,
        )) as { hookSpecificOutput?: { permissionDecision?: string } };
      });

      expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
      const traced = lines.filter((line) => line.includes('を記録できませんでした'));
      expect(traced).toHaveLength(1);
      expect(traced[0]).toContain('grant=grant-1');
      expect(traced[0]).not.toContain(GRANT.rule);
      expect(traced[0]).not.toContain('gh release edit');

      await s.clone.stop();
    });

    it('Bash 以外の道具には何もしない', async () => {
      const s = setup();
      await s.stores.permissionGrants.put(GRANT);
      const hook = await hookOf(s);

      const result = (await hook(
        { tool_name: 'mcp__alteroid__memory_write', tool_input: { slug: 'values' } } as never,
        undefined,
        {} as never,
      )) as { hookSpecificOutput?: unknown };
      expect(result.hookSpecificOutput).toBeUndefined();

      await s.clone.stop();
    });
  });

  describe(
    '#noteDenial が「hook の allow を SDK が追い越した」ことを検出する' +
      '（issue #863 残項目、2026-09-26）',
    () => {
      const GRANT = {
        id: 'grant-1',
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit'],
        denies: ['gh release edit; rm -rf /'],
        approvalId: 'ap-1',
        answer: '許可します',
        grantedAt: '2026-01-01T00:00:00.000Z',
        route: { principalKind: 'account' as const, accountId: 'acc-1' },
      };

      const FUNNELED_MARK = 'PreToolUse が allow を返した';

      function hooksOf(s: Setup) {
        const options = (s.calls[0] as FakeCall).options;
        const preToolUse = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
        const postToolUse = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (preToolUse === undefined) throw new Error('PreToolUse フックが登録されていない');
        if (postToolUse === undefined) throw new Error('PostToolUse フックが登録されていない');
        return { preToolUse, postToolUse };
      }

      it('grant に一致して allow → 同じ tool_use_id の live 拒否 → 検出の記録が出る', async () => {
        let beforeAssistantCalls = 0;
        const denial = {
          tool_name: 'Bash',
          tool_use_id: 'tu-funnel-1',
          tool_input: { command: 'gh release edit --draft' },
        };
        const s = setup(undefined, createMemoryStores(), {
          beforeAssistant: () => {
            beforeAssistantCalls += 1;
            return beforeAssistantCalls === 2
              ? [
                  {
                    type: 'system',
                    subtype: 'permission_denied',
                    ...denial,
                    decision_reason: '分類器が止めた',
                    decision_reason_type: 'classifier',
                    message: 'Bash is not allowed right now',
                  } as unknown as SDKMessage,
                ]
              : [];
          },
        });
        await s.stores.permissionGrants.put(GRANT);

        s.clone.post(humanMessage('やあ'));
        await waitForDone(s.events);
        const { preToolUse } = hooksOf(s);

        const decision = (await preToolUse(
          {
            tool_name: 'Bash',
            tool_input: { command: 'gh release edit --draft' },
            tool_use_id: 'tu-funnel-1',
          } as never,
          undefined,
          {} as never,
        )) as { hookSpecificOutput?: { permissionDecision?: string } };
        expect(decision.hookSpecificOutput?.permissionDecision).toBe('allow');

        s.events.length = 0;
        s.clone.post(humanMessage('two'));
        await waitForDone(s.events);

        const entries = await s.stores.journal.list({ types: ['exchange'] });
        const funneled = entries.filter((entry) =>
          (entry as { text: string }).text.includes(FUNNELED_MARK),
        );
        expect(funneled.length).toBe(1);
        const text = (funneled[0] as { text: string }).text;
        expect(text).toContain('Bash(gh release edit:*)');
        expect(text).toContain('grant-1');
        expect(text).toContain('分類: classifier');
        expect(text).toContain('理由: 分類器が止めた');
        expect(text).toContain('分類器へ回すようになった');
        expect(text).toContain('deny 規則が hook の allow を上書きした');
        expect(text).toContain('この許可は、いまは効いていない可能性がある');
        expect(text).not.toContain('gh release edit --draft');

        await s.clone.stop();
      });

      it('grant に一致しない呼び出しの拒否では検出の記録が出ない', async () => {
        let beforeAssistantCalls = 0;
        const denial = {
          tool_name: 'Bash',
          tool_use_id: 'tu-no-match-1',
          tool_input: { command: 'git push' },
        };
        const s = setup(undefined, createMemoryStores(), {
          beforeAssistant: () => {
            beforeAssistantCalls += 1;
            return beforeAssistantCalls === 2
              ? [
                  {
                    type: 'system',
                    subtype: 'permission_denied',
                    ...denial,
                  } as unknown as SDKMessage,
                ]
              : [];
          },
        });
        await s.stores.permissionGrants.put(GRANT);

        s.clone.post(humanMessage('やあ'));
        await waitForDone(s.events);

        s.events.length = 0;
        s.clone.post(humanMessage('two'));
        await waitForDone(s.events);

        const entries = await s.stores.journal.list({ types: ['exchange'] });
        expect(
          entries.some((entry) => (entry as { text: string }).text.includes(FUNNELED_MARK)),
        ).toBe(false);

        await s.clone.stop();
      });

      it(
        'allow の後に PostToolUse で成功が決着すれば帳面から消え、後で同じ id の' +
          '拒否が来ても検出しない（id の再利用は現実には無いが、帳面が消えている' +
          'ことの歯として）',
        async () => {
          let beforeAssistantCalls = 0;
          const denial = {
            tool_name: 'Bash',
            tool_use_id: 'tu-settled-1',
            tool_input: { command: 'gh release edit --draft' },
          };
          const s = setup(undefined, createMemoryStores(), {
            beforeAssistant: () => {
              beforeAssistantCalls += 1;
              return beforeAssistantCalls === 2
                ? [
                    {
                      type: 'system',
                      subtype: 'permission_denied',
                      ...denial,
                    } as unknown as SDKMessage,
                  ]
                : [];
            },
          });
          await s.stores.permissionGrants.put(GRANT);

          s.clone.post(humanMessage('やあ'));
          await waitForDone(s.events);
          const { preToolUse, postToolUse } = hooksOf(s);

          await preToolUse(
            {
              tool_name: 'Bash',
              tool_input: { command: 'gh release edit --draft' },
              tool_use_id: 'tu-settled-1',
            } as never,
            undefined,
            {} as never,
          );
          await postToolUse(
            {
              tool_name: 'Bash',
              tool_use_id: 'tu-settled-1',
              tool_input: { command: 'gh release edit --draft' },
              tool_response: { output: 'ok' },
            } as never,
            undefined,
            {} as never,
          );

          s.events.length = 0;
          s.clone.post(humanMessage('two'));
          await waitForDone(s.events);

          const entries = await s.stores.journal.list({ types: ['exchange'] });
          expect(
            entries.some((entry) => (entry as { text: string }).text.includes(FUNNELED_MARK)),
          ).toBe(false);

          await s.clone.stop();
        },
      );
    },
  );

  describe(
    '#onSubagentStop が「決着も拒否の記録も無いまま作業者が終わった」ことを検出する' +
      '（issue #1803）',
    () => {
      const GRANT = {
        id: 'grant-1',
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit'],
        denies: ['gh release edit; rm -rf /'],
        approvalId: 'ap-1',
        answer: '許可します',
        grantedAt: '2026-01-01T00:00:00.000Z',
        route: { principalKind: 'account' as const, accountId: 'acc-1' },
      };

      const UNSETTLED_MARK = 'SubagentStop を迎えた';

      function hooksOf(s: Setup) {
        const options = (s.calls[0] as FakeCall).options;
        const preToolUse = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
        const postToolUse = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        const subagentStop = options.hooks?.SubagentStop?.[0]?.hooks?.[0];
        if (preToolUse === undefined) throw new Error('PreToolUse フックが登録されていない');
        if (postToolUse === undefined) throw new Error('PostToolUse フックが登録されていない');
        if (subagentStop === undefined) throw new Error('SubagentStop フックが登録されていない');
        return { preToolUse, postToolUse, subagentStop };
      }

      it(
        '作業者の allow が決着も拒否も無いまま SubagentStop を迎えたら、日誌に1行残り' +
          '帳面から消える（もう一度同じ agentId で SubagentStop が来ても増えない）',
        async () => {
          const s = setup();
          await s.stores.permissionGrants.put(GRANT);
          s.clone.post(humanMessage('やあ'));
          await waitForDone(s.events);
          const { preToolUse, subagentStop } = hooksOf(s);

          const decision = (await preToolUse(
            {
              tool_name: 'Bash',
              tool_input: { command: 'gh release edit --draft' },
              tool_use_id: 'tu-sub-1',
              agent_id: 'agent-1',
            } as never,
            undefined,
            {} as never,
          )) as { hookSpecificOutput?: { permissionDecision?: string } };
          expect(decision.hookSpecificOutput?.permissionDecision).toBe('allow');

          await subagentStop({ agent_id: 'agent-1' } as never, undefined, {} as never);

          const entries = await s.stores.journal.list({ types: ['exchange'] });
          const unsettled = entries.filter((entry) =>
            (entry as { text: string }).text.includes(UNSETTLED_MARK),
          );
          expect(unsettled.length).toBe(1);
          const text = (unsettled[0] as { text: string }).text;
          expect(text).toContain('grant-1');
          expect(text).toContain('Bash(gh release edit:*)');
          expect(text).toContain('agent-1');
          expect(text).toContain('tu-sub-1');
          expect(text).toContain('決着しなかった');
          expect(text).not.toContain('gh release edit --draft');

          await subagentStop({ agent_id: 'agent-1' } as never, undefined, {} as never);
          const entriesAfter = await s.stores.journal.list({ types: ['exchange'] });
          expect(
            entriesAfter.filter((entry) =>
              (entry as { text: string }).text.includes(UNSETTLED_MARK),
            ).length,
          ).toBe(1);

          await s.clone.stop();
        },
      );

      it('PostToolUse で決着していれば、その作業者の SubagentStop でも何も出ない', async () => {
        const s = setup();
        await s.stores.permissionGrants.put(GRANT);
        s.clone.post(humanMessage('やあ'));
        await waitForDone(s.events);
        const { preToolUse, postToolUse, subagentStop } = hooksOf(s);

        await preToolUse(
          {
            tool_name: 'Bash',
            tool_input: { command: 'gh release edit --draft' },
            tool_use_id: 'tu-sub-2',
            agent_id: 'agent-1',
          } as never,
          undefined,
          {} as never,
        );
        await postToolUse(
          {
            tool_name: 'Bash',
            tool_use_id: 'tu-sub-2',
            tool_input: { command: 'gh release edit --draft' },
            tool_response: { output: 'ok' },
          } as never,
          undefined,
          {} as never,
        );

        await subagentStop({ agent_id: 'agent-1' } as never, undefined, {} as never);

        const entries = await s.stores.journal.list({ types: ['exchange'] });
        expect(
          entries.some((entry) => (entry as { text: string }).text.includes(UNSETTLED_MARK)),
        ).toBe(false);

        await s.clone.stop();
      });

      it('別の作業者の SubagentStop では出ない（agentId で絞れている）', async () => {
        const s = setup();
        await s.stores.permissionGrants.put(GRANT);
        s.clone.post(humanMessage('やあ'));
        await waitForDone(s.events);
        const { preToolUse, subagentStop } = hooksOf(s);

        await preToolUse(
          {
            tool_name: 'Bash',
            tool_input: { command: 'gh release edit --draft' },
            tool_use_id: 'tu-sub-3',
            agent_id: 'agent-1',
          } as never,
          undefined,
          {} as never,
        );

        await subagentStop({ agent_id: 'agent-2' } as never, undefined, {} as never);

        const entries = await s.stores.journal.list({ types: ['exchange'] });
        expect(
          entries.some((entry) => (entry as { text: string }).text.includes(UNSETTLED_MARK)),
        ).toBe(false);

        await s.clone.stop();
      });

      it('メインスレッド（agent_id 無し）の控えは、どの SubagentStop でも出ない', async () => {
        const s = setup();
        await s.stores.permissionGrants.put(GRANT);
        s.clone.post(humanMessage('やあ'));
        await waitForDone(s.events);
        const { preToolUse, subagentStop } = hooksOf(s);

        await preToolUse(
          {
            tool_name: 'Bash',
            tool_input: { command: 'gh release edit --draft' },
            tool_use_id: 'tu-sub-4',
          } as never,
          undefined,
          {} as never,
        );

        await subagentStop({ agent_id: 'agent-1' } as never, undefined, {} as never);

        const entries = await s.stores.journal.list({ types: ['exchange'] });
        expect(
          entries.some((entry) => (entry as { text: string }).text.includes(UNSETTLED_MARK)),
        ).toBe(false);

        await s.clone.stop();
      });

      it(
        'SubagentStop の後に同じ tool_use_id で PostToolUse が来ても例外にならず、' +
          '二重にも出ない',
        async () => {
          const s = setup();
          await s.stores.permissionGrants.put(GRANT);
          s.clone.post(humanMessage('やあ'));
          await waitForDone(s.events);
          const { preToolUse, postToolUse, subagentStop } = hooksOf(s);

          await preToolUse(
            {
              tool_name: 'Bash',
              tool_input: { command: 'gh release edit --draft' },
              tool_use_id: 'tu-sub-5',
              agent_id: 'agent-1',
            } as never,
            undefined,
            {} as never,
          );

          await subagentStop({ agent_id: 'agent-1' } as never, undefined, {} as never);

          let threw = false;
          try {
            await postToolUse(
              {
                tool_name: 'Bash',
                tool_use_id: 'tu-sub-5',
                tool_input: { command: 'gh release edit --draft' },
                tool_response: { output: 'ok' },
              } as never,
              undefined,
              {} as never,
            );
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);

          const entries = await s.stores.journal.list({ types: ['exchange'] });
          expect(
            entries.filter((entry) => (entry as { text: string }).text.includes(UNSETTLED_MARK))
              .length,
          ).toBe(1);

          await s.clone.stop();
        },
      );
    },
  );

  it(
    '会話 id を持つ承認に答えると、返答が with: "human" としてその会話 id と共に' +
      '日誌へ積まれ、会話の窓（readConversationWindow）からも読める（#768）',
    async () => {
      const s = setup((input) =>
        input.includes('承認待ちにしていた質問に人間が答えた') ? '(a) で進めます' : 'やあの返事',
      );

      s.clone.post(humanMessage('本番 DB へ打ってよいか判断してくれ'));
      await waitForDone(s.events);

      await s.stores.jobs.putApproval({
        id: 'ap-1',
        createdAt: new Date().toISOString(),
        question: '本番 DB へ2文だけ打ってよいか',
        conversationId: 'conv-1',
      });

      await s.clone.answerApproval('ap-1', '(a) でよい');

      await waitFor(async () => {
        const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
        return found.some(
          (entry) =>
            entry.type === 'exchange' &&
            entry.role === 'outbound' &&
            entry.text.includes('(a) で進めます'),
        );
      }, '会話 id を持つ承認への返答が日誌に積まれる');

      const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
      const reply = found.find(
        (entry) =>
          entry.type === 'exchange' &&
          entry.role === 'outbound' &&
          entry.text.includes('(a) で進めます'),
      );
      if (reply === undefined || reply.type !== 'exchange') {
        throw new Error('回答ターンの返答が日誌に見つからない');
      }
      expect(reply.with).toBe('human');
      expect(reply.conversationId).toBe('conv-1');

      const window = await readConversationWindow(s.stores.journal, { scan: 100 });
      const messages = conversationMessages(window, 'conv-1');
      expect(messages.some((m) => m.role === 'outbound' && m.text.includes('(a) で進めます'))).toBe(
        true,
      );

      await s.clone.stop();
    },
  );

  it(
    '会話 id を持つ承認に答えると、その会話へ SSE が流れる' +
      '（Issue の実測は回答後の SSE が0件だった。ここが変わるのが直った証拠）（#768）',
    async () => {
      const s = setup((input) =>
        input.includes('承認待ちにしていた質問に人間が答えた') ? '(a) で進めます' : 'やあの返事',
      );

      s.clone.post(humanMessage('本番 DB へ打ってよいか判断してくれ'));
      await waitForDone(s.events);
      const afterFirstTurn = s.events.length;

      await s.stores.jobs.putApproval({
        id: 'ap-1',
        createdAt: new Date().toISOString(),
        question: '本番 DB へ2文だけ打ってよいか',
        conversationId: 'conv-1',
      });

      expect(s.events.length).toBe(afterFirstTurn);

      await s.clone.answerApproval('ap-1', '(a) でよい');

      await s.waitForEvents((events) => events.slice(afterFirstTurn).some(isTerminal));

      const after = s.events.slice(afterFirstTurn);
      expect(after.length).toBeGreaterThan(0);
      expect(after.some((e) => e.type === 'text' && e.text.includes('(a) で進めます'))).toBe(true);
      expect(after.some((e) => e.type === 'done')).toBe(true);

      await s.clone.stop();
    },
  );

  it(
    'ask_human は人間の発言のターン中に呼ばれると承認に conversationId を積み、' +
      '内部ターン（会話 id を持たない承認への回答）では積まない（#768）',
    async () => {
      const stores = createMemoryStores();
      let captured: ToolContext | undefined;
      const { fn, calls } = fakeSdk(undefined, { delayMs: 200 });
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
        mcpServerFactory: (context) => {
          captured = context;
          return createCloneMcpServer(context);
        },
      });
      const { events } = wireEvents(clone, 'conv-1');

      async function askHuman(question: string): Promise<void> {
        if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
        const tools = createCloneTools(captured);
        const found = tools.find((entry) => entry.name === 'ask_human');
        if (!found) throw new Error('ask_human という道具が無い');
        await found.handler({ question } as never, {});
      }

      clone.post(humanMessage('本番 DB へ打ってよいか判断してくれ'));
      await waitFor(
        () => calls[0]?.inputs.some((input) => input.includes('本番 DB')) ?? false,
        '『本番 DB』を含む入力がクローンに届く',
      );
      await askHuman('人間のターン中の質問');
      await waitForDone(events);

      const duringHuman = (await stores.jobs.listApprovals({ pendingOnly: true })).entries.find(
        (approval) => approval.question === '人間のターン中の質問',
      );
      expect(duringHuman?.conversationId).toBe('conv-1');

      await stores.jobs.putApproval({
        id: 'ap-internal',
        createdAt: new Date().toISOString(),
        question: '内部ターンの引き金',
      });
      await clone.answerApproval('ap-internal', 'よい');
      await waitFor(
        () =>
          calls[0]?.inputs.some(
            (input) =>
              input.includes('承認待ちにしていた質問に人間が答えた') &&
              input.includes('内部ターンの引き金'),
          ) ?? false,
        '承認待ちの質問への回答が内部ターンの引き金として入力に届く',
      );
      await askHuman('内部ターン中の質問');

      const duringInternal = (await stores.jobs.listApprovals({ pendingOnly: true })).entries.find(
        (approval) => approval.question === '内部ターン中の質問',
      );
      expect(duringInternal?.conversationId).toBeUndefined();

      await waitFor(async () => {
        const entries = await stores.journal.list({ types: ['exchange'], limit: 100 });
        return (
          entries.filter((entry) => entry.type === 'exchange' && entry.role === 'outbound')
            .length >= 2
        );
      }, 'outbound の exchange が2件以上、日誌に積まれる');

      await clone.stop();
    },
  );

  it(
    '会話 id を持つ承認に答えると、outbound の exchange に approvalId が積まれる' +
      '（issue #782 の1）',
    async () => {
      const s = setup((input) =>
        input.includes('承認待ちにしていた質問に人間が答えた')
          ? '承認への返答（#782）'
          : 'やあの返事',
      );

      s.clone.post(humanMessage('本番 DB へ打ってよいか判断してくれ'));
      await waitForDone(s.events);

      await s.stores.jobs.putApproval({
        id: 'ap-1',
        createdAt: new Date().toISOString(),
        question: '本番 DB へ2文だけ打ってよいか',
        conversationId: 'conv-1',
      });
      await s.clone.answerApproval('ap-1', '(a) でよい');

      await waitFor(async () => {
        const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
        return found.some(
          (entry) =>
            entry.type === 'exchange' &&
            entry.role === 'outbound' &&
            entry.text.includes('承認への返答（#782）'),
        );
      }, '承認への返答（approvalId 付き）が日誌に積まれる');

      const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
      const reply = found.find(
        (entry) =>
          entry.type === 'exchange' &&
          entry.role === 'outbound' &&
          entry.text.includes('承認への返答（#782）'),
      );
      if (reply === undefined || reply.type !== 'exchange') {
        throw new Error('回答ターンの返答が日誌に見つからない');
      }
      expect(reply.approvalId).toBe('ap-1');
      expect(reply.with).toBe('human');
      expect(reply.conversationId).toBe('conv-1');

      await s.clone.stop();
    },
  );

  it(
    '同じ会話で2件の承認へ立て続けに答えても、それぞれの outbound の exchange は' +
      '別の approvalId を持つ（issue #782 の1。「同じ時刻に2件答えたら区別できない」' +
      'の裏返し——会話 id と時刻の近さだけでは区別できない場面の芯）',
    async () => {
      const s = setup((input) => {
        if (input.includes('質問A')) return '返答A';
        if (input.includes('質問B')) return '返答B';
        return 'やあの返事';
      });

      s.clone.post(humanMessage('本番 DB へ打ってよいか判断してくれ'));
      await waitForDone(s.events);

      await s.stores.jobs.putApproval({
        id: 'ap-A',
        createdAt: new Date().toISOString(),
        question: '質問A: 本番 DB へ2文だけ打ってよいか',
        conversationId: 'conv-1',
      });
      await s.stores.jobs.putApproval({
        id: 'ap-B',
        createdAt: new Date().toISOString(),
        question: '質問B: ステージングへも打ってよいか',
        conversationId: 'conv-1',
      });
      await s.clone.answerApproval('ap-A', 'よい');
      await waitFor(async () => {
        const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
        return found.some(
          (entry) =>
            entry.type === 'exchange' && entry.role === 'outbound' && entry.text === '返答A',
        );
      }, '質問Aへの返答が日誌に積まれる');
      await s.clone.answerApproval('ap-B', 'よい');
      await waitFor(async () => {
        const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
        return found.some(
          (entry) =>
            entry.type === 'exchange' && entry.role === 'outbound' && entry.text === '返答B',
        );
      }, '質問Bへの返答が日誌に積まれる');

      const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
      const replyA = found.find(
        (entry) => entry.type === 'exchange' && entry.role === 'outbound' && entry.text === '返答A',
      );
      const replyB = found.find(
        (entry) => entry.type === 'exchange' && entry.role === 'outbound' && entry.text === '返答B',
      );
      if (
        replyA === undefined ||
        replyA.type !== 'exchange' ||
        replyB === undefined ||
        replyB.type !== 'exchange'
      ) {
        throw new Error('2件の回答ターンの返答が日誌に見つからない');
      }
      expect(replyA.conversationId).toBe('conv-1');
      expect(replyB.conversationId).toBe('conv-1');
      expect(replyA.approvalId).toBe('ap-A');
      expect(replyB.approvalId).toBe('ap-B');
      expect(replyA.approvalId).not.toBe(replyB.approvalId);

      await s.clone.stop();
    },
  );

  it(
    '承認に由来しないターン（人間の発言・会話 id を持たない承認への回答）の' +
      'outbound の exchange には approvalId が付かない（issue #782 の1。契約の反対側 ——' +
      '片側だけの歯だと「全部に付ける」実装も緑になってしまう）',
    async () => {
      const s = setup((input) =>
        input.includes('承認待ちにしていた質問に人間が答えた') ? '内部ターンの返答' : '通常の返事',
      );

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      await s.stores.jobs.putApproval({
        id: 'ap-internal',
        createdAt: new Date().toISOString(),
        question: '内部ターンの引き金',
      });
      await s.clone.answerApproval('ap-internal', 'よい');
      await waitFor(async () => {
        const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
        return found.some(
          (entry) =>
            entry.type === 'exchange' &&
            entry.role === 'outbound' &&
            entry.text === `${EXCHANGE_KIND_REPLY_PREFIX}内部ターンの返答`,
        );
      }, '内部ターンの返答が日誌に積まれる');

      const found = await s.stores.journal.list({ types: ['exchange'], limit: 100 });
      const outbound = found.filter(
        (entry) => entry.type === 'exchange' && entry.role === 'outbound',
      );
      expect(outbound.length).toBeGreaterThanOrEqual(2);
      for (const entry of outbound) {
        if (entry.type !== 'exchange') continue;
        expect(entry.approvalId).toBeUndefined();
      }
      const internalReply = outbound.find(
        (entry) =>
          entry.type === 'exchange' &&
          entry.text === `${EXCHANGE_KIND_REPLY_PREFIX}内部ターンの返答`,
      );
      if (internalReply === undefined || internalReply.type !== 'exchange') {
        throw new Error('内部ターンの返答が見つからない');
      }
      expect(internalReply.with).toBe('self');

      await s.clone.stop();
    },
  );

  it('マネージャーの報告と確認は受信箱を通ってクローンに届く（配線）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report',
      text: '直しました',
    });
    s.clone.post({
      type: 'manager_message',
      id: 'evt-permission',
      at: new Date().toISOString(),
      managerId: 'mgr-2',
      kind: 'permission',
      text: 'Bash の実行許可: git push',
      requestId: 'req-1',
    });

    const inputs = () => (s.calls[0] as FakeCall).inputs;
    await waitFor(
      () => inputs().some((input) => input.includes('直しました')),
      '『直しました』を含む入力が届く',
    );

    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('git push'))).toBeTruthy(),
      '『git push』を含む入力が届く',
    );
    const permission = inputs().find((input) => input.includes('git push')) ?? '';

    expect(permission).toContain('mgr-2');
    expect(permission).toContain('manager_send');
    expect(permission).toContain('ask_human');

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { with: string }[];
    expect(exchanges.some((entry) => entry.with === 'manager')).toBe(true);

    await s.clone.stop();
  });
});
