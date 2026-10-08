import { randomUUID } from 'node:crypto';

import {
  checkCodexAuthJson,
  codexChatgptAuthStatusOf,
  newCodexChatgptAuthRevision,
  type CodexChatgptAuthRecord,
  type CodexChatgptAuthStatus,
  type CodexChatgptAuthStore,
} from './codex-chatgpt-auth.js';
import type { CodexDeviceLogin, CodexDeviceLoginOutcome } from './codex-device-login.js';
import { fingerprintOf } from './credentials.js';
import { reasonOf } from './dropped-record.js';
import type { CodexAuthRunnerSync } from './manager.js';
import {
  RunnerCodexAuthUnsupportedError,
  type RunnerClient,
  type RunnerEvent,
  type RunnerRegistry,
} from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';

/**
 * Codex の ChatGPT ログインの正本を持ち、ログイン（デバイスコード）・ログアウト・runner への配布・
 * 書き戻し（compare-and-swap）・失効の記録を1本の列で行う（#3939）。**正本はデーモンが持つ。**
 *
 * 口は CLI（`alteroid codex login|status|logout`）・HTTP（`/codex/auth`・`/codex/login`）・Web の
 * 3つで、どれもここを通る（片方でしかできないことを作らない）。
 *
 * ## 鍵を出さない
 *
 * 値（`auth.json` の中身）を返す口をここに作らない。日誌に書くのはアカウント・プラン・指紋・
 * runner の id・理由だけ。
 *
 * ## 書き戻しの取り合い（5台の runner）
 *
 * runner は「どの版から書き換えたか」（`baseRevision`）を添えて知らせる。正本は
 * `compareAndSwap(baseRevision, …)` で、**読んだ版がいまの版と同じときだけ**置き換える。
 * 置き換えたら新しい版を全 runner へ降ろし直す。負けた runner には正本の値を降ろし直す
 * （手元の古い・別系統の値を正本で上書きする）。古い値が新しい値を潰さない。
 */
export interface CodexLoginView {
  id: string;
  state: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'expired';
  verificationUrl: string;
  userCode: string;
  startedAt: string;
  finishedAt: string | null;
  /** 失敗の理由（伏せ字済み）。 */
  error: string | null;
}

export interface CodexChatgptAuthService extends CodexAuthRunnerSync {
  status(): Promise<CodexChatgptAuthStatus>;
  /** デバイスコードのログインを始める。進行中のものがあればそれを返す（同時に1本）。 */
  startLogin(): Promise<CodexLoginView>;
  login(id: string): CodexLoginView | undefined;
  /** 取り消す。決着までを待って返す。知らない id は `undefined`。 */
  cancelLogin(id: string): Promise<CodexLoginView | undefined>;
  /** 正本を消し、全 runner から外す。 */
  logout(): Promise<{ removed: boolean }>;
  /** 進行中のログインの決着を待つ（テスト・畳むとき用）。 */
  settled(): Promise<void>;
}

export interface CodexChatgptAuthServiceOptions {
  store: CodexChatgptAuthStore;
  runners?: Pick<RunnerRegistry, 'list'>;
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** デバイスコードのログインを始める（デーモンが `startCodexDeviceLogin` を渡す）。 */
  startDeviceLogin: () => Promise<CodexDeviceLogin>;
  now?: () => Date;
  newRevision?: () => string;
  newId?: () => string;
}

/** 終わったログインを覚えておく数（状態を CLI / Web から見るため）。 */
const FINISHED_LOGINS_KEPT = 10;

const SUBJECT = 'Codex の ChatGPT ログイン';

