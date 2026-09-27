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

    // **`with: ['human']` で絞る（Issue #1060）。** 受信箱から自動で台帳を
    // 開いた合図には、いまは機械自身の記録（`exchange with=self`）が別途
    // 1行増える（`#commit` 段1）——**人間との往復そのものを測るこの歯とは
    // 別の軸**なので、絞って混ぜない（`with` を付けなければ3行に増え、
    // この歯が測りたい「人間との往復」の形が読み取れなくなる）。
    const exchanges = await s.stores.journal.list({ types: ['exchange'], with: ['human'] });
    expect(exchanges.map((e) => (e as { role: string }).role)).toEqual(['outbound', 'inbound']);

    await s.clone.stop();
  });

  it('層とモデル帯の対応、道具の配置を固定する（北極星の不変条件）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { options } = s.calls[0] as FakeCall;
    // クローン = Fable。既定はここから動かない。降ろせるのは人間だけであり、
    // 実装や AI の都合で既定を下げない（AGENTS.md 地雷5 / north_star 禁止1）
    expect(options.model).toBe(CLONE_MODEL);
    expect(CLONE_MODEL).toBe('fable');
    // 組み込みツールは持たせない（人間の写像としての配置）
    //
    // ↑ **この期待は #32 で反転した。** 元の文（と実装）は north_star「適用範囲」が
    // 名指しで否定している推論だった — 人間は道具を持たない存在ではないので、
    // 「人間の写像だから道具を持たない」は写像として成り立たない。したがって
    // `tools` は**渡さない**（preset 一式）。マネージャー・作業者と同じ扱いである
    // （AGENTS.md 地雷1・7 / PRD「層ごとの能力」）。
    expect(options.tools).toBeUndefined();
    // 自作ツールは確認なしで使える。**これは使える道具の一覧ではない**（確認を
    // 省く側の一覧である）。組み込みツールが減っていないことは上で見ている。
    expect(options.allowedTools).toContain('mcp__alteroid__memory_write');
    expect(options.allowedTools).toContain('mcp__alteroid__ask_human');
    expect(options.mcpServers).toHaveProperty('alteroid');
    // 人間の設定と MCP 連携をそのまま読む（PRD「業務範囲」）。ここが `[]` だと
    // 人間が使っている連携がクローンから1つも見えない
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    // 人間が開く Claude Code と同じ既定。`default` だと、答える相手が居ない確認が
    // そのまま拒否になって「道具を渡したのに使えない」が生まれる
    expect(options.permissionMode).toBe('auto');
    // ターン数上限で暴走を止めない（AGENTS.md 地雷2）
    expect(options.maxTurns).toBeUndefined();

    await s.clone.stop();
  });

  it('自分の手で使った道具は日誌に残る（自作ツールは重ねて残さない）', async () => {
    // docs/architecture.md「非対称な可視性」:「どちらで見たかは日誌に残す。委譲が
    // 原則である理由が守られているかは、禁止ではなく記録で見る」。道具を渡した以上
    // （#32）、ここが無いと「委譲していない」を見る手が禁止しか残らない。
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
    // 自作ツールはそれ自身が跡を残す（`memory_update` / 日誌の本文 / 台帳）。
    // ここで重ねると、毎ターン数本叩く道具の記録で日誌が埋まって掘れなくなる。
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
    // クローンは preset 一式を持つので `Task` も持っている。ここを分けないと
    // 「自分でやったのか委ねたのか」の問いに嘘の数が返る（runner が
    // `manager:<id>` と `worker:<id>:<agent>` を分けているのと同じ理由）。
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
    // **`agent_type` が読めなくても、サブエージェント側であることは落とさない。**
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
    // どれもクローンの手として数えられる（digest の分類が拾えること）
    for (const actor of byTool.values()) expect(isCloneActor(actor)).toBe(true);

    await s.clone.stop();
  });

  it('道具の名前が読めなくても、記録を落とさない（監査の穴を静かに空けない）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    // 名前が読めないなら「自作ツールだった」ではなく「観測できなかった」である。
    await hook({ tool_input: { any: 1 } } as never, undefined, {} as never);

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.map((entry) => (entry as { tool: string }).tool)).toEqual(['(不明な道具)']);

    await s.clone.stop();
  });

  it('自作ツールでも「読む」道具は日誌に残る（自前では跡を残さないので、重ねないと消える）', async () => {
    // `docs/architecture.md`「非対称な可視性」の要求どおり——`memory_write` の
    // ような書く道具は自分で `memory_update` 等を書くので重ねないが、`memory_read` /
    // `journal_read` / `conversation_read` はハンドラが自前で日誌へ何も書かないので、
    // ここで落とすと使ったことがどこにも残らなくなる（かつて `mcp__alteroid__*` を
    // 一律で除いていた期間、19本がそうなっていた）。
    //
    // **1本だけでは済ませない** — 既存の歯（「自分の手で使った道具は日誌に残る」）が
    // `memory_write` 1本しか測っていなかったことが、この穴を長く隠した。
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
    // **3本とも `tool_use` として残る** — 順序は `journal.list` の並びに依存
    // するので、集合として測る（この道具が「読む」以外に見出しの見え方を
    // 変える理由は無い）。
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
    // `cloneToolJournalsItself` は名簿に無い `mcp__alteroid__*` に `false` を
    // 返す（`tools.ts` の doc）。これは「まだ分類していない自作ツール」を
    // 誤って消さないための倒れ先——記録が重複するほうが、監査の穴が静かに
    // 空くより軽い。
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
    // **道具と許可モードを揃えたのだから、記録も揃っていること。**
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

  /**
   * **Issue #924**: `PostToolUse` は道具呼び出しが成功したときにしか発火しない
   * （出荷済みの SDK 実行体を実測して確認した排他分岐 — Issue 本文参照）。
   * ⟹ 失敗・中断した道具呼び出しは、`onPostToolUseFailure` を足すまで日誌に
   * 1件も残らなかった。3マスで陰性対照ごと確かめる —— 失敗・成功（陰性対照）・
   * 中断の3つを分けて測らないと、「常に failed を書く」実装でも緑になる。
   */
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
    // これが無いと「常に outcome: 'failed' を書く」実装でも緑になる。
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
    // is_interrupt は optional——SDK が付けてこないことがある。欠けを第3の
    // 値にせず、安全側（failed）に倒す（schema.ts の tool_use.outcome の doc）。
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
    // **自作ツール（memory_write）の失敗は除外される**——`#journalToolUse` と
    // 同じ除外規則を通すため（判断は `#journalToolUseFailure` の doc に
    // 名指ししてある）。だから別の道具（`Write`）で「蒸留側の失敗が残る」
    // ことを別途確かめる。
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
    // **判断が要った点**: 失敗だけは自作ツールでも重ねて残す、という選択肢も
    // 在ったが、`#journalToolUse` と同じ除外規則（`cloneToolJournalsItself`）を
    // そのまま通すことにした（`#journalToolUseFailure` の doc に名指ししてある）。
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

    const huge = 'エラー詳細:'.repeat(2000); // 明らかにどの上限よりも長い
    await hook(
      { tool_name: 'Bash', tool_input: { command: 'x' }, error: huge } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    const error = (entries[0] as { error?: string }).error;
    expect(error).toBeDefined();
    // 黙って切らない——`excerptLine` の「省略」合図が付く（excerpt.ts の doc）。
    expect(error).toMatch(/省略/);
    // 全文を書けば huge.length（20,000字超）になる。切れていることを見る
    // ——正確な上限値はここでは固定しない（clone.ts の TOOL_USE_ERROR_EXCERPT
    // が正本）。
    expect(error!.length).toBeLessThan(huge.length);
    expect(error!.length).toBeLessThan(1000);

    await s.clone.stop();
  });

  /**
   * **Issue #1338 残件1**: 自前で日誌へ書く自作ツール（`SELF_JOURNALING_CLONE_TOOLS`）
   * の呼び出しが、ハンドラへ届く前の MCP 入力検証で落ちた回は、除外の前提
   * （「そのハンドラが自分で記録する」）が崩れているのに `#journalToolUse` の
   * 早期 return だけが効いて、日誌にも `self_dropped` にも何も残らなかった
   * （`journal_write` の `decision` 欠落が実例——#1343 は `grounds` の欠落しか
   * 直していない）。**この経路は `PostToolUseFailure` ではなく `PostToolUse`
   * で発火する**——MCP SDK が検証エラーを自分で `try/catch` し、`isError: true`
   * の普通の `CallToolResult` を返すため（`tool-arguments.test.ts` の実測）。
   * ⟹ ここでは `PostToolUse` フックへ、検証落ちを示す `tool_response` を
   * 乗せて呼ぶ。
   */
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
          // **`decision` が無い。** `grounds` だけが送られてハンドラへは届かず、
          // zod の検証で落ちる（#1343 が直したのは grounds 側で、decision 側は
          // 今も必須——`tools.ts` の journal_write の doc「これで直らない残り」）。
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
      // journal_write は秘密を運ぶ道具ではないので、生の引数（grounds）は
      // 他の道具と同じ扱いでそのまま残る。
      expect(entry.input).toEqual({ grounds: 'ある根拠のテキスト' });
      expect(entry.error).toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);

      // **判断の記録そのものが落ちたので、self_dropped にも跡を残す**
      // （#1343 の grounds 欠落と同じ理由。journal_write だけの扱い）。
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
          // `summary` が無い。
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

      // **`journal_write` 以外には self_dropped を広げていない**（doc の判断）。
      const traces = recentDroppedTraces();
      expect(traces.some((line) => line.includes('判断そのもの'))).toBe(false);

      await s.clone.stop();
    });

    it('⭐ 陰性対照: 自前で日誌へ書く道具の正常な成功は、tool_response が在っても二重に残さない', async () => {
      // **検知の印（`MCP_INPUT_VALIDATION_ERROR_MARKER`）が無ければ、成功応答は
      // 従来どおり除外され続ける。** ここが緑にならないと、「常に tool_use を
      // 書く」実装でも他の歯が緑になってしまう。
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
          // `summary` が無い。`script` は実行環境の鍵そのものを運ぶ契約
          // （`tools.ts` の `cloneToolCarriesSecrets` の doc）。
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
      // **`input` を一切残さない。** 生の引数を写すと script の値（鍵）が
      // そのまま日誌に焼かれる。
      expect(entry.input).toBeUndefined();
      // **`error` にも値そのものは出ない。** 道具名と欠けた欄の名前だけ。
      expect(entry.error).not.toContain(SECRET_MARK);
      expect(entry.error).toContain('summary');

      // JSON へ直列化しても値がどこにも現れないことを、念のため丸ごと確認する。
      expect(JSON.stringify(entries)).not.toContain(SECRET_MARK);

      // **profile_write は journal_write ではないので self_dropped は増えない。**
      const traces = recentDroppedTraces();
      expect(traces.some((line) => line.includes(SECRET_MARK))).toBe(false);

      await s.clone.stop();
    });

    it('陽性対照: 秘密を運ばない道具（memory_write）では、同じ目印の値がそのまま入力に残る', async () => {
      // **redaction が profile_write 固有の判断であって、値を含む入力全般への
      // 目つぶし（フィルタ）ではないことを示す。**
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
    // `permissionMode: 'auto'` ＋ `canUseTool` 無しなので拒否は普通に起きる。
    // ここを捨てると「静かになった」と「起きていない」が区別できなくなる。
    //
    // **生の合図と `result` の両方に同じ1件を載せる。** SDK は前者を best-effort、
    // 後者を authoritative と言っているので実装は両方読む ＝ 二重に書かないことも
    // 一緒に確かめないと、日誌が同じ拒否で2倍に膨らむ。
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
    // **分類・理由・モデルへの拒否文の3つとも読む。** #230 で `runner.ts` 側は
    // 3つとも読むようになったが、`clone.ts` 側は `decision_reason` しか読んで
    // いなかった（#229）。ここが赤くなれば、その非対称が戻ってきたということ。
    expect(text).toContain('分類: classifier');
    expect(text).toContain('理由: 分類器が止めた');
    expect(text).toContain('モデルへの拒否文: Bash is not allowed right now');
    // 許可モードも添える（「なぜ確認が来ないのか」を後から読む人のために）
    expect(text).toContain('auto');
    // **拒否は `tool_use` として数えない** — 使えていない回数を「自分で手を動かした
    // 回数」に混ぜると、digest の材料がそのまま狂う。
    expect(await s.stores.journal.list({ types: ['tool_use'] })).toEqual([]);

    await s.clone.stop();
  });

  it('確認へ上がらず止められた道具の分類・拒否文が欠けているときは作り物を出さず省く', async () => {
    // `result.permission_denials`（`via: 'result'`）は理由を持たない。`via:
    // 'live'` でも SDK がフィールドを付けてこなければ同じく欠ける。**欠けている
    // ものを空文字や「不明」で埋めると、読み手が「そう答えが返ってきた」と誤読
    // する。** 欠けていること自体を、ラベルごと出さないことで表す。
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
    // 何も詰められなかったときは括弧そのものを出さない（空の括弧を残さない）。
    expect(text).not.toContain('（）');

    await s.clone.stop();
  });

  /**
   * Issue #373 — `runner.ts` の `#noteDenial` は `agent_id` を読んで層
   * （マネージャー自身／作業者）を判定するが、`clone.ts` の同名メソッドは
   * 読んでいなかった。クローン自身も preset 一式を持つので `Task`（作業者＝
   * サブエージェント）を持ち、拒否がクローン本体のものか作業者のものかを
   * 区別できないと、日誌を追う側が誤った層へ次の手を向けかねない。
   *
   * **`via: 'live'` のときだけ層が載る。** `agent_id` は `SDKPermissionDeniedMessage`
   * （生の合図、`via: 'live'`）にしか原理的に存在しない
   * （`SDKPermissionDenial`＝`via: 'result'` は3つのフィールドしか持たない）。
   */
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
      // `permissionDenials` が読む `result.permission_denials` 側は authoritative
      // だが `agent_id` を持たない——生の合図（上）とは別の tool_use_id にして
      // 二重書き防止（`#deniedToolUses`）に引っかからないようにする。
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

  /**
   * `denial-shape.ts` の配線 — 拒否の日誌に「入力の形」が正しく載るか、
   * 同じ `tool_use_id` の二度目の記録（`via: 'result'`）が来たときに
   * 追記の1行だけが増えるか、増えないべき順では増えないかを見る
   * （PR「拒否の入力の形」）。
   */

  it('live だけの拒否は「入力の形」が空にならず、入力が無い理由が載る（C1）', async () => {
    // `via: 'live'` の合図には `tool_input` が原理的に付かない
    // （`runner-protocol.ts` の doc）。ここで空文字に落ちると、
    // 「入力が空だった」と「そもそも入力の欄が無い経路だった」が同じ字面に
    // 見えてしまう——`denialInputAbsence` がそれを分けていることを確かめる。
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
    // 拒否そのものの行は、あとから入力が分かっても増えない（1本のまま）。
    const denialLines = exchanges.filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denialLines.length).toBe(1);

    // 追記の行——値ではなく形だけを書く——がちょうど1本増える。
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
      // 同じ拒否が result の一覧に重複して2件載る形（SDK が累積で返す場合の
      // 最悪ケース）を再現する。追記が二重に書かれないことを確かめる。
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
    // 1本目のターンの result で入力込みの記録が先に立ち、2本目のターンの
    // live で同じ tool_use_id の（入力を持たない）合図が遅れて届く——という
    // 順番。入力は既に降りているので、追記は起きないし拒否の行も増えない。
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
    // ダミーの秘密（本物のトークンではない）。先頭が代入なので headWordOf は
    // 弾く（`SAFE_HEAD_WORD` が `=` を許さない）はずで、先頭の語も
    // 「(伏せた)」に落ちる。live→result で同じ tool_use_id を通し、追記の
    // 行でも値が漏れないことまで確かめる。
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
    // `default` のままだと、答える相手が居ない確認（このセッションに `canUseTool`
    // は無い）がそのまま拒否になり、道具を渡したのに使えない状態になる。
    expect(resolveClonePermissionMode({})).toBe('auto');
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '' })).toBe('auto');
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '   ' })).toBe('auto');
    // 人間が締めることはできる（実行環境の設定であって能力の制限ではない）
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '  default  ' })).toBe(
      'default',
    );
    // **綴りの間違いは黙って既定へ倒さない。** 倒すと「都度確認にしたはずなのに
    // 確認が来ない」ことに人間が気づけない
    expect(() => resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: 'strict' })).toThrow(
      /ALTEROID_CLONE_PERMISSION_MODE/,
    );
  });

  it('置かれたかどうかは「既定と違うか」では言い換えられない（起動時の告知の材料）', () => {
    // モデル帯（`placedCloneModel`）と同じ含み。`auto` を明示的に置いた人にも
    // 「置かれている」と言えなければ、告知は事実を言っていない。
    expect(placedClonePermissionMode({})).toBeNull();
    expect(placedClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '  ' })).toBeNull();
    expect(placedClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: ' auto ' })).toBe('auto');
    // **綴りを間違えた値も返す。** 告知は落ちる前に出るので、ここで潰すと
    // 「何を置いたせいで落ちたか」が本人に見えない
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
    // 人間が置いた値だけが効く。既知の別名で関門を作らない（SDK が増やした
    // モデルを人間が選べなくなる＝能力の削除。north_star 禁止1）
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

    // PreCompact の蒸留は別の短命セッションで走る。ここだけ帯が違うと、
    // 人格を書く側だけが別の頭になる。
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
    // **道具の配置も揃っていること**（#32）。帯だけ揃えても、片方に道具が無ければ
    // 人格を書く側だけが別の頭になる（会話の最後に「鍵を実行環境へ移す」を
    // やろうとして失敗した実例と同じ形）。
    expect(side.options.tools).toBeUndefined();
    expect(side.options.settingSources).toEqual(['user', 'project', 'local']);
    // **`toBe(main…)` だけにしないこと。** 両方 `undefined` でも等しくなるので、
    // 「どちらにも渡していない」が「揃っている」として通ってしまう。
    expect(side.options.permissionMode).toBe('auto');
    expect(side.options.permissionMode).toBe(main.options.permissionMode);

    await s.clone.stop();
  });

  /**
   * **測る対象を「本文が載るか」から「カードが載るか」へ移した**（人間の決定
   * 2026-09-08。`memory.ts` の `renderPremiseCard`）。かつてここは
   * `systemPrompt` が本文の一節（`人間が手で書いた方針`）を含むことだけを見て
   * いたが、`premise` の焼き込みは要旨と節の目次だけになり、本文はどの
   * セッションにも載らない。
   *
   * **保証は弱まっていない。むしろ「次の会話に反映される」を初めて実際に測る
   * 形になった** —— 元の歯は1度書いて1度読むだけで、題にある「人間が書き換え
   * れば」の側（書き換えた後にもう一度セッションを組むと、新しい版が載り、
   * 古い版は載っていない）を1つも確かめていなかった。節id は本文のハッシュ
   * なので（`memoryCardOutlineLines` の doc）、本文が載らなくても手編集が
   * 届いたことはこの行で測れる。
   */
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

    // 人間がエディタで直接書き換える（節を1つ足す＝カードの目次が変わる）。
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
    // **古い版が残っていない**（足されただけではなく、置き換わっている）。
    // 節id は中身のハッシュなので、子を足した親の行も別の値になる。
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
    /**
     * `setup()` は `sessionStore`（SDK の型。`Stores` とは別枠の `CloneOptions`
     * フィールド）を配線しないので、ここでは `createClone` を直接呼ぶ
     * （`clone-grave-pickup-race.test.ts` の `bootClone` と同じ理由・同じ形）。
     *
     * 偽の `queryFn` は SDK の契約を模す（SDK の型定義 `sdk.d.ts` の
     * `SessionStore.load` の doc「Load a full session for resume」）——
     * `options.resume` が付いているときだけ `options.sessionStore.load()` を
     * 呼ぶ。**これが「`load()` が呼ばれたか」を直接観測できる唯一の場所である**
     * （本物の SDK 内部はテストから見えない。`load()` を呼ぶのは alteroid では
     * なく SDK 自身なので、ここで模すしかない）。
     */
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

    /** `sessionStore` 側の `load` だけをスパイにした最小実装。 */
    function fakeSdkSessionStore(): SessionStore & { load: ReturnType<typeof vi.fn> } {
      return {
        append: async () => undefined,
        load: vi.fn(async () => null),
      };
    }

    /** 日誌の self/outbound を text で読む（`selfTexts` と同じ形。この describe 専用）。 */
    async function selfOutboundTexts(stores: Stores): Promise<string[]> {
      const rows = await stores.journal.list({ types: ['exchange'] });
      return rows
        .filter(
          (entry) =>
            entry.type === 'exchange' && entry.with === 'self' && entry.role === 'outbound',
        )
        .map((entry) => (entry.type === 'exchange' ? entry.text : ''));
    }

    // 実装（`RESUME_SIZE_BUDGET_BYTES`、`clone.ts`）は 536,870,912（512 MiB）。
    // ここへ書き写すと腐るので、超過側は「実装の1バイト上」ではなく明確に
    // 超えた値を使う。
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
      // **本丸: `resume` が渡っていない ⟹ SDK は `load()` を呼ぶ材料を持たない。**
      expect(calls[0]?.resume).toBeUndefined();
      // **そしてここが直接の観測** —— 偽の SDK は `resume` が無ければ
      // `load()` を呼ばない（doc「Load a full session for resume」を模した形。
      // 上の helper 参照）。呼ばれていなければ、この経路は契約（`load()` は
      // 全件を戻す）を破っていない。
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
      // **`sessionTranscriptTail` を足さない** —— `createMemoryStores()` は
      // storage-fs の代わりであり、fs 構成と同じく既定で undefined
      // （`Stores.sessionTranscriptTail` の doc「pg 構成でだけ付く」）。

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
      // 空振り（capability が無い）は黙って通す——日誌には残らない
      // （`#resumeCandidateWithinBudget` の doc）。
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
      // **エラーは握り潰さず跡を残す**（`noteDroppedRecord`。本文は出さない）。
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
    // **人間の発言は末尾にそのまま載る。** 断り書き（配り直し・台帳）は前に付くので
    // 完全一致では見ないが、**後ろを削ったり書き換えたりしていないこと**は
    // `endsWith` のほうが強く言える（`toContain` だと部分一致で通ってしまう）。
    expect(inputs[0]?.endsWith('価値観を伝える')).toBe(true);
    expect(inputs[1]).toContain('記憶へ移すべきものがあるか確認せよ');

    await s.clone.stop();
  });

  it('承認待ちへの回答は受信箱を通ってクローンに届く', async () => {
    // **返答の文言をターンごとに分ける。** 既定の偽 SDK は入力に関わらず同じ
    // 文言を返すので、人間の発言のターンの返答と、承認への回答のターンの返答が
    // 日誌の中で見分けられない ——どちらを掴んだのか分からないまま `with` を
    // 測ることになる（実際、分ける前のこの歯は人間のターンの返答のほうを掴んで
    // `with: 'human'` で落ちていた。測りたい経路を測っていなかった）。
    const s = setup((input) =>
      input.includes('承認待ちにしていた質問に人間が答えた') ? '承認への返答' : 'わかった',
    );
    await s.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これを送ってよいか',
      // **conversationId を持たせていない。** #768 以前はこの承認が唯一の
      // 形だった（`ask_human` が会話 id を記録していなかった）。以後もこの
      // 形自体は残る ——`ask_human` がマネージャー発の確認・蒸留・timer など
      // 内部ターンから呼ばれたときは、いまも conversationId を持たない。
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const eventsBeforeAnswer = s.events.length;
    await s.clone.answerApproval('ap-1', 'よい');

    // 回答済みになる
    expect(await s.stores.jobs.listApprovals({ pendingOnly: true })).toEqual([]);

    // クローンに回答が届く（内部ターンなので chat には出さない）
    await waitFor(
      () => (s.calls[0] as FakeCall).inputs.some((input) => input.includes('よい')),
      '承認への回答「よい」がクローンの入力に届く',
    );

    // **#768 の下読み: この歯はもともと「chat に出さない」を測っていなかった**
    // （コメントだけで、`inputs` に回答が届くことしか見ていない）。この承認は
    // `putApproval` で直接積まれ conversationId を持たないので、#768 の直しの
    // 後もこの経路は `self` のままが正しい ——反転すべき期待値は無い。
    // **だから反転はせず、ここに「会話 id を持たない承認は self のまま・
    // SSE も流れない」を測るアサーションを足して歯を強くする**
    // （AGENTS.md「対象をスコープして特定する＝保証が強くなる」）。
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
    // 会話 id が無いので #emit は先頭で return する ⟹ conv-1 へ SSE は増えない。
    expect(s.events.length).toBe(eventsBeforeAnswer);

    await s.clone.stop();
  });

  /**
   * 回答の経路（`answeredVia`、Issue #1479）が、承認待ちの器・日誌の
   * `escalation`・クローンのターン入力の3か所すべてへ運ばれることを固定する。
   * `via` を渡さない呼び出し（既定・古い経路）ではどこにも付かないことも
   * 併せて見る——「わからない」を「operator ではない」に化けさせない
   * （`answeredViaSchema` の doc）。
   */
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

      // 1. 承認待ちの器。
      const approval = await s.stores.jobs.getApproval('ap-via-1');
      expect(approval?.answeredVia).toEqual({ kind: 'account', accountId: 'acc-1' });

      // 2. 日誌の escalation（回答）行。
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

      // 3. クローンのターン入力（`case 'human_answer'` の文面。#1479）。
      // **`calls[0]` はまだ無いことがある**——このテストは事前に人間の発言を
      // post していないので、回答のターンそのものが最初の呼びを作る。
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

      // **`calls[0]` はまだ無いことがある**（直上のテストと同じ理由）。
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

      // 1回目: まだ有効なので allow。
      const before = (await hook(
        { tool_name: 'Bash', tool_input: { command: 'gh release edit' } } as never,
        undefined,
        {} as never,
      )) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(before.hookSpecificOutput?.permissionDecision).toBe('allow');

      // 取り消す。
      await s.stores.permissionGrants.put({ ...GRANT, revokedAt: '2026-01-02T00:00:00.000Z' });

      // 2回目: 取り消し済みなので何も決めない。
      const after = (await hook(
        { tool_name: 'Bash', tool_input: { command: 'gh release edit' } } as never,
        undefined,
        {} as never,
      )) as { hookSpecificOutput?: unknown };
      expect(after.hookSpecificOutput).toBeUndefined();

      await s.clone.stop();
    });

    it('人間の取り消しが、#onPreToolUse の list() と put() の間に割り込んでも消えない（lost update）', async () => {
      // `#onPreToolUse` は `list()` で読んだ古い写しへ `lastUsedAt` を足して
      // `put()` する（当時の実装）。この「読んでから書く」の間に人間の
      // `POST /permission-grants/:id/revoke`（`get()` → `put({ ...grant,
      // revokedAt })`）が割り込むと、後から来る `#onPreToolUse` 側の `put()`
      // が「`revokedAt` の無い」古い写しをそのまま書き戻し、取り消しを消す。
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

      // `#onPreToolUse` が `list()` を呼んだ直後（`put()` で書き戻す前）に、
      // 人間の取り消し相当の書き込みを割り込ませる。
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

    /**
     * **Issue #1687。** `list()` で読んだ後、照合が許可に着く前に人間の取り消しが
     * 完了すると、写しの上では生きている許可で道具が1回通っていた。判断を
     * `markUsed`（取り消されていれば記録せず `false`）の結果に寄せたので、
     * 「取り消した」が人間に返った後に、その許可で通ることは無い。
     */
    it('list() の後に人間の取り消しが完了していたら、同じ呼び出しでもその許可では通さない', async () => {
      const base = createMemoryStores();
      const stores: Stores = {
        ...base,
        permissionGrants: {
          ...base.permissionGrants,
          async list() {
            const grants = await base.permissionGrants.list();
            // 読んだ後に取り消しが確定する（人間には「取り消した」が返る）。
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
      // 取り消された許可に「使った」時刻を残さない。
      expect((await base.permissionGrants.get('grant-1'))?.lastUsedAt).toBeUndefined();

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

      /** 検出の記録が付ける文言の目印。**この文言自体が固定なので、ここに1本だけ持つ。** */
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
          // **1本目のターン（hook を捕まえるだけ）では拒否を出さず、2本目で
          // だけ出す**（`result→live の順では、行は1本のまま増えない（C5）` と
          // 同じ「呼び出し回数で数える」idiom）。
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

        // SDK が実際に PreToolUse を呼んだのと同じ形で allow を消費させる
        // （`tool_use_id` 付き——`toAgentPreToolRecord` が読む欄そのもの）。
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
        // 拒否の分類・理由は読む。
        expect(text).toContain('分類: classifier');
        expect(text).toContain('理由: 分類器が止めた');
        // 原因は断定しない2行——両方の筋を挙げたうえで「可能性がある」とだけ言う。
        expect(text).toContain('分類器へ回すようになった');
        expect(text).toContain('deny 規則が hook の allow を上書きした');
        expect(text).toContain('この許可は、いまは効いていない可能性がある');
        // コマンド本文は書かない。
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

        // **PreToolUse を一度も呼ばない**——grant に一致する allow が
        // そもそも起きていない状態を作る。
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
          // **決着した**（実行が成功で終わった）ことを PostToolUse で伝える——
          // `#allowedByGrantToolUses` から消えるはずの経路。
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

      /** 検出の記録が付ける文言の目印。**この文言自体が固定なので、ここに1本だけ持つ。** */
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
          // コマンド本文は書かない。
          expect(text).not.toContain('gh release edit --draft');

          // 帳面からもう消えている——同じ agentId でもう一度 SubagentStop が
          // 来ても、控えが無いので何も増えない。
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

        // 別の作業者が SubagentStop を迎えても、agent-1 の控えには触れない。
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

        // agent_id を持たない ＝ クローン本体の呼び出し。
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

      // 1. 人間の発言で会話 conv-1 を立てる（`humanMessage` の既定 conversationId）。
      s.clone.post(humanMessage('本番 DB へ打ってよいか判断してくれ'));
      await waitForDone(s.events);

      // 2. `ask_human` が会話 id を埋めるのと同じ形で、承認へ conversationId を持たせる。
      await s.stores.jobs.putApproval({
        id: 'ap-1',
        createdAt: new Date().toISOString(),
        question: '本番 DB へ2文だけ打ってよいか',
        conversationId: 'conv-1',
      });

      // 3. 人間が承認画面で答える。
      await s.clone.answerApproval('ap-1', '(a) でよい');

      // 4. 返答が日誌へ積まれるまで待つ。
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

      // 5. チャットが読む会話 conv-1 の中身にも、この返答が現れる
      //    （`readConversationWindow` + `conversationMessages` — 本番の読み口そのもの。
      //    `apps/daemon/src/app.ts` の `GET /conversations/:id` と同じ組み立て）。
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

      // 承認を積むだけでは SSE は増えない（回答前の基準線）。
      expect(s.events.length).toBe(afterFirstTurn);

      await s.clone.answerApproval('ap-1', '(a) でよい');

      // 回答を受けたターンが終わる（done）まで待つ。
      // **終端は `afterFirstTurn` から後ろだけで見る。** 配列全体を `some` で
      // 見ると1つ前のターン（人間の発言）の `done` に当たってしまい、この回答の
      // ターンでは最初の1件（`thinking`）が届いた時点で待ちが解ける ——本文が
      // 届く前に測ることになり、**直っていても赤くなる**（実際に落ちた）。
      await s.waitForEvents((events) => events.slice(afterFirstTurn).some(isTerminal));

      const after = s.events.slice(afterFirstTurn);
      // Issue の実測（2026-09-10T08:19Z、ローカル再現）: 「回答後にチャットへ
      // 流れた SSE は0件」。ここでは0件ではないことと、その中身まで測る。
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

      // 1. 人間の発言のターンが走っている間に呼ぶ。
      clone.post(humanMessage('本番 DB へ打ってよいか判断してくれ'));
      await waitFor(
        () => calls[0]?.inputs.some((input) => input.includes('本番 DB')) ?? false,
        '『本番 DB』を含む入力がクローンに届く',
      );
      await askHuman('人間のターン中の質問');
      await waitForDone(events);

      const duringHuman = (await stores.jobs.listApprovals({ pendingOnly: true })).find(
        (approval) => approval.question === '人間のターン中の質問',
      );
      expect(duringHuman?.conversationId).toBe('conv-1');

      // 2. 内部ターン（会話 id を持たない承認への回答）が走っている間に呼ぶ。
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

      const duringInternal = (await stores.jobs.listApprovals({ pendingOnly: true })).find(
        (approval) => approval.question === '内部ターン中の質問',
      );
      expect(duringInternal?.conversationId).toBeUndefined();

      // **`waitForDone(events)` は使わない。** この内部ターンは会話 id を
      // 持たないので `#emit(null, …)` が先頭で return し、`conv-1` へ `done`
      // は届かない（それ自体がこのテストの検証対象の一部である）。ここでは
      // 代わりに日誌側で両方のターンの返答（outbound 2件）が積まれたことを
      // 見てから `stop()` する——in-flight のまま呼んでも `stop()` 自体は
      // 安全だが、検証を確実にするための待ちである。
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
      // **芯（issue #782 の1）**: 会話 id や時刻ではなく、id そのもので結ぶ。
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

      // 2件の承認を同じ会話へ積む。**立て続けに**（`await` を挟むだけで）答える
      // ——実時刻では厳密な同時刻を再現できないが、ここで測りたいのは
      // 「時刻が近いと区別できない」ことそのものではなく、**区別する手段が
      // 会話 id と時刻の他に無かった**という穴が、id を運ぶことで塞がることである。
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
      // 同じ会話 id を持ちながら、approvalId で正しく結び分けられている。
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

      // 1. ただの人間の発言（承認とは無関係のターン）。
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      // 2. 会話 id を持たない承認への回答（= 内部ターン。`with: 'self'` に倒れる）。
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
        // 通常の人間の発言への返答にも、会話 id を持たない承認（`self`）への
        // 返答にも、approvalId は付かない。
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

    // 止まっているのはその仕事だけだと伝わり、答え方の経路も示される
    expect(permission).toContain('mgr-2');
    expect(permission).toContain('manager_send');
    expect(permission).toContain('ask_human');

    // マネージャーとの往復も日誌に残る（見えない層を作らない）
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { with: string }[];
    expect(exchanges.some((entry) => entry.with === 'manager')).toBe(true);

    await s.clone.stop();
  });
});
