import { redactErrorText } from './denial-input-head.js';
import { reasonOf } from './dropped-record.js';
import {
  fingerprintOf,
  normalizeProfileScript,
  type PreparedProfile,
  type ProfileApplier,
  type ProfileApplyResult,
} from './profile.js';
import type {
  RunnerClient,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
} from './runner-protocol.js';
import {
  compareProfileEntryNames,
  PROFILE_ENTRY_NAME,
  type EnvProfileEntry,
  type EnvProfileScope,
  type Stores,
} from './store.js';

/** 判定をここ1か所に寄せるのは、別々に判定すると食い違い、外したはずの側に本文が残るから。 */
export function profileScopeAppliesTo(
  scope: EnvProfileScope | undefined,
  target: 'clone' | 'runner',
): boolean {
  const normalized = scope ?? 'all';
  if (normalized === 'all') return true;
  return normalized === 'app' ? target === 'clone' : target === 'runner';
}

export type ProfileComposeTarget = 'clone' | 'runner' | 'all';

/**
 * 見出しは入れない: 1行だけのとき合成が元の本文とバイトまで一致し、アップグレードで指紋が変わらない。
 * 掛かる行が0なら `''` を降ろす（「何もしない」にすると撒く先を狭めた側に本文が残る）。
 */
export function composeProfileScript(
  entries: readonly EnvProfileEntry[],
  target: ProfileComposeTarget,
): string {
  const parts = entries
    .filter((entry) => target === 'all' || profileScopeAppliesTo(entry.scope, target))
    .filter((entry) => entry.script.trim().length > 0)
    .sort((a, b) => compareProfileEntryNames(a.name, b.name))
    .map((entry) => (entry.script.endsWith('\n') ? entry.script : `${entry.script}\n`));
  return normalizeProfileScript(parts.join('\n'));
}

export interface ComposedFingerprint {
  sha256?: string;
  bytes?: number;
}

function fingerprintOfComposed(script: string): ComposedFingerprint {
  return script.length === 0
    ? {}
    : { sha256: fingerprintOf(script), bytes: Buffer.byteLength(script) };
}

export function composedFingerprints(entries: readonly EnvProfileEntry[]): {
  clone: ComposedFingerprint;
  runner: ComposedFingerprint;
} {
  return {
    clone: fingerprintOfComposed(composeProfileScript(entries, 'clone')),
    runner: fingerprintOfComposed(composeProfileScript(entries, 'runner')),
  };
}

/**
 * 更新（クローンの器へ commit・記憶ストアへ保存・各 runner へ配布）を直列化する:
 * 同時に2つ入ると層ごとに違う本文が残り、どちらも成功を返すのに環境が割れる。
 * `syncRunner` も同じ列を通す: 更新の最中に走ると古い本文で新しい本文を上書きする。
 */
export interface ProfileService {
  read(): Promise<EnvProfileEntry[]>;
  /** `scope` を省略すると既存行の撒く先を保つ（本文だけ直して撒く先が `all` へ戻るのを避ける）。 */
  set(name: string, script: string, scope?: EnvProfileScope): Promise<ApplyProfileResult>;
  remove(name: string): Promise<ApplyProfileResult & { removed: boolean }>;
  clearAll(): Promise<ApplyProfileResult>;
  apply(script: string): Promise<ApplyProfileResult>;
  /** 記憶ストアへは書かない: 書くと `updatedAt` が最後にデーモンを起こした時刻になる。 */
  restore(): Promise<ProfileApplyResult | null>;
  syncRunner(runner: RunnerClient): Promise<RunnerProfileResult | null>;
  /** 即時の配布は `ManagerPool` の押し込みの帳面と挑み直しを通らないので、ここを購読して同じ帳面に積む。 */
  onPushed?(
    listener: (results: readonly (RunnerProfileResult & { runnerId: string })[]) => void,
  ): () => void;
}

/** 呼び出し側は文言ではなくこの型で見分け、利用者の誤りとして返す（500 にしない）。 */
export class ProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileInputError';
  }
}

/** 呼び出し側は文言ではなく `instanceof` で見分け、日誌の決定を状態どおりに書き換える。 */
export class ProfileRollbackFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProfileRollbackFailedError';
  }
}

