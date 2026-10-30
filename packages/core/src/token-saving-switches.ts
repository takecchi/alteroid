import { clearEnvSwitchNotesForTesting, resolveEnvSwitch } from './env-switch.js';

// トークン節約の改修を系統別に入り切りするスイッチ。応答の質が下がったときに、節約が原因かを切り分けるための口である。
// 値の綴り: `on` / `1` / `true` / `yes` / `enabled` が有効、`off` / `0` / `false` / `no` / `disabled` が無効、未設定と空は既定。大文字小文字は問わない。
// それ以外の綴りは既定へ倒して `noteUnreadableRecord` で残す（`resolveInboxSettleMs` と同じ作法）。デーモンの起動は落とさない。

/** 系統2「決まった文の折り畳み」。既定は無効＝2回目以降も毎回、元の全文が出る。 */
export const TOKEN_SAVING_FOLD_FIXED_TEXT_ENV = 'ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT';
/** 系統4「compaction まわり」。既定は無効＝自動要約の窓を設定せず、要約後は記憶を全文で載せ直し、要約直後の軽い再掲もしない。 */
export const TOKEN_SAVING_COMPACTION_ENV = 'ALTEROID_TOKEN_SAVING_COMPACTION';
/** 系統3「可変内容の抜粋・予算」。既定は有効＝現状のまま。無効にすると抜粋・予算を節約改修の前の形に戻す。 */
export const TOKEN_SAVING_EXCERPT_ENV = 'ALTEROID_TOKEN_SAVING_EXCERPT';

export interface TokenSavingSwitches {
  readonly foldFixedText: boolean;
  readonly compaction: boolean;
  readonly excerpt: boolean;
}

// 読み方は `env-switch.ts`。セッションを組むたび（`autoCompactWindowSettings`）に呼ばれるので、痕跡は同じ名前・同じ値で1回だけ残る。
const resolveSwitch = resolveEnvSwitch;

/** テスト用: 読めない綴りの痕跡の「1回だけ」の控えを空にする。 */
export const clearTokenSavingNotesForTesting = clearEnvSwitchNotesForTesting;

export function resolveTokenSavingFoldFixedText(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveSwitch(env, TOKEN_SAVING_FOLD_FIXED_TEXT_ENV, false, '固定文の折り畳みの設定');
}

export function resolveTokenSavingCompaction(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveSwitch(env, TOKEN_SAVING_COMPACTION_ENV, false, 'compaction まわりの節約の設定');
}

export function resolveTokenSavingExcerpt(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveSwitch(env, TOKEN_SAVING_EXCERPT_ENV, true, '抜粋・予算の節約の設定');
}

export function resolveTokenSavingSwitches(
  env: NodeJS.ProcessEnv = process.env,
): TokenSavingSwitches {
  return {
    foldFixedText: resolveTokenSavingFoldFixedText(env),
    compaction: resolveTokenSavingCompaction(env),
    excerpt: resolveTokenSavingExcerpt(env),
  };
}
