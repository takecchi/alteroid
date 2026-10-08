import { randomUUID } from 'node:crypto';

import {
  markTokenUnusable,
  markTokenUsable,
  normalizeTokenPool,
  toAgentTokenView,
  type AgentToken,
  type AgentTokenInput,
  type AgentTokenView,
  type TokenFailureObservation,
  type TokenRotationPolicy,
  type TokenRotationSettings,
} from './token-pool.js';
import { reasonOf } from './dropped-record.js';
import type { UnreadableToken } from './schema.js';
import { UnreadableTokenSettingsError, type Stores } from './store.js';
import { createTokenPoolWriteLock, type TokenPoolWriteLock } from './token-pool-write-lock.js';

// settings を既定値で埋めない: 「無い」と「読めない」の区別が潰れ、off にしてあった回転を黙って戻すため。
// rowsUnreadable は1件でも在るときだけ載せる: { count: 0 } は「読めない行は無いと確かめた」と読めてしまうため
export type TokenPoolView = (
  | { tokens: AgentTokenView[]; settings: TokenRotationSettings; settingsUnreadable?: undefined }
  | {
      tokens: AgentTokenView[];
      settings?: undefined;
      settingsUnreadable: { reason: string };
    }
) & { rowsUnreadable?: TokenRowsUnreadable };

export interface TokenRowsUnreadable {
  count: number;
  rows: UnreadableToken[];
  carriedOver?: true;
}

export interface ReplaceOptions {
  // 渡す行は値を持つ（正本）: 日誌へ値を書かない
  beforeSave?: (change: {
    before: readonly AgentToken[];
    after: readonly AgentToken[];
  }) => Promise<void>;
}

export interface SetSettingsOptions {
  beforeWrite?: (change: {
    before: TokenRotationSettings | undefined;
    after: Pick<TokenRotationSettings, 'rotateOn' | 'cooldownMs'>;
  }) => Promise<void>;
}

export interface RemoveUnreadableOptions {
  beforeRemove?: (ids: readonly string[]) => Promise<void>;
}

export type RemoveUnreadableResult =
  | { kind: 'removed'; ids: string[]; view: TokenPoolView }
  // cause をそのまま外へ出さない: メッセージに行の中身が載りうるため。消したことは確かなので「消せなかった」として扱わない
  | { kind: 'removedViewFailed'; ids: string[]; cause: unknown }
  | { kind: 'unknown'; count: number };

export type ReplaceResult =
  | { kind: 'replaced'; view: TokenPoolView }
  // cause をそのまま外へ出さない: メッセージに行の中身が載りうるため。保存したことは確かなので「保存できなかった」として扱わない
  | { kind: 'replacedViewFailed'; cause: unknown };

export interface TokenPoolService {
  list(): Promise<TokenPoolView>;
  // tokens の保存は設定が読めるかどうかに関係なく行う: 設定が壊れていることを理由にプールの置換まで止めないため
  replace(inputs: readonly AgentTokenInput[], options?: ReplaceOptions): Promise<ReplaceResult>;
  // 全部か無か: 打ち間違いで別の行を消さないため。件数だけ返し指された文字列は返さない: 取り違えて貼ったトークンの値を応答へ映さないため
  removeUnreadable(
    ids: readonly string[],
    options?: RemoveUnreadableOptions,
  ): Promise<RemoveUnreadableResult>;
  setSettings(
    patch: {
      rotateOn?: TokenRotationPolicy;
      cooldownMs?: number;
    },
    options?: SetSettingsOptions,
  ): Promise<TokenRotationSettings>;
  // 設定を呼び出し側で読んで渡さない: 読んでから渡すまでの隙間に設定が変わると、古い既定で冷やすため。
  // 引数の形を書き写さず Pick する: 自前で宣言すると TokenFailureObservation の変更が型検査を素通りし、期限が黙って捨てられるため
  noteUnusable(
    input: { id: string } & Pick<TokenFailureObservation, 'message' | 'resets'>,
  ): Promise<AgentTokenView | undefined>;
  noteUsable(id: string): Promise<AgentTokenView | undefined>;
}

