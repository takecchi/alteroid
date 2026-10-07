import { describe, it, expect } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingJournalAppend,
  humanMessage,
} from './testing.js';
import { fakeSdk, setup, wireEvents, waitFor, waitForTerminal } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — ターンの失敗の跡', () => {
  async function exchanges(stores: Stores) {
    return (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
      conversationId?: string;
      turnFailure?: string;
    }[];
  }

  it('人間が chat を閉じた後にターンが失敗しても、日誌に残る（購読者は居ない）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, { failWith: 'セッションを起こせない' });

    s.clone.post(humanMessage('やあ', 'conv-9'));

    await waitFor(
      async () =>
        (await exchanges(stores)).some(
          (entry) => entry.role === 'outbound' && entry.text.includes('失敗した'),
        ),
      'outbound の『失敗した』という exchange が日誌に積まれる',
    );

    const all = await exchanges(stores);
    const failure = all.find(
      (entry) =>
        entry.with === 'self' &&
        entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
    );
    expect(failure).toBeDefined();
    expect(failure?.conversationId).toBe('conv-9');
    expect(failure?.text).toContain('セッションを起こせない');

    const toHuman = all.filter(
      (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
    );
    expect(toHuman).toHaveLength(1);
    expect(toHuman[0]?.conversationId).toBe('conv-9');
    expect(toHuman[0]?.text).not.toContain('セッションを起こせない');

    await s.clone.stop();
  });

  it('購読者が例外を投げても、跡は残る（`#emit` は購読側の失敗を握り潰す）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, { failWith: '読み取りが即死した' });
    s.clone.subscribe('conv-9', () => {
      throw new Error('購読側が壊れている');
    });

    s.clone.post(humanMessage('やあ', 'conv-9'));

    await waitFor(
      async () =>
        (await exchanges(stores)).some(
          (entry) => entry.role === 'outbound' && entry.text.includes('失敗した'),
        ),
      'outbound の『失敗した』という exchange が日誌に積まれる',
    );

    await s.clone.stop();
  });

  describe('文脈窓超過の失敗には目印が入る', () => {
    it('該当する失敗: 目印（ASCII の検索語）と生の文言の両方が `with: self` に残る', async () => {
      const stores = createMemoryStores();
      const real = 'prompt is too long: 220000 tokens > 200000 maximum';
      const s = setup(undefined, stores, { failWith: real });

      s.clone.post(humanMessage('やあ', 'conv-9'));

      await waitFor(
        async () =>
          (await exchanges(stores)).some(
            (entry) =>
              entry.with === 'self' &&
              entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
          ),
        "with: 'self' の『人間との対話ターンが失敗した』という exchange が日誌に積まれる",
      );

      const failure = (await exchanges(stores)).find(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
      );
      expect(failure?.text).toContain('context_window_failure');
      expect(failure?.text).toContain('prompt_too_long');
      expect(failure?.text).toContain(real);
      expect(failure?.text).toContain('契約ではない');

      const toHuman = (await exchanges(stores)).find(
        (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
      );
      expect(toHuman?.text).not.toContain('context_window_failure');
      expect(toHuman?.text).not.toContain(real);

      await s.clone.stop();
    });

    it('対照: 文脈窓と無関係な失敗には目印が入らない', async () => {
      const stores = createMemoryStores();
      const real = "You've hit your individual spend limit";
      const s = setup(undefined, stores, { failWith: real });

      s.clone.post(humanMessage('やあ', 'conv-9'));

      await waitFor(
        async () =>
          (await exchanges(stores)).some(
            (entry) =>
              entry.with === 'self' &&
              entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
          ),
        "with: 'self' の『人間との対話ターンが失敗した』という exchange が日誌に積まれる",
      );

      const failure = (await exchanges(stores)).find(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`),
      );
      expect(failure?.text).toContain(real);
      expect(failure?.text).not.toContain('context_window_failure');

      await s.clone.stop();
    });
  });

  describe('文脈窓で落ちたら、セッションを畳んで作り直す', () => {
    const tooLong = 'Prompt is too long';

    function setupFold(failText: string, failDistill = false) {
      const stores = createMemoryStores();
      let failNext = false;
      const { fn, calls } = fakeSdk(undefined, {
        resultFor: () =>
          failNext ? { subtype: 'success', isError: true, text: failText } : undefined,
      });
      const queryFn: typeof fn = (args) => {
        if (failDistill && typeof args.prompt === 'string') throw new Error('枠が閉じている');
        return fn(args);
      };
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const { events } = wireEvents(clone, 'conv-1');
      return { clone, stores, calls, events, failFrom: () => (failNext = true) };
    }

    async function lastToHuman(stores: Stores): Promise<string | undefined> {
      const rows = (await exchanges(stores)).filter(
        (entry) =>
          entry.with === 'human' &&
          entry.role === 'outbound' &&
          (entry.text.startsWith('この発言には返せなかった') ||
            entry.text.startsWith('いま利用上限に当たっているので')),
      );
      return rows[rows.length - 1]?.text;
    }

    it('畳んで、次のターンは新しいセッションで走る。resume 素材は捨てられている', async () => {
      const s = setupFold(tooLong);

      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();

      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        'resume 素材が捨てられること',
      );

      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      await s.clone.stop();

      expect(s.calls.length).toBeGreaterThan(1);
    });

    it('人間へ返す1行で「記録は消えていない」と言う（会話が失われたとは言わない）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      const text = await lastToHuman(s.stores);
      await s.clone.stop();

      expect(text).toContain('次の発言から新しく開き直す');
      expect(text).toContain('消えていない');
      expect(text).not.toContain('失われ');
      expect(text).not.toContain('context_window_failure');
    });

    it('対照1（長さではない失敗）: 畳まない。resume 素材も残る', async () => {
      const s = setupFold('何か別の理由で落ちた');
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      const text = await lastToHuman(s.stores);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();
      await s.clone.stop();
      expect(text).not.toContain('次の発言から新しく開き直す');
    });

    it('対照2（暴走の止め）: 引き継がずに開いて1度も答えていないなら、畳まずにそう言う', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      const text = await lastToHuman(s.stores);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await s.clone.stop();

      expect(text).not.toContain('次の発言から新しく開き直す');
      expect(text).toContain('開き直していない');
      expect(text).toContain('プロンプトそのものが収まっていない可能性');
    });

    async function heldEscalationLines(stores: Stores): Promise<string[]> {
      return (await exchanges(stores))
        .filter(
          (entry) =>
            entry.with === 'self' &&
            entry.text.includes('1回目の長さの失敗では開き直さずに持ちこたえた'),
        )
        .map((entry) => entry.text);
    }

    it('🔴 #955 (A) 陰性: 1回目の長さの失敗だけなら畳まない（held）。畳み直しの行も出ない', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
      await new Promise((resolve) => setTimeout(resolve, 80));
      const calls = s.calls.length;
      const lines = await heldEscalationLines(s.stores);
      const sessionId = await s.stores.sessions.getCloneSessionId();
      await s.clone.stop();

      expect(calls).toBe(1);
      expect(lines).toHaveLength(0);
      expect(sessionId).not.toBeNull();
    });

    it('🔴 #955 (A) 陽性: held した同じセッションで、別の入力でもう一度長さで落ちたら畳み、日誌と人間へ1行ずつ残す', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      s.clone.post(humanMessage('一つ目'));
      await waitFor(
        () => s.events.filter((event) => event.type === 'error').length === 1,
        '1回目が落ちること',
      );
      s.clone.post(humanMessage('二つ目'));
      await waitFor(
        () => s.events.filter((event) => event.type === 'error').length === 2,
        '2回目が落ちること',
      );

      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        'resume 素材が捨てられること',
      );
      const lines = await heldEscalationLines(s.stores);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('連続 1 回目');
      expect(lines[0]).not.toContain('収まっていない可能性');
      expect(
        (await exchanges(s.stores)).some(
          (entry) =>
            entry.with === 'human' &&
            entry.role === 'outbound' &&
            entry.text.startsWith('この発言には返せなかった') &&
            entry.text.includes('次の発言から新しく開き直す'),
        ),
      ).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('三つ目'));
      await waitFor(() => s.calls.length > 1, '新しいセッションが開くこと');
      await s.clone.stop();
    });

    it('#955 (A): 内部のターンで畳み直した回も、直近の人間の会話へ1行で知らせる（黙って畳まない）', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      s.clone.post(humanMessage('一つ目'));
      await waitFor(
        () => s.events.filter((event) => event.type === 'error').length === 1,
        '人間の発言のターンが落ちること（held）',
      );
      s.clone.post({
        type: 'external',
        id: 'evt-ext-955',
        at: new Date().toISOString(),
        source: 'ci',
        payload: 'ビルドが落ちた',
      });
      await waitFor(
        async () => (await heldEscalationLines(s.stores)).length === 1,
        '内部のターンで畳み直すこと',
      );
      const notices = (await exchanges(s.stores)).filter(
        (entry) =>
          entry.with === 'human' &&
          entry.role === 'outbound' &&
          entry.text.startsWith('文脈が収まらずに走れなくなっていたので'),
      );
      await s.clone.stop();

      expect(notices).toHaveLength(1);
      expect(notices[0]?.conversationId).toBe('conv-1');
      expect(notices[0]?.text).toContain('記録は残っている');
    });

    it('#955 (A): 開き直したセッションもまた答えないまま同じ形で畳み直したら、回数つきで「収まっていない可能性」を名乗る', async () => {
      const s = setupFold(tooLong);
      s.failFrom();
      const errors = (n: number) => s.events.filter((event) => event.type === 'error').length === n;
      s.clone.post(humanMessage('一つ目'));
      await waitFor(() => errors(1), '1回目');
      s.clone.post(humanMessage('二つ目'));
      await waitFor(() => errors(2), '2回目（畳む）');
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('三つ目'));
      await waitFor(() => errors(3), '3回目（新しいセッションで held）');
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(await heldEscalationLines(s.stores)).toHaveLength(1);
      s.clone.post(humanMessage('四つ目'));
      await waitFor(() => errors(4), '4回目（また畳む）');
      await waitFor(
        async () => (await heldEscalationLines(s.stores)).length >= 2,
        '畳み直しの行が2本',
      );
      const lines = (await heldEscalationLines(s.stores)).reverse();
      await s.clone.stop();

      expect(lines[1]).toContain('連続 2 回目');
      expect(lines[1]).toContain('収まっていない可能性');
      expect(lines[1]).toContain('held と畳み直しの交互');
    });

    it('畳む直前に生ログを退避する（在り処は PostToolUse から控えたもの）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await makeTempDir('alteroid-ctxwin-');
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

        await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');
        const entries = await s.stores.archive.list();
        expect(await s.stores.archive.read(entries[0]?.id as string)).toEqual({
          kind: 'body',
          body: '畳む直前の生ログ',
        });
      } finally {
        await s.clone.stop();
      }
    });

    it('対照（在り処を控えていない）: 退避を試みず、日誌にノイズも増やさない', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
      await new Promise((resolve) => setTimeout(resolve, 80));
      await s.clone.stop();

      expect(await s.stores.archive.list()).toHaveLength(0);
      const selfRows = (await exchanges(s.stores)).filter((entry) => entry.with === 'self');
      expect(selfRows.some((entry) => entry.text.includes('生ログの退避に失敗した'))).toBe(false);
    });

    it('退避が落ちても蒸留へ進み、日誌は「どこにも残っていない」と言う', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await makeTempDir('alteroid-ctxwin-gone-');
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
      const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
      await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
      await rm(dir, { recursive: true, force: true });

      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      await waitFor(
        async () =>
          (await exchanges(s.stores)).some((entry) =>
            entry.text.includes('文脈窓で畳む前の蒸留に失敗した'),
          ),
        '蒸留まで進んで、その失敗が日誌に残ること',
      );
      const rows = await exchanges(s.stores);
      expect(
        rows.some((entry) => entry.text.includes('文脈窓で畳む前の生ログの退避に失敗した')),
      ).toBe(true);
      const distillRow = rows.find((entry) =>
        entry.text.includes('文脈窓で畳む前の蒸留に失敗した'),
      );
      expect(distillRow?.text).toContain('この区間はどこにも残っていない');
      expect(distillRow?.text).not.toContain('生ログの退避は済んでいる');
      expect(await s.stores.sessions.getTranscriptGrave()).toBeNull();

      await s.clone.stop();
    });

    it('蒸留が落ちたら、退避の id を墓標として残す', async () => {
      const s = setupFold(tooLong, true);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await makeTempDir('alteroid-ctxwin-grave-');
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

        await waitFor(
          async () => (await s.stores.sessions.getTranscriptGrave()) !== null,
          '墓標が立つこと',
        );
        const entries = await s.stores.archive.list();
        expect((await s.stores.sessions.getTranscriptGrave())?.archiveId).toBe(entries[0]?.id);
      } finally {
        await s.clone.stop();
      }
    });

    it('対照: 蒸留が通った回は墓標を残さない', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await makeTempDir('alteroid-ctxwin-grave-none-');
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
        await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');

        expect(await s.stores.sessions.getTranscriptGrave()).toBeNull();
      } finally {
        await s.clone.stop();
      }
    });

    it('畳んだ次のターンで、クローン自身へ1度だけ断る（読み口の名前つき）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        '畳むと決まること',
      );

      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      const next = s.calls.at(-1) as FakeCall;
      await waitFor(() => next.inputs.length > 0, '入力が届くこと');

      const first = next.inputs[0] as string;
      expect(first).toContain('前の会話を引き継がずに開き直した');
      expect(first).toContain('conversation_read');
      expect(first).toContain('記憶');

      s.clone.post(humanMessage('やあ'));
      await waitFor(() => next.inputs.length > 1, '2ターン目の入力が届くこと');
      await s.clone.stop();
      expect(next.inputs[1] as string).not.toContain('前の会話を引き継がずに開き直した');
    });

    it('対照（畳んでいない失敗）: クローンへの断りも載らない', async () => {
      const s = setupFold('何か別の理由で落ちた');
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      const main = s.calls[0] as FakeCall;
      const before = main.inputs.length;
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => main.inputs.length > before, '次の入力が届くこと');
      await s.clone.stop();

      expect(main.inputs.at(-1) as string).not.toContain('前の会話を引き継がずに開き直した');
    });

    it('対照3: トークンを回すだけでは resume 素材を捨てない（会話が切れない）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      s.clone.recycleSessionForToken();
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      await s.clone.stop();

      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();
    });
  });

  describe('枠で保持していて、長さにも当たっていたら、両方言う', () => {
    const bothMessage =
      "Prompt is too long · automatic compaction failed: You've hit your org's monthly spend limit";
    const usageOnlyMessage = "You've hit your individual spend limit for this account.";

    let markOfLastLine: string | undefined;

    async function toHumanAfterFailure(resultText: string): Promise<string | undefined> {
      const stores = createMemoryStores();
      const s = setup(undefined, stores, {
        resultFor: () => ({ subtype: 'success', isError: true, text: resultText }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForTerminal(s.events);
      await waitFor(
        async () =>
          (await exchanges(stores)).some(
            (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
          ),
        '人間への1行',
      );

      const toHuman = (await exchanges(stores)).find(
        (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
      );
      await s.clone.stop();
      markOfLastLine = toHuman?.turnFailure;
      return toHuman?.text;
    }

    it('枠で保持 × 長さにも当たった: 保持の1行に「枠が開いても落ちる」が足される', async () => {
      const toHuman = await toHumanAfterFailure(bothMessage);

      expect(toHuman).toContain('いま利用上限に当たっているので');
      expect(toHuman).toContain('枠が開いたら試し直して返信する');
      expect(toHuman).toContain('文脈窓');
      expect(toHuman).toContain('枠が開いても');
      expect(toHuman).not.toContain('context_window_failure');
      expect(toHuman).not.toContain(bothMessage);
    });

    it('対照1（枠だけ）: 長さの語を含まない上限では、断りが出ない', async () => {
      const toHuman = await toHumanAfterFailure(usageOnlyMessage);

      expect(markOfLastLine).toBe('held');
      expect(toHuman).toContain('枠が開いたら試し直して返信する');
      expect(toHuman).not.toContain('文脈窓');
    });

    it('対照2（保持なし × 長さ）: 枠に当たっていない長さの失敗では、1行は変わらない', async () => {
      const toHuman = await toHumanAfterFailure('prompt is too long: 1206750 tokens > 1000000');

      expect(toHuman).toContain('この発言には返せなかった');
      expect(toHuman).not.toContain('文脈窓');
      expect(toHuman).not.toContain('いま利用上限に当たっているので');
      expect(markOfLastLine).toBe('failed');
    });
  });

  it('日誌にも書けなければ stderr に1行。ただし本文は出さない', async () => {
    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';
    const stores = failingJournalAppend(createMemoryStores(), '器が閉じている');

    const lines = await captureStderr(async () => {
      const s = setup(undefined, stores, { failWith: `クエリが失敗した params=["${secret}"]` });
      const { events: seen } = wireEvents(s.clone, 'conv-9');
      s.clone.post(humanMessage('やあ', 'conv-9'));
      await waitFor(() => seen.some((event) => event.type === 'error'), 'error イベントが届く');
      await s.clone.stop();
    });

    const outbound = lines.filter(
      (line) => line.includes('日誌を記録できませんでした') && line.includes('role=outbound'),
    );
    expect(outbound).toHaveLength(2);
    for (const line of outbound) {
      expect(line).toContain('器が閉じている');
      expect(line).toMatch(/role=outbound chars=[1-9]\d*/u);
    }
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('ghp_');
    expect(lines.join('')).not.toContain('params=');
  });
});