export function createCodexChatgptAuthService(
  options: CodexChatgptAuthServiceOptions,
): CodexChatgptAuthService {
  const { store, runners, journal, startDeviceLogin } = options;
  const now = options.now ?? (() => new Date());
  const newRevision = options.newRevision ?? newCodexChatgptAuthRevision;
  const newId = options.newId ?? randomUUID;
  const logins = new Map<
    string,
    { view: CodexLoginView; handle: CodexDeviceLogin; done: Promise<void> }
  >();
  /** 口を持たないと分かった runner（同じ知らせを日誌へ積み続けない）。 */
  const unsupported = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  async function note(decision: string, grounds: string): Promise<void> {
    try {
      await journal({ type: 'decision', decision: `${SUBJECT}: ${decision}`, grounds });
    } catch {
      // 日誌に書けなくても、正本の操作は止めない（書けなかったことは日誌の側が跡を残す）。
    }
  }

  function pushOf(
    record: CodexChatgptAuthRecord | null,
  ): { value: string; revision: string } | null {
    return record === null ? null : { value: record.value, revision: record.revision };
  }

  /** 1台へ降ろす。投げない。 */
  async function pushTo(
    runner: RunnerClient,
    record: CodexChatgptAuthRecord | null,
  ): Promise<void> {
    if (runner.setCodexAuth === undefined) return;
    try {
      await runner.setCodexAuth(pushOf(record));
      unsupported.delete(runner.runnerId);
    } catch (error) {
      if (error instanceof RunnerCodexAuthUnsupportedError) {
        // ログインしていないなら降ろすものも無い（古い runner へ空を降ろせないことは知らせない）。
        if (record === null || unsupported.has(runner.runnerId)) {
          unsupported.add(runner.runnerId);
          return;
        }
        unsupported.add(runner.runnerId);
      }
      await note(
        `runner ${runner.runnerId} へ降ろせなかった`,
        `${reasonOf(error)}（この runner の peer の Codex は、CODEX_API_KEY が無ければ認証を持たずに走る）`,
      );
    }
  }

  async function pushAll(record: CodexChatgptAuthRecord | null): Promise<void> {
    if (runners === undefined) return;
    const list = await runners.list().catch(() => []);
    await Promise.all(list.map((runner) => pushTo(runner, record)));
  }

  function remember(view: CodexLoginView, handle: CodexDeviceLogin, done: Promise<void>): void {
    logins.set(view.id, { view, handle, done });
    const finished = [...logins.values()].filter((entry) => entry.view.state !== 'pending');
    for (const entry of finished.slice(0, Math.max(0, finished.length - FINISHED_LOGINS_KEPT))) {
      logins.delete(entry.view.id);
    }
  }

  async function settle(view: CodexLoginView, outcome: CodexDeviceLoginOutcome): Promise<void> {
    const at = now().toISOString();
    if (outcome.kind === 'succeeded') {
      try {
        await serial(async () => {
          const next: CodexChatgptAuthRecord = {
            value: outcome.authJson,
            revision: newRevision(),
            updatedAt: at,
            email: outcome.email,
            planType: outcome.planType,
            failure: null,
          };
          await store.replace(next);
          await note(
            'ログインした（正本へ置き、runner へ降ろす）',
            `アカウント ${outcome.email ?? '(不明)'}・プラン ${outcome.planType ?? '(不明)'}・指紋 ${fingerprintOf(next.value)}。` +
              'デバイスコードのログインで人間がブラウザで承認した。値は記録しない。',
          );
          await pushAll(next);
        });
        view.state = 'succeeded';
      } catch (error) {
        view.state = 'failed';
        view.error = `正本へ置けなかった: ${reasonOf(error)}`;
      }
    } else if (outcome.kind === 'failed') {
      view.state = 'failed';
      view.error = outcome.reason;
      await note('ログインに失敗した', outcome.reason);
    } else {
      view.state = outcome.kind;
    }
    view.finishedAt = at;
  }

  return {
    async status() {
      return codexChatgptAuthStatusOf(await store.get());
    },

    async startLogin() {
      const pending = [...logins.values()].find((entry) => entry.view.state === 'pending');
      if (pending !== undefined) return { ...pending.view };
      const handle = await startDeviceLogin();
      const view: CodexLoginView = {
        id: newId(),
        state: 'pending',
        verificationUrl: handle.started.verificationUrl,
        userCode: handle.started.userCode,
        startedAt: now().toISOString(),
        finishedAt: null,
        error: null,
      };
      const done = handle.outcome.then((outcome) => settle(view, outcome));
      remember(view, handle, done);
      return { ...view };
    },

    login(id) {
      const entry = logins.get(id);
      return entry === undefined ? undefined : { ...entry.view };
    },

    async cancelLogin(id) {
      const entry = logins.get(id);
      if (entry === undefined) return undefined;
      entry.handle.cancel();
      await entry.done;
      return { ...entry.view };
    },

    async logout() {
      return serial(async () => {
        const removed = await store.remove();
        if (removed) {
          await note('ログアウトした（正本から消し、runner から外す）', '人間が API から消した。');
        }
        await pushAll(null);
        return { removed };
      });
    },

    async settled() {
      await Promise.all([...logins.values()].map((entry) => entry.done));
      await chain;
    },

    async syncRunner(runner) {
      const record = await store.get().catch(async (error: unknown) => {
        await note(`runner ${runner.runnerId} へ降ろす正本を読めなかった`, reasonOf(error));
        return undefined;
      });
      if (record === undefined) return;
      await serial(() => pushTo(runner, record));
    },

    async onRunnerNotice(
      event: Extract<RunnerEvent, { type: 'codex_auth' }>,
      runnerId: string,
      runner: RunnerClient | null,
    ) {
      try {
        if (event.kind === 'failed') {
          await serial(() => recordFailure(event, runnerId));
          return;
        }
        await serial(() => writeBack(event, runnerId, runner));
      } catch (error) {
        await note(`runner ${runnerId} の知らせを扱えなかった`, reasonOf(error));
      }
    },
  };

  async function recordFailure(
    event: Extract<RunnerEvent, { type: 'codex_auth' }>,
    runnerId: string,
  ): Promise<void> {
    const reason = event.reason ?? '(理由は届かなかった)';
    const current = await store.get();
    if (current === null) return; // ログアウト済み。
    if (current.revision !== event.baseRevision) {
      // 古い版で起きた失敗。正本は既に新しい（別の runner の更新・再ログイン）。
      await note(
        `runner ${runnerId} が古い版で認証の失敗を知らせた（正本は既に新しいので記録だけ）`,
        reason,
      );
      return;
    }
    if (current.failure !== null) return; // 同じ失敗を積み続けない。
    const at = now().toISOString();
    await store.compareAndSwap(current.revision, { ...current, failure: { at, reason } });
    await note(
      '認証が切れた・失効した・更新に失敗した（再ログインが要る）',
      `runner ${runnerId}: ${reason}。peer の Codex は ChatGPT ログインで走れない。` +
        '人間に `alteroid codex login`（または Web の Codex の画面）で再ログインを頼むこと。',
    );
  }

  async function writeBack(
    event: Extract<RunnerEvent, { type: 'codex_auth' }>,
    runnerId: string,
    runner: RunnerClient | null,
  ): Promise<void> {
    const fingerprint = event.fingerprint;
    if (fingerprint === undefined) return;
    if (runner === null || runner.takeCodexAuthWriteBack === undefined) {
      await note(
        `runner ${runnerId} の書き換え（指紋 ${fingerprint}）を取りに行けなかった`,
        'runner が繋がっていない、または取り出す口を持たない。正本は前の版のまま。',
      );
      return;
    }
    const taken = await runner.takeCodexAuthWriteBack(fingerprint);
    if (taken === null) return; // 既に新しい版が降りて捨てられた。
    const checked = checkCodexAuthJson(taken.value);
    if (!checked.ok) {
      await note(`runner ${runnerId} の書き戻しを捨てた`, checked.reason);
      return;
    }
    const current = await store.get();
    if (current === null) {
      await note(
        `runner ${runnerId} の書き戻しを捨てた（ログアウト済み）`,
        `指紋 ${fingerprint}。runner からも外す。`,
      );
      await pushTo(runner, null);
      return;
    }
    if (current.value === taken.value) return;
    const next: CodexChatgptAuthRecord = {
      ...current,
      value: taken.value,
      revision: newRevision(),
      updatedAt: now().toISOString(),
      failure: null,
    };
    if (await store.compareAndSwap(taken.baseRevision, next)) {
      await note(
        `runner ${runnerId} で Codex が更新したトークンを正本へ書き戻した`,
        `指紋 ${fingerprintOf(current.value)} → ${fingerprintOf(next.value)}。全 runner へ降ろし直す。値は記録しない。`,
      );
      await pushAll(next);
      return;
    }
    await note(
      `runner ${runnerId} の古い版からの書き戻しを捨てた（正本は既に新しい）`,
      `書き戻しの指紋 ${fingerprint}。正本（指紋 ${fingerprintOf(current.value)}）をこの runner へ降ろし直す。`,
    );
    await pushTo(runner, current);
  }
}