export interface TokenPoolServiceOptions {
  stores: Stores;
  now?: () => Date;
  newId?: () => string;
  // 知らせるだけで判断しない: 「回せ」と言う形にすると設定が off でも回る経路が生まれるため。
  // 投げても保存の結果を巻き添えにしない: 鍵は保存できているのに「保存できなかった」と返すことになるため
  onChanged?: (change: 'pool' | 'settings') => void;
  // 回し手と別のインスタンスを渡さない: 別々の直列の列が互いを待たず、後に書いたほうが前の変更を消すため
  writeLock?: TokenPoolWriteLock;
}

export function createTokenPoolService(options: TokenPoolServiceOptions): TokenPoolService {
  const { stores } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const writeLock = options.writeLock ?? createTokenPoolWriteLock();

  // 保存が成功した後だけ呼ぶ: 前に呼ぶと検証で落ちた入力でも「変わった」が飛ぶため。握り潰さず跡を残す: 契機が届いていないことが見えなくなるため
  function announceChange(change: 'pool' | 'settings'): void {
    if (options.onChanged === undefined) return;
    try {
      options.onChanged(change);
    } catch (error) {
      // 本文を出さない: この関数は値を扱う経路の中に居るため
      process.stderr.write(
        `alteroidd: 認証トークンのプールの変更（${change}）を見張りへ知らせられなかった: ` +
          `${reasonOf(error)}\n`,
      );
    }
  }

  // この serial() は回し手の書き込みを待たない: 回し手と排他にするのは writeLock
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // UnreadableTokenSettingsError 以外は飲み込まず投げる: 器そのものの異常まで「設定が壊れている」に化けさせないため
  async function readSettingsOrUnreadable(): Promise<
    { ok: true; settings: TokenRotationSettings } | { ok: false; reason: string }
  > {
    try {
      const settings = await stores.tokens.readSettings();
      return { ok: true, settings };
    } catch (error) {
      if (!(error instanceof UnreadableTokenSettingsError)) throw error;
      return { ok: false, reason: error.message };
    }
  }

  function viewOf(
    tokens: AgentTokenView[],
    settingsResult: Awaited<ReturnType<typeof readSettingsOrUnreadable>>,
    unreadableRows: readonly UnreadableToken[],
    options: { carriedOver?: boolean } = {},
  ): TokenPoolView {
    const base = settingsResult.ok
      ? { tokens, settings: settingsResult.settings }
      : { tokens, settingsUnreadable: { reason: settingsResult.reason } };
    return unreadableRows.length === 0
      ? base
      : {
          ...base,
          rowsUnreadable: {
            count: unreadableRows.length,
            rows: [...unreadableRows],
            ...(options.carriedOver === true ? { carriedOver: true as const } : {}),
          },
        };
  }

  async function currentView(): Promise<TokenPoolView> {
    const [tokens, settingsResult, unreadableRows] = await Promise.all([
      stores.tokens.list(),
      readSettingsOrUnreadable(),
      stores.tokens.listUnreadable(),
    ]);
    return viewOf(tokens.map(toAgentTokenView), settingsResult, unreadableRows);
  }

  // 器に「1行だけ更新する」口を足さずこの形にする: read-modify-write の原子性を fs と pg にもう1つ実装することになり、replace と二重になるため。
  // existing を呼び出し側から受け取らない: 読んだ時点で古くなりうるため。
  // 書いた後に読み直せないときは undefined へ潰さず投げる: 「元から無かった」と見分けが付かなくなるため
  async function writeOne(
    id: string,
    mutate: (token: AgentToken) => AgentToken,
  ): Promise<AgentTokenView | undefined> {
    const stored = await writeLock.run(async () => {
      const existing = await stores.tokens.list();
      if (!existing.some((token) => token.id === id)) return undefined;
      return stores.tokens.replace(
        existing.map((token) => (token.id === id ? mutate(token) : token)),
      );
    });
    if (stored === undefined) return undefined;
    const written = stored.find((token) => token.id === id);
    if (written === undefined) {
      // id だけを含める: この例外は上の層でログに出るため
      throw new Error(`トークン（id ${id}）を書いた直後に読み直せなかった`);
    }
    return toAgentTokenView(written);
  }

  return {
    // 読みは直列化の列を通さない: 読みを待たせる理由が無いため
    list: () => currentView(),

    replace: (inputs: readonly AgentTokenInput[], replaceOptions: ReplaceOptions = {}) =>
      serial(async () => {
        // 読み直しから書き戻しまでを writeLock の中に収める: 通さないと、読んでから書く間に回し手の冷却が割り込んで黙って消えるため
        const stored = await writeLock.run(async () => {
          const existing = await stores.tokens.list();
          const normalized = normalizeTokenPool(inputs, existing, { now, newId });
          await replaceOptions.beforeSave?.({ before: existing, after: normalized });
          return stores.tokens.replace(normalized);
        });
        // 読み直しの失敗は投げず値で返す: 投げると呼び出し側が「保存できなかった」と読むため
        let view: TokenPoolView;
        try {
          const settingsResult = await readSettingsOrUnreadable();
          const unreadableRows = await stores.tokens.listUnreadable();
          view = viewOf(stored.map(toAgentTokenView), settingsResult, unreadableRows, {
            carriedOver: true,
          });
        } catch (cause) {
          announceChange('pool');
          return { kind: 'replacedViewFailed', cause } satisfies ReplaceResult;
        }
        announceChange('pool');
        return { kind: 'replaced', view } satisfies ReplaceResult;
      }),

    removeUnreadable: (ids: readonly string[], options: RemoveUnreadableOptions = {}) =>
      serial(async () => {
        const wanted = [...new Set(ids)];
        const removed = await writeLock.run(
          async (): Promise<RemoveUnreadableResult | string[]> => {
            const present = new Set(
              (await stores.tokens.listUnreadable()).flatMap((row) =>
                row.id === undefined ? [] : [row.id],
              ),
            );
            const unknown = wanted.filter((id) => !present.has(id));
            if (unknown.length > 0 || wanted.length === 0) {
              return { kind: 'unknown', count: unknown.length };
            }
            await options.beforeRemove?.(wanted);
            return stores.tokens.removeUnreadable(wanted);
          },
        );
        if (!Array.isArray(removed)) return removed;
        // 読み直しの失敗は投げず値で返す: 投げると呼び出し側が「消せなかった」と読むため
        let view: TokenPoolView;
        try {
          const [tokens, settingsResult, unreadableRows] = await Promise.all([
            stores.tokens.list(),
            readSettingsOrUnreadable(),
            stores.tokens.listUnreadable(),
          ]);
          view = viewOf(tokens.map(toAgentTokenView), settingsResult, unreadableRows);
        } catch (cause) {
          announceChange('pool');
          return { kind: 'removedViewFailed', ids: removed, cause };
        }
        announceChange('pool');
        return { kind: 'removed', ids: removed, view };
      }),

    noteUnusable: (input: { id: string } & Pick<TokenFailureObservation, 'message' | 'resets'>) =>
      serial(async () => {
        // 一覧を先読みしない: writeOne が writeLock の中で読み直すので、ここで読むと古くなりうるため
        const settings = await stores.tokens.readSettings();
        return writeOne(input.id, (token) =>
          markTokenUnusable(token, {
            at: now().toISOString(),
            message: input.message,
            ...(input.resets === undefined ? {} : { resets: input.resets }),
            fallbackCooldownMs: settings.cooldownMs,
          }),
        );
      }),

    noteUsable: (id: string) =>
      serial(async () => writeOne(id, (token) => markTokenUsable(token, now().toISOString()))),

    setSettings: (
      patch: { rotateOn?: TokenRotationPolicy; cooldownMs?: number },
      setOptions: SetSettingsOptions = {},
    ) =>
      serial(async () => {
        const updatedAt = now().toISOString();
        let next: TokenRotationSettings;
        let before: TokenRotationSettings | undefined;
        try {
          const current = await stores.tokens.readSettings();
          before = current;
          next = {
            rotateOn: patch.rotateOn ?? current.rotateOn,
            cooldownMs: patch.cooldownMs ?? current.cooldownMs,
            updatedAt,
          };
        } catch (error) {
          // 片方だけの patch は投げたまま返す: 埋める元の現在値が読めないため
          if (
            !(error instanceof UnreadableTokenSettingsError) ||
            patch.rotateOn === undefined ||
            patch.cooldownMs === undefined
          ) {
            throw error;
          }
          next = { rotateOn: patch.rotateOn, cooldownMs: patch.cooldownMs, updatedAt };
        }
        await setOptions.beforeWrite?.({ before, after: next });
        const written = await stores.tokens.writeSettings(next);
        announceChange('settings');
        return written;
      }),
  };
}