export interface ProfileServiceOptions {
  stores: Stores;
  applier?: ProfileApplier;
  runners?: RunnerRegistry;
}

export interface ApplyProfileResult {
  stored: boolean;
  updatedAt?: string;
  entries?: EnvProfileEntry[];
  composed?: { clone: ComposedFingerprint; runner: ComposedFingerprint };
  clone: ProfileApplyResult;
  runners: (RunnerProfileResult & { runnerId: string })[];
}

export function createProfileService(options: ProfileServiceOptions): ProfileService {
  const { stores, applier, runners } = options;
  const pushListeners = new Set<
    (results: readonly (RunnerProfileResult & { runnerId: string })[]) => void
  >();

  // 前の失敗で列が止まらないように、常に解決する形で繋ぐ。
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  interface Plan {
    rows: EnvProfileEntry[];
    write: () => Promise<void>;
  }

  /**
   * どの段で落ちても旧版で揃える: 失敗を返したのに1層だけ新版が残ると、次に runner が
   * 名乗った時点で `syncRunner` がそれを配り、分裂が黙って広がる。
   * clone に掛かる行が無い側へは空を効かせる: 「触らない」だと前の本文（鍵を含みうる）が残る。
   */
  async function transact(
    plan: (previous: EnvProfileEntry[]) => Plan,
  ): Promise<ApplyProfileResult> {
    // 更新はこの列の中でしか起きないので、ここで読んだものが直前の版である。
    const previous = await stores.profile.list();
    const { rows, write } = plan(previous);
    const cloneScript = composeProfileScript(rows, 'clone');
    const runnerScript = composeProfileScript(rows, 'runner');
    const at = new Date().toISOString();

    const prepared: PreparedProfile | null =
      applier === undefined
        ? null
        : await applier.prepare(cloneScript).catch((error: unknown): PreparedProfile => ({
            ok: false,
            error: redactErrorText(String(error), process.env),
            commit: async () => undefined,
            discard: async () => undefined,
          }));

    const clone: ProfileApplyResult =
      prepared === null
        ? { ok: true }
        : {
            ok: prepared.ok,
            ...(prepared.profile === undefined ? {} : { profile: prepared.profile }),
            ...(prepared.error === undefined ? {} : { error: prepared.error }),
            ...(prepared.output === undefined ? {} : { output: prepared.output }),
            ...(prepared.names === undefined ? {} : { names: prepared.names }),
          };

    if (prepared !== null && !prepared.ok) {
      await prepared.discard();
      return { stored: false, clone, runners: [] };
    }

    try {
      await write();
    } catch (error) {
      // 正本へ書けなかったものをクローンに効かせると、失敗を返したのにクローンだけ新しい本文で走る。
      await prepared?.discard();
      await stores.profile.replaceAll(previous).catch(() => undefined);
      throw error;
    }

    try {
      await prepared?.commit();
    } catch (error) {
      // 戻さないと、失敗を返したのに正本だけ新版が残り、次の `syncRunner` で runner へ配られる。
      await prepared?.discard();
      try {
        // 通常の書き込みで戻すと `updatedAt` が失敗した時刻へ進み、成功していない更新が最後の変更に見える。
        await stores.profile.replaceAll(previous);
      } catch (rollbackError) {
        // 正本=新版・クローン=旧版が残るので、人間が直せるよう両方の理由を出す。`cause` は書き戻しの失敗。
        throw new ProfileRollbackFailedError(
          'プロファイルをクローンへ反映できず、正本を書き戻すこともできなかった' +
            `（正本だけ新版のまま残っている）: 反映=${redactErrorText(String(error), process.env)} / 書き戻し=${redactErrorText(String(rollbackError), process.env)}`,
          { cause: rollbackError },
        );
      }
      throw new Error(
        `プロファイルをクローンへ反映できなかったので、正本も元へ戻した: ${redactErrorText(String(error), process.env)}`,
        { cause: error },
      );
    }

    const results = await pushAll(runnerScript);
    for (const listener of pushListeners) {
      try {
        listener(results);
      } catch {
        // 購読者の例外で応答を落とさない。
      }
    }

    const entries = await stores.profile.list();
    return {
      stored: true,
      updatedAt: at,
      entries,
      // 指紋は合成後の本文から直に取る: 器の有無で出たり消えたりすると突き合わせる手段が構成によって消える。
      composed: composedFingerprints(entries),
      clone,
      runners: results,
    };
  }

  function entryName(name: string): string {
    if (!PROFILE_ENTRY_NAME.test(name)) {
      throw new ProfileInputError(
        `プロファイルの行の名前の形が不正である（${PROFILE_ENTRY_NAME.source}）`,
      );
    }
    return name;
  }

  const clearPlan = (): Plan => ({
    rows: [],
    write: async () => void (await stores.profile.clear()),
  });

  return {
    read: () => stores.profile.list(),

    set: (name, script, scope) =>
      serial(() => {
        entryName(name);
        // 保存・配布・指紋が同じ文字列を見ないと、置いた指紋と読んだ指紋が食い違う。
        const normalized = normalizeProfileScript(script);
        if (normalized.length === 0) {
          throw new ProfileInputError('空の本文は行として置けない（外すなら remove / clearAll）');
        }
        return transact((previous) => {
          const existing = previous.find((entry) => entry.name === name);
          // 大文字小文字を区別しないファイルシステム（macOS）で fs 版の `<name>.sh` が同じファイルになり、片方が黙ってもう片方を上書きする。
          const clash = previous.find(
            (entry) => entry.name !== name && entry.name.toLowerCase() === name.toLowerCase(),
          );
          if (clash !== undefined) {
            throw new ProfileInputError(
              `大文字小文字だけが違う行 ${clash.name} が既にある（別の行としては置けない）`,
            );
          }
          const resolved: EnvProfileScope = scope ?? existing?.scope ?? 'all';
          const row: EnvProfileEntry = {
            name,
            script: normalized,
            scope: resolved,
            updatedAt: new Date().toISOString(),
          };
          return {
            rows: [...previous.filter((entry) => entry.name !== name), row],
            write: async () => void (await stores.profile.set(name, normalized, resolved)),
          };
        });
      }),

    remove: (name) =>
      serial(async () => {
        entryName(name);
        let removed = false;
        const result = await transact((previous) => {
          removed = previous.some((entry) => entry.name === name);
          return {
            rows: previous.filter((entry) => entry.name !== name),
            write: async () => void (await stores.profile.remove(name)),
          };
        });
        return { ...result, removed };
      }),

    clearAll: () => serial(() => transact(clearPlan)),

    apply: (script: string) =>
      serial(() => {
        const normalized = normalizeProfileScript(script);
        if (normalized.length === 0) return transact(clearPlan);
        return transact(() => ({
          rows: [
            {
              name: 'default',
              script: normalized,
              scope: 'all',
              updatedAt: new Date().toISOString(),
            },
          ],
          write: async () => {
            await stores.profile.clear();
            await stores.profile.set('default', normalized, 'all');
          },
        }));
      }),

    restore: () =>
      serial(async () => {
        const entries = await stores.profile.list();
        if (applier === undefined) return null;
        const script = composeProfileScript(entries, 'clone');
        if (script.length === 0 && entries.length === 0) return null;
        return applier.apply(script);
      }),

    onPushed: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        const script = composeProfileScript(await stores.profile.list(), 'runner');

        // 「読めなかった」を `undefined`（何も載っていない）に潰さない: 潰すと `script` が空のとき
        // 「一致」になり、外したはずのプロファイル（鍵を含みうる）が runner に残り続ける。
        let unreadable = false;
        let current: RunnerProfileFingerprint | undefined;
        try {
          current = await runner.profile();
        } catch {
          unreadable = true;
        }
        const same =
          script.length === 0 ? current === undefined : current?.sha256 === fingerprintOf(script);
        if (!unreadable && same) return null;

        return runner.setProfile(script);
      }),
  };

  async function pushAll(script: string): Promise<(RunnerProfileResult & { runnerId: string })[]> {
    if (runners === undefined) return [];
    return Promise.all(
      (await runners.list()).map(async (runner) => {
        try {
          return { runnerId: runner.runnerId, ...(await runner.setProfile(script)) };
        } catch (error) {
          return { runnerId: runner.runnerId, ok: false, error: reasonOf(error) };
        }
      }),
    );
  }
}
