import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  PostToolUseHookInput,
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk';

import { buildCloneDistillOptions, buildCloneSessionOptions } from './claude-provider.js';
import { buildActivityDigest } from './digest.js';
import { excerptLine } from './excerpt.js';
import {
  inboxEventShape,
  journalEntryShape,
  noteBackgroundFailure,
  noteDroppedInboxEvent,
  noteDroppedRecord,
} from './dropped-record.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry, type RunnerClient } from './runner-protocol.js';
import { Inbox } from './inbox.js';
import { createManagerPool, type ManagerPool, type ManagerSummary } from './manager.js';
import { renderMemoryDocuments } from './memory.js';
import { placedModelTier, resolveModelTier } from './model-tier.js';
import {
  placedPermissionMode,
  resolvePermissionModeFor,
  type PermissionModeName,
} from './permission-mode.js';
import type { ProfileApplier } from './profile.js';
import type { ProfileService } from './profile-service.js';
import { createRecentMap } from './recent.js';
import type { RunnerRegistry } from './runner-protocol.js';
import {
  buildCloneSystemPrompt,
  buildDailyReportPrompt,
  buildDistillPrompt,
  buildExternalEventPrompt,
  buildSelfInitiativePrompt,
  buildTimerPrompt,
} from './prompt.js';
import { DAILY_REPORT_KIND, localDate, localDayRange } from './schedule.js';
import type { ScheduleStatus } from './schedule.js';
import { isDailyReport, isWrittenDailyReport } from './schema.js';
import type {
  ChatStreamEvent,
  Commitment,
  InboxEvent,
  JournalEntry,
  JournalEntryInput,
  MemoryDocument,
  ScheduledRequest,
} from './schema.js';
import { resolveBuildRevision } from './revision.js';
import type { CloneRuntimeFacts, SelfFacts } from './self.js';
import type { CommitmentList, PendingInboxEvent, Stores } from './store.js';
import { MCP_SERVER_NAME, createCloneMcpServer, type ToolContext } from './tools.js';
import { turnInputEntry } from './turn-input.js';
import type { AccountUsageState } from './usage-snapshot.js';
import {
  CLONE_ACTOR_ID,
  CLONE_DISTILL_ACTOR_ID,
  CLONE_SUB_ACTOR_PREFIX,
  isSuccessResult,
  modelUsageOf,
  usageDate,
  type UsageSite,
  type UsageSnapshot,
} from './usage.js';
import {
  classifyUsageNotice,
  describeUsageNotice,
  mergeRateLimitFacts,
  toRateLimitFacts,
  usageTransitionOf,
  type RateLimitFacts,
  type UsageLimitNotice,
} from './usage-limits.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import {
  assistantFailureOf,
  resultErrorLines,
  resultFailureOf,
  type SdkFailure,
} from './sdk-failure.js';

/**
 * クローン = デーモン内の長寿命 SDK セッション1本（docs/architecture.md）。
 *
 * - model の既定は `fable`。役割とモデル帯の対応は設計判断であり、変更には
 *   人間の承認が要る（AGENTS.md 地雷5）。`ALTEROID_CLONE_MODEL` はその
 *   **承認そのもの**であって、AI や実装の都合で動かしてよい旋盤ではない。
 * - **道具は全部渡す。** `tools` を渡さない（preset 一式）＋インプロセス MCP の
 *   自作ツール＋人間の設定と MCP 連携（`settingSources`）。**「クローンは人間の
 *   写像だから道具を持たない」は写像として成り立たない** — PC の前の人間は
 *   Claude Code に頼むだけでなく、自分でも端末を叩きファイルを開く
 *   （north_star「適用範囲」/ PRD「層ごとの能力」/ AGENTS.md 地雷7）。
 *   重い調査と実作業を下へ委ねるのは**方針**であって、道具を取り上げて
 *   実現しない（方針の置き場は `prompt.ts` のシステムプロンプト）。
 * - **ターンの起動口は受信箱ただ1つ。** 人間の発言もタイマーも蒸留も、必ず
 *   受信箱を通って直列に処理される。ここを迂回して直接ターンを起こすと、
 *   走行中のターンを踏み潰してループごと止まる。
 */

/** クローンのモデル帯の既定。変更には人間の承認が要る。 */
export const CLONE_MODEL = 'fable';

/**
 * クローンのモデル帯を人間が差し替えるための環境変数。
 *
 * **これは設定ではなく、人間の承認の置き場である。** 層とモデル帯の対応は
 * 設計判断であり（AGENTS.md 地雷5）、既定は `fable` のまま動かさない。ここに
 * 値を置けるのは人間だけで、置いた事実はデーモンの起動時に必ず表へ出す
 * （黙って上位帯から降りることを許さない）。
 *
 * 読むのはクローンを組み立てる一度きり。走行中の SDK セッションのモデルは
 * どのみち差し替えられないので、途中で読み直すと本セッションと蒸留の
 * サイドクエリだけがずれる。効かせたければ器を作り直すこと。
 */
export const CLONE_MODEL_ENV_KEY = 'ALTEROID_CLONE_MODEL';

/**
 * 環境変数を見てクローンのモデル帯を決める。空・空白なら既定（`fable`）。
 *
 * 判定の本体は `model-tier.ts` にある（マネージャーと作業者も同じ形を使う）。
 * 値は検証しない — 理由はあちらに書いてある。
 */
export function resolveCloneModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, CLONE_MODEL_ENV_KEY, CLONE_MODEL);
}

/**
 * 人間が実際に値を置いたか（置いていなければ `null`）。
 *
 * **{@link resolveCloneModel} と同じ判定を2か所に書かないためにここに居る。**
 * 置いた値がたまたま既定と同じ（`ALTEROID_CLONE_MODEL=fable`）でも「置いた」で
 * あり、「既定と違うか」では言い換えられない — `self_status` が返すのは
 * 「差し替えの承認がここに置かれているか」だからである。
 */
export function placedCloneModel(env: NodeJS.ProcessEnv = process.env): string | null {
  return placedModelTier(env, CLONE_MODEL_ENV_KEY);
}

/**
 * クローンの権限モードを人間が差し替えるための環境変数。
 *
 * **マネージャー（`ALTEROID_MANAGER_PERMISSION_MODE`）と対になっている。**
 * 片方にしか置き場が無いのは非対称で、「マネージャーは都度確認に締められるが
 * クローンは締められない」も「クローンだけ緩められない」も、どちらも*人間の側の*
 * 能力の欠落になる（`MANAGER_MODEL_ENV_KEY` に書いてあるのと同じ理由）。
 *
 * **これは能力の制限ではなく実行環境の設定である。** 締めても道具は減らない。
 * 既定（`auto`）の意味と、`default` に倒したときに何が起きるかは
 * `permission-mode.ts` に書いてある。
 */
export const CLONE_PERMISSION_MODE_ENV_KEY = 'ALTEROID_CLONE_PERMISSION_MODE';

/**
 * 人間の合図を待ち行列の先頭側へ入れるか（`ALTEROID_CLONE_HUMAN_PRIORITY`）。
 *
 * **既定は有効。** これは人間の決定である（2026-08-22 JST、逐語）:
 *
 * > **優先度を人間 > マネージャーにできますか？**
 * > **割り込んでもいいので人間への回答を優先するようにしてほしい。**
 *
 * **切れる口を必ず残す**（north_star 禁止2「方針は設定で開けられなければ
 * ならない」）。順序付けは方針であって能力ではないので、方針として設定で
 * 表す — ここを「切れない」にすると、器が優先順位を握って動かせなくなる。
 */
export const CLONE_HUMAN_PRIORITY_ENV_KEY = 'ALTEROID_CLONE_HUMAN_PRIORITY';

/**
 * 環境変数を見て人間優先を使うか決める。**既定は有効**で、明示的に切ったときだけ偽。
 *
 * **「読めなかった」を「切られた」と読まないこと。** 未設定・空・空白はすべて
 * 既定（有効）である — 人間が明示的に `0` / `false` / `off` / `no` と書いたときだけ
 * 切る。ここを緩めると、変数が届かなかっただけの器で**人間の待ちが黙って戻る。**
 */
export function resolveCloneHumanPriority(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CLONE_HUMAN_PRIORITY_ENV_KEY]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * 待ち行列で割り込んでよい合図か ＝ 人間が返事を待っている合図か。
 *
 * **2種類ある。** `human_message`（発言）と `human_answer`（承認待ちへの回答）で、
 * どちらも**人間が画面の前で止まっている**。後者を外すと、「答えたのに止まった
 * マネージャーへ返らない」という既知の壊れ方（`commitmentFor` の `human_answer`
 * の doc）が、待ち時間の側からもう一度出る。
 *
 * **タイマー・発意・外部イベント・マネージャーからの一件・蒸留は含まない。**
 * どれも人間が待っている合図ではない。
 *
 * ## なぜこれで人間以外が餓死しないのか
 *
 * **理由は「割り込みの量が有界だから」であって、実装が何かを保証しているから
 * ではない。** 割り込めるのは人間が実際に打った発言だけで、**人間の速さでしか
 * 来ない。** 5件まとめて送られれば5件ぶん遅れて、そのあと必ず進む。
 *
 * **だから機械が人間を名乗る形を作らないこと。** ここに `external`（webhook）や
 * `timer` を足した瞬間、割り込みの量が機械の速さで決まるようになり、**有界性の
 * 根拠が消えて本当に餓死する。** `isHumanOriginated` が2つしか返さないのは、
 * 数が少ないからではなく**ここが有界性の全体だから**である。
 *
 * **テストが測っているのは餓死しないことではない**（それは上の有界性の話で、
 * 有限のテストでは示せない）。**測っているのは「人間を挟んでも人間以外が1件も
 * 消えず、人間以外どうしの到着順も保たれる」＝ 順序の保存と非喪失**である。
 * 歯の名前もそう書いてある。**名前が中身より多くを約束しないこと。**
 */
export function isHumanOriginated(event: InboxEvent): boolean {
  return event.type === 'human_message' || event.type === 'human_answer';
}

/** 環境変数を見てクローンの権限モードを決める。空・空白なら既定（`auto`）。 */
export function resolveClonePermissionMode(
  env: NodeJS.ProcessEnv = process.env,
): PermissionModeName {
  return resolvePermissionModeFor(env, CLONE_PERMISSION_MODE_ENV_KEY);
}

/**
 * 人間がクローンの権限モードを置いたか（置いていなければ `null`）。
 *
 * **起動時に表へ出すために要る。** モデル帯と同じで、既定から動いていることが
 * 黙って効いている状態を作らない（`placedCloneModel` と同じ理由）。締める側の
 * 差し替えは「道具が使えない」として現れるので、告知が無いと原因を探す手が
 * `self_status` だけになる。
 */
export function placedClonePermissionMode(env: NodeJS.ProcessEnv = process.env): string | null {
  return placedPermissionMode(env, CLONE_PERMISSION_MODE_ENV_KEY);
}

/** PreCompact で退避したトランスクリプトのうち、蒸留に渡す末尾のサイズ。 */
const DISTILL_TRANSCRIPT_TAIL_BYTES = 60_000;

/** 発意 tick と定期ジョブに渡す「直近」の幅。 */
const RECENT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 日報が既に書かれたかを確かめるときに遡る件数。 */
const DAILY_REPORT_LOOKUP = 30;

/** 外部イベントの中身をクローンに見せる上限。全文が要るなら送り元で切ること。 */
const EXTERNAL_PAYLOAD_LIMIT = 8_000;

/**
 * 観測できなかった名前の言い方。
 *
 * **空文字や省略で表さない。** 読めなかったことを黙って落とすと、監査の穴が
 * 「何も起きなかった」と同じ見え方になる（`runner.ts` の `'(不明)'` と同じ作法）。
 */
const UNKNOWN_TOOL_NAME = '(不明な道具)';
const UNKNOWN_AGENT_TYPE = '(不明)';

/**
 * 二重書き込み防止のために覚えておく拒否 `tool_use_id` の件数。
 *
 * `runner.ts` の `DENIED_MEMORY_LIMIT`（同じ役目・同じ値）に揃える。長く走る
 * セッションでメモリが伸び続けないための蓋であって、回数制限ではない
 * （AGENTS.md 地雷2）。溢れたら `#deniedToolUses` の `onForget` が日誌へ残す。
 */
const DENIED_TOOL_USE_MEMORY_LIMIT = 512;

/**
 * 継続中の依頼の器に触るときの試行回数と間隔（読み取りと発火の記録の両方）。
 *
 * **これは回数制限ではない**（AGENTS.md 地雷2）。器が一瞬揺れただけで1周期ぶんの
 * 仕事を落とさないための拾い直しであって、仕事の量を絞るものではない。
 */
const SCHEDULE_STORE_ATTEMPTS = 3;
const SCHEDULE_STORE_RETRY_MS = 200;

/**
 * `#forget` が `inbox.remove` を拾い直す回数と間隔（issue #256）。
 *
 * **これも回数制限ではない**（`SCHEDULE_STORE_ATTEMPTS` と同じ理由）。器の
 * 一瞬の揺れで消せなかっただけの合図を、次の起動を待たずに同じプロセスの中で
 * 消し込むための拾い直しであって、諦めた合図を切り捨てるものではない——
 * 全部失敗しても合図は失われない（`#forget` の doc）。
 */
const FORGET_RETRY_ATTEMPTS = 3;
const FORGET_RETRY_MS = 200;

/**
 * 版が入れ替わっていたときに読み直す回数。
 *
 * 人間が依頼を直した瞬間に発火が重なると1回ずれる。**古い本文で走らないことが最優先**
 * なので、合わなければ諦めて次の発火に譲る（依頼は消えないし `lastRunAt` も進まない）。
 */
const SCHEDULE_CLAIM_ROUNDS = 3;

/**
 * resume したセッションの最初のターンで1度だけ添える断り（`#resumedHistoryHasMemory`）。
 *
 * **記憶の全文を載せ直して上書きしないこと。** それはいま塞いでいる二重載せを
 * 自分でやることであり、しかも履歴の写しは resume のたびに増えていく。正本が
 * どちらかを言うだけなら、記憶がどれだけ大きくてもこの数行で済む。
 */
const RESUMED_MEMORY_NOTICE =
  '[system] このセッションは前のセッションを引き継いで（resume して）開いたものである。' +
  '**現在の記憶は、システムプロンプトの「現在の記憶」に載っているものである。** ' +
  'この下より前の会話に「記憶が更新された」として載っている塊は、それより古い可能性がある' +
  '（デーモンが落ちている間に人間が直していれば、正本のほうが新しい）。食い違ったら' +
  'システムプロンプト側を採ること。確かめたければ `memory_read` で読み直せる。';

export interface CloneOptions {
  stores: Stores;
  /** 主にテスト用。既定は SDK の `query`。 */
  queryFn?: typeof query;
  /**
   * クローンのセッションを置くディレクトリ。SDK はここを基準に
   * トランスクリプトを保存するので、**呼び出し元のカレントディレクトリに
   * 依存させてはいけない**（依存させると別の場所から起動した途端に resume が
   * 迷子になる）。デーモンは `~/.alteroid` を渡す。
   */
  cwd?: string;
  /**
   * 委譲先（manager-runner）の名簿。
   *
   * **クローンは SDK を直接起こさない。** マネージャーは別プロセス（既定では
   * 別コンテナ）の runner で走り、ここはその宛先を決める間接層だけを見る
   * （docs/architecture.md「プロセス境界」）。
   */
  runners?: RunnerRegistry;
  /**
   * SDK のセッション永続化先（M4）。クローンとマネージャーの生ログを同じ
   * PostgreSQL へ載せる。渡さなければローカルディスクのまま（M1〜M3 と同じ）。
   */
  sessionStore?: SessionStore;
  /** 主にテスト用。差し替えると委譲先ごと入れ替えられる。 */
  managers?: ManagerPool;
  /**
   * モデル帯の差し替え（`ALTEROID_CLONE_MODEL`）と権限モードの差し替え
   * （`ALTEROID_CLONE_PERMISSION_MODE`）を読む先。主にテスト用で、
   * 既定は `process.env`。
   */
  env?: NodeJS.ProcessEnv;
  /**
   * SDK 子プロセスへ重ねる鍵の現在値を返す関数（Issue #393 PR3）。
   *
   * **クローンにも認証トークンのプールの現在値を届けるための口である。** 渡さなければ
   * 今までどおり `env` とプロファイルだけになる（既定の構成の挙動を変えない）。
   *
   * **呼ばれるのは SDK セッションを起こす直前だけである** ⟹ **走っている
   * セッションには届かない。** 畳んで作り直す経路は PR4 で足す（Issue #393
   * 追記5「ターンの途中では畳まない」）。
   */
  credentials?: () => Record<string, string>;
  /**
   * いま撒かれているトークンの身元（Issue #393 PR3）。**セッションを起こす瞬間に
   * 1度だけ読み、そのセッションの観測すべてに添える。**
   *
   * これが無いと、回し手は「もう回した後の通知」を見分けられない
   * （`observationFreshness` が `unknown` へ落ちる）。
   */
  tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
  /**
   * 枠の観測を回し手へ渡す口（Issue #393 PR3）。
   *
   * **クローンは回すかどうかを判断しない。** 枠に当たった瞬間このループはターンを
   * 回さない（`#usageBlocked`）ので、**判断をここへ置くといちばん要るときに
   * いちばん動かない。** ここは観測を渡すだけで、判定も選択も撒きも回し手が持つ。
   *
   * **投げてもターンを壊さない**（呼ぶ側で握って報告する）。回せなかったことは
   * 枠に当たったこととは別の失敗であり、後者の報告を前者で置き換えない。
   */
  onUsageObservation?: (observation: TokenRotatorObservation) => Promise<void>;
  /**
   * 名乗ってきた runner へ、いま撒いてある認証トークンを降ろす口（Issue #393 PR3）。
   * **このクローンは使わない** — 作った `ManagerPool` へそのまま渡すだけである。
   */
  syncRunnerToken?: (runner: RunnerClient) => Promise<void>;
  /**
   * 権限モード。省略すると `env` の `ALTEROID_CLONE_PERMISSION_MODE`、
   * それも無ければ `auto`（`permission-mode.ts`）。主にテスト用の直渡しで、
   * runner の `RunnerHostOptions.permissionMode` と同じ形である。
   */
  permissionMode?: PermissionModeName;
  /**
   * 人間の合図を待ち行列の先頭側へ入れるか。省略すると `env` の
   * `ALTEROID_CLONE_HUMAN_PRIORITY`、それも無ければ**有効**
   * （`resolveCloneHumanPriority`）。主にテスト用の直渡しである。
   */
  humanPriority?: boolean;
  /**
   * 実行環境プロファイル（`.zprofile` 相当）。
   *
   * **クローンにも効かせる。** 人間の `.zshenv` は、その人が Claude Code に頼む
   * ときにも、自分で端末を叩くときにも同じように効く。クローンは人間の写像で
   * あって「道具を持たない存在」ではない（north_star「適用範囲」）ので、
   * 「マネージャーには効くがクローンには効かない」を作らない。
   */
  profile?: ProfileApplier;
  /**
   * 実行環境プロファイルを置いて配る1本道（`profile_read` / `profile_write` と
   * 再接続時の降ろし直しが通る）。
   *
   * **デーモンが作った同じインスタンスを渡すこと。** 人間の口とクローンの道具が
   * 別のインスタンスを持つと直列化の意味が消える（層ごとに違う本文が残る）。
   */
  profileService?: ProfileService;
  /**
   * アカウント全体の利用状況（claude.ai 側の値）を読む口。
   *
   * **人間が `claude.ai/settings/usage` で見られるものを、クローンにも渡す。**
   * 見られないのは能力の削除（north_star 禁止1）であり、しかもこれは飾りではなく
   * 判断の材料である（重い委譲を続けてよいかは、残りを見ずには決められない）。
   */
  accountUsage?: () => AccountUsageState;
  /**
   * `Scheduler.list()` の写し。`ToolContext.scheduler`（`tools.ts`）へそのまま
   * 渡す — `schedule_list` が「次: <nextAt>」を出す材料（Issue #237）。
   *
   * **省略できるのはテストのためだけである。** `Scheduler` はデーモン側（
   * `apps/daemon/src/index.ts`）が組み立てるので、ここで作り直さない。
   */
  scheduler?: () => ScheduleStatus[];
  /**
   * いま自分がどう走っているかの事実（記憶の器・作業ディレクトリ・委譲先・
   * 入口・モデル帯）。システムプロンプトの自己認識の節に載る。
   *
   * **省略できるのはテストのためだけである。** 本番の配線で落とすと、
   * クローンは自分がどこで走っているかを知らないまま判断することになる。
   * 組み立てるのはデーモン側 — 事実を知っているのはあちらだからで、
   * ここで環境変数を読み直すと出所が2つになる。
   */
  self?: SelfFacts;
  /**
   * 道具の MCP サーバを組み立てる関数。**主にテスト用。既定は `createCloneMcpServer`。**
   *
   * `createSdkMcpServer`（SDK）は道具を MCP の transport の裏へ隠すので、テストから
   * ハンドラを直接呼べない。ここを差し替えると、渡ってくる `context`（クローンが
   * 実際に組み立てたものと同一 — `runtime` 含む）を控えたうえで本物の
   * `createCloneMcpServer(context)` を呼べる。道具の実装もクローンが渡す
   * `context` も本物のまま、呼び出しの境界だけを覗ける
   * （`queryFn` と同じ「差し替え可能だが既定は本物」という形）。
   */
  mcpServerFactory?: typeof createCloneMcpServer;
}

type Listener = (event: ChatStreamEvent) => void;

interface Turn {
  /** 出力を届ける会話。null なら人間に見せない内部ターン（蒸留など）。 */
  conversationId: string | null;
  text: string;
  /** 逐次配信（stream_event）で本文を流したか。流していなければ完成品を流す。 */
  streamed: boolean;
  /**
   * SDK が「これは応答ではない」と印を付けたメッセージ（`assistant.error`）。
   *
   * **本文は `text` へ入れず、ここへ置く。** 直す前は `assistant` の text ブロックを
   * 無条件に `text` へ足していたので、支出上限の文言がそのまま「クローンの応答」に
   * なり、日報の本文にまでなった（`sdk-failure.ts` の doc）。
   */
  rejected: SdkFailure | null;
  /**
   * 失敗として畳んだ理由（`#reportFailure` が立てる）。
   *
   * **`#runTurn` の戻り値をこれで分岐させる。** 直す前の戻り値は `string` 一本で、
   * 失敗しても `text`（部分出力か空文字）を返していた ＝ 呼び出し側は成否を
   * 知る手段が無かった。
   */
  failure: string | null;
  resolve: () => void;
  /**
   * このターンが蒸留のターンか、通常のターンか。`#runTurn` の `kind` 引数を
   * そのまま載せる。
   *
   * **`#toolContext()` の `memoryCause` がこれを読む。** 道具（`memory_write` /
   * `memory_append` / `memory_delete`）が書く日誌の `cause` を、いま走っている
   * ターンの種類から導くためのもの — 呼び手（モデル）に申告させない
   * （書き忘れ・書き間違いがそのまま計器の値になるのを避ける）。
   */
  kind: 'normal' | 'distill';
}

/**
 * ターン1本の結果。**「文字列」ではなく「状態」で返す。**
 *
 * 直す前は `Promise<string>` で、失敗したターンでも本文（部分出力か空文字）が
 * 返っていた。呼び出し側（日報）は成否を判別できないので、**エラーの文言を
 * 応答として保存してしまう**。型で分けておけば、次に戻り値を使う者も同じ穴を
 * 踏めない。
 */
type TurnOutcome =
  | { status: 'answered'; text: string }
  | {
      status: 'failed';
      reason: string;
      /**
       * 枠（利用上限）で保持しているか。真なら**この合図は捨てられておらず、
       * 枠が開いたら配り直される**（`#pump` の `finally` が `defer` する）ので、
       * 呼び出し側は「もう書いた」という痕跡を残してはいけない。
       *
       * **同名の `Clone#heldForUsage`（`Set<string>`）とは別物である。**
       * あちらは「どの合図を保持したか」を id で覚えて断り書きを1回に絞る器で、
       * ここは「いま返しているこの1ターンが保持されたか」の真偽値。どちらも
       * 同じ事実（枠で保持した）を指すので名前は揃えてあるが、**取り違えると
       * 意味が反転する** — あちらは配り直しの後も id が残る（消すのは成功した
       * とき）ので、`has()` を真偽値として使うと「もう保持は解けているのに
       * 保持中」と読める。
       */
      heldForUsage: boolean;
    };

export function createClone(options: CloneOptions): CloneHost {
  return new Clone(options);
}

class Clone implements CloneHost {
  readonly #stores: Stores;
  readonly #queryFn: typeof query;
  readonly #cwd: string | undefined;
  readonly #sessionStore: SessionStore | undefined;
  readonly #managers: ManagerPool;
  /**
   * このクローンのモデル帯。本セッションと蒸留のサイドクエリで必ず同じものを
   * 使う（片方だけ帯が違うと、蒸留＝人格の書き手だけが別の頭になる）。
   */
  readonly #model: string;
  /** 自己認識の材料。デーモンが組み立てて渡す（テストでは省略される）。 */
  readonly #self: SelfFacts | undefined;
  /** `#model` が既定（`CLONE_MODEL`）から差し替えられているか（`self_status` の材料）。 */
  readonly #modelOverridden: boolean;
  /**
   * SDK へ渡す権限モード。**下の `#observedPermissionMode` とは別物である** —
   * こちらは「alteroid が何を頼んだか」、あちらは「SDK が init で何を報告したか」。
   * 片方だけを持つと、頼んだ値が通っていないことに気づけない。
   */
  readonly #permissionMode: PermissionModeName;
  /** 人間の合図を割り込ませるか（`CLONE_HUMAN_PRIORITY_ENV_KEY`）。 */
  readonly #humanPriority: boolean;
  /** 道具の MCP サーバを組み立てる関数。既定は本物、テストでは差し替えられる。 */
  readonly #mcpServerFactory: typeof createCloneMcpServer;

  // --- `self_status` の材料（SDK が実際に報告してきた値） ---------------------
  //
  // **本セッション（`#read`/`#dispatch` を通す方）だけが更新する。** 蒸留の
  // サイドクエリ（`#distillFromTranscript`）は別の SDK セッションで、その init は
  // ここへは反映しない（`CloneRuntimeFacts.sessionId` のコメントと同じ理由）。
  #sdkModel: string | null = null;
  #effort: string | null = null;
  #claudeCodeVersion: string | null = null;
  #apiKeySource: string | null = null;
  #observedPermissionMode: string | null = null;
  /**
   * **`null` は「init 未観測」、`[]` は「init を観測して、SDK が0本と報告した」——
   * 別の状態として持つ（#324）。** 隣の `#observedPermissionMode` 等と同じ形。
   * どちらも `[]` に畳むと、`self.ts` 側でこの2つを区別する手段が無くなる。
   */
  #mcpServersInfo: Array<{ name: string; status: string }> | null = null;
  /** init で報告された、いまの SDK セッション id。`#resumedFrom` とは別（あちらは resume 元）。 */
  #sdkSessionId: string | null = null;
  /**
   * 既に日誌へ残した拒否の `tool_use_id`。
   *
   * 生の合図と `result` の記録は同じ1件を2回運んでくるので、ここで畳む。
   * **器を作り直せば消える**（＝件数の集計には使えない。集計は日誌が持つ）。
   *
   * 無制限には覚えない（長く走る1本のセッションでメモリが伸び続ける）。
   * `runner.ts` の `#denied`（同じ役目 — 二重書き込み防止の id 帳面）と同じく
   * `createRecentMap` に揃える。**上限に達したら黙って忘れない** — 忘れた id が
   * `result.permission_denials` にもう一度載れば、同じ拒否がもう一度日誌へ載る
   * （`runner.ts` の `#denied` の `onForget` が明示している代償と同じ形）。
   */
  readonly #deniedToolUses = createRecentMap<true>({
    limit: DENIED_TOOL_USE_MEMORY_LIMIT,
    onForget: (ids) => {
      void this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'inbound',
        text:
          `二重書き込み防止のために覚えている拒否の記憶が上限` +
          `（${DENIED_TOOL_USE_MEMORY_LIMIT}件）に達したので、古い ${ids.length} 件を忘れた: ` +
          `${ids.join(', ')}。この tool_use_id の拒否が生の合図と result の両方から` +
          '再び届くと、同じ拒否がもう一度日誌に載る。',
      });
    },
  });
  /** `#buildOptions` で組み立てたシステムプロンプトの文字数。セッションの間は固定。 */
  #systemPromptChars = 0;
  /**
   * システムプロンプトへ焼き込んだ記憶の文字数。**セッションの間は固定。**
   *
   * `#memoryOnRecord` の合計で代用しないこと — あちらは走行中に人間が記憶を直せば
   * 動く。`CloneRuntimeFacts.injectedMemoryChars` が名乗っているのは「このセッション
   * を組み立てた時点」の値であり、動く数を渡せばその場で嘘になる。
   */
  #promptMemoryChars = 0;

  readonly #inbox = new Inbox();
  readonly #listeners = new Map<string, Set<Listener>>();
  /** 受信箱に積んだイベントの処理完了を待つための約束。 */
  readonly #completions = new Map<string, () => void>();

  /**
   * 枠（利用上限）が閉じていると分かっているときの理由。`null` なら閉じていない。
   *
   * **タイマーを持たない。** 「枠が開いたか」を無料で知る方法は無い
   * （`rate_limit_event` はターン中にしか届かない — `usage-snapshot.ts` の
   * `toAccountUsage` は `status` を書かない）。だから「試すしか無い」を選び、
   * 試行の契機は**新しい合図が届いたとき**に限る（受け取るのは `post`、実際に
   * 降ろすのは `#pump` の先頭。分けてある理由は `#releaseRequested` の doc）。人間の発言が
   * 最も価値の高い試行で、誰も話しかけなければ `self_initiative`（既定間隔ごと。
   * 値は `apps/daemon/src/schedule.ts` の `DEFAULT_INITIATIVE_EVERY_MINUTES`）が
   * 自然に試す。
   */
  #usageBlocked: UsageLimitNotice | null = null;
  /**
   * 枠が閉じていて処理できなかった合図。**FIFO を崩さない。**
   *
   * 積む・戻すのどちらも配列の端だけを使う（`push` で足し、`splice(0)` で
   * 全部を順序どおり取り出す）。ここに居る合図は `#forget` していない
   * （器＝`stores.inbox` にも未読のまま残っている）ので、途中でプロセスが
   * 死んでも `#restoreUnread` が拾い直す。この配列はそれとは別に、**同じ
   * 器の中身をメモリ上でも順序どおり並べておく**ためのものである。
   *
   * **中身を持たない合図（`isTick`）の畳み込みは、ここも見る**
   * （`#foldsIntoHeldTick`）。`post` の畳み込みは `Inbox#hasPending`＝待ち行列
   * しか見ないので、ここに移った分は向こうからは見えない。両方を見なければ、
   * 枠が閉じている間だけ畳み込みが効かなくなる。
   */
  readonly #deferred: InboxEvent[] = [];
  /**
   * 一度でも枠で保持した合図の id。**まとめ読み（`#mergedHumanBatch`）から外すため**
   * だけに持つ。
   *
   * 枠が閉じている間の再試行は「新しい合図1件につき高々1回」に絞ってある（解除の
   * doc は `#pump` 先頭の解除ブロック。`post` は印を立てるだけである）。保持して
   * いた発言を、解除の契機になった新しい発言と1ターンに束ねると、
   * **その1回が何件ぶんの仕事なのかが変わる** — 束ねた回が再び枠に当たれば、新しい
   * 発言も一緒に保持へ戻り、人間は自分の発言が受け取られたのかどうかを（保持の断り書き
   * すら受け取れずに）判断できなくなる。費用の設計に触るので、ここは分けたままにする。
   *
   * `#deferred` そのものではなく別に持つのは、`#deferred` が解除のたびに空になる
   * （＝受信箱へ戻した時点で「保持していた」ことが消える）ためである。
   */
  readonly #heldForUsage = new Set<string>();
  /**
   * 新しい合図が届いたので、枠（利用上限）の解除を試す、という印。
   *
   * **`post()` はこの印を立てるだけで、解除そのものはしない。** 解除は
   * `#pump` の先頭（合図1件の後始末が終わっている地点）でだけ行う
   * （`#pump` の解除ブロックの doc に、直す前に何が壊れていたかがある）。
   *
   * **印を立てる側と、それを見て動く側を1つにまとめないこと。** `post()` は
   * 外から**同期で**呼ばれる口で、`#pump` が `await` で開けた隙間にいつでも
   * 割り込む。割り込んだ側で状態遷移（`#usageBlocked` を降ろす・`#deferred`
   * を取り出す）まで済ませてしまうと、その隙間に居た合図が1件、必ず取り
   * 残される（`claimRun` / `completeRun` を1つに戻すな、と同じ形である）。
   */
  #releaseRequested = false;
  /**
   * 種類（`kind`）ごとに最後に日誌へ書いた上限の文言。
   *
   * **同じ知らせで日誌を埋めないためにある。** `reached` は一度立てば `#pump`
   * がターンを回さなくなるので `rate_limit_event` はもう来ないが、`transition`
   * / `warning` はまだ動く分類なのでターンが回り続け、`system` 通知が毎ターン
   * 届く（`usage-limits.ts` の `usageTransitionOf` の doc「毎ターン届く同じ
   * 事実で受信箱を埋めないこと」と同じ理由）。畳まなければ日誌が同じ文言で
   * 埋まり、本当に変わった1回が埋もれる。
   *
   * **`manager.ts` の `#usageNotices` を写して作った**（マネージャー側にあって
   * クローン側に無いのは非対称だった）。**ただし、あちらはもう同じ形ではない。**
   * あちらは「最後に見た文言」1つではなく「配った文言の集合」を覚える形へ変えて
   * ある — 同じ種類で文言が2通り交互に届くと `!==` が毎回「違う」と答え、配達の
   * たびに**クローンのターンが1本焼かれる**からである（`manager.ts` の
   * `#usageNotices` の doc）。**ここを揃えていないのは、畳んでいる先が違うため
   * である** — こちらが畳むのは日誌への書き込みだけで、交互の文言で起きるのは
   * 日誌の行が増えることだけ（ターンは焼かれない）。**揃えたくなったら、まず
   * 「こちらでも配達が焼かれているか」を確かめること。**
   *
   * 畳むのは**日誌への書き込みだけ**にする — `reached` の `#usageBlocked`
   * を立てる処理と `usage_limited` の emit はここでは畳まない
   * （`#noteUsageNotice` 参照）。2件目以降の合図は別の会話から来ているかも
   * しれず、`usage_limited` まで畳むとその送り主に何も見えなくなる。
   */
  readonly #usageNotices = new Map<string, string>();

  /**
   * 未読として器に置いた合図。id → その書き込みの約束。
   *
   * **消し込みがこの書き込みを追い越さないために持つ。** `post` は同期なので
   * 書き込みは非同期になり、短いターンなら「処理を終えた」が「書けた」より先に
   * 来る。順序を見ないと、消したはずの合図が後から書かれて永久に配り直される。
   *
   * ここに居ないものは器に置いていない合図である（`#postAndWait` の蒸留）。
   */
  readonly #unread = new Map<string, Promise<void>>();
  /**
   * 受理した瞬間に日誌へ書いた発言。id → その追記の約束。
   *
   * **応答がこの追記を追い越さないために持つ。** `post` は同期なので追記は
   * 非同期になる。日誌の順序は追記した順なので、待たずにターンを走らせると
   * 短いターンでは応答（`result` の `#journal`）が先に載り、**日誌の上で
   * クローンが問われる前に答えたことになる**。ここに置いて `#handle` が
   * 待てば、受理の瞬間に書き始めながら順序は保てる。
   *
   * ここに居ないものは受理の瞬間に書いていない合図である（人間の発言以外と、
   * 起動時に拾い直したもの＝前の器で既に書いてあるもの）。
   */
  readonly #recorded = new Map<string, Promise<void>>();
  /**
   * 受理の瞬間の追記を、受け取った順に1本ずつ器へ渡すための列。
   *
   * **「日誌の追記順がそのまま会話の順序」という不変条件を、器の側に賭けない。**
   * `GET /conversations` / `GET /conversations/:id` は追記順をそのまま使う（`at` で
   * 並べ直さないのは、同じミリ秒に並んだ発言の前後が時刻からは決められないから
   * である）。追記が `#pump` の中に在ったあいだ、その直列は受信箱のループが与えて
   * いた。受理の瞬間へ移した以上、**同じ会話へ短時間に2発言が届くと2本の追記が
   * 同時に飛ぶ** — `FsJournalStore` は自分で直列化しているが、`PgJournalStore` は
   * していない（コネクションプール越しなので、`seq` が呼び出し順と一致する保証が
   * 無い）。ここで列にすれば、器がどちらでも呼び出し順のまま入る。
   *
   * **`PgJournalStore` 側を直列化する形は採らない。** あちらを直列化すると
   * マネージャーの `tool_use`（量が多い）まで1本の列に並び、日誌の書き込みが
   * 全体の律速になる。守りたいのは会話の順序であって、日誌の全書き込みの順序では
   * ない。
   */
  #recordChain: Promise<void> = Promise.resolve();
  /** 起動時に拾い直した合図。id → 何度目の配達か。 */
  readonly #redelivered = new Map<string, PendingInboxEvent>();
  /**
   * 拾い直した合図のうち、クローンが既に `commitment_close` で片付け済みのもの。
   * id → 台帳の記録（`closedAt` が立っている）。
   *
   * **`#redelivered` と対で持つ。** あちらは「二度目だと分かる」ための印、
   * こちらは「本文を短くしてよい」ための印で、`#forget`（消し込み）で一緒に
   * 消す。ここに載っているかどうかは `#restoreUnread` が `stores.commitments`
   * を引いて決める — **決めるのはそこだけ**（`#handle` の側では引き直さない）。
   *
   * **載っていない合図は、これまでどおり全文で配る。** `commitments.get` が
   * 投げたときも載せない（安全側は「全文で配る」— 雑音であって喪失ではない側
   * へ倒す。`#restoreUnread` の catch を見よ）。
   */
  readonly #redeliveredClosed = new Map<string, Commitment>();
  /**
   * いま処理している合図が配り直しなら、その断り書き。ターンの本文の先頭に載る。
   *
   * **断り書きを起点ごとに配らない。** プロンプトの組み立ては起点の数だけ
   * （7か所）散っていて、そのうち1か所へ入れ忘れると「二度目だと分からない
   * 配達」がその起点にだけ生まれる。ターンの入口（`#runTurn`）は1か所しかない
   * ので、そこに置けば起点を問わず必ず載る。
   */
  #redeliveryNotice = '';
  /**
   * 自動で開いた未了。合図の id → その書き込みの約束。
   *
   * **`#unread` と同じ理由で持つ。** `open` は非同期なので、待たずにターンを走らせると
   * 短いターンでは `commitment_close` が open を追い越し、**クローンが閉じたつもりの
   * 未了が後から開いて残り続ける**。順序を見るためだけのもので、書けたかどうかは
   * ターンの条件にしない。
   */
  readonly #committed = new Map<string, Promise<void>>();
  /**
   * いま処理している合図の未了 id と、台帳の全体像。ターンの本文の先頭に載る。
   *
   * **`#redeliveryNotice` と同じ場所に置く理由も同じである。** プロンプトの組み立ては
   * 起点の数だけ散っていて、どれか1か所へ入れ忘れると「閉じ方の分からない未了」が
   * その起点にだけ生まれる。ターンの入口は1か所しかない。
   */
  #commitmentNotice = '';

  /** SDK へ流す入力の待ち行列。 */
  readonly #input: SDKUserMessage[] = [];
  #inputWaiter: (() => void) | null = null;
  /**
   * 認証トークンを回したので、**次のターンの境界で** SDK セッションを畳んで作り直す
   * （Issue #393 PR4）。
   *
   * **印だけを持つ。** 回すと決めた時点ではセッションに触らない —— 触ると、
   * そのとき走っていたターンを殺すか、失敗として報告するかのどちらかになる
   * （`#inputStream` の doc）。
   */
  #recycleForToken = false;

  #query: Query | null = null;
  #reader: Promise<void> | null = null;
  #turn: Turn | null = null;
  #stopped = false;
  /**
   * セッション内で「前回の蒸留以降に、蒸留すべき新しいことがあったか」の印。
   *
   * **`stop()` が無条件に蒸留を投げていたことの直しである。** `endConversation()`
   * の直後に器の入れ替えで `stop()` が来ると、`buildDistillPrompt` は
   * `conversation_end` と `shutdown` を同じ文面へ写すので（`#handle` の
   * `'distill'` 分岐）、**同一内容の蒸留がフルコストで2回走っていた。**
   *
   * - **立てる（`true`）のは `#runTurn` 自身。** ターンが1本走ったこと（受信箱の
   *   起点を問わない）が「新しいことがあった」の唯一の根拠であり、個々の起点
   *   ごとに立てる形にすると起点を1つ足すたびに立て忘れが起きる
   *   （`#redeliveryNotice` と同じ理由でここへ寄せた）。
   * - **蒸留そのもののターンでは立て直さない。** 立て直すと蒸留のたびに印が
   *   即座に戻り、`stop()` の判定は永久に「新しいことがある」のままになって
   *   この直しは何もしないのと同じになる（`#runTurn` の `kind` 引数で見分ける）。
   * - **下ろすのは蒸留が成功で終わった時点だけ**（`#runInternal` が返す
   *   `TurnOutcome.status === 'answered'` を `'distill'` 分岐で直接見る）。
   *   失敗した蒸留（枠で保持された場合を含む）で下ろすと、移せなかった記憶を
   *   「移した」ことにして記憶を落とす。迷ったら蒸留する側へ倒す
   *   （AGENTS.md「蒸留は生存条件」）。
   * - **初期値は `true`。** プロセスを起こした直後・新しいセッションを開いた
   *   直後は、前のプロセスが shutdown 蒸留を済ませたかをこの層からは知れない。
   *   知れないものを「済んだ」と仮定すると記憶を落とす側に倒れるので、
   *   知れないなら蒸留する側を既定にする。
   * - **回数の上限ではない**（AGENTS.md 地雷2）。「新しいことがあるたびに必ず
   *   蒸留する」側は締めていない — 締めているのは「同一内容を2回払わない」側
   *   だけである。
   *
   * **プロセス内だけで持つ。** ストアへ持ち越さない — 狙っているのは
   * `endConversation()` → `stop()` という同一プロセス内の並びであり、持ち越すと
   * 「済んだと思ったら済んでいなかった」の事故が記憶の喪失として出る経路が
   * 増える（`pre_compact` の蒸留はこの印を一切触らない。`#distillFromTranscript`
   * は `#runTurn` を経由しない別の短命セッションだからである）。
   *
   * **成否の判定に専用フィールドを持たない。** 初版（PR #119）はここに
   * `#lastTurnSucceeded` という専用フィールドを持ち、`#dispatch` の成功枝
   * （`this.#usageBlocked = null` の直後）へ直接立てていた —
   * 当時の `#runTurn` の戻り値が `Promise<string>` 一本で、失敗しても本文を
   * 返していたため、成否を運ぶ手段がそこにしか無かったからである。main は
   * その後 #124（`fix: SDK のエラーを応答として扱うのをやめる`）で `#runTurn` /
   * `#runInternal` の戻り値を `TurnOutcome`（`'answered' | 'failed'`）へ変えて
   * おり、`#dailyReport` は既にその戻り値を直接見て成否を判定している
   * （同ファイル該当箇所）。**同じ形をここでも使う** — 呼び出し元
   * （`#handle` の `'distill'` 分岐）が `#runInternal` の戻り値を直接見れば
   * 専用フィールドは不要で、`#dispatch`（#124・#125 が書き換えた領域）を
   * 一切触らずに済む。
   */
  #hasUndistilledActivity = true;
  /**
   * いまの SDK セッションでクローンが最後に見た記憶。slug → 本文。
   *
   * **全文の1文字列ではなく文書ごとに持つ。** 全文で持って全文と比べていた頃は、
   * 人間が1つの文書の1行を直しただけで**記憶の全文をもう一度クローンの文脈へ
   * 載せていた** — システムプロンプトに焼き込んだ分と合わせて二重に載り、しかも
   * 直すたびに写しが増えた（会話の履歴に残るので、resume でも運ばれる）。
   * 文書ごとに持てば、載せ直すのは実際に変わった文書だけで済む。
   */
  readonly #memoryOnRecord = new Map<string, string>();
  /**
   * resume で起こしたセッションかどうか（最初のターンで1度だけ断るために持つ）。
   *
   * **履歴には前のセッションで載せ直した記憶の写しが残っている。** それは
   * 「以降はこれが現在の記憶である」と名乗る形で、しかもシステムプロンプトより
   * **後ろ**に並ぶ。デーモンが落ちている間に人間が記憶を直していた場合、正本
   * （システムプロンプト）のほうが新しいのに、古い写しが最後の言葉として残る。
   * 全文を載せ直して上書きするのではなく、**どちらが正本かを1文で断る**
   * （載せ直せば、いま塞いでいる二重載せを自分でやることになる）。
   */
  #resumedHistoryHasMemory = false;
  /** resume を試みた session id。init が来る前に落ちたら捨てる。 */
  #resumedFrom: string | null = null;
  #sawInit = false;
  readonly #env: NodeJS.ProcessEnv;
  /**
   * SDK 子プロセスへ重ねる鍵の**現在値を返す関数**（Issue #393 PR3）。
   *
   * **値そのものではなく関数を持つ。** 値を持つと構築時に凍り、回し手が差し替えた
   * トークンが永久に届かない——`#env` がすでにそうなっている問題を、もう1つ作ることに
   * なる。
   */
  readonly #credentials: (() => Record<string, string>) | undefined;
  readonly #tokenIdentity: (() => { tokenId: string; generation: number } | undefined) | undefined;
  readonly #onUsageObservation:
    ((observation: TokenRotatorObservation) => Promise<void>) | undefined;
  /**
   * **このセッションが起きたときの**トークンの身元（Issue #393 PR3）。
   *
   * `#childEnv()` で1度だけ捕まえる——**観測のたびに読み直さない。** 読み直すと、
   * 回した後に届いた「前のセッションの観測」が新しい身元を名乗り、**世代の照合が
   * そのまま素通しになる**（`observationFreshness` が `current` を返す）。
   */
  #sessionTokenIdentity: { tokenId: string; generation: number } | undefined;
  /**
   * 枠の事実を枠の種類ごとに覚える（`ManagerPool#onEvent` と同じ形）。
   *
   * **`rate_limit_event` はターンの頭ごとに来る。** 状態をそのまま回し手へ流すと
   * 「同じ `rejected` で毎ターン回そうとする」になるので、`usageTransitionOf` が
   * 遷移と認めた1回だけを渡す。
   */
  readonly #rateLimits = new Map<string, RateLimitFacts>();
  readonly #profile: ProfileApplier | undefined;
  readonly #profileService: ProfileService | undefined;
  readonly #accountUsage: (() => AccountUsageState) | undefined;
  readonly #scheduler: (() => ScheduleStatus[]) | undefined;

  constructor(options: CloneOptions) {
    const {
      stores,
      queryFn,
      cwd,
      runners,
      sessionStore,
      managers,
      env,
      credentials,
      tokenIdentity,
      onUsageObservation,
      syncRunnerToken,
      permissionMode,
      humanPriority,
      profile,
      profileService,
      accountUsage,
      scheduler,
      self,
      mcpServerFactory,
    } = options;
    this.#stores = stores;
    this.#queryFn = queryFn ?? query;
    this.#cwd = cwd;
    this.#sessionStore = sessionStore;
    const envSource = env ?? process.env;
    this.#model = resolveCloneModel(envSource);
    this.#modelOverridden = placedCloneModel(envSource) !== null;
    this.#permissionMode = permissionMode ?? resolveClonePermissionMode(envSource);
    this.#humanPriority = humanPriority ?? resolveCloneHumanPriority(envSource);
    this.#env = envSource;
    this.#credentials = credentials;
    this.#tokenIdentity = tokenIdentity;
    this.#onUsageObservation = onUsageObservation;
    this.#profile = profile;
    this.#profileService = profileService;
    this.#accountUsage = accountUsage;
    this.#scheduler = scheduler;
    this.#self = self;
    this.#mcpServerFactory = mcpServerFactory ?? createCloneMcpServer;
    this.#managers =
      managers ??
      createManagerPool({
        stores,
        ...(profileService === undefined ? {} : { profile: profileService }),
        // マネージャーからの報告・質問も、人間の発言と同じ受信箱を通る。
        post: (event) => this.post(event),
        runners: runners ?? createRunnerRegistry([]),
        // 枠の観測は**マネージャー経由でも**回し手へ合流させる（Issue #393 PR3）。
        // **クローンの側とプールの側で別々の回し手へ渡さないこと** — 同じ1本へ
        // 集めるからこそ、世代の照合が「同じ当たりで1回だけ」を保証できる。
        ...(tokenIdentity === undefined ? {} : { tokenIdentity }),
        ...(onUsageObservation === undefined ? {} : { onUsageObservation }),
        ...(syncRunnerToken === undefined ? {} : { syncRunnerToken }),
      });
    // **落ち方は変えない。「どこで」だけを足す（#438 案D）。**
    //
    // ここは daemon の生涯に1本だけ走る中枢ループで、投げれば `for await` ごと
    // 抜けて受信箱のループが死ぬ（`#pump` の中のコメント）。**握り潰さない** ——
    // 生き残ると HTTP は答え続け、受信箱は積まれ続けたまま誰も気づかない。
    // 器が「壊れた」と判定できる材料はプロセスの終了しか無い（`uncaught-net.ts`）。
    // いまは落ちて再起動し、`#restoreUnread` が未読を本文ごと配り直して戻る。
    void this.#pump().catch((error: unknown) => {
      noteBackgroundFailure('クローンの受信箱のループ', '', error);
      throw error;
    });
  }

  /**
   * 認証トークンを回したので、**次のターンの境界で**セッションを畳んで作り直す
   * （Issue #393 PR4）。
   *
   * ## なぜ要るか
   *
   * SDK 子プロセスの env は**起動時に凍る**ので、回した鍵は走っているセッションに
   * 届かない（`credentials.ts` / `profile.ts` の doc が同じ境界を何度も書いている）。
   * ⟹ **畳んで作り直すまで、クローンは古いトークンのまま**である。
   *
   * 枠に当たったクローンは `#usageBlocked` が立ってターンを回さないが、再挑戦の
   * 経路は在る（`grep -Fn -- '枠の解除を試す' packages/core/src/clone.ts`）。**作り直さ
   * ないと、その再挑戦が古いトークンで走って同じところで止まる。**
   *
   * ## 会話は切れない
   *
   * 次の `#ensureQuery()` が `getCloneSessionId()` の `resume` で作り直すので、
   * **セッション id は引き継がれる。** 畳むのは SDK の子プロセスであって、
   * 会話でも記憶でもない。
   *
   * ## ここではセッションに触らない
   *
   * 立てるのは印だけである。**いま走っているターンは最後まで走って結果を返す**
   * （受け入れ基準。理由は `#inputStream` の doc）。
   *
   * **セッションがまだ無ければ何もしない。** 印を立てると、次に作られる
   * セッション（＝もう新しい鍵で起きたもの）がいきなり畳まれる。
   */
  recycleSessionForToken(): void {
    if (this.#query === null) return;
    this.#recycleForToken = true;
    // 入力待ちで止まっているなら、そこから抜けさせる（ターンの境界に居る場合）。
    this.#wakeInput();
  }

  /** デーモンの HTTP 層から一覧・生ログへ降りるための口。 */
  get managers(): ManagerPool {
    return this.#managers;
  }

  // -------------------------------------------------------------------------
  // CloneHost
  // -------------------------------------------------------------------------

  post(event: InboxEvent): void {
    // 片付け中に届いたものは、**このプロセスでは**処理できない（`stop()` の直後に
    // `storage.close()` → `process.exit(0)` が来る）。だが**次の起動でなら処理できる。**
    //
    // かつてここは何もせず捨てていて、その根拠は「処理しようとすると『未読の永続化』
    // という別の設計になる」だった。**その設計はいま在る**（`#remember` と
    // `#restoreUnread`）。根拠が消えた以上、捨てる側に留まる理由も無い — 器へ残せば
    // 次の起動で配り直される。片付けの窓に人間の最後の一言が落ちるのは、いちばん
    // 気づかれない失われ方である。
    //
    // **受信箱へは積まない。** ここから新しいターンを回す余地は無く、積めば
    // `Inbox#push` が閉じた受信箱に対して投げる。
    //
    // **「残した」と言い切らない。** この窓の後半ではストアが既に閉じており、
    // 書き込みは落ちうる（落ちれば `#remember` / `#commit` が stderr へ跡を残す）。
    // 跡の文言はそのことを含む — ここで「次の起動へ回した」と断言すると、
    // 書けなかった回だけ跡が静かに嘘をつく。
    if (this.#stopped) {
      this.#remember(event);
      this.#commit(event);
      noteDroppedInboxEvent(event);
      return;
    }

    // **枠（利用上限）が閉じているなら、新しい合図1件につき試すのは1回だけにする。**
    //
    // タイマーを持たない以上（`#usageBlocked` の doc）、「試す」の契機は新しい合図の
    // 到着そのものである。保持していた合図は FIFO の順のまま受信箱へ戻り、先頭
    // （＝最初に保持したもの）だけが `#pump` で実際に投げ直される。戻した先頭が
    // また枠で落ちれば `#usageBlocked` は再び立ち、残り（この event を含む）は
    // `#pump` の枠チェックで積み直される（`#pump` のコメント）。**この「1合図につき
    // 1試行」が費用の設計そのものである** — 保持している間、新しい合図がいくつ届いても
    // 実際にモデルへ渡るのは常に高々1回に絞られる。
    //
    // **`isTick` の畳み込み（次の行）より前に置く。** 畳み込みで捨てられる tick
    // （＝既に同じ tick が受信箱に居る）でも、ここまでは通した後で return する。
    // その tick 自体が積まれなくても、**「新しい合図が届いた」という事実そのもの**は
    // 本物であり（既定間隔ごとの `self_initiative` が実際にもう一度発火した、など）、
    // 時間が経ったことの合図として試す価値がある。しかも解除そのものはモデルを
    // 一度も呼ばない（保持分を受信箱へ戻すだけ）ので、畳まれる tick で解除しても
    // 実行回数の制限（AGENTS.md 地雷2）にはならない — 実際に金を払うかどうかは
    // 依然として「新しい合図1件につき高々1回」に保たれる。
    //
    // **ここでは印を立てるだけである（`#releaseRequested` の doc）。** 実際に
    // `#usageBlocked` を降ろして保持分を配り直すのは `#pump` の先頭で、理由は
    // そこの doc にある — 要は、この `post()` は `#pump` が合図1件の後始末を
    // 走らせている最中にも割り込むので、**ここで状態を動かすと、その隙間に
    // 居た合図が必ず1件取り残される**（実測の壊れ方2つはあちらに書いた）。
    if (this.#usageBlocked !== null) this.#releaseRequested = true;

    // 同じ合図がまだ読まれないまま積み重なっても、読んだときに見る材料は同じなので
    // 畳む。**これは実行回数の制限ではない**（AGENTS.md 地雷2）— 発火を減らすのでも
    // 遅らせるのでもなく、「まだ読んでいない同じ合図」を二度読まないだけである。
    // 人間の発言・マネージャーからの一件・外部イベントは中身が違うので絶対に畳まない。
    //
    // **「畳む」と「まとめて読む」を混同しないこと。** ここで畳んだ tick は捨てられて
    // 器からも消える。処理待ちのあいだに積み上がった人間の発言を1ターンで読む機構
    // （`#mergedHumanBatch`）は**捨てない** — 全文が届いた順に渡り、合図は件数ぶん
    // 器に残り、後始末も件数ぶん通る。だからそちらはこの `return` の側に足さないこと。
    if (isTick(event) && this.#inbox.hasPending((queued) => isSameTick(queued, event))) return;

    // **受理した時点で未読として書き出す。** 境界を「queue に入った時点」に置いては
    // いけない — クローンが暇なときに届いた合図は `Inbox#push` の waiter 経路を
    // 通って queue を素通りするので、queue を吐き出す形の永続化はその経路を1件も
    // 救わない。ここに置けば、どちらの経路でも必ず1度は通る。
    this.#remember(event);
    // 受理した瞬間に日誌へ載せて合図を出す。**器へ書くのと同じ場所である**
    // （`#remember` の隣）。
    this.#record(event);
    // 頼まれたことを未了として開くのも同じ場所である。**ターンの中に置かないこと** —
    // ターンが例外で落ちた合図は `#forget` されて二度と来ないので（`#pump` の
    // `finally`）、ターンの中で開く形にすると、いちばん落としてはいけない
    // 「処理に失敗した依頼」だけが台帳に載らない。
    this.#commit(event);
    // **人間が待っている合図は、待ち行列の人間の最後尾へ入れる**（`Inbox#push` の
    // `insertAfterLast`）。人間どうしは追い越さず、人間以外は飛び越す。
    //
    // **効く範囲を取り違えないこと。** `Inbox#push` は待ち手が居ればそのまま渡す
    // ので、**クローンが暇なときこの分岐は何もしない**（待ち行列が空なので割り込む
    // 相手が居ない）。効くのは「ターンが走っていて後ろに積まれている」ときだけで、
    // それがまさに人間が待たされる場面である。
    //
    // **走行中のターンは止めない。** 止めれば掛かった分が捨てられる。できるのは
    // 「次に読むものを人間にする」までで、人間の待ちは「いま回っているターンの
    // 残り」に縮む（それ以上は縮まない）。
    this.#inbox.push(
      event,
      this.#humanPriority && isHumanOriginated(event) ? isHumanOriginated : undefined,
    );
  }

  subscribe(conversationId: string, listener: Listener): () => void {
    const set = this.#listeners.get(conversationId) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (this.#listeners.get(conversationId) === set && set.size === 0) {
        this.#listeners.delete(conversationId);
      }
    };
  }

  async endConversation(conversationId: string): Promise<void> {
    // 会話終了は蒸留の契機。受信箱を通すので、走行中のターンを踏み潰さない。
    await this.#postAndWait({
      type: 'distill',
      id: randomUUID(),
      at: new Date().toISOString(),
      reason: 'conversation_end',
    });
    const set = this.#listeners.get(conversationId);
    if (set && set.size === 0) this.#listeners.delete(conversationId);
  }

  async answerApproval(approvalId: string, answer: string): Promise<void> {
    const approval = await this.#stores.jobs.getApproval(approvalId);
    if (!approval) throw new Error(`承認待ち ${approvalId} は存在しない`);

    const answeredAt = new Date().toISOString();
    await this.#stores.jobs.putApproval({ ...approval, answeredAt, answer });

    // 日誌だけを追っても回答済みだと分かるようにする（追記専用なので新しい行）
    await this.#journal({
      type: 'escalation',
      question: approval.question,
      approvalId,
      answeredAt,
      answer,
    });

    // 回答は受信箱へ。止まっていたその仕事だけが再開する。
    this.post({
      type: 'human_answer',
      id: randomUUID(),
      at: answeredAt,
      approvalId,
      answer,
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;

    // 落ちる前にもう一度だけ記憶へ移す機会を作る（蒸留は生存条件）。
    // 既にセッションが無いなら何も起きない。**ここでは無条件に投げる** —
    // 「前回の蒸留以降に新しいことがあったか」の判定は `#handle` の `'distill'`
    // 分岐に1本化してある（ターンの起動口を受信箱の1か所に保つ設計と同じ理由。
    // `#hasUndistilledActivity` の doc）。ここで先に判定すると、判定が2か所に
    // 散り、`endConversation()` 側だけ判定を足し忘れるような穴が生まれる。
    if (this.#query) {
      await this.#postAndWait({
        type: 'distill',
        id: randomUUID(),
        at: new Date().toISOString(),
        reason: 'shutdown',
      }).catch(() => undefined);
    }

    this.#stopped = true;
    this.#inbox.close();
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    await this.#reader?.catch(() => undefined);
    // 走行中のマネージャーも畳む。返事待ちで宙吊りのまま消えない。
    await this.#managers.stop().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // 受信箱のループ（ターンの起動口はここだけ）
  // -------------------------------------------------------------------------

  #postAndWait(event: InboxEvent): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#completions.set(event.id, resolve);
      this.#inbox.push(event);
    });
  }

  async #pump(): Promise<void> {
    // 前の器が終えられなかったものを戻す。**始めるだけで、待たない。**
    //
    // 待つと2つ壊れる。1つは可用性で、器（PostgreSQL）が詰まっているときに
    // `claimPending` が返らないと、**受信箱のループそのものが始まらない** —
    // 人間の発言すら処理できないクローンになる。未読を拾い直せないことと、
    // 何も受け取れないことは釣り合わない。もう1つは取り出しの間合いで、ここで
    // 待つと `for await` の最初の `next()`（＝待ち受けの登録）が1周遅れ、起動
    // 直後に積まれた合図の畳み込み方が変わる（`isTick` の畳み込みは「処理中の
    // 1件＋待ち行列の1件」を残す形で効いている）。
    //
    // 拾い直したものは、戻り次第この同じループへ入る。**待たない以上、失敗は
    // 自分で受けること** — ここで漏らすと unhandled rejection になり、未読を
    // 拾い直せなかっただけでデーモンごと落ちる（走行中のマネージャーも巻き添え）。
    void this.#restoreUnread().catch((error: unknown) => {
      noteDroppedRecord('未読の読み直し', '', error);
    });

    for await (const event of this.#inbox) {
      // **枠（利用上限）の解除はここでだけ行う。`post()` からは行わない。**
      //
      // ここは「直前の合図の後始末（`#settleInboxEvent`）が完全に終わっている」
      // と言える唯一の地点である。`post()` は外から同期で呼ばれるので、後始末が
      // 途中の隙間にも割り込む — かつてそこで解除していて、**同じ隙間で2つの
      // 壊れ方が起きた**（どちらも `clone.test.ts` の「終端を出した直後…」／
      // 「短絡した合図の後始末の直前に…」が名指しで踏んでいる）。
      //
      // 1. **保持したはずの合図が器から消える。** 下の `finally` は
      //    `this.#usageBlocked !== null` を読んで `defer` を決める。`post()` が
      //    先に降ろしてしまうと `defer: false` になり、枠で失敗しただけの合図が
      //    `#forget` される ＝ 未読でもなくなるので**再起動でも戻らない。**
      // 2. **保持した合図が in-memory で迷子になる。** `post()` が
      //    `#deferred.splice(0)` を読む時点で、いま後始末中の合図はまだ
      //    `#deferred` へ積まれていない。積まれた後には誰も取り出さないので、
      //    その合図は器には未読のまま残るのに**このプロセスでは二度と処理
      //    されない**（次に枠が閉じて解除されるまで）。
      //
      // 印（`#releaseRequested`）を見て**ここで**降ろせば、どちらも起きない。
      // 印を立てた `post()` の呼びは、必ずこの後で `#inbox.push` するか、
      // さもなくば「同じ tick が待ち行列に居る」ため畳んで return する
      // （`post()` の `isTick` の畳み込み）。**どちらの道でも待ち行列は空でない**
      // ので、`for await` はここへ必ず到達する（印だけ立って誰も見ない、が
      // 起きない理由）。
      //
      // **片付け中は解除しない（`#inbox.closed` を見る）。** `stop()` は
      // `#stopped` を立てて `#inbox.close()` を呼ぶが、`for await` は待ち行列に
      // 残った分を吐き出しながら回り続けるので、**閉じた後にこの地点へ来る**
      // ことがありうる。`Inbox#unshift` は閉じた受信箱では投げ、しかもここは
      // 下の `try` の外なので、投げれば `for await` ごと抜けて受信箱のループが
      // 死ぬ（`#pump` は `void` で起こしてあるので unhandled rejection になる）。
      // 解除しないほうの被害は無い — 保持した分は器に未読のまま残っており
      // （`#settleInboxEvent` が `#forget` を呼んでいない）、次の起動で
      // `#restoreUnread` が拾い直す。**この機構が生死をまたげる理由がそれである。**
      if (this.#releaseRequested && !this.#inbox.closed) {
        this.#releaseRequested = false;
        if (this.#usageBlocked !== null) {
          this.#usageBlocked = null;
          const held = this.#deferred.splice(0);
          // **いま取り出した `event` は `held` より後に届いている。** だから
          // `held` → `event` の順で受信箱の**先頭へ**戻し、次の反復で先頭から
          // 取り直す（`event` を末尾へ push すると到着順が崩れる）。
          //
          // 器（`stores.inbox`）には `held` が既に未読として残っている
          // （`#settleInboxEvent` が `#forget` を呼ばずに保持した）ので、
          // `#remember` / `#record` / `#commit` はやり直さない。やり直すと
          // 同じ合図の記帳・日誌追記が二重になる（`#restoreUnread` が起動直後
          // にだけこれをやり直す理由とは違う — あちらは「書き込みが器へ届く前に
          // 落ちた可能性」を消せないための再実行だが、ここはメモリ上の配列を
          // 並べ直すだけで、その可能性が無い）。
          //
          // `held` が空でも同じ形で通す。**「空なら戻さない」を足さないこと** —
          // 分岐が1本増えるだけで、通る条件（枠が閉じているのに保持が0件）は
          // 構造上ほぼ起きないのでテストの当たらない道になる。空なら次の反復で
          // 同じ `event` が枠の閉じていない状態で取り出されるだけである。
          this.#inbox.unshift([...held, event]);
          await this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text: `枠の解除を試す。新しい合図が届いたので、保持していた ${held.length} 件を配り直す。`,
          });
          continue;
        }
      }

      // **枠（利用上限）が閉じている間はターンを回さない（＝金を払わない）。**
      // `#usageBlocked` はここに来た時点で既に立っている場合と、今回の `#handle`
      // の中で新しく立つ場合の2通りがある。前者はここで `#handle` を呼ばずに
      // 短絡し、後者は下の通常経路の `finally` で拾う（`#usageBlocked` が非 null
      // かどうかだけを見るので、どちらの経路でも同じ扱いになる）。
      if (this.#usageBlocked !== null) {
        const notice = this.#usageBlocked;
        // `error` は終端なので、枠が閉じていること自体（消えない情報）を
        // **必ず先に**届ける。
        this.#emit(this.#conversationOf(event), {
          type: 'usage_limited',
          message: describeUsageNotice(notice),
        });
        // 送り主を待たせない。「失敗した」だけにはしない — 何が起きていて、
        // 合図がどうなるかまで分かる文言にする（PR #89 の経路をそのまま使う）。
        await this.#reportFailure(
          this.#conversationOf(event),
          '枠が閉じているので、いまは投げていない。合図は保持してある。次に別の合図が' +
            `届いたとき、保持した分から順に試し直す（${describeUsageNotice(notice)}）`,
        );
        await this.#settleInboxEvent(event, true);
        continue;
      }

      // 処理待ちのあいだに積み上がった**続きの発言**を、ここで一緒に取り出す
      // （`#mergedHumanBatch`）。`null` なら今までどおりこの1件だけを読む。
      //
      // **ここで言う「積み上がった続きの発言」は、かつては到着順で連続して
      // いたものだけを指していた。** いまは人間優先（`CLONE_HUMAN_PRIORITY_ENV_KEY`）
      // により、人間が待っている発言は待ち行列の人間の最後尾へ入り直すので、
      // 到着順では間に人間以外が挟まっていた発言どうしが、並べ替えられた結果
      // として連続することもある（`#mergedHumanBatch` 本体の doc「並びは到着順
      // とは限らない」）。書かないと、この一文が黙って偽になる。
      const merged = this.#mergedHumanBatch(event);
      const batch: InboxEvent[] = merged ?? [event];

      this.#redeliveryNotice = this.#redeliveryNoticeFor(event);
      // **ここは `try` の外である。** 投げれば `for await` ごと抜けて受信箱の
      // ループが死に、クローンは何も受け取れなくなる（`#handle` の失敗とは被害の
      // 桁が違う）。中では読み取りの失敗を自分で握っているが、握り漏らしが1つでも
      // 残ると全部が止まるので、外側にも受けを置く。**断り書きが付かないことより、
      // ループが止まることの方がずっと高い。**
      this.#commitmentNotice = await this.#commitmentNoticeFor(batch).catch((error: unknown) => {
        noteDroppedRecord('未了の断り書きの組み立て', inboxEventShape(event), error);
        return '';
      });
      try {
        if (merged === null) await this.#handle(event);
        else await this.#runHumanTurn(merged);
      } catch (error) {
        await this.#reportFailure(this.#conversationOf(event), String(error));
        this.#finishTurn();
      } finally {
        this.#redeliveryNotice = '';
        this.#commitmentNotice = '';
        // **枠のせいで処理できなかったかは、ここで初めて分かることがある。**
        // `#handle` の中（`#dispatch` の `result` / `rate_limit_event` /
        // `system` 通知）で今回の合図が枠に当たったと判明したなら、この時点で
        // `#usageBlocked` が非 null になっている。その場合は `#settleInboxEvent`
        // に `defer: true` を渡し、`#forget` ではなく `#deferred` へ積む側を選ぶ。
        //
        // **まとめて読んだ分は1件も飛ばさずここを通す。** 通し忘れた合図は器
        // （`stores.inbox`）に未読のまま残り、**起動のたびに永久に配り直される**
        // （`#forget` の doc）。判定（`#usageBlocked`）は先に1度だけ取る —
        // 後始末の途中で変わる値ではないが、件ごとに読み直す形にすると
        // 「同じ1ターンの分が、半分は消えて半分は保持される」を作れる形が残る。
        const defer = this.#usageBlocked !== null;
        for (const held of batch) await this.#settleInboxEvent(held, defer);
      }
    }
    // 閉じた後に待っている人を取り残さない
    for (const done of this.#completions.values()) done();
    this.#completions.clear();
  }

  /**
   * 取り出した合図と一緒に1ターンで読む発言を決める。まとめないなら `null`。
   *
   * **人間は返事を待っているあいだも喋る。** 先客（走行中のターン・蒸留・
   * マネージャーとの往復）が居るあいだに積み上がった発言を1件ずつ別のターンで
   * 読むと、クローンは「あとで言い直された最初の一言」に本気で答え、次のターンで
   * その仕事をやり直す。人間が Claude Code に立て続けに3行打ったときに起きるのは
   * それではない — **溜まった分をまとめて読んでから答えるのが等価な振る舞い**である。
   *
   * **これは畳み込み（`post` の `isTick`）ではない。** あちらは「読む前の同じ合図を
   * 二度読まない」＝**捨てる**。こちらは1文字も捨てず、全文を届いた順に1つの本文へ
   * 並べる（`humanTurnText`）。合図そのものも捨てないので、器の未読・台帳・日誌は
   * 件数ぶん残り、後始末（`#settleInboxEvent`）も件数ぶん通る。
   *
   * 3つは**まとめない**。
   *
   * - **人間の発言以外。** タイマー・外部イベント・マネージャーからの一件・蒸留・
   *   承認の回答は、それぞれ起点ごとのプロンプトを持つ別の仕事である
   * - **会話が違う発言。** 応答の宛先（`#emit` は会話単位）が1つに決まらない。
   *   別のタブ・別の端末で話している相手の画面に、こちらの応答が流れる
   * - **配り直しの合図**（`#redelivered`）。「これは配り直しである（N 回目）」は
   *   合図1件ごとの断り書きで、初回配達のものと混ぜると何が二度目なのか言えなくなる
   * - **枠で保持した合図**（`#heldForUsage`）。再試行は「新しい合図1件につき高々1回」
   *   に絞ってあり、束ねるとその1回が何件ぶんの仕事なのかが変わる
   */
  #mergedHumanBatch(event: InboxEvent): HumanMessage[] | null {
    if (event.type !== 'human_message') return null;
    if (!this.#mergeable(event)) return null;

    // **先頭から連続している分だけ**である（`Inbox#drainWhile`）。間に別の起点が
    // 挟まっていたらそこで止まる — 飛び越えて集めると、**並んでいる順に読む**という
    // 約束が崩れる。
    //
    // **並びは到着順とは限らない。** 人間が待っている合図は `post` の時点で人間の
    // 最後尾へ入る（`CLONE_HUMAN_PRIORITY_ENV_KEY`）ので、人間以外より前に並ぶ。
    // **ここはむしろ素直に効く** — 人間の発言が先頭側へ固まるぶん、連続して
    // 取れる範囲が広がる（人間どうしの到着順は保たれているので、まとめた本文の
    // 並びも到着順のままである）。
    const rest = this.#inbox.drainWhile(
      (queued) =>
        queued.type === 'human_message' &&
        queued.conversationId === event.conversationId &&
        this.#mergeable(queued),
    );
    // **1件だけなら `null` を返す**（`#handle` の通常経路をそのまま通す）。まとめる
    // 側へ寄せると、いちばん多い「1件だけ」の本文に断り書きが載る形が作れてしまう。
    if (rest.length === 0) return null;
    return [event, ...rest.filter(isHumanMessage)];
  }

  /**
   * その合図を他の発言と1ターンにまとめてよいか。
   *
   * **一度でも「1件として扱う」と決めた合図は、まとめる側へ戻さない。** 配り直し
   * （`#redelivered`）も枠での保持（`#heldForUsage`）も、合図1件ごとの断り書きと
   * 1件ごとの試行回数に意味があり、束ねるとその意味が言えなくなる。
   */
  #mergeable(event: InboxEvent): boolean {
    return !this.#redelivered.has(event.id) && !this.#heldForUsage.has(event.id);
  }

  /**
   * 人間の発言を1ターンとして通す。**1件でも複数件でも同じ道を通す。**
   *
   * 分けて書くと、片方にだけ `#recorded` の待ちが入る・片方だけ会話 id の取り方が
   * 違う、といった食い違いが静かに入る（どちらも人間からは見えない形で壊れる）。
   *
   * @param closedNotice 片付け済みの配り直しの断り書き。付いていれば、組み立てた
   *   本文（`humanTurnText`）の代わりにこちらを使う。**日誌への追記は変えない** —
   *   `#recorded` の待ちはこの下でも通常どおり行う。`#mergeable` が配り直した
   *   合図をまとめ読みから外しているので、これが付くのは常に `events.length === 1`
   *   である。
   */
  async #runHumanTurn(events: HumanMessage[], closedNotice: string | null = null): Promise<void> {
    // **ここでは書かない。** 発言は受理した瞬間に `#record` が書いている。
    // 両方で書くと同じ発言が日誌に二度載る（会話の再構成が二重になる）。
    //
    // 待つのは順序のためだけである（`#recorded` の理由）。**まとめた分は全部待つ** —
    // 1件でも飛ばすと、その発言だけが日誌で自分への応答より後ろに回りうる。
    // **書けたかどうかを条件にしない** — `#journal` は失敗を自分で握って stderr へ
    // 落とすので、ここへ来る約束は必ず解決する。書けなかったからターンを止める、には
    // しない（記録できないことより、応答が返らないことの方が高くつく）。
    for (const event of events) await this.#recorded.get(event.id);

    const head = events[0];
    if (head === undefined) return;
    await this.#runTurn(head.conversationId, closedNotice ?? humanTurnText(events));
  }

  /**
   * 合図1件の後始末。**`#pump` の2箇所（枠で最初から回さなかった場合／`#handle`
   * を通した場合）から呼ぶので1本にまとめてある** — 別々に書くと、台帳の控えを
   * 外し忘れる・待っている相手を起こし忘れるといった漏れが片方にだけ起きる。
   *
   * `defer` が真なら **`#forget` を呼ばない**＝器（`stores.inbox`）にも未読の
   * まま残す。理由は `#forget` の doc・`#pump` 旧 finally のコメント
   * （「決定的に失敗する合図を残すと起動のたびに配り直されてクローンのターンを
   * 焼く」）に対する例外である — **枠は決定的な失敗ではなく、時間で解決する
   * 失敗である。** 消してしまえば、枠が開いたときにはもう合図そのものが無く、
   * 仕事が失われる。`#forget` を呼ばない＝未読のままにしておけば、途中で
   * プロセスが死んでも `#restoreUnread` が次の起動で拾い直す（この機構の
   * 「保持」がプロセスの生死をまたいで壊れない理由でもある）。
   */
  async #settleInboxEvent(event: InboxEvent, defer: boolean): Promise<void> {
    // 記帳の控えも同じ場所で捨てる。**台帳の行は消さない** — 消すのは「もう
    // 順序を待つ相手が居ない」という印だけで、閉じられていない未了はそのまま残る
    // （それがこの器の目的である）。
    this.#committed.delete(event.id);
    // 受理の瞬間に書いた追記の控えは、待つ相手が居なくなった時点で捨てる。
    // **例外で終わった経路も通る**ので、ここに置く（`#handle` の中で消すと、
    // 途中で投げたぶんが残り続ける）。追記そのものは取り消さない — 消すのは
    // 「もう誰も待たない」という印だけである。
    this.#recorded.delete(event.id);

    if (defer && this.#foldsIntoHeldTick(event)) {
      // **中身を持たない合図で在庫を作らない。** `post` の畳み込みと同じ規則
      // （`isTick` の doc「読まれる前の重複には情報が無い」）を、保持した側にも
      // 適用する地点である。規則は「読まれる前」で書かれているのに、`post` は
      // `Inbox#hasPending`（＝待ち行列）しか見ない。枠で保持した分は `#deferred`
      // に居て待ち行列には無いので、**合図が溜まる唯一の状況＝枠が閉じている間
      // だけ、規則が静かに効かなくなっていた**（実測: 枠を閉じたまま発意 tick を
      // 5回送ると5件とも別々に保持される）。
      //
      // **`post` 側では畳めない。ここでなければならない。** `post` で return すると
      // 受信箱へ何も積まれないので、`#releaseRequested` を立てても `#pump` がその印を
      // 見に来ない（解除ブロックの doc の「どちらの道でも待ち行列は空でない」が
      // 成り立たなくなる）。tick は**枠が開いたかを試す唯一の定期的な契機**なので、
      // そこで畳むと再試行そのものが静かに止まる。ここまで通っていれば、その合図は
      // 既に解除を1回試させた後である ＝ **試行の回数は1回も減らない。**
      //
      // 畳むのは**いま届いた新しい方だけ**で、先に保持している同じ tick は1件も
      // 動かない（FIFO も断り書きも `#heldForUsage` も触らない）。
      await this.#noteFoldedTick(event);
      // 器の未読からも外す。**残すと、この1件だけが起動のたびに配り直されて
      // クローンのターンを焼く**（`#forget` の doc）。吸収した側は未読のまま残るので、
      // 「見に行け」という仕事そのものは失われない。
      this.#heldForUsage.delete(event.id);
      await this.#forget(event);
    } else if (defer) {
      this.#deferred.push(event);
      // 保持したことを覚えておく（`#heldForUsage` の doc）。**印を消すのは
      // `#forget` と同じ側である** — 保持している間に消すと、解除で戻ってきた
      // 合図が「初めて届いたもの」に見えてまとめ読みの対象へ戻る。
      this.#heldForUsage.add(event.id);
    } else {
      // **終えた時点で消す。取り出した時点ではない。** 取り出した時点で消すと、
      // 処理の途中でプロセスが死んだものが失われる＝いま塞いでいる穴がそのまま残る。
      //
      // **例外で終わったものも消す。** ここへ来ているということは失敗が
      // `#reportFailure`（＝人間へ流すか日誌へ落とす）に記録されたということで、
      // 消えたわけではない。残す側を選ぶと、決定的に失敗する合図（形が不正・
      // 参照先が消えている）が起動のたびに配り直され、そのたびに同じ失敗を
      // 繰り返してクローンのターンを1本ずつ焼く。**残るのはプロセスが死んだ
      // ときと、枠で保持したとき（上の `defer` 側）だけ**、が守るべき線である。
      this.#heldForUsage.delete(event.id);
      await this.#forget(event);
    }
    const done = this.#completions.get(event.id);
    this.#completions.delete(event.id);
    done?.();
  }

  /**
   * いま保持しようとしている合図を、既に保持している同じ tick へ畳んでよいか。
   *
   * **畳めるのは「中身を持たない合図」だけである**（`isTick`）。人間の発言・
   * マネージャーからの一件・外部イベント・蒸留・承認の回答は、`isTick` が偽を
   * 返すので構造上ここを通らない。`timer` は `kind` / `target` / `cause` が
   * 揃ったときだけ同じ tick である（別の日の日報は別の仕事 — `isSameTick`）。
   *
   * **文言では判定しない。** 判定は `isSameTick`（型と構造化フィールドだけを見る）
   * に委ねてあり、本文の一致は1文字も見ていない。
   */
  #foldsIntoHeldTick(event: InboxEvent): boolean {
    return isTick(event) && this.#deferred.some((held) => isSameTick(held, event));
  }

  /**
   * 畳んだことを日誌へ残す。
   *
   * **畳む仕組みを入れるなら、畳んだ跡が残らなければならない。** この畳み込みは
   * 器にも台帳にも何も残さない（`#forget` で未読から外す）ので、**ここで書かな
   * ければ「静かに消えた」と区別が付かない。** 判定が間違っていたとき、記録が
   * 在れば後から気づけるが、無ければ永久に見えない。
   *
   * 件数を添えるのは、後から数え直せるようにするためである（枠が閉じている間に
   * 何件ぶん畳んだのかは、この行を数えれば出る）。
   */
  async #noteFoldedTick(event: InboxEvent): Promise<void> {
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `枠で保持している同じ合図（${event.type}）が既にあるので、新しく届いた分を畳んだ。` +
        `中身は処理の瞬間に組み立て直すので、読まれる前の重複には情報が無い（保持中の同種: ` +
        `${this.#deferred.filter((held) => isSameTick(held, event)).length} 件）。`,
    });
  }

  #conversationOf(event: InboxEvent): string | null {
    return event.type === 'human_message' ? event.conversationId : null;
  }

  // -------------------------------------------------------------------------
  // 未読の永続化（プロセスが死んでも判断の材料を失わない）
  // -------------------------------------------------------------------------

  /**
   * 受け取った合図を未読として器に置く。
   *
   * **`post` は同期で返り値を持たない**（7種類の起点すべてがそう呼ぶ）ので、書き
   * 込みは待てない。したがって「受理した」と「書けた」の間には窓が残る。**そこは
   * 塞げないが、塞げるのは残り全部である** — この直しの前は「受理してから処理を
   * 終えるまで」丸ごとが失われる窓で、そこにはターン1本ぶん（マネージャーの委譲を
   * 含めば数分から数十分）が入っていた。
   *
   * **失敗しても post を落とさない。** 未読を書けないことでその合図の処理まで
   * 止めたら、いま直そうとしているものより広い穴になる。跡は stderr へ1行だけ残す
   * （本文を出さない理由は `dropped-record.ts`。ここへ来る合図には人間の発言・
   * webhook の本文・マネージャーの報告が入り、テスト出力（`railway/setup.test.ts`
   * の差分アサーション）に `GH_TOKEN` が全文で出た前例がある。#52）。
   */
  #remember(event: InboxEvent): void {
    this.#unread.set(
      event.id,
      this.#stores.inbox.put(event, event.at).catch((error: unknown) => {
        noteDroppedRecord('未読の合図', inboxEventShape(event), error);
      }),
    );
  }

  /**
   * 人間の発言を、受理した瞬間に日誌へ残して合図を出す。
   *
   * **「一件ずつ判断する」と「発言の記録も一件ずつ待たせる」は別のことである。**
   * ターンの直列は意図された設計（architecture.md「同時実行モデル」）だが、
   * 記録をその直列の後ろに置いていたのは帰結であって設計ではなかった。後ろに
   * 置くと、先客（蒸留・マネージャーとの往復・自律の起点）が走っているあいだ
   * **日誌にその発言が存在しない** — 日誌から組み立てる `GET /conversations`
   * にも出ないので、器（端末・タブ・アプリ）を替えた人からは発言そのものが
   * 消えて見える。「続きから話せること自体が要件」（north_star 禁止1）に
   * 対して、直列が可視性まで直列にしていた。
   *
   * **記録が先、通知は後**（`journal-bus.ts` と同じ順）。日誌へ載れば
   * `GET /journal/stream` にもそのまま流れるので、**この1か所で「送った本人の
   * 画面」以外の観測者3種（開き直した人・別端末・API の利用者）が同時に埋まる。**
   * `queued` はそれに加えて、**まだ順番が来ていない**という日誌に残せない状態
   * （残すと古くなる）を、いま見ている購読者へ渡すためのものである。
   *
   * **失敗しても post を落とさない**（`#remember` と同じ理由）。跡は `#journal`
   * が `journalEntryShape` へ畳んで stderr へ落とす。
   *
   * **人間の発言だけを見る。** 他の6種は起点ごとに違う型で日誌へ残っており
   * （`manager_message` は `exchange`、`external` は `external_event`、
   * `timer` は走らせるかどうかを決めた後）、そこは「受け取ったこと」ではなく
   * 「何をしたか」の記録である。ここへ寄せると意味の違う2つを1つの型に潰す。
   */
  #record(event: InboxEvent): void {
    if (event.type !== 'human_message') return;

    // 前の発言の追記が器へ入ってから次を渡す（`#recordChain` の理由）。
    const written = this.#recordChain.then(() =>
      this.#journal({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: event.text,
        conversationId: event.conversationId,
      }),
    );
    // 列そのものは失敗で切らない。**1本書けなかったことで以後の発言の記録まで
    // 止めない**（`#journal` は自分で握るので普通は来ないが、列は器の外の失敗にも
    // 耐える形で持つ）。待っている側（`#handle`）には元の約束を渡す。
    this.#recordChain = written.catch(() => undefined);
    this.#recorded.set(event.id, written);

    // 同期で呼ぶ。`post` から見て、この合図は日誌の書き込みを待たずに届く
    // （待てるのは記録の**順序**だけで、通知を待たせる理由は無い）。
    this.#emit(event.conversationId, { type: 'queued' });
  }

  /**
   * 頼まれたことを未了として台帳へ開く。
   *
   * **合図の id をそのまま未了の id にする。** 配り直しでも同じ id になるので、
   * `CommitmentStore.open` の冪等性がそのまま「二度開かない・閉じたものを開き直さない」
   * になる。別の id を振ると、器が落ちるたびに片付いた依頼が蘇る。
   *
   * **開くのは「誰かが渡してきたもの」だけである**（人間の発言・人間の回答・
   * マネージャーからの一件・外部イベント）。`timer` と `self_initiative` は起こされた
   * こと自体であって渡されたものではなく、しかも `timer` には既に器がある
   * （`ScheduledRequest.pendingRun`）。ここで開くと発意 tick のたびに未了が1件増え、
   * 台帳が数時間で読めなくなる。**クローン自身が気づいたことは `commitment_open` で
   * 自分で開く** — 人間が「あ、これ直さなきゃ」と思ったときにメモするのと同じ形で、
   * 器が代わりに決めることではない。
   *
   * **失敗しても post を落とさない**（`#remember` と同じ理由。跡は stderr へ1行）。
   */
  #commit(event: InboxEvent): void {
    const entry = commitmentFor(event);
    if (entry === null) return;
    this.#committed.set(
      event.id,
      this.#stores.commitments.open(entry).then(
        () => undefined,
        (error: unknown) => {
          noteDroppedRecord('未了の記帳', inboxEventShape(event), error);
        },
      ),
    );
  }

  /**
   * ターンの本文の先頭に載せる、台帳の断り書き。
   *
   * 2つを1つの節で渡す。**この合図に対応する未了の id**（閉じ方が分からなければ
   * 閉じられない）と、**いま何件が未了で、いちばん古いものがいつのものか**である。
   *
   * **件数と齢を毎ターン見せるのは、優先度を決め直させるためである。** 器は起点の
   * 中身を読んで順番を付けない（**付けた瞬間に「何を先にやるか」の判断が器へ移る**）。
   * 代わりに溜まっているものを毎回見せて、順序はクローンが記憶に照らして決め直す。
   *
   * **⚠️ 例外が1つある。人間が待っている合図だけは器が前へ出す**
   * （`CLONE_HUMAN_PRIORITY_ENV_KEY` に人間の逐語がある）。**それでもこの節は
   * 要る** — 前へ出るのは「人間 対 それ以外」の1段だけで、**溜まっている中身の
   * どれを先にやるかは、依然としてクローンが決める。** 器が持っているのは
   * 「人間を待たせない」という1行の方針であって、優先順位そのものではない。
   * **ここが古くなると、クローンは「器は並べ替えない」と読み続ける。****一覧そのものは載せない** — 件数に比例して伸びるものを毎ターン
   * 積むと、溜まっているときほどターンが重くなる。全文は `commitment_list` で取れる。
   *
   * **読めなくても空文字を返してターンを進める。** 台帳が読めないことでターンまで
   * 止めたら、いま塞いでいる穴より広い穴になる。
   */
  async #commitmentNoticeFor(events: InboxEvent[]): Promise<string> {
    const event = events[0];
    if (event === undefined) return '';

    // 蒸留には載せない。**記憶へ移すためだけの内部ターン**であって、しかも
    // `stop()` 経由の蒸留はこの直後にプロセスが消える。そこへ「未了が3件ある」と
    // 渡すのは、畳んでいる最中に新しい仕事を始めさせることでしかない。
    if (event.type === 'distill') return '';

    // この合図の記帳が済んでから読む（読んだ一覧に自分が居ないことを防ぐ）。
    // **まとめて読む分は全部待つ** — 1件でも飛ばすと、そのぶんだけが一覧に
    // 間に合わず、閉じ方（id）を渡せない未了が黙って混じる。
    for (const pending of events) await this.#committed.get(pending.id);

    // **`list()` は `CommitmentList`（`{ entries, unreadable }`）を返す
    // （issue #296）。`entries` のことをここでは従来どおり `open` と呼ぶが、
    // 読めない行が在れば `unreadable` として別に断る（下）——件数だけを見て
    // 読めない行を握り潰さない。
    let list: CommitmentList;
    try {
      list = await this.#stores.commitments.list();
    } catch (error) {
      noteDroppedRecord('未了の読み出し', inboxEventShape(event), error);
      return '';
    }
    const open = list.entries;

    // **まとめた件数ぶん台帳に載っている**（記帳は `post` が合図ごとに行う）。
    // 1件しか渡さないと、残りは id を渡されないまま未了として溜まる。
    const ids = new Set(events.map((pending) => pending.id));
    const mine = open.filter((entry) => ids.has(entry.id));
    const idList = mine.map((entry) => `\`${entry.id}\``).join(', ');
    const oldest = open[0];
    const lines = [
      `[system] 引き受けたまま終わっていない仕事は **${open.length} 件** ある` +
        (oldest === undefined ? '。' : `（いちばん古いものは ${oldest.at} に受け取ったもの）。`),
      ...(mine.length === 0
        ? []
        : [
            (mine.length === 1
              ? `いま届いたこの一件も台帳に載せた（id: ${idList}）。`
              : `いま届いたこの ${mine.length} 件も台帳に載せた（id: ${idList}）。` +
                '**まとめて1つの応答で答えても、閉じるのは id ごとである。**') +
              '**片付いたら `commitment_close` で閉じること** — 返事をしただけでは閉じない。' +
              '雑談や、その場で答えて終わる話なら、答えたうえですぐ閉じてよい。',
          ]),
      // **読めない行が在ることを、ここでも断る（issue #296）。** `open.length`
      // には読めない行は数えられていない（`entries` だけの件数）ので、
      // ここが無いと読めない行は完全に見えなくなる — digest / commitment_list
      // と同じ趣旨の1行をターンの先頭にも置く。
      ...(list.unreadable.length === 0
        ? []
        : [
            // **「詳細が見られる」とは書かない。** `commitment_list id=<id>` の
            // 全文モードは読めない行で `get(id)` が throw するので、返るのは
            // 「読めない」という事実だけで本文ではない（`tools.ts` の
            // `UnreadableCommitmentError` の扱いを見よ）。ここは実際に
            // できることだけを書く。
            `**読めない行が ${list.unreadable.length} 件ある（片付いたのではない）。**` +
              '`commitment_list` の一覧に件数として出る（本文はここでは取れない）。',
          ]),
      '全文と齢は `commitment_list` で見られる。**どれを先にやるかは、記憶にある目的と価値観に照らして毎回決め直すこと**' +
        '（台帳は順序を持たない。溜まっている順に片付ける決まりは無い）。',
      '',
      '---',
      '',
    ];
    return lines.join('\n');
  }

  /**
   * 処理を終えた合図を器から消す。
   *
   * **書き込みの完了を待ってから消す。** 待たないと、短いターンでは消し込みが
   * 書き込みを追い越し、消したはずの合図が後から書かれて**起動のたびに永久に
   * 配り直される**（この直しが一番作りやすい壊れ方である）。
   *
   * **`inbox.remove` が確定するまでメモリ上の印は消さない（issue #256）。**
   * 以前は `#unread` / `#redelivered` / `#redeliveredClosed` を `remove` の
   * **前**に消していた——`remove` が失敗しても印だけは先に消えるので、
   * 「ストアにはまだ残っているのに `#unread` には無い」という、この関数自身の
   * 前提（`#unread` ＝ まだ消せていない合図の集合、上の doc）と矛盾する状態を
   * 自分で作っていた。`inbox.remove` は冪等（`InboxStore.remove` の doc
   * 「無ければ何もしない」）なので、消せたと確定するまで印を残しておいても
   * 安全に何度でも試せる。
   *
   * **一時的な失敗は `SCHEDULE_STORE_ATTEMPTS` と同じ理由で拾い直す
   * （`FORGET_RETRY_ATTEMPTS`）。** `commitment_close`（`tools.ts`）と
   * `inbox.remove`（ここ）は別のストア・別の時点（前者はターンの最中、後者は
   * ターンの `finally`）の書き込みで、**両者を1本の DB トランザクションで
   * 束ねることはできない**——束ねようとすると、トランザクションをターンの
   * 残り（モデルの生成・他の道具呼び出し・人間への返信の送出）のあいだ開いた
   * ままにすることになり、それ自体が新しい危険（長時間ロック・接続の占有）を
   * 作る。**ここで拾い直すのは `remove` 単体の一時的な失敗（器の瞬断）に対して
   * だけであり、`commitment_close` 成功後・この関数に到達する前にプロセス
   * ごと落ちる窓（issue #256 が挙げる T1〜T3）は塞げない。** その窓は
   * `#restoreUnread` の配り直し（`closedRedeliveryNotice`、issue #217）が
   * 拾う——**「消せなかったものは次の起動で配り直される。それは設計どおりの
   * 側の失敗（消えるより配り直す）」という下の判断を壊さないための境界線を
   * ここに引く。**
   */
  async #forget(event: InboxEvent): Promise<void> {
    const written = this.#unread.get(event.id);
    // 器に置いていない合図（`#postAndWait` の蒸留）は消すものが無い。
    if (written === undefined) return;

    await written;

    let last: unknown;
    for (let attempt = 0; attempt < FORGET_RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, FORGET_RETRY_MS * attempt));
      }
      try {
        await this.#stores.inbox.remove(event.id);
        this.#unread.delete(event.id);
        this.#redelivered.delete(event.id);
        this.#redeliveredClosed.delete(event.id);
        return;
      } catch (error) {
        last = error;
      }
    }
    // 消せなかったものは次の起動で配り直される。**それは設計どおりの側の失敗**
    // （消えるより配り直す）なので、印も残したまま跡だけ残して進む——印を消すと
    // 「もう消せている」と嘘をつくことになる（上の doc）。
    noteDroppedRecord('未読の消し込み', inboxEventShape(event), last);
  }

  /**
   * 前の器が終えられなかった合図を受信箱へ戻す。
   *
   * **永続化と拾い直しは1つの直しの前半と後半である。** 永続化しても拾い直さな
   * ければ器の中で腐るだけだし、拾い直しには永続化が要る。片方だけ入れないこと。
   *
   * **digest（`digest.ts`）は変えない。** あちらも `done` のマネージャーを拾うが、
   * 見せるのは 200 字の抜粋・最大15件・24時間の窓であり、**未読かどうかは区別
   * しない**。ここで戻すのは全文が1ターンとして届く経路なので、両者は競合しない
   * （digest に載るのは「この期間に何があったか」で、この直しの前から報告の抜粋は
   * そこに出ていた＝重複が増えるわけではない）。むしろ**「消えたと思ったものが、
   * 実は 200 字の抜粋として通り過ぎていた」を解くのがこちら側である** — 未読は
   * 抜粋ではなく全文で、断り書き付きで届く。
   */
  async #restoreUnread(): Promise<void> {
    let pending: PendingInboxEvent[];
    try {
      pending = await this.#stores.inbox.claimPending();
    } catch (error) {
      // 読めなければ配り直せないが、消してもいないので次の起動で拾い直せる。
      noteDroppedRecord('未読の読み直し', '', error);
      return;
    }

    for (const record of pending) {
      if (this.#stopped || this.#inbox.closed) return;

      // 人間が後から「なぜ二度来たのか」を追えるようにする。**積む前に書く** —
      // 後だと、配り直した合図の本文（人間の発言なら下の `#record`、他の起点なら
      // `#handle` が起点ごとの型で残すもの）より後ろに回りうる。**この行に本文は
      // 載せない**（載せると、本文を持つ側と二重になる）。
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `未読のまま残っていた合図を配り直した（${record.deliveries}回目の配達、` +
          `${record.at} に受け取ったもの）: ${inboxEventShape(record.event)}`,
      });

      // 日誌を書いているあいだに片付けが始まっていることがある。**積む直前に
      // もう一度見ること**（`Inbox#push` は閉じた後だと投げる）。消してはいない
      // ので、積めなかったものは次の起動で拾い直せる。
      if (this.#stopped || this.#inbox.closed) return;

      // **クローンが既に片付けているかを見る。** 台帳の id は合図の id その
      // ものである（`commitmentFor`）ので、`event.id` でそのまま引ける。
      // `commitmentFor` が `null` を返す型（`timer` / `self_initiative` /
      // `distill`）は台帳に載らない＝引く意味が無いので、そもそも呼ばない。
      if (commitmentFor(record.event) !== null) {
        try {
          const commitment = await this.#stores.commitments.get(record.event.id);
          // **`closedAt` が立っているものだけ短縮の対象にする。** 未了はここでは
          // 何もしない（`#redeliveredClosed` に載らない）ので、後段は変わらず
          // 全文で配る — 1文字も変えない。
          if (commitment !== null && commitment.closedAt !== undefined) {
            this.#redeliveredClosed.set(record.event.id, commitment);
          }
        } catch (error) {
          // **読めなければ「閉じていない」として扱う＝全文で配る。** ここで
          // ターンを止めない。安全側は「全文で配る」— 雑音であって喪失ではない
          // 側へ倒す。
          noteDroppedRecord('配り直しの片付き確認', inboxEventShape(record.event), error);
        }
      }

      this.#redelivered.set(record.event.id, record);
      // 既に器に在るので書き直さない。**ただし消し込みの対象には入れる**
      // （入れ忘れると、拾い直したものが処理後も残って毎回配られる）。
      this.#unread.set(record.event.id, Promise.resolve());
      // **本文は配達のたびに書く。** 受理の瞬間の追記（`#record`）は `post` から
      // 見て非同期なので、器へ届く前に落ちたかどうかは**ここからは分からない**。
      // 書かない側を選ぶと、その窓に落ちた発言が日誌から永久に消える（未読の器に
      // は在るのに、日誌にも `GET /conversations` にも無い）。書く側を選べば重複
      // しうるが、それは**この直しの前と同じ回数**である（以前も `#handle` が配達
      // ごとに書いていた）。「消えるより配り直す」の向きを、記録でも揃える。
      this.#record(record.event);
      // **記帳もやり直す。** `open` は冪等なので、前の器で開けていれば何も起きず、
      // 閉じてあれば閉じたままである。やり直さない側を選ぶと、`post` が受理してから
      // `open` が器へ届く前に落ちた合図だけが、未読としては残るのに台帳から永久に
      // 漏れる（そしてその窓は、いちばん落ちやすい起動直後と重なる）。
      this.#commit(record.event);
      // `post` を通さないのは、tick の畳み込みで落ちた行が器に残り続けるからである
      // （落とした側は誰も消さないので、起動のたびに配られて回数だけが増える）。
      this.#inbox.push(record.event);
    }
  }

  /**
   * 配り直しの断り書き。初めての配達なら空文字。
   *
   * **「二度届く」ことは受け入れるが、「二度目だと分からない」ことは受け入れない。**
   * 分からなければクローンは同じ報告に二度応答し、そのターンが丸ごと無駄になる
   * （消費にも直結する）。ここが、消し込みを「終えた時点」に置いた取引の対価である。
   */
  #redeliveryNoticeFor(event: InboxEvent): string {
    const record = this.#redelivered.get(event.id);
    if (record === undefined) return '';

    return [
      `[system] **これは配り直しである（${record.deliveries} 回目の配達）。**` +
        `${record.at} に受け取ったまま、処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。`,
      '同じ内容に既に応答しているかもしれない。日誌（`journal_read`）と `manager_list` を見て、' +
        '同じ仕事を二度起こさないこと。',
      ...(record.deliveries >= 2
        ? [
            '**2 回以上配り直している。** この合図を処理するたびに器が落ちている可能性がある。' +
              '同じやり方をもう一度なぞる前に、なぜ落ちたかを先に見ること。',
          ]
        : []),
      '',
      '---',
      '',
    ].join('\n');
  }

  /**
   * 片付け済みの配り直しなら、本文の代わりに配る断り書き。片付いていなければ
   * `null`（呼び出し側は全文をそのまま使う）。
   *
   * **`#redeliveryNoticeFor` とは別物。** あちらは全ての配り直しに付く定型の
   * 1文で、本文は変えない。こちらは「片付け済み」の配り直しにだけ掛かり、
   * 本文そのものを短い断り書きへ置き換える（`closedRedeliveryNotice`）。
   *
   * **判定は `#restoreUnread` が済ませてある。** ここでは `stores.commitments`
   * を引き直さない — 引き直すと「配り直した後、ターンが実際に読まれるまでの
   * 間にクローン自身がこの合図を閉じた」ような場合にも短縮が掛かってしまい、
   * 「配り直した時点では未了だった」という事実が消える。
   */
  #closedRedeliveryNoticeFor(event: InboxEvent): string | null {
    const commitment = this.#redeliveredClosed.get(event.id);
    if (commitment === undefined) return null;
    return closedRedeliveryNotice(event, commitment);
  }

  /**
   * ターンの失敗を必ずどこかに残す。
   *
   * 人間が繋がっていれば chat へも流れるが、**流せたことを記録の代わりにしない。**
   * `#emit` はその会話の購読者が居なければ何もしないので、chat へ流すだけで
   * 済ませると「人間が発言 → chat を閉じる／切断 → そのターンが例外で失敗」が
   * どこにも残らない。内部ターン（マネージャーからの確認・蒸留・自律）には
   * そもそも聞き手が居ないので、握り潰せば「クローンが黙り、マネージャーが
   * 永久に返事を待つ」が無記録で起きる。**どちらの向きも日誌で受ける。**
   *
   * これは消し込みの前提でもある。受信箱のループは例外で終わった合図も
   * `#forget` するが（`#pump` の `finally`）、その根拠は「失敗が記録されて
   * いる」ことである。人間の発言だけがその根拠を欠いていた。
   *
   * **なぜ日誌か（`Clone#post` の #57 とは選択が違う）。** あちらは同期で
   * 返り値を持たず、日誌へ書けば fire-and-forget ＝跡が残る前にプロセスが
   * 消える窓そのものへ賭けることになるので stderr にした。ここは `async` で、
   * **呼び出し側が全経路で `await` している**（`#pump` の catch / `#runTurn` /
   * 読み取りループの finally）。しかも `#forget` はこの `await` が返った後の
   * `finally` で走るので、書き終える前に落ちれば合図は未読のまま残って配り
   * 直される。跡を残す窓と競合しない以上、stderr へ落とす理由が無い。
   *
   * **本文（`message`）を stderr へは出さない。** ここに入るのは呼び出し側3か所
   * すべてで `String(error)` である。**いま辿れる範囲に、人間の発言そのものを
   * 載せて戻ってくる経路は無い**（発言を束縛して書くのは `#handle` の
   * `#journal` だが、あれは自分で握って `noteDroppedRecord` へ落とすので
   * ここまで投げてこない）。だが `message` は SDK・API・ストアのドライバが
   * 決める文字列であって**こちらが値を決めていない** — `journalEntryShape` の
   * 判定基準（「自由文かどうか」ではなく「値を誰が決めるか」）では出せない側で
   * ある。日誌は持ち主しか読まないが stderr は器の外へ出ていく
   * （`noteDroppedRecord` の doc）。書けなかったときの跡は `#journal` が
   * `journalEntryShape` ＝長さだけに畳んで `noteDroppedRecord` へ落とす。
   * **ここに素の `String(error)` を1行も足さないこと。**
   *
   * ## 失敗の記録は `with: 'self'` へ置く（#92）
   *
   * 直す前は、会話のある失敗を `with: 'human'` / `role: 'outbound'` で書いていた。
   * `GET /conversations/:id` は `with === 'human'` だけで絞って `role` をそのまま
   * 返すので、**失敗の記録が「クローンの返信」として会話に並んでいた** — 人間が
   * 見たのがこれである（利用上限に当たった状態で話しかけると、SDK の英語の文言
   * だけが返信として出る）。`message` の中身は SDK・API・ストアのドライバが決める
   * 文字列で、**人間へ向けた発言ではない。**
   *
   * だから記録は `self`（人間に見せない側）へ移す。**`conversationId` は落とさない**
   * ので、どの会話の失敗かは日誌の列でそのまま辿れる（#56 の線）。#89 が塞いだ
   * 「失敗がどこにも残らない」は記録が残ることで満たされていて、**どの `with` で
   * 残すかとは無関係である**（`with` を変えても、テキストの前置きは変えていない —
   * 既存の回帰テストが見ているのはそこである）。
   *
   * ## 代わりに、人間には人間の言葉で1行返す
   *
   * `self` へ移しただけだと、会話の画面を後から開いた人間には**自分の発言だけが
   * あって返信が無い**状態になる。沈黙は「まだ考えている」と見分けられないので、
   * 生の文言を含まない1行を `with: 'human'` で残す。**枠（利用上限）で保持して
   * いる場合はそう言う** — 人間の要望は「あとで良いのでちゃんと返信してほしい」で
   * あって待つこと自体は受け入れられている。待てば返るのか、もう返らないのかが
   * 会話から読めなければ、その要望は満たせない。
   */
  async #reportFailure(conversationId: string | null, message: string): Promise<void> {
    // **走っているターンに失敗の印を残す。** `#runTurn` の戻り値をこれで分岐させる
    // （`TurnOutcome`）。ここに置いてあるのは、失敗を畳む経路が4つある（セッションの
    // 起動失敗 / 読み取りループの例外 / 失敗した `result` / `#handle` の例外）ため —
    // 呼び出し側ごとに印を立てると、経路が増えたときに**印の無い失敗**が静かに
    // 混ざり、それは「成功して空文字を返した」と区別できない。
    //
    // **`#finishTurn()` より必ず先に呼ばれる**（全4経路でこの順序）。逆にすると
    // `this.#turn` は既に `null` で、印はどこにも残らない。
    const running = this.#turn;
    if (running !== null) running.failure = message;

    // 繋がっている人間には即座に見せる。日誌より先なのは、書き込みを待たせて
    // 「反応が無い」時間を伸ばさないため。届かなくても下の記録が残る。
    this.#emit(conversationId, { type: 'error', message });

    // `conversationId` は呼び出し側が構造化フィールドとして持っている値なので
    // 載せる（#56 の線）。落とすと、失敗がどの会話のものだったかを時刻でしか
    // 突き合わせられなくなる — 日誌には列があるのに。
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        conversationId === null
          ? `内部ターンが失敗した: ${message}`
          : `人間との対話ターンが失敗した: ${message}`,
      ...(conversationId === null ? {} : { conversationId }),
    });

    if (conversationId === null) return;

    // **枠で保持しているかは `#usageBlocked` を見て決める。** ここへ来る前に
    // `#noteUsageNotice` が立てている（枠を検知する3経路はいずれもこの
    // `#reportFailure` より先に `await` してある。`#pump` の枠チェックの分岐は
    // 既に立っているものを読んでいる）ので、文言の分岐をこの1か所に置ける —
    // 呼び出し側ごとに書き分けると、経路が増えたときに「枠なのに枠と言わない」
    // 失敗が静かに混ざる。
    await this.#journal({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text:
        this.#usageBlocked === null
          ? 'この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。'
          : 'いま利用上限に当たっているので、この発言にはまだ返せない。' +
            '発言は捨てずに保持していて、枠が開いたら試し直して返信する。',
      conversationId,
    });
  }

  /**
   * 上限の合図を1か所で扱う。**分類ごとの扱いはここでだけ決める** — 3経路
   * （`rate_limit_event` / `system` の通知・情報メッセージ / 失敗した `result`）
   * がそれぞれ検知して、ここへ渡す。
   *
   * | `kind` | どうするか |
   * | --- | --- |
   * | `reached` | **保持して待つ**（この機構の対象）。`#usageBlocked` を立て、
   *   以降の合図は `#pump` がターンを回さず保持する（保持も解除も本体は
   *   `#pump` にある。`post` は解除の印を立てるだけ）。いま処理中の会話には
   *   `usage_limited` を届ける —
   *   呼び出し側がこの直後に `error`（終端）を出すなら、**この `await` を
   *   先に済ませてから**でなければならない。 |
   * | `org_policy` | **待たないが、記録は残す。** `usage-limits.ts` が「待っても
   *   直らないし、増やす先も違う」と明記しているので保持はしない（従来どおりの
   *   失敗として呼び出し側の通常の失敗処理に任せる）。**ただし日誌には書く** —
   *   直す前はここで早期 return して日誌にも残さなかったので、
   *   `This service is disabled for your org` で止まったことがどこにも出ず、
   *   「ただ失敗した」と区別できなかった。**「待たない」は設計判断だが、
   *   「記録しない」はどこにも書かれていない。** |
   * | `transition` / `warning` | **待たない**（まだ動く）。ただし日誌には残す
   *   — そろそろ止まることが、止まる前に分かるように。 |
   *
   * **同じ `kind` で同じ文言が続くなら、日誌への書き込みは畳む**
   * （`#usageNotices` の doc）。`transition` / `warning` はターンが回り続ける
   * ので `system` 通知が毎ターン届き、畳まないと同じ知らせで日誌が埋まる。
   * **畳むのは日誌だけ** — `reached` の `#usageBlocked` を立てる処理と
   * `usage_limited` の emit は、同じ `kind`・同じ文言が再び来ても毎回行う
   * （2件目以降の合図は別の会話から来ているかもしれず、emit まで畳むと
   * その送り主に何も見えなくなる）。
   */
  async #noteUsageNotice(
    notice: UsageLimitNotice | undefined,
    conversationId: string | null,
    /**
     * この通知が**どこから来たか**（Issue #393 PR3）。
     *
     * - `text`: SDK が出した文言を `classifyUsageNotice` に通したもの
     * - `rate_limit`: `rate_limit_event` の `rejected` を通知の形へ仕立て直したもの
     *
     * **回し手へ渡すのは `text` だけである**（下の分岐に理由がある）。日誌と
     * `#usageBlocked` の扱いは今までどおり両方で同じ——**この引数で変わるのは
     * 回し手へ渡すかどうかだけ**にしてある。
     */
    source: 'text' | 'rate_limit',
  ): Promise<void> {
    if (notice === undefined) return;

    // 枠が閉じた（あるいは近づいた）と分かった瞬間に日誌へ1件。**言い換えない**
    // — `describeUsageNotice` がそのまま人間の検索できる文言を返す。
    if (this.#usageNotices.get(notice.kind) !== notice.text) {
      this.#usageNotices.set(notice.kind, notice.text);
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: describeUsageNotice(notice),
      });
    }

    // **回し手へ渡すのは、文言から分類した通知だけである。**
    //
    // **⚠️ `rate_limit_event` 由来のものを渡さないこと。** この関数はそちらからも
    // 呼ばれ（`rejectedRateLimitNotice`）、そこで作られる `reached` は
    // **「その枠が尽きた」を `reached` の形へ仕立て直したもの**であって
    // 「仕事が止まった」ではない（Issue #393 追記1 の訂正。`clone.ts` に逐語で
    // 在る「1つぶんの状態でしかない」）。回し手へ `reached` として渡すと、
    // **`overage_exhausted` の設定でも課金枠を1円も使わずに回ってしまう。**
    //
    // ⟹ 出所を引数で受ける。`source` を足したのはこの1点のためである。
    if (source === 'text') await this.#observeForTokenRotation({ notice });

    if (notice.kind !== 'reached') return;

    this.#usageBlocked = notice;
    this.#emit(conversationId, { type: 'usage_limited', message: describeUsageNotice(notice) });
  }

  async #handle(event: InboxEvent): Promise<void> {
    switch (event.type) {
      case 'human_message': {
        // 1件だけの経路。**まとめて読む経路（`#runHumanTurn`）と同じ関数を通す** —
        // 理由と、ここで日誌へ書かない理由はそちらの doc にある。
        // 片付け済みの配り直しなら、本文の代わりに断り書きを渡す
        // （`#closedRedeliveryNoticeFor` の doc）。
        await this.#runHumanTurn([event], this.#closedRedeliveryNoticeFor(event));
        return;
      }

      case 'distill': {
        // セッションがまだ無いなら蒸留するものも無い
        if (!this.#query) return;
        // **前回の蒸留以降に新しいことが無ければ、同一内容の蒸留を重ねて払わない。**
        // `endConversation()` の直後に `stop()` が来る形（デプロイの夜間再起動が
        // これに当たる）は、`event.reason` が `conversation_end` でも `shutdown`
        // でも `buildDistillPrompt` が同じ文面へ写す（すぐ下）ので、間に新しい
        // ターンが1本も無ければ2回目は文字どおりの重複でしかない
        // （`#hasUndistilledActivity` の doc）。**取りこぼしより重複を疑うこと** —
        // 印が立っていれば必ず投げる。
        if (!this.#hasUndistilledActivity) {
          await this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text:
              `蒸留（${event.reason}）は見送った。前回の蒸留以降にターンが1本も` +
              '走っていない（＝内容が変わっていない）ので、同一内容を重ねて払わない。',
          });
          return;
        }
        const distillPrompt = buildDistillPrompt(
          event.reason === 'shutdown' ? 'conversation_end' : event.reason,
        );
        // **このターンへ何が入ったかを残す**（#243）。本文は定型文なので長さだけ
        // を書く（何を載せるかの判断は `turnInputEntry` に1本化してある）。
        await this.#journal(
          turnInputEntry({ type: 'distill', reason: event.reason, prompt: distillPrompt }),
        );
        const outcome = await this.#runInternal(distillPrompt, 'distill');
        // **成功で終わった蒸留だけが印を下ろす。** 失敗した蒸留（枠で保持
        // された場合を含む。`outcome.status === 'failed'`）で下ろすと、移せ
        // なかった記憶を「移した」ことにして記憶を落とす（`#hasUndistilledActivity`
        // の doc）。
        if (outcome.status === 'answered') this.#hasUndistilledActivity = false;
        return;
      }

      case 'human_answer': {
        // 片付け済みの配り直しなら、承認待ちを読み直さず断り書きだけで済ませる
        // （`#closedRedeliveryNoticeFor` の doc。全文の取り方は `approvals_list`）。
        // **配った断り書きは日誌へ全文で残す**（#243）— この文字列はここで組み立てた
        // だけでどこにも保存されないので、写さなければ「回答の代わりに何を配ったか」が
        // 永久に取れない。
        const closedNotice = this.#closedRedeliveryNoticeFor(event);
        if (closedNotice !== null) {
          await this.#journal(
            turnInputEntry({
              type: 'human_answer_closed',
              approvalId: event.approvalId,
              text: closedNotice,
            }),
          );
          await this.#runInternal(closedNotice);
          return;
        }

        const approval = await this.#stores.jobs.getApproval(event.approvalId);
        const question = approval?.question ?? '(不明な質問)';
        // 宛先は managerId と requestId の対で戻す。requestId を落とすと、
        // そのマネージャーが複数を待っているとき宛先が決まらず、人間が答えたのに
        // 仕事が再開しない（人間へ回る経路の端から端まで id を運ぶこと）。
        const waiting =
          approval?.jobId === undefined
            ? ''
            : `\n\nこの確認はマネージャー ${approval.jobId} のものである。` +
              `回答を \`manager_send\`（許可確認なら decision 付き）で返すと、止まっていたその仕事が再開する。` +
              `\n宛先: managerId: "${approval.jobId}"` +
              (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`);
        const answerPrompt =
          `[system] 承認待ちにしていた質問に人間が答えた。\n\n質問: ${question}\n回答: ${event.answer}` +
          `${waiting}\n\n` +
          'この回答に沿って続きを進めよ。今後同じ判断を自分でできるよう、必要なら記憶へ残すこと。';
        // **全文を残す**（#243）。回答そのものは承認待ちの器にも在るが、質問・回答・
        // 宛先を1本にしたこの形＝**このターンへ入ったもの**は、ここにしか無い。
        await this.#journal(
          turnInputEntry({
            type: 'human_answer',
            approvalId: event.approvalId,
            text: answerPrompt,
          }),
        );
        await this.#runInternal(answerPrompt);
        return;
      }

      case 'manager_message': {
        // **日誌の書き込みは変えない。** 片付け済みの配り直しでも全文をここへ
        // 書く（`#restoreUnread` の「本文は配達のたびに書く」と同じ理由 —
        // 読む側にとってはこの1回が「全文の取り方」の在り処になる）。短くする
        // のは `#runInternal` へ渡す本文だけ。
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[${event.managerId}/${event.kind}] ${event.text}`,
        });
        const closedNotice = this.#closedRedeliveryNoticeFor(event);
        if (closedNotice !== null) {
          // 片付け済みの配り直しなら、`waiting` の生死を確かめるまでもなく
          // 短い断り書きで済ませる（`#closedRedeliveryNoticeFor` の doc）。
          // これから答えさせる文言（`managerPrompt` の 'live'/'settled' 分岐）
          // 自体を出さないので、liveness の判定と両立できないという構造ではない
          // ——単に、片付いているものには liveness を問わないだけである。
          await this.#runInternal(closedNotice);
          return;
        }

        // `report` は判定の対象外（`confirmationLiveness` の doc）。
        // `'unknown'` を渡しても `managerPrompt` はその分岐を読まない。
        const liveness: ConfirmationLiveness =
          (event.kind === 'question' || event.kind === 'permission') &&
          event.requestId !== undefined
            ? await confirmationLiveness(this.#managers, event.managerId, event.requestId)
            : 'unknown';
        // **報告は逆に、台帳を引く**（#391。`reportSettlement` の doc）。質問側と
        // 材料が違うので、判定も別に取る。
        const settlement: ReportSettlement =
          event.kind === 'report'
            ? await reportSettlement(this.#stores.commitments, event.id)
            : { kind: 'unknown' };
        await this.#runInternal(managerPrompt(event, liveness, settlement));
        return;
      }

      // --- 人間以外の起点（PRD「自律」の②③④） -------------------------------
      // どれも人間が見ていない時間に来る。だから応答の宛先は無く（内部ターン）、
      // 何をするかの判断はプロンプトではなくクローンに残す。

      case 'timer': {
        if (event.kind === DAILY_REPORT_KIND) {
          await this.#dailyReport(event.target ?? localDate(new Date(event.at)));
          return;
        }
        // 依頼の本文は**いま**読み、読んだその版で発火を確定させる。イベントに
        // 載せて運ぶと、人間が依頼を書き換えても発火時点の写しで走る（真実はストア側）。
        const claimed = await this.#claimScheduledRun(
          event.kind,
          event.at,
          // 省略時は定期の予定（`schema.ts` の `timer` の既定）
          event.cause === 'manual' ? 'manual' : 'schedule',
        );

        // **動かさない方を選ぶ場面が3つある。** どれも「時刻が来れば必ず届く」の側を
        // 1周期遅らせるだけで済むが、走らせてしまうと取り返せない。
        if (claimed.status !== 'ok' && claimed.status !== 'missing') {
          await this.#journal({
            type: 'exchange',
            with: 'self',
            role: 'outbound',
            text: `定期の依頼 ${event.kind} は、この発火では動かない: ${claimed.reason}`,
          });
          return;
        }

        const cause = event.cause === 'manual' ? 'manual' : 'schedule';
        const plan = claimed.status === 'ok' ? claimed.plan : null;
        const timerDigest = await this.#recentDigest();
        // **このターンへ何が入ったかを残す**（#243）。digest の全文は書かない —
        // 材料はこの日誌の中に在るので、形と長さがあれば組み直せる
        // （`turn-input.ts` の doc）。
        await this.#journal(
          turnInputEntry({
            type: 'timer',
            kind: event.kind,
            cause,
            ...(event.target === undefined ? {} : { target: event.target }),
            request: plan !== null,
            digest: timerDigest,
          }),
        );
        await this.#runInternal(
          buildTimerPrompt({
            kind: event.kind,
            ...(event.target === undefined ? {} : { target: event.target }),
            ...(plan === null ? {} : { request: plan.request }),
            ...(plan?.lastRunAt === undefined ? {} : { lastRunAt: plan.lastRunAt }),
            // 前の発火が終わっていなかったなら、それは器が落ちた跡である。
            // 走りかけていた可能性があることを隠さない（二重に手を出さないため）。
            ...(plan?.pendingRun === undefined ? {} : { unfinishedAt: plan.pendingRun.at }),
            digest: timerDigest,
          }),
        );

        // **終わったことを記録するのはここ。** claim（引き受けた印）とは別に置く。
        // ここまで来ないうちに器が落ちたら、印が残っているので配り直される
        // （日次なら翌日・週次なら翌週まで消える、を作らない）。
        if (plan !== null) await this.#completeScheduledRun(event.kind, event.at, cause);
        return;
      }

      case 'external': {
        const body = renderPayload(event.payload);
        // **日誌の書き込みは変えない**（`manager_message` と同じ理由）。
        await this.#journal({
          type: 'external_event',
          source: event.source,
          summary: body,
        });
        await this.#runInternal(
          this.#closedRedeliveryNoticeFor(event) ??
            buildExternalEventPrompt({ source: event.source, body }),
        );
        return;
      }

      case 'self_initiative': {
        const digest = await this.#recentDigest();
        // **このターンへ何が入ったかを残す**（#243。digest の全文を書かない理由は
        // `turn-input.ts` の doc）。
        await this.#journal(
          turnInputEntry({ type: 'self_initiative', reason: event.reason, digest }),
        );
        await this.#runInternal(buildSelfInitiativePrompt({ reason: event.reason, digest }));
        return;
      }

      default: {
        const exhaustive: never = event;
        throw new Error(`未知の受信箱イベント: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // ターンの実行
  // -------------------------------------------------------------------------

  /**
   * ターンを1本回して**結果の状態**を返す（`TurnOutcome`）。
   *
   * **本文だけを返さない。** 直す前は `Promise<string>` で、失敗しても
   * `turn.text` を返していたので、呼び出し側は「クローンが答えた」と
   * 「SDK がエラーを返した」を区別できなかった（`sdk-failure.ts` の doc）。
   *
   * **`kind` が `'distill'` のときだけ `#hasUndistilledActivity` を立て直さない。**
   * 蒸留そのものもここを通る（人間の発言と同じ「1本のターン」であることに
   * 変わりは無い）が、蒸留のターンで立て直すと印は永久に下りず、`stop()` の
   * 重複防止は何もしないのと同じになる（`#hasUndistilledActivity` の doc）。
   * それ以外の全経路（`human_message` / `human_answer` / `manager_message` /
   * `timer` / `external` / `self_initiative`）は素通しで `kind` を省略し、
   * 既定の `'normal'` で印を立てる。
   */
  async #runTurn(
    conversationId: string | null,
    text: string,
    kind: 'normal' | 'distill' = 'normal',
  ): Promise<TurnOutcome> {
    if (kind !== 'distill') this.#hasUndistilledActivity = true;

    // ターンは **セッションを起こす前に** 登録する。セッションの生成が失敗したり
    // 読み取りが即死したりしても、待っているターンを必ず誰かが解放できるように。
    let turn!: Turn;
    const done = new Promise<void>((resolve) => {
      turn = {
        conversationId,
        text: '',
        streamed: false,
        rejected: null,
        failure: null,
        resolve,
        kind,
      };
      this.#turn = turn;
    });

    try {
      await this.#ensureQuery();
      // 配り直しと台帳の断り書きは**ここでだけ**載せる（`#redeliveryNotice` の理由）。
      this.#pushInput(
        await this.#withFreshMemory(this.#redeliveryNotice + this.#commitmentNotice + text),
      );
      // 入力がモデルへ渡った瞬間から最初の出力までは「考えている」。
      // **`#ensureQuery` より後で送る** — セッションの起動そのものはまだ考え
      // 始めていないので、そこで送ると手が動いていないのに考えていると
      // 言うことになる。`#pushInput` は同期なので、この emit は続く `text`
      // より必ず先に届く。
      this.#emit(conversationId, { type: 'thinking' });
    } catch (error) {
      await this.#reportFailure(conversationId, String(error));
      this.#finishTurn();
    }

    await done;

    // **失敗の印を先に見る。** 本文が部分的に出ていても、失敗したターンの本文は
    // 応答ではない（`daily_report` はまさにそれを本文として保存していた）。
    if (turn.failure !== null) {
      return {
        status: 'failed',
        reason: turn.failure,
        // 保持しているかは `#usageBlocked` が持つ。**`#pump` の `finally` が
        // `defer` を決めるのに使うのと同じ値を読む** — 別の判定を書くと、
        // 「保持したのに呼び出し側は保持していないと思っている」がありうる。
        heldForUsage: this.#usageBlocked !== null,
      };
    }
    return { status: 'answered', text: turn.text };
  }

  /**
   * 人間に見せない内部ターン（蒸留・承認回答の反映・人間以外の起点）。
   *
   * `kind` は `#runTurn` へそのまま渡す。蒸留の呼び出し元だけが `'distill'` を
   * 渡し、それ以外は省略して既定（`'normal'`）のままにする。
   */
  async #runInternal(text: string, kind: 'normal' | 'distill' = 'normal'): Promise<TurnOutcome> {
    return this.#runTurn(null, text, kind);
  }

  // -------------------------------------------------------------------------
  // 自律（人間以外の起点の中身）
  // -------------------------------------------------------------------------

  /**
   * 発火した kind の依頼を読む。
   *
   * **「消された」と「読めなかった」を区別する。** 前者は人間が手で仕込んだ kind を
   * 起こした場合も含むので、本文なしのターン（記憶に照らして判断する）が正しい。
   * 後者は器の瞬断であって、本文なしで動かす理由にはならない。
   *
   * 一瞬の揺れで1周期ぶんの仕事を落とさないよう、この発火の中で読み直す。**回数を
   * 絞るためではなく取りこぼしを拾うため**であり、諦めた場合も `lastRunAt` を
   * 進めないので、次の発火で同じ依頼がそのまま来る。
   */
  async #scheduledRequestFor(
    kind: string,
  ): Promise<
    { status: 'ok'; plan: ScheduledRequest | null } | { status: 'unreadable'; error: string }
  > {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        return { status: 'ok', plan: await this.#stores.schedules.get(kind) };
      } catch (error) {
        last = String(error);
      }
    }
    return { status: 'unreadable', error: last };
  }

  /**
   * 「この発火で起きた」をストア側で確定させる。書けたら確定した依頼、書けなければ
   * 理由を返す（`null` は「同じ版がもう無い」＝消された・書き換わった）。
   *
   * 読み取りと同じ理由で、この発火の中で書き直す（器の一瞬の揺れで1周期ぶんの仕事を
   * 落とさない）。**それでも書けなければ動かない** — 動いた事実が外の世界にだけ残り、
   * `lastRunAt` が古いままだと、次の起動で「落ちている間に過ぎた予定」として同じ仕事を
   * もう一度起こす（取り消せない操作の二重実行は、1周期遅れるよりずっと高い）。
   */
  async #claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<
    { status: 'ok'; plan: ScheduledRequest | null } | { status: 'failed'; error: string }
  > {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        return {
          status: 'ok',
          plan: await this.#stores.schedules.claimRun(kind, expectedUpdatedAt, at, cause),
        };
      } catch (error) {
        last = String(error);
      }
    }
    return { status: 'failed', error: last };
  }

  /**
   * 引き受けた発火が終わったことを記録する。
   *
   * 書けなくても**ターンはもう走っている**ので、ここで止めるものは無い。印が残るぶん
   * 次の起動で配り直されるが、それは「消えるより配り直す」を選んだ結果である
   * （プロンプトには前の発火が終わっていないことを添えるので、二重に手を出す前に
   * クローンが `manager_list` と日誌を見られる）。
   */
  async #completeScheduledRun(
    kind: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt < SCHEDULE_STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_STORE_RETRY_MS * attempt));
      }
      try {
        await this.#stores.schedules.completeRun(kind, at, cause);
        return;
      } catch (error) {
        last = String(error);
      }
    }
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text:
        `定期の依頼 ${kind} の「終わった」を記録できなかった` +
        `（引き受けた印が残るので、次の起動で配り直される）: ${last}`,
    });
  }

  /**
   * 発火した kind を「読んで、その版で確定させる」まで通す。
   *
   * **読んだ本文で走るなら、走ると決めた時点でその版が生きていることを確かめる。**
   * 読みと記録が別操作だと、その隙間に人間が消した・直した依頼が古い本文で走る
   * （消した依頼が外の世界へ手を出したら取り返せない）。確定はストア側の1操作
   * （`claimRun`）に閉じてあり、ここはその周りの再試行と、版が入れ替わっていたときの
   * 読み直しだけを持つ。
   *
   * 版が入れ替わっていたら**新しい版を読み直して**そちらで確定させる。人間が直した
   * 直後なら、その新しい依頼で動くのが正しい（古い方で走らないことが最優先）。
   */
  async #claimScheduledRun(
    kind: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<
    | { status: 'ok'; plan: ScheduledRequest }
    /**
     * そもそも仕込みが無い kind だった（人間が手で `POST /schedule/:kind/run` を
     * 叩いた等）。本文が無いのは正常なので、記憶に照らして判断させる。
     */
    | { status: 'missing' }
    | { status: 'unreadable' | 'unrecordable' | 'withdrawn' | 'churning'; reason: string }
  > {
    // 一度でも依頼を読めていたなら、後から消えたのは「人間が消した」である。
    // 最初から無いのとは意味が違うので分ける（片方は動かさない、片方は判断させる）。
    let sawPlan = false;

    for (let round = 0; round < SCHEDULE_CLAIM_ROUNDS; round += 1) {
      const found = await this.#scheduledRequestFor(kind);
      if (found.status === 'unreadable') {
        return {
          status: 'unreadable',
          reason:
            `依頼を読めなかった（本文なしで曖昧に動かすより、次の発火で読み直す）: ` + found.error,
        };
      }
      if (found.plan === null) {
        return sawPlan
          ? {
              status: 'withdrawn',
              reason: '確定する前に人間がこの依頼を消した（取り消された仕事は動かさない）',
            }
          : { status: 'missing' };
      }
      sawPlan = true;

      const claimed = await this.#claimRun(kind, found.plan.updatedAt, at, cause);
      if (claimed.status === 'failed') {
        return {
          status: 'unrecordable',
          reason:
            `「起きた」を記録できなかった（動いてから記録できないと、次の起動で同じ仕事を` +
            `もう一度起こす）: ${claimed.error}`,
        };
      }
      // 確定できた。返るのは更新前の姿なので「前回いつ動いたか」も分かる
      if (claimed.plan !== null) return { status: 'ok', plan: claimed.plan };
      // 読んでから確定するまでに人間が消した・直した。新しい版で読み直す
    }
    return {
      status: 'churning',
      reason: '読むたびに依頼が書き換わっている（人間が直している最中なので次の発火に譲る）',
    };
  }

  /** 発意・定期ジョブに渡す直近の状況。 */
  async #recentDigest(): Promise<string> {
    try {
      return await buildActivityDigest(this.#stores, {
        since: new Date(Date.now() - RECENT_DIGEST_WINDOW_MS),
      });
    } catch (error) {
      return `（直近の状況をまとめられなかった: ${String(error)}）`;
    }
  }

  /**
   * 日報 — 人間が普段読む唯一の層（PRD「可観測性」）。
   *
   * クローンに `daily_report_write` で書かせるが、**書かれなかった日を作らない**。
   * 道具を呼び忘れたらその応答をそのまま日報にする。ここで穴が開くと、人間が
   * 見ようとしたときに見えないという、要件上バグとして扱う状態になる。
   *
   * ## **ターンが失敗したときの応答を日報にしないこと**
   *
   * 実際に起きた壊れ方は、日報の本文が丸ごと
   * `You've hit your org's monthly spend limit · ask your admin to raise it at …`
   * になっていた、というものである。直す前の `#runInternal` は戻り値が `string`
   * 一本で成否を運ばなかったので、ここは**エラーの文言を日報として保存した**。
   *
   * いまは `TurnOutcome` を見る。失敗したときに書くのは
   * `unavailable`（`schema.ts` の doc）の印が付いた行だけで、**本文は日報では
   * ないと分かる形にする**。
   */
  async #dailyReport(date: string): Promise<void> {
    const range = localDayRange(date);
    const digest =
      range === null
        ? await this.#recentDigest()
        : await buildActivityDigest(this.#stores, range).catch(
            (error: unknown) => `（この日の記録をまとめられなかった: ${String(error)}）`,
          );

    // **このターンへ何が入ったかを残す**（#243）。日報は結果（`daily_report` の行）
    // しか残っていなかったので、「何を材料に書いたか」が後から取れなかった。digest の
    // 全文は書かない（`turn-input.ts` の doc）。
    await this.#journal(turnInputEntry({ type: 'daily_report', date, digest }));

    const outcome = await this.#runInternal(buildDailyReportPrompt({ date, digest }));

    // **枠で保持しているなら、痕跡を1つも残さずに引き下がる。** この合図は
    // 捨てられておらず（`#pump` の `finally` が `defer` する）、枠が開いたら
    // 配り直されてこの関数がもう一度走る。ここで印だけでも書いてしまうと、
    // 下の早期 return と `missingDailyReportDates`（`schedule.ts`）の両方が
    // 「もう書いた」と判断して、**本物の日報が永久に書かれない**。
    if (outcome.status === 'failed' && outcome.heldForUsage) return;

    const written: JournalEntry[] = await this.#stores.journal
      .list({ types: ['daily_report'], limit: DAILY_REPORT_LOOKUP })
      .catch(() => []);
    const existing = written.filter(isDailyReport).filter((entry) => entry.date === date);
    // **印の付いた行は「日報がある」と数えない**（`schema.ts` の `unavailable` の
    // doc）。数えると、後から本物を書き直す道が閉じる。
    if (existing.some(isWrittenDailyReport)) return;

    if (outcome.status === 'failed') {
      // 印は1日1件でよい。**積むと人間が読む唯一の層が「作れなかった」で埋まる。**
      // 失敗が続いた回数は日誌（`#reportFailure`）に全部残っているので、ここで
      // 数える必要は無い。
      if (existing.length > 0) return;
      await this.#journal({
        type: 'daily_report',
        date,
        // **SDK の文言をそのまま残す**（人間が検索できる形。`usage-limits.ts` の
        // 「言い換えないこと」と同じ約束）。ただし日報の本文としてではなく、
        // 書けなかった理由として置く。
        body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${outcome.reason}）`,
        unavailable: outcome.reason,
      });
      return;
    }

    await this.#journal({
      type: 'daily_report',
      date,
      body:
        outcome.text.trim().length > 0
          ? outcome.text
          : '（クローンがこの日の日報を残さなかった。日誌から直接辿ること。）',
    });
  }

  /**
   * システムプロンプトはセッション開始時に固定されるので、走行中に人間が記憶を
   * 書き換えても届かない。ターンごとに差分を見て、変わっていたら本文の前に
   * 載せ直す（受け入れ基準3: 手編集が次の会話に反映されること）。
   *
   * **載せ直すのは実際に変わった文書だけである。** 記憶はもうシステムプロンプトに
   * 全文が載っており、そこへ全文をもう一度置けば、変わっていない文書まで二重に
   * 文脈へ載る。しかも載せ直した塊は会話の履歴として残るので、直すたびに写しが
   * 増え、resume でもそのまま運ばれる。「どの文書か」を指せる形（`slug.md` の
   * 見出し。システムプロンプトに載っているものと同じ見出しである）で差分だけを
   * 渡し、載っていない文書は変わっていないと明示する。
   *
   * **削除は名前だけで伝える。** 消えた文書の本文を載せ直す意味は無く、載せれば
   * 「消したのに文脈には居る」という一番まぎらわしい状態になる。
   */
  async #withFreshMemory(text: string): Promise<string> {
    let documents: MemoryDocument[];
    try {
      documents = await this.#stores.persona.documents();
    } catch {
      // 記憶が読めないことでターンまで止めない。**ただし `#memoryOnRecord` も
      // 触らない** — 触れば「載せた」ことになり、次のターンで差分が消える。
      return text;
    }

    const changed = documents.filter((doc) => this.#memoryOnRecord.get(doc.slug) !== doc.content);
    const present = new Set(documents.map((doc) => doc.slug));
    const removed = [...this.#memoryOnRecord.keys()].filter((slug) => !present.has(slug));

    // resume の断りは、載せ直すものが無くても1度だけ出す（それが目的である）。
    const resumeNotice = this.#resumedHistoryHasMemory ? RESUMED_MEMORY_NOTICE : null;
    this.#resumedHistoryHasMemory = false;

    if (changed.length === 0 && removed.length === 0) {
      return resumeNotice === null ? text : [resumeNotice, '', '---', '', text].join('\n');
    }

    this.#memoryOnRecord.clear();
    for (const doc of documents) this.#memoryOnRecord.set(doc.slug, doc.content);

    const head =
      '[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。' +
      '**変わった文書だけを載せる。ここに出ていない文書は変わっていない**' +
      '（システムプロンプトに載っているものが現在の内容である）。';

    return [
      ...(resumeNotice === null ? [] : [resumeNotice, '']),
      head,
      ...(changed.length === 0 ? [] : ['', renderMemoryDocuments(changed)]),
      ...(removed.length === 0
        ? []
        : ['', `削除された記憶: ${removed.map((slug) => `${slug}.md`).join(' / ')}`]),
      ...(documents.length === 0 ? ['', '（記憶は空になった）'] : []),
      '',
      '---',
      '',
      text,
    ].join('\n');
  }

  #pushInput(text: string): void {
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.#wakeInput();
  }

  #wakeInput(): void {
    const waiter = this.#inputWaiter;
    this.#inputWaiter = null;
    waiter?.();
  }

  async *#inputStream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.#input.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#stopped) return;
      // **認証トークンを回したので、このセッションを畳んで作り直す**（Issue #393 PR4）。
      //
      // **ここが「ターンの境界」である** —— 積まれた入力が無く（上の `shift` が
      // `undefined`）、走っているターンも無い（`#turn === null`）。
      //
      // ## 途中で畳んではいけない理由は2つあり、どちらも既定の設定で必ず踏む
      //
      // 1. **既定（`free_exhausted`）は `rejected` で回すが、そのターンは成功しうる**
      //    （課金枠で通る。`usage-limits.ts` の「1つぶんの状態でしかない」）。
      //    途中で畳むと**通るはずだった仕事を殺す**
      // 2. **`#read` の `finally` は、未完のターンが在ると失敗を報告する**
      //    （すぐ上の `if (turn) { … 'クローンのセッションが終了した' }`）。
      //    ⟹ 途中で畳むと、**回したことが依頼者には「セッションが終了した」という
      //    失敗として届く**
      //
      // **`#stopped` に相乗りしないこと。** あれはクローン全体の停止であり、
      // 混ぜると「トークンを回したらクローンが止まる」になる。
      if (this.#recycleForToken && this.#turn === null) {
        this.#recycleForToken = false;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#inputWaiter = resolve;
      });
    }
  }

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  async #ensureQuery(): Promise<void> {
    if (this.#query) return;

    const resume = await this.#stores.sessions.getCloneSessionId();
    this.#resumedFrom = resume;
    this.#sawInit = false;
    // **前のセッションで観測した値を持ち越さない。** ここを残すと、新しい
    // セッションの init が届く前（あるいは届かないまま）に `self_status` が
    // 前のセッションのモデル id や effort を「いまの値」として返す ＝
    // 観測していないものを確信することになる（`CloneRuntimeFacts` の約束）。
    this.#forgetObservedFacts();

    const q = this.#queryFn({
      prompt: this.#inputStream(),
      options: await this.#buildOptions(resume),
    });
    this.#query = q;
    this.#reader = this.#read(q);
  }

  async #buildOptions(resume: string | null): Promise<Options> {
    const documents = await this.#stores.persona.documents();
    const memory = renderMemoryDocuments(documents);

    // **焼き込んだ内容をそのまま「クローンが見たもの」として控える。** ここを
    // 控え損ねると、最初のターンでいきなり全文が載せ直される（システムプロンプト
    // と合わせて二重に載る）。読み直して比べるのではなく、載せた値を控えること —
    // 読み直すと、この行までの間に人間が直した場合に差分を見失う。
    this.#memoryOnRecord.clear();
    for (const doc of documents) this.#memoryOnRecord.set(doc.slug, doc.content);
    // 履歴に前のセッションの載せ直しが残っているのは resume のときだけである。
    this.#resumedHistoryHasMemory = resume !== null;

    const systemPrompt = buildCloneSystemPrompt({
      memory,
      ...(this.#self === undefined ? {} : { self: this.#self }),
    });
    this.#systemPromptChars = systemPrompt.length;
    this.#promptMemoryChars = memory.length;

    return buildCloneSessionOptions({
      model: this.#model,
      permissionMode: this.#permissionMode,
      mcpServer: this.#mcpServerFactory(this.#toolContext()),
      systemPrompt,
      env: this.#childEnv(),
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      resume,
      ...(this.#sessionStore === undefined ? {} : { sessionStore: this.#sessionStore }),
      onPreCompact: (input, _toolUseId, extra) => this.#onPreCompact(input, extra?.signal),
      // `self_status` の effort と、**クローンが自分の手を使った跡**をここで拾う
      // （後者は `#onPostToolUse` のコメント）。
      //
      // 1. **`PostToolUse` はツールの実行後に走るので、実行そのものを止められない**
      //    （`PreToolUse` と違ってここで判断を差し込む余地が無い＝観測専用として
      //    安全に足せる）。
      // 2. **`PreCompact` はセッション生涯に対して1本のフックであり、effort は
      //    載らない**（`BaseHookInput.effort` はツール実行の文脈で発火するフックに
      //    しか付かない）。だから既存の `PreCompact` はそのままにし、別の枠へ足す。
      // 3. **クローンは毎ターン MCP の道具を叩く。** `self_status` を呼ぶ時点までに
      //    別の道具呼び出しが1本挟まっていれば、その回で観測済みになっている。
      //    **例外はそのセッションで最初の道具呼び出しそのもの** — そのときはまだ
      //    どの `PostToolUse` も発火しておらず `effort` は `null` のままである
      //    （`CloneRuntimeFacts.effort` のコメントと同じ）。
      onPostToolUse: (input) => this.#onPostToolUse(input),
    });
  }

  /**
   * クローンの道具（インプロセス MCP）へ渡す context。**本セッション
   * （`#sessionOptions`）だけが呼ぶ。**
   *
   * **蒸留のサイドクエリ（`#distillFromTranscript`）はここを経由しない。**
   * 同じ形の context を、自分のインラインのオブジェクトリテラルとして
   * 別に組んでいる。**これは意図した設計であって、直し忘れではない** —
   * 統合すると振る舞いが変わってしまう点が2つある:
   *
   * - **`emit`** — 本セッションは実物の `this.#emit` を渡すが、サイドクエリは
   *   `() => undefined`（捨てる）。サイドクエリは `pre_compact` フックから走り、
   *   人間の会話に紐づいていない。しかも**本セッションのターンと同時に
   *   走りうる**ので、実物の `emit` を渡すとサイドクエリの出来事が人間の
   *   chat へ漏れる。
   * - **`managers`** — サイドクエリには渡さない。`ToolContext.managers` の
   *   doc が既に明言している通り、「省略できるのは蒸留用の短命セッションの
   *   ためで、そこではマネージャーを起こさない（記憶へ移すだけの内部
   *   ターン）」。
   *
   * **だから2つを1本の関数へ寄せない。** 寄せると上の2点の意図的な違いを
   * 表現できなくなる（`emit` を実物にしてしまう／`managers` を渡してしまう）。
   *
   * **この結果、`ToolContext` に新しい口を1つ足すときは、ここと
   * `#distillFromTranscript` のインラインのリテラルの2か所へ手で足す必要が
   * ある。** これがまさに「片方へ渡し忘れる」穴の形である — `runtime` が
   * まさにそれで、片方に足し忘れるとその場面だけ `self_status` が「取れない」
   * を返す。`memoryCause` にも同じ注意を書いてある
   * （`ToolContext.memoryCause` の doc）。
   *
   * **`runtime` は本セッションの private フィールドを読むだけの薄い closure。**
   * サイドクエリに渡しても、そちらの init やツール実行は反映されない
   * （`CloneRuntimeFacts.sessionId` のコメントの理由）。
   *
   * **`memoryCause` も同じ形の薄い closure。** ここが読むのは `this.#turn?.kind`
   * だけで、`#distillFromTranscript` 側は自分のインライン context に
   * `memoryCause: () => 'distill'` を固定で持たせている（あちらは常に
   * 蒸留のターンなので、`#turn` を読む必要が無い）。
   */
  #toolContext(): ToolContext {
    return {
      stores: this.#stores,
      emit: (event) => this.#emit(this.#turn?.conversationId ?? null, event),
      managers: this.#managers,
      ...(this.#profileService === undefined ? {} : { profile: this.#profileService }),
      ...(this.#accountUsage === undefined ? {} : { accountUsage: this.#accountUsage }),
      ...(this.#scheduler === undefined ? {} : { scheduler: this.#scheduler }),
      runtime: () => this.#runtimeFacts(),
      memoryCause: () => (this.#turn?.kind === 'distill' ? 'distill' : 'clone'),
    };
  }

  /** {@link CloneRuntimeFacts} を、いまの private フィールドから組み立てる。 */
  #runtimeFacts(): CloneRuntimeFacts {
    return {
      // **呼ぶたびに解決する（構築時に凍らせない）。** `resolveBuildRevision` は
      // 実行時の環境変数まで見るので、凍らせるとその経路が「起動時に在ったか」
      // しか答えられなくなる（`revision.ts`「環境変数は呼び出し時に読む」）。
      revision: resolveBuildRevision(),
      declaredModel: this.#model,
      modelOverridden: this.#modelOverridden,
      modelEnvKey: CLONE_MODEL_ENV_KEY,
      sdkModel: this.#sdkModel,
      effort: this.#effort,
      // alteroid はどこでも `options.effort` を渡していない（SDK の既定に任せている）。
      requestedEffort: null,
      claudeCodeVersion: this.#claudeCodeVersion,
      apiKeySource: this.#apiKeySource,
      permissionMode: this.#observedPermissionMode,
      requestedPermissionMode: this.#permissionMode,
      mcpServers: this.#mcpServersInfo,
      sessionId: this.#sdkSessionId,
      resumedFrom: this.#resumedFrom,
      injectedMemoryChars: this.#promptMemoryChars,
      systemPromptChars: this.#systemPromptChars,
    };
  }

  /**
   * SDK から観測した事実をすべて捨てる（セッションを開き直すとき）。
   *
   * **`#sdkModel` と `#effort` を残さないこと。** モデル帯の宣言は変わらなくても、
   * SDK 側の解決結果はセッションを開き直せば変わりうる（版が上がる／帯の別名が
   * 別の id を指す）。effort も同じで、次のセッションで観測し直すまでは
   * 「まだ分からない」が正しい。
   */
  #forgetObservedFacts(): void {
    this.#sdkModel = null;
    this.#effort = null;
    this.#claudeCodeVersion = null;
    this.#apiKeySource = null;
    this.#observedPermissionMode = null;
    // **`null` に戻す（`[]` ではない）。** セッションを開き直した直後は「まだ
    // 観測していない」であって「0本と観測した」ではない（#324）。`[]` に戻すと
    // 次の init が届くまでの窓で「0本」と嘘をつく。
    this.#mcpServersInfo = null;
    this.#sdkSessionId = null;
  }

  /**
   * init で SDK が報告してきた実行時の事実を、`self_status` の材料として控える。
   *
   * **`typeof` で検査し、読めない形は `null` のままにする。** 型定義の上では
   * どれも必須フィールドだが、ここで読み違えて例外を投げると本セッションの
   * 起動そのものが壊れる。読めなかったことは「まだ分からない」として出せば済む
   * （`describeCloneRuntime` 側の仕事）。**`mcp_servers` も同じ扱いにする（#324）**
   * —— この関数は init を観測した後にしか呼ばれないが、`mcp_servers` の形が
   * 読めなかったときにまで「0本」と主張する根拠は無い。読めた配列だけが「0本」
   * を名乗れる。
   */
  #captureInitFacts(message: SDKMessage): void {
    const raw = message as unknown as {
      session_id?: unknown;
      model?: unknown;
      claude_code_version?: unknown;
      apiKeySource?: unknown;
      permissionMode?: unknown;
      mcp_servers?: unknown;
    };
    this.#sdkSessionId = typeof raw.session_id === 'string' ? raw.session_id : null;
    this.#sdkModel = typeof raw.model === 'string' ? raw.model : null;
    this.#claudeCodeVersion =
      typeof raw.claude_code_version === 'string' ? raw.claude_code_version : null;
    this.#apiKeySource = typeof raw.apiKeySource === 'string' ? raw.apiKeySource : null;
    this.#observedPermissionMode =
      typeof raw.permissionMode === 'string' ? raw.permissionMode : null;
    this.#mcpServersInfo = Array.isArray(raw.mcp_servers)
      ? raw.mcp_servers.filter(
          (entry): entry is { name: string; status: string } =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { name?: unknown }).name === 'string' &&
            typeof (entry as { status?: unknown }).status === 'string',
        )
      : null;
  }

  /**
   * `PostToolUse` フックから effort の実効値と、**自分の手を使った跡**を拾う
   * （`#buildOptions` の hooks コメント参照）。
   *
   * ## なぜ日誌に残すのか
   *
   * `docs/architecture.md`「非対称な可視性」が名指しで求めている
   * — 「**どちらで見たかは日誌に残す。** 委譲が原則である理由（俯瞰と判断を守る）が
   * 守られているかは、禁止ではなく記録で見る」。道具を渡した以上、記録がここに
   * 無いと「委譲していない」が誰にも見えなくなり、方針が守られているかを見る手が
   * 禁止しか残らない。
   *
   * ## なぜ自作ツールを除くのか
   *
   * 自作ツール（`mcp__alteroid__*`）は**それ自身が跡を残す** — `memory_write` は
   * `memory_update`、`journal_write` は本文、`manager_start` は台帳と `tool_use`
   * （マネージャー側の記録）へ落ちる。ここで重ねて書くと、クローンは毎ターン
   * 数本の道具を叩くので日誌が自分の記録で埋まり、**掘るための層が掘れなくなる**。
   * 残すのは「委譲せずに自分で手を動かした」という、他のどこにも出ない事実だけで
   * よい（人間の MCP 連携も preset の道具と同じくここに載る — あちらも
   * 「自分でブラウザを開いた」側である）。
   *
   * **例外を投げないこと。** 投げるとツール実行の後続に影響しうる。読めない形なら
   * 何もしないだけで、道具の実行そのものは常に続ける（日誌の失敗も `#journal` が
   * 飲み込む）。
   */
  async #onPostToolUse(input: unknown): Promise<{ continue: true }> {
    // **`PostToolUseHookInput` の形として読む**（SDK の型。フィールド名の綴りを
    // ここで自前に決めない）。`unknown` から入るのはフックの引数が SDK 側で
    // 広い型になっているためで、読めない形でも投げないための検査は下でやる。
    const raw = input as Partial<PostToolUseHookInput> | null | undefined;
    const level = raw?.effort?.level;
    if (typeof level === 'string') this.#effort = level;

    await this.#journalToolUse(raw, CLONE_ACTOR_ID);
    return { continue: true };
  }

  /**
   * 蒸留のサイドクエリでの道具実行を日誌へ残す。
   *
   * **本セッションと同じ関数を通す。** 道具の配置を揃えたのだから記録も揃える
   * （片方だけ記録が無いと「蒸留のターンで何をしたか」がどこにも残らない）。
   * 違うのは actor だけで、**effort はここでは拾わない** — あちらは別セッション
   * なので、その値を本セッションの観測として持つと嘘になる。
   */
  async #onDistillToolUse(input: unknown): Promise<{ continue: true }> {
    await this.#journalToolUse(
      input as Partial<PostToolUseHookInput> | null | undefined,
      CLONE_DISTILL_ACTOR_ID,
    );
    return { continue: true };
  }

  /** `PostToolUse` の合図1件を日誌へ落とす（自作ツールは除く）。 */
  async #journalToolUse(
    raw: Partial<PostToolUseHookInput> | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    // 自作ツールは除く（上のコメント）。**`tool_name` が読めなかったときは
    // 落とさずに `(不明な道具)` で残す** — 除外の判定に使う名前が読めないなら、それは
    // 「自作ツールだった」ではなく「観測できなかった」である。黙って消すと、
    // 監査の穴がいちばん静かな形（何も起きなかったように見える）で空く。
    const tool = typeof raw?.tool_name === 'string' ? raw.tool_name : UNKNOWN_TOOL_NAME;
    if (tool.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return;
    await this.#journal({
      type: 'tool_use',
      actor: cloneToolActor(raw, mainThreadActor),
      tool,
      input: raw?.tool_input,
    });
  }

  /**
   * 確認へ上がらずに止められた1件を日誌へ残す。
   *
   * **生の合図（`system/permission_denied`）と `result.permission_denials` の
   * 両方から呼ばれる。** 前者は best-effort で取りこぼしうるが速く、後者は
   * authoritative だがターンの終わりにしか来ない。だから両方読み、`tool_use_id`
   * で二重書きを防ぐ（`runner.ts` の `#noteDenial` と同じ形）。
   *
   * **`tool_use` としては記録しない。** 拒否は「道具を使った」ではないので、
   * 混ぜると `digest` の「自分で手を動かした回数」が使えていない回数まで数える。
   */
  async #noteDenial(source: unknown, via: 'live' | 'result'): Promise<void> {
    const denial = source as
      | {
          tool_name?: unknown;
          tool_use_id?: unknown;
          decision_reason?: unknown;
          decision_reason_type?: unknown;
          message?: unknown;
        }
      | null
      | undefined;
    const tool = typeof denial?.tool_name === 'string' ? denial.tool_name : UNKNOWN_TOOL_NAME;
    // id が無ければ道具の名前で代用する。**取りこぼすより重複を許す。**
    const toolUseId =
      typeof denial?.tool_use_id === 'string' && denial.tool_use_id.length > 0
        ? denial.tool_use_id
        : `${tool}:${via}`;
    if (this.#deniedToolUses.has(toolUseId)) return;
    this.#deniedToolUses.set(toolUseId, true);

    // `decision_reason` / `decision_reason_type` / `message` は3つとも
    // `via: 'result'` では必ず欠け、`via: 'live'` でも SDK が付けてこなければ
    // 欠ける（`runner.ts` の `#noteDenial` と同じ前提）。**欠けているものは
    // 作り物を出さず、そのまま行を省く**（`manager.ts` の `permission_denied`
    // 受信での組み立てと同じ形）。
    const denialDetails = [
      typeof denial?.decision_reason_type === 'string'
        ? `分類: ${denial.decision_reason_type}`
        : undefined,
      typeof denial?.decision_reason === 'string' ? `理由: ${denial.decision_reason}` : undefined,
      typeof denial?.message === 'string' ? `モデルへの拒否文: ${denial.message}` : undefined,
    ].filter((line): line is string => line !== undefined);
    const why = denialDetails.length > 0 ? `（${denialDetails.join(' / ')}）` : '';
    await this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'inbound',
      text:
        `${tool} の実行が、確認へ上がらずに止められた${why}。` +
        `許可モードは ${this.#permissionMode} で、この層に確認を回す相手は居ない` +
        `（合図の出所: ${via}）。`,
    });
  }

  /**
   * クローンの SDK 子プロセスへ渡す env。
   *
   * **記憶ストアの鍵は落とさない。** ここはマネージャー（`runner.ts` の
   * `#childEnv`）と扱いが逆である — 伏せるのは「上（記憶）へ到達する鍵を
   * *下の層* へ配らない」ためであって、記憶の持ち主であるクローン自身から
   * 取り上げるためではない。取り上げれば、それはただのデグレードになる。
   */
  #childEnv(): NodeJS.ProcessEnv {
    // **鍵は呼ばれるたびに読み直す。** `this.#env` は構築時のスナップショットなので、
    // そのまま配ると人間（や回し手）が後から差し替えた鍵が永久に届かない
    // （`credentials.ts` / `runner.ts` の `#childEnv()` と同じ理由）。
    //
    // **重ね順は runner.ts と揃えてある** ——`env` → 鍵 → プロファイル。あちらの
    // doc が「プロファイルは鍵より後。人間が明示的に書いたほうが勝つ」と言っており、
    // **層ごとに順序が違うと「マネージャーには回るのにクローンには回らない」
    // （あるいは逆）が生まれる。** 規則は1つにする。
    //
    // **⚠️ この順序の帰結として、プロファイルが鍵と同じ名前を宣言していると
    // 鍵が黙って上書きされる。** 塞ぐのは順序ではなく検出のほうである
    // （`credentialNamesShadowedByProfile`。理由はあちらの doc）。
    // **セッションが起きるこの瞬間の身元を捕まえる**（`#sessionTokenIdentity` の doc）。
    // ここ以外で読み直すと、世代の照合が素通しになる。
    this.#sessionTokenIdentity = this.#tokenIdentity?.();
    return {
      ...this.#env,
      ...(this.#credentials?.() ?? {}),
      ...(this.#profile?.env() ?? {}),
    };
  }

  /**
   * 枠の観測を回し手へ渡す（Issue #393 PR3）。**判断はしない。**
   *
   * **投げてもターンを壊さない。** 回せなかったことは枠に当たったこととは別の
   * 失敗であり、後者の報告を前者で置き換えない——ここで投げ直すと、人間には
   * 「上限に当たった」ではなく「回し手が落ちた」だけが届く。
   */
  async #observeForTokenRotation(
    observation: Omit<TokenRotatorObservation, 'observedBy'>,
  ): Promise<void> {
    if (this.#onUsageObservation === undefined) return;
    try {
      await this.#onUsageObservation({
        ...observation,
        ...(this.#sessionTokenIdentity === undefined
          ? {}
          : { observedBy: this.#sessionTokenIdentity }),
      });
    } catch (error) {
      // **黙って握り潰さない。** 跡は残すが、ターンは続ける。
      noteDroppedRecord('認証トークンの切替', 'clone', error);
    }
  }

  /**
   * 要約に潰される直前に、全文をアーカイブへ落とし、そこから蒸留する。
   *
   * 蒸留は生存条件であり、後回しにしてよい機能ではない。ここで記憶へ移し損ねた
   * ものは、compaction のたびに人格の一部として失われる。
   */
  async #onPreCompact(input: unknown, signal?: AbortSignal): Promise<{ continue: true }> {
    const { session_id: sessionId, transcript_path: transcriptPath } = input as {
      session_id?: string;
      transcript_path?: string;
    };

    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
      return { continue: true };
    }

    try {
      // 退避するのは全文（ロードマップの要件）。蒸留に渡すのは末尾だけにする。
      const transcript = await readFile(transcriptPath, 'utf8');
      await this.#stores.archive.archive(sessionId ?? 'clone', transcript);
      if (signal?.aborted !== true) await this.#distillFromTranscript(tailOf(transcript));
    } catch (error) {
      // これはクローンの判断ではなくシステムの失敗なので、判断として記録しない
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `PreCompact の退避・蒸留に失敗した: ${String(error)}`,
      });
    }

    return { continue: true };
  }

  /**
   * 走行中のセッションは compaction 中なので、蒸留は別の短命セッションで行う。
   * 道具（記憶・日誌）は同じインプロセス MCP を渡すので、書き込み先は同じ。
   */
  async #distillFromTranscript(transcriptTail: string): Promise<void> {
    // ここは**別の短命セッション**なので、載せ直しの控え（`#memoryOnRecord`）は
    // 触らない。触ると本セッションの差分が消える。
    const memory = renderMemoryDocuments(await this.#stores.persona.documents());

    // **このターンへ何が入ったかを残す**（#243 の7本目）。本文は会話の生ログの
    // 末尾で、他の5経路の `digest` のように器から組み直せる寄せ集めではないので、
    // 長さに加えて指紋も書く（何を載せるかの判断は `turnInputEntry` に1本化して
    // ある）。
    await this.#journal(turnInputEntry({ type: 'pre_compact_distill', transcriptTail }));

    const prompt = [
      buildDistillPrompt('pre_compact'),
      '',
      '以下は、要約に潰される直前の会話の生ログ（末尾）である。',
      '',
      transcriptTail,
    ].join('\n');

    const side = this.#queryFn({
      prompt,
      options: buildCloneDistillOptions({
        model: this.#model,
        permissionMode: this.#permissionMode,
        // **蒸留のターンでも同じ道具を渡す。** ここだけ欠けていると、
        // 会話の最後に「鍵を実行環境へ移す」をやろうとして失敗する。
        //
        // **本セッションで観測した値をそのまま渡す。** ここだけ欠けていると、
        // 蒸留のターンだけ自分のことが分からないクローンになる
        // （`CloneRuntimeFacts.sessionId` のコメントの理由）。
        mcpServer: this.#mcpServerFactory({
          stores: this.#stores,
          emit: () => undefined,
          ...(this.#profileService === undefined ? {} : { profile: this.#profileService }),
          ...(this.#accountUsage === undefined ? {} : { accountUsage: this.#accountUsage }),
          ...(this.#scheduler === undefined ? {} : { scheduler: this.#scheduler }),
          runtime: () => this.#runtimeFacts(),
          // このサイドクエリ自体が常に蒸留のターンなので、`#turn` を読む必要は
          // 無い（`#toolContext()` の doc）。**ここを削ると `memoryCause` は
          // 既定の `'clone'` に落ち、蒸留が書いた記憶なのに `cause: 'clone'`
          // と名乗る**（`ToolContext.memoryCause` の doc の「渡し忘れ」）。
          memoryCause: () => 'distill',
        }),
        systemPrompt: buildCloneSystemPrompt({
          memory,
          ...(this.#self === undefined ? {} : { self: this.#self }),
        }),
        env: this.#childEnv(),
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
        onPostToolUse: (input) => this.#onDistillToolUse(input),
      }),
    });

    for await (const message of side) {
      if (message.type !== 'result') continue;
      // **このサイドクエリの `result` を読み捨てないこと。** ここが「要約のたびに
      // 払っている蒸留の費用」の唯一の観測点である。別の `query()` 呼び出しなので
      // 累積は1回で閉じており（SDK: 「during this query() call」）、値はこの1回の
      // 総量そのものである ＝ 基準を持たせない（`usage.ts` の `foldOneshotUsage`）。
      //
      // **これは「要約そのものの費用」ではない。** 要約を作る推論は本セッションの
      // `modelUsage` に合算されて分離できない（`usage.ts` の `usageSiteSchema`）。
      // 混ぜて名乗ると、取れていないものを取れたことにする。
      await this.#recordUsage(message, 'distill', 'oneshot');
      break;
    }
  }

  /**
   * `result` に載っている消費を台帳へ積む。
   *
   * **モデル id で層を代用しない。** `ALTEROID_CLONE_MODEL` を置けばクローンも
   * マネージャーと同じ opus で走るので、台帳では同じ `model` に並ぶ。層は
   * `layer` の列で言う（`usage.ts` の `usageLayerSchema`）。
   *
   * **台帳に積めないことでクローンのターンを止めない。ただし黙って消さない**
   * （`manager.ts` の `case 'usage'` と同じ作法）。
   */
  async #recordUsage(
    message: SDKMessage,
    site: UsageSite,
    accumulation: 'cumulative' | 'oneshot',
  ): Promise<void> {
    // 成功した result だけを通す。理由は `usage.ts` の `isSuccessResult`。
    if (!isSuccessResult(message)) return;
    const models = modelUsageOf(message);
    if (models === undefined) return;

    const sessionId = (message as { session_id?: unknown }).session_id;
    const snapshot: UsageSnapshot = {
      models,
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    };

    const at = new Date();
    try {
      const fold = await this.#stores.usage.record({
        layer: 'clone',
        site,
        managerId: CLONE_ACTOR_ID,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot,
        accumulation,
        // **セッションが起きた瞬間の身元を使う**（`#sessionTokenIdentity`）。
        // ここで `#tokenIdentity?.()` を読み直すと、回した直後に届いた**前の
        // セッションぶんの消費**が新しいトークンに付く（`store.ts` の
        // `UsageStore.record` の `tokenId` の doc）。
        //
        // **無いときは渡さない。** プールが空の器では毎回 undefined になり、
        // 台帳のトークン軸は空のまま ＝ 受け入れ基準7（既定の構成の挙動を
        // 1文字も変えない）。
        ...(this.#sessionTokenIdentity === undefined
          ? {}
          : { tokenId: this.#sessionTokenIdentity.tokenId }),
      });

      // **ターン1回ぶんの増分を日誌へ残す。** 台帳は日 × actor × モデル ×
      // 層 × 場所に畳むので、このターンがいくらだったかは台帳のどこにも
      // 残らない（`schema.ts` の `turn_usage` の doc）。
      //
      // **増分が空の回は行を書かない**（`hasAnyUsage` と同じ判定を
      // `fold.delta` に直接当てる — `foldUsageSnapshot` / `foldOneshotUsage`
      // は増えていないモデルの行を作らないので、キーが1つも無ければ「この
      // 回は増分ゼロだった」で確定する）。取れない軸に0の行を作らない
      // （AGENTS.md 地雷表）。
      if (Object.keys(fold.delta).length > 0) {
        await this.#journal({
          type: 'turn_usage',
          layer: 'clone',
          site,
          managerId: CLONE_ACTOR_ID,
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          models: fold.delta,
          ...(fold.reset === undefined
            ? {}
            : {
                reset: { fromCostUsd: fold.reset.fromCostUsd, toCostUsd: fold.reset.toCostUsd },
              }),
        });
      }

      // **数え直しを黙って通さない。** resume や mid-session の `/clear` で累積が
      // 0 に戻るのは正常だが、記録が無いと後から「なぜ集計が飛んでいるか」を誰も
      // 辿れない（PRD「可観測性」）。クローンは resume する層なので必ず起きる。
      if (fold.reset !== undefined) {
        await this.#journal({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text:
            `自分の消費の累積が数え直された（${fold.reset.fromCostUsd.toFixed(4)} → ` +
            `${fold.reset.toCostUsd.toFixed(4)}）。resume か /clear で SDK 側の累積が ` +
            '0 から始まったため。記録済みの分は保持している。',
        });
      }
    } catch (error) {
      // **跡がどこにも無いと「日誌に無い」が「起きなかった」と読める。**
      // `noteDroppedRecord` の作者の理由（ストアへの書き込みが失敗している
      // のに同じストアへ日誌を書こうとするのは循環である）は正しい。だから
      // stderr をやめて日誌にするのではなく、**両方を残す**。
      //
      // stderr は今回も残す（消さない） — 台帳の失敗を確実に名指しする跡が
      // 1本要る。下の `#journal` が失敗すればその跡は `#journal` 自身の
      // catch（stderr フォールバック）に落ち、「台帳が落ちた」という名指しが
      // 消えて「日誌を記録できませんでした」という別の文言に置き換わる。
      // stderr にこの行を残しておけば、その置き換わりが起きても「台帳が
      // 落ちた」という事実だけは残る。
      noteDroppedRecord('利用状況の台帳', `layer=clone site=${site}`, error);

      // **ここで日誌にも1件残す。** マネージャー層の `case 'usage'` の
      // `catch` は `exchange with=manager` を書いて日誌に跡を残すが、
      // クローン層はここが `noteDroppedRecord` だけで終わっていたため、
      // 台帳の記録が落ちたクローンのターンは日誌に `turn_usage` も
      // `exchange` も1行も残らなかった（`schema.ts` の `turn_usage` の
      // doc「行が無い理由は3つある」の2番）。
      //
      // **これは循環しない。** `#journal` は既に「best-effort で日誌へ
      // append し、失敗したら `noteDroppedRecord('日誌', ...)` で stderr に
      // 落とし、throw しない」という契約を持っている（`#journal` の実装を
      // 見よ）。だから日誌への追記そのものが失敗しても、それはここへ
      // 投げ返らず、`#journal` の中で吸収されて終わる。台帳への書き込みが
      // 失敗した状態で「同じ場所（台帳）へもう一度書きに行く」わけではなく、
      // 別のストア（日誌）へ1回だけ試すだけなので、堂々巡りにならない。
      //
      // `with: 'self'` を使うのは、これが人間に見せない内部ターンだから
      // （`schema.ts` の `exchange.with` の doc）。マネージャー層が
      // `with: 'manager'` を使うのと対応する。
      //
      // 文言はマネージャー層（`manager.ts` の `case 'usage'` の catch）と
      // 揃える。層ごとに言い方を変えると、読む側が層ごとに文言を覚える
      // ことになる。ただしマネージャー層は複数のマネージャーを区別する
      // ために `managerId` をタグとして前置しており、クローン層には
      // マネージャーのような複数性が無い代わりに `site`（`session` /
      // `distill`）が呼び出し文脈を区別する軸なので、同じ位置に `site` を
      // タグとして前置する。
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `[site=${site}] 消費を台帳へ記録できなかった（この分は集計に出ない）`,
      });
    }
  }

  async #read(q: Query): Promise<void> {
    let failure: string | null = null;

    try {
      for await (const message of q) {
        await this.#dispatch(message);
      }
    } catch (error) {
      failure = String(error);

      // init すら来ずに落ちたなら resume 素材が腐っている。捨てて作り直す。
      // 同一性はセッションではなく記憶に宿るので、捨てて困るものは無い。
      if (!this.#stopped && !this.#sawInit && this.#resumedFrom !== null) {
        await this.#stores.sessions.setCloneSessionId(null).catch(() => undefined);
      }
    } finally {
      if (!this.#stopped) {
        // result を伴わずに終わってもターンを取り残さない（取り残すと受信箱ごと止まる）
        const turn = this.#turn;
        if (turn) {
          await this.#reportFailure(
            turn.conversationId,
            failure ?? 'クローンのセッションが終了した',
          );
        }
        this.#finishTurn();
        this.#query = null;
        // 次のセッションは `#buildOptions` が控え直す。ここで空にしておかないと、
        // 前のセッションで見せた分を「もう見せた」と数えたまま新しいシステム
        // プロンプトを組むことになる（実際には焼き込み直すので嘘にはならないが、
        // 控えの出所が2か所になる）。
        this.#memoryOnRecord.clear();
      }
    }
  }

  async #dispatch(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.#sawInit = true;
          await this.#stores.sessions.setCloneSessionId(message.session_id).catch(() => undefined);
          this.#captureInitFacts(message);
          return;
        }
        // 確認へ上げずにその場で止められた1件（分類器・deny 規則・モード）。
        //
        // **`permissionMode: 'auto'` で `canUseTool` を繋いでいない以上、拒否は
        // 普通に起きる**（そのうえ `settingSources` で人間の deny 規則も読む）。
        // ここを捨てると、クローンの手が止められたことが日誌のどこにも出ない ＝
        // 「静かになった」と「起きていない」が区別できなくなる（`runner.ts` の
        // 同じ箇所と同じ理由。あちらは受信箱にも出すが、こちらは**自分が**
        // ツール結果でエラーを読むので、要るのは後から辿れる記録だけである）。
        if ((message as { subtype?: unknown }).subtype === 'permission_denied') {
          await this.#noteDenial(message, 'live');
          return;
        }
        // 上限の文言。**API エラーとしては来ない**（SDK のコメント）ので、
        // 通知・情報メッセージの本文を見るしかない（`runner.ts` の同じ場面と
        // 同じ理由 — マネージャー側だけがこれを見ていて、クローン側に無いのは
        // 非対称だった）。
        const said =
          message.subtype === 'notification'
            ? (message as { text?: unknown }).text
            : message.subtype === 'informational'
              ? (message as { content?: unknown }).content
              : undefined;
        if (typeof said === 'string') {
          const notice = classifyUsageNotice(said);
          if (notice !== undefined)
            await this.#noteUsageNotice(notice, this.#turn?.conversationId ?? null, 'text');
        }
        return;
      }

      // 枠の事実（アカウント単位）。**ターンの頭ごとに来る**ので、ここが走行中の
      // 唯一の最新情報になる（`runner.ts` の同じ場面と同じ理由）。
      case 'rate_limit_event': {
        const facts = toRateLimitFacts((message as { rate_limit_info?: unknown }).rate_limit_info);
        if (facts !== undefined) {
          // **回し手へは事実と遷移で渡す**（通知の形へ仕立て直したものではない）。
          // `#noteUsageNotice` の `source` の doc に理由がある。
          //
          // **状態ではなく遷移を渡す。** `rate_limit_event` はターンの頭ごとに
          // 来るので、状態をそのまま流すと同じ `rejected` で毎ターン回そうと
          // する。覚えるのは**重ねた形**（`mergeRateLimitFacts`）——届いた1件で
          // 丸ごと置き換えると、`status` を運んでいない観測が「もう知らせた」と
          // いう記憶を消す（あちらの doc）。
          const kind = facts.kind ?? '';
          const previous = this.#rateLimits.get(kind);
          const transition = usageTransitionOf(previous, facts);
          const merged = mergeRateLimitFacts(previous, facts);
          this.#rateLimits.set(kind, merged);
          if (transition !== undefined) {
            await this.#observeForTokenRotation({ facts: merged, transition });
          }
        }
        if (facts?.status === 'rejected') {
          await this.#noteUsageNotice(
            rejectedRateLimitNotice(facts),
            this.#turn?.conversationId ?? null,
            'rate_limit',
          );
        }
        return;
      }

      case 'stream_event': {
        const delta = textDelta(message.event);
        if (delta === null) return;
        const turn = this.#turn;
        if (turn) turn.streamed = true;
        this.#emit(turn?.conversationId ?? null, { type: 'text', text: delta });
        return;
      }

      case 'assistant': {
        const turn = this.#turn;
        const said = assistantTextOf(message.message);

        // **SDK が「これは応答ではない」と印を付けたメッセージは、応答として
        // 扱わない。** 支出上限（`billing_error`）・枠（`rate_limit`）・認証の失敗は
        // ここへ来る。直す前はこの印を1度も見ておらず、text ブロックを無条件に
        // `turn.text` へ足していたので、`You've hit your org's monthly spend limit …`
        // がそのままクローンの応答になり、日報の本文にまでなった。
        //
        // **本文は捨てず `turn.rejected` へ置く**（`resultFailureOf` と同じ材料として
        // `classifyUsageNotice` へ渡る）。人間へ `text` として流さないのは、
        // 「返答が来た」と見えてしまうからである — 終端は `result` の分岐が出す
        // `usage_limited` / `error` に任せる。
        const rejected = assistantFailureOf(message, said);
        if (rejected !== undefined) {
          if (turn) turn.rejected = rejected;
          return;
        }

        for (const block of contentBlocks(message.message)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            if (turn) turn.text += block.text;
            // 逐次配信が来ていない環境でも、人間に本文が届かないことは無いようにする
            if (!turn?.streamed) {
              this.#emit(turn?.conversationId ?? null, { type: 'text', text: block.text });
            }
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            this.#emit(turn?.conversationId ?? null, { type: 'tool', tool: block.name });
          }
        }
        return;
      }

      // 道具の結果が返った＝実行は終わり、モデルが次を考え始めた。ここで
      // 送り直さないと画面は `tool` の合図（「…を実行中…」）のまま止まり、
      // もう終わっている実行をまだ続いているように見せてしまう。
      // `tool_result` を含むときだけにしているのは、人間の発言のエコーや
      // replay（`SDKUserMessageReplay`）を「考え始めた」と読み違えないため。
      case 'user': {
        if (!contentBlocks(message.message).some((block) => block.type === 'tool_result')) return;
        this.#emit(this.#turn?.conversationId ?? null, { type: 'thinking' });
        return;
      }

      case 'result': {
        // **クローンの消費も台帳へ載せる。** ここを渡していなかったのは設計判断
        // ではなく抜けで（#45 の本文にも `usage.ts` にも「クローンの分は記録
        // しない」は無い）、その結果クローンは自分がいくら使ったかを読めなかった。
        // 人間は `claude.ai/settings/usage` で見られるので、これは能力の削除に
        // なっていた（north_star 禁止1）。
        await this.#recordUsage(message, 'session', 'cumulative');

        // **生の合図と `result` の両方を読む。** SDK は前者を best-effort と言い、
        // 「authoritative なのは `result.permission_denials`」と言っている。
        // **成否で絞らない** — 拒否は成功したターンにも失敗したターンにも載る
        // （`runner.ts` の同じ箇所と同じ判断）。二重に書かないのは `#deniedToolUses`。
        for (const denial of permissionDenialsOf(message)) {
          await this.#noteDenial(denial, 'result');
        }

        const turn = this.#turn;
        // 失敗の印は日誌へ書く前に決める（下の分岐と同じ材料を使う）。**本文を
        // 「クローンの発言」として無印で残せるかどうかがこれで変わる。**
        const failure = resultFailureOf(message) ?? turn?.rejected ?? undefined;

        if (turn && turn.text.trim().length > 0) {
          // 内部ターン（蒸留・自律）も必ず残す。見えない層を作らない。
          //
          // **失敗したターンの本文には印を付ける。** 本文を捨てないのは、人間は
          // それを画面で現に見ている（逐次配信）ので、履歴から消すと見たものが
          // 探せなくなるからである。**無印で残さないのは、日誌が digest を通って
          // 次の日報の材料になるからである** — 印が無いと「クローンがそう言った」
          // として翌日の日報に効いてしまう。
          await this.#journal({
            type: 'exchange',
            with: turn.conversationId === null ? 'self' : 'human',
            role: 'outbound',
            text:
              failure === undefined
                ? turn.text
                : `（このターンは失敗して終わった。以下は失敗する前に出ていた本文である）\n${turn.text}`,
            ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
          });
        }

        // **成否を見ずに `done` を出していたのがこの穴の本体である。** 直す前は
        // ここで `result` の成否を一度も見ておらず、`error_during_execution` や
        // 支出上限でターンが死んでも `{ type: 'done' }` が無条件に出て
        // `#finishTurn()` が呼ばれていた。`#read()` の `finally` に来た時点で
        // `this.#turn` は既に `null` なので `#reportFailure` は一度も呼ばれず、
        // 例外も起きないから `#handle` は正常終了し、受信箱の合図は `#forget`
        // されて消える — 支出上限でクローンのターンが死んでも、どこにも記録が
        // 残らなかった。**`runner.ts:1064` の
        // `if (isSuccessResult(message)) { ... } else { ... }` と同じ分岐をここにも
        // 置く**（マネージャー側にはこの分岐と回帰テストがあり、クローン側だけ
        // 無いのは非対称だった）。
        //
        // **判定は `isAnsweredResult` である（`isSuccessResult` ではない）。**
        // `subtype: 'success'` かつ `is_error: true` という組み合わせが SDK の型に
        // あり（`SDKResultSuccess.is_error`）、`isSuccessResult` はそれを成功として
        // 通す — 台帳の問い（累積を通してよいか）と応答の問い（答えとして扱って
        // よいか）が違うからである（`sdk-failure.ts` の表）。`#recordUsage` は
        // 上で `isSuccessResult` のまま通してあり、こちらだけを厳しくしている。
        //
        // **`turn.rejected` も見る**（`failure` は上で決めてある）。`assistant.error`
        // が付いたメッセージが来たターンは、たとえ `result` が綺麗な成功で返って
        // きても応答として扱わない。
        if (failure !== undefined) {
          // **枠（利用上限）の文言を見逃さない。** 分類にかけるのは
          // **「SDK が失敗として出した文言」だけ**である — `assistant.error` の
          // 本文・`result.result`・`result.errors[]` の3つ。`classifyUsageNotice` は
          // 部分一致なので、クローンが書いた本文（`turn.text`）をここへ通すと
          // 「上限に当たったと日報に書いた瞬間に上限と誤判定する」自家中毒に
          // なる（`sdk-failure.ts` の doc の順序）。
          //
          // `errors[]` を混ぜたのは `runner.ts:1111` に揃えるためで、直す前は
          // クローン側だけがこれを読んでいなかった。
          //
          // `reached` なら以降の合図を保持する側へ切り替わる（`#noteUsageNotice` が
          // `#usageBlocked` を立てる）。この `await` は下の `#reportFailure`
          // （`error` を emit する）より必ず先に終わる — `usage_limited` は終端では
          // ないので、終端の `error` より先に届いていなければならない。
          for (const candidate of [
            failure.text,
            resultBody(message),
            ...resultErrorLines(message),
          ]) {
            const notice = classifyUsageNotice(candidate);
            if (notice !== undefined) {
              await this.#noteUsageNotice(notice, turn?.conversationId ?? null, 'text');
              break;
            }
          }
          // 失敗した result では `done` を出さない。`#reportFailure` が出す
          // `{ type: 'error' }` を終端にする（成功したことにしない）。
          await this.#reportFailure(turn?.conversationId ?? null, failureReason(failure, message));
          // 失敗側でも必ず畳む。`#runTurn` は `#finishTurn()` が呼ぶ `turn.resolve()`
          // だけを待っており（`await done`）、`#handle`（`human_message` の分岐）は
          // その `#runTurn` を待つ。呼ばなければ `#runTurn` が永久に返らず、それを
          // 待つ `#handle` も返らず、`#handle` を待つ `#pump` の `for await` が
          // 次の合図へ進めない ＝ 受信箱ごと止まる。
          this.#finishTurn();
          return;
        }

        // **成功した result は「枠が開いている」ことの権威ある証拠なので、
        // ここで保持のスイッチを降ろす。** `rate_limit_event.status` は枠
        // 1つぶんの状態でしかない（`rateLimitFactsSchema` — `status` とは別に
        // `overageStatus` / `usingOverage` / `overageResetsAt` がある）。
        // つまり「`five_hour` が `rejected` でも課金枠（overage）に落ちて
        // ターンは成功する」という組み合わせが構造上ある — `usage-limits.ts`
        // の `usageTransitionOf` が `entered_overage` と名前まで付けている
        // **通常の遷移**であって、異常系ではない。
        //
        // 直す前は、ターン途中の `rate_limit_event`（`rejected`）で
        // `#usageBlocked` が立った後、同じターンの `result` が成功しても
        // それを見ずに `done` を出すだけだった。`#pump` の `finally` は
        // `#usageBlocked !== null` を見て `defer: true` にする（`#forget` しない）
        // ので、**答えが返って終わった合図が保持され、次の合図が来たときに
        // 同じ発言がもう一度処理される**（成功した仕事の二重実行。しかも
        // 「答えは返ったのに、もう一度同じことをやり出す」という、人間から
        // 見て最も分かりにくい壊れ方だった）。
        //
        // ここで降ろせば、`finally` は `#usageBlocked === null` を見て正しく
        // `#forget` する。**「試したら通った」を機構が自分で観測して状態を
        // 戻す**ことにもなり、タイマーを持たない設計（`#usageBlocked` の doc）
        // とも一貫する — 枠が開いたかを知る唯一の方法は試すことで、成功は
        // まさにその答えだからである。
        //
        // **`#usageNotices`（日誌の畳み込み）は降ろさない。** あれは「同じ
        // 文言を二度書かない」ためのもので、枠が開いたかどうかとは別の関心
        // である。
        this.#usageBlocked = null;
        this.#emit(turn?.conversationId ?? null, { type: 'done' });
        this.#finishTurn();
        return;
      }

      default:
        return;
    }
  }

  /** 日誌の書き込み失敗でクローンのセッションを殺さない。 */
  async #journal(entry: JournalEntryInput): Promise<void> {
    try {
      await this.#stores.journal.append(entry);
    } catch (error) {
      // 記録できないこと自体は致命ではない。文脈を失う方が高くつく。
      // **ただし黙って消さない。** 跡がどこにも無いと「日誌に無い」が
      // 「起きなかった」と読めてしまい、日誌を判別器に使った切り分けが
      // 静かに嘘をつく（本文を出さない理由は `noteDroppedRecord`）。
      //
      // **⚠️ ここから `#journal` を呼び直さないこと。** 日誌への書き込みが
      // 失敗した直後に日誌へ書き直そうとするのは、本物の循環である
      // （`noteDroppedRecord` の doc「ストアが閉じている窓で日誌へ書こうと
      // しても同じ理由で落ちるため」）。他の呼び出し元（`#recordUsage` 等）が
      // 「まず本来のストアへ書き、失敗したら `#journal` へ1回だけ試す」の
      // 形で二段構えにするのは循環にならないが、それはあちら側の話であって、
      // ここ（`#journal` 自身の失敗経路）から一歩でも日誌へ戻ろうとした
      // 瞬間に循環になる。stderr で止めるのはそのためである。
      noteDroppedRecord('日誌', journalEntryShape(entry), error);
    }
  }

  #finishTurn(): void {
    const turn = this.#turn;
    this.#turn = null;
    turn?.resolve();
    // **ここがターンの境界になった。** 回す印が立っていれば、入力待ちで止まって
    // いる `#inputStream` を起こして畳ませる（Issue #393 PR4）。起こさないと、
    // **次に入力が届くまで古いトークンのまま走り続ける。**
    if (this.#recycleForToken) this.#wakeInput();
  }

  #emit(conversationId: string | null, event: ChatStreamEvent): void {
    if (conversationId === null) return;
    for (const listener of this.#listeners.get(conversationId) ?? []) {
      try {
        listener(event);
      } catch {
        // 購読側の失敗でクローンを止めない
      }
    }
  }
}

/** 人間の発言1件。 */
export type HumanMessage = Extract<InboxEvent, { type: 'human_message' }>;

function isHumanMessage(event: InboxEvent): event is HumanMessage {
  return event.type === 'human_message';
}

/**
 * 人間の発言をターン1本の本文にする。
 *
 * **1件なら本文そのままである。** 断り書きを足さない — いちばん多いのがこの形で、
 * ここに `[system]` の節を載せると、普通の一往復のたびに読ませるものが増える。
 *
 * 複数件になるのは、先客が居るあいだに人間が喋り続けたときである（`#mergedHumanBatch`）。
 * そのとき渡すのは**全文を届いた順に並べたもの**で、要約も間引きもしない。
 *
 * **時刻を各件に添える。** 「3分空けて言い直した」と「続けて3行打った」は別の
 * 出来事で、後者なら最後の一行だけが本題のことがある。判断の材料はクローンに渡し、
 * どう読むかはこちらで決めない（プロンプトで「最後のものを優先せよ」とは書かない —
 * 前の依頼を取り消したのか、条件を足したのかは本文だけが持っている）。
 */
export function humanTurnText(events: HumanMessage[]): string {
  const head = events[0];
  if (head === undefined) return '';
  if (events.length === 1) return head.text;

  return [
    `[system] 前のターンを処理しているあいだに、人間から続けて **${events.length} 件** の発言が届いた。` +
      '届いた順に全文を渡す（要約していない）。',
    '**まとめて1つの応答で答えよ。** 1件目に答えたうえで、後の発言が' +
      'それを言い直している・取り消している・条件を足していることがある。**最後まで読んでから答えること。**',
    '',
    '---',
    '',
    ...events.map((event, index) => `**(${index + 1}) ${event.at}**\n\n${event.text}\n`),
  ].join('\n');
}

/**
 * 質問・許可確認が、いまも `ManagerPool` の `waiting` で待たれているかの3値。
 *
 * 2値にしない（`AGENTS.md`「静かに失敗する道具」— 判定できない場合がどちらかへ
 * 黙って倒れる）。**`'unknown'` は安全側（雑音）へ倒すためのものであって、
 * 「待っている」の言い換えではない** — `managerPrompt` はこれを `'live'` と
 * 同じ扱いにするが、根拠が無いことは呼び出し元がここで確定させる。
 */
type ConfirmationLiveness = 'live' | 'settled' | 'unknown';

/**
 * 報告（`kind === 'report'`）が、台帳で既に片付けられているかの3値（#391）。
 *
 * **2値にしない**（AGENTS.md「静かに失敗する道具」——判定できない場合が
 * どちらかへ黙って倒れる）。`'unknown'` は**安全側＝雑音側**（＝ふつうに全文を
 * 出す）へ倒すためのもので、`'open'` の言い換えではない。
 *
 * ## `'open'` は「まだ読んでいない」を意味しない
 *
 * クローンが閉じずに読んだ報告は `'open'` のままである。**この3値が保証するのは
 * 「閉じたものには印が付く」までであって、「印が無ければ未読」ではない。**
 */
type ReportSettlement =
  { kind: 'closed'; closedReason?: string } | { kind: 'open' } | { kind: 'unknown' };

/**
 * 片付け済みの報告に添える「閉じた理由」の長さ（#391）。
 *
 * **全文ではなく先頭だけでよい。** 目的は「自分がどういう判断で閉じたか」を
 * 思い出させることであって、判断そのものを読み直させることではない
 * （読み直すなら `commitment_list` に全文が在る）。
 */
const CLOSED_REASON_EXCERPT = 120;

/**
 * 報告の台帳項目を引いて、既に片付けられているかを答える（#391）。
 *
 * ## なぜ台帳を引くのか（質問側と材料が違う）
 *
 * 質問・許可確認は `managers.list()` の `waiting` に `requestId` が載っているかで
 * 「もう待たれていない」を判定できる（{@link confirmationLiveness}）。**報告には
 * `requestId` が無く、「待たれている」という状態がそもそも存在しない。** 報告に
 * おける「もう要らない」の合図は、**クローンが `commitment_close` で閉じたこと
 * そのもの**である。
 *
 * ## 「配り直しかどうか」を見ない —— それがこの判定の要点である
 *
 * `#redeliveredClosed` を引く既存の断り書きは、`#restoreUnread`（プロセスの生涯に
 * 1回だけ走る）が埋めた Map しか見ないので、**起動を跨がない配達には初めから
 * 対象外である。** そして `Clone#post()` は受信箱へ積む**前**に `#commit` を呼ぶので、
 * **台帳に本文が見えるのは `post()` 到達の瞬間であって、ターンへ配られた時点では
 * ない** —— クローンは配られる前の本文を台帳で読んで閉じられる。**その後に来る
 * 「初回配達」は配り直しではないので、配り直しの機構では原理的に捕まえられない。**
 *
 * **だからここでは配り直しかどうかを一切見ず、「いま配ろうとしているこの報告は、
 * 台帳で既に閉じているか」だけを見る。** #391 が未決のまま残した問い（初回配達か
 * 再配達か）に答えなくても、この判定は成り立つ。
 *
 * 追加の I/O は無い —— 台帳の id は `event.id` そのもの（{@link commitmentFor} の
 * `base`）で、`closedAt` / `closedReason` は `get(id)` の戻り値に載っている。
 */
async function reportSettlement(
  commitments: Stores['commitments'],
  id: string,
): Promise<ReportSettlement> {
  const commitment = await commitments.get(id).catch(() => null);
  // **引けなかったのと「無い」のを混ぜない。** `get` は無ければ `null` を返すが、
  // 投げたときもここで `null` に畳んでいる——どちらも「閉じていると言える根拠が
  // 無い」側なので、同じ `'unknown'` へ倒す。**`'open'` にはしない**：
  // 「開いている」は台帳を実際に読めたときにだけ言える。
  if (commitment === null) return { kind: 'unknown' };
  if (commitment.closedAt === undefined) return { kind: 'open' };
  return {
    kind: 'closed',
    ...(commitment.closedReason === undefined ? {} : { closedReason: commitment.closedReason }),
  };
}

/**
 * 片付け済みの報告に添える1行（#391）。**閉じた理由の先頭を一緒に運ぶ。**
 *
 * ## なぜ理由まで出すのか
 *
 * **誤って閉じたとき、誤りは「閉じた理由」に出る。** 実例（2026-08-24、台帳
 * `801f5ee7`）: クローンが「判断は求めていない」と書いて閉じたが、**本文の後半に
 * 依頼が入っていた。** 印だけでは「片付け済みだから読まなくてよい」と読めてしまい、
 * その誤りに気づく手がかりが1つも無い。
 *
 * **ただし本文の代わりにはならない。** 上の実例でクローンが気づけたのは本文の
 * 後半を読み直したからであって、閉じた理由を見たからではない。**だから本文は
 * 短くしない**（{@link managerPrompt} の doc）。
 *
 * `closedReason` が無ければ括弧ごと出さない（取れない軸に値を作らない）。
 */
function closedReportNotice(settlement: ReportSettlement): string | null {
  if (settlement.kind !== 'closed') return null;
  const why =
    settlement.closedReason === undefined
      ? ''
      : `（閉じた理由: 「${excerptLine(settlement.closedReason, CLOSED_REASON_EXCERPT)}」）`;
  return `この報告は台帳で既に片付けている${why}。読み直す必要は無い。`;
}

/**
 * `event`（質問・許可確認）が、いまも `managers.list()` の `waiting` に載って
 * いるかを確かめる。
 *
 * **配り直し（`#redelivered`）に限定しない。** 実測された再送は
 * `ManagerPool#emit`（`manager.ts`）が初回配達と同じ経路（毎回新しい
 * `event.id` を発行する）で届き、`#redelivered` の判定には乗らない。限定すると
 * この実例を取りこぼす——だから `manager_message` を受け取るたびに、ここで
 * 毎回確かめる。
 *
 * **競合の心配は無い。** `manager.ts` の `ask` 分岐は `record.waiting.push(...)`
 * → `#persist` → 日誌 → `#emit()` の順で動くので、**初回配達の時点で
 * `waiting` には既に載っている。** 「生きている確認を死んだと誤判定する」窓は
 * 無い。
 *
 * ⚠️ **ただし「答えたのに、まだ `waiting` に載っている」窓はある。** `manager.ts`
 * の `send()`（`manager_send` の実体）は `runner.answer()` が成功しても
 * `record.waiting` を同期では書き換えない。`waiting` からその requestId が
 * 消えるのは、あとから非同期で届く別種の `RunnerEvent`（`'settled'`）の
 * ハンドラだけである。**その窓の中で合図が配られると、ここは `'live'` を返し、
 * 従来どおり「まだ止まっている」の文言が出る。** 安全側（雑音）へ倒れている
 * ので方針には反しないが、「解決済みなら必ず正しい文言が出る」の保証では
 * ない——回答の受理そのものを冪等にしない限り、この窓は残る。
 *
 * **`event.managerId` に対応する要素が `list()` に無いときも `'unknown'`。**
 * 本物の配達では `#emit` の前に必ず `#persist` が通るので実際には起きないが
 * （委譲の記録が無いのに合図だけ届くことは無い）、起きたとしても「待たれて
 * いない」と決め打たず、確かめられなかった側へ倒す。
 */
async function confirmationLiveness(
  managers: ManagerPool,
  managerId: string,
  requestId: string,
): Promise<ConfirmationLiveness> {
  let summaries: ManagerSummary[];
  try {
    summaries = await managers.list();
  } catch {
    return 'unknown';
  }
  const summary = summaries.find((entry) => entry.managerId === managerId);
  if (summary === undefined) return 'unknown';
  return summary.waiting.some((item) => item.requestId === requestId) ? 'live' : 'settled';
}

/**
 * マネージャーからの一件をクローンの言葉に直す。
 *
 * ここに「何なら答えてよいか」の一覧を書かないこと。答えるか人間に回すかの線引きは
 * クローンが記憶として持っているものであり、書いた瞬間に人による違いが潰れる
 * （PRD「権限境界」/ AGENTS.md 地雷3）。
 *
 * `liveness` は `kind` が `question` / `permission` のときだけ意味を持つ
 * （`confirmationLiveness` の doc）。`report` では読まない。
 */
function managerPrompt(
  event: Extract<InboxEvent, { type: 'manager_message' }>,
  liveness: ConfirmationLiveness,
  settlement: ReportSettlement = { kind: 'unknown' },
): string {
  const head = `[system] マネージャー ${event.managerId} から届いた。`;

  if (event.kind === 'report') {
    const closed = closedReportNotice(settlement);
    return [
      `${head}（報告）`,
      '',
      event.text,
      '',
      // **印は本文の後ろ、指示の前に置く**（#391）。本文より前に置くと「読まなく
      // てよい」と読まれて本文を飛ばされる —— 本文を残した意味が消える。
      ...(closed === null ? [] : [closed, '']),
      '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。',
      '学びや判断の基準になったことがあれば記憶へ移すこと。',
    ].join('\n');
  }

  const label = event.kind === 'question' ? '質問' : '実行の許可確認';

  // **もう待たれていない確認は、答え直せと言わない。** 台帳が既に解決済みだと
  // 知っているものを「まだ止まっている」と偽ると、クローンが同じ requestId へ
  // 二重に答え、`manager_send` が「その確認は待っていない」と弾く（実測の
  // バグそのもの）。`liveness === 'unknown'` はここへは来ない——確かめられな
  // かった側は下の「生きている」と同じ文言（安全側＝雑音）へ倒す。
  if (liveness === 'settled') {
    return [
      `${head}（${label}）`,
      '',
      event.text,
      '',
      'この確認はもう待たれていない（既に解決したか、マネージャーが終わっている）。答え直す必要は無い。',
    ].join('\n');
  }

  // 宛先には requestId まで書く。同じマネージャーが同時に複数を待つことがあり
  // （1応答で並列に呼ばれた道具）、宛先を欠いた回答は宛先を推測できない。
  const to =
    event.requestId === undefined
      ? `managerId: "${event.managerId}"`
      : `managerId: "${event.managerId}", requestId: "${event.requestId}"`;

  return [
    `${head}（${label}）`,
    '',
    event.text,
    '',
    `返事をするまで ${event.managerId} のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。`,
    `記憶に根拠があるなら自分で決めて \`manager_send\`（${to}）で返し、その判断を \`journal_write\` に残せ。`,
    event.kind === 'permission' ? '許可確認なので `decision` に allow / deny を明示すること。' : '',
    `根拠が無いなら \`ask_human\` に ${to} を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。` +
      '（宛先を添えないと、人間が答えてもこの仕事を再開できない）',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 片付け済みの合図が配り直されたときの断り書き。本文の全文の代わりに配る。
 *
 * **依頼者の条件（1つでも欠けたら能力の欠落）を全部入れる**:
 * (1) 再起動後の配り直しであること (2) どの合図か（`inboxEventShape` を流用
 * — 既にこの用途で使われている本文を含まない見分け） (3) いつ受け取ったか
 * (4) クローンが既に閉じていること・閉じた時刻・`closedReason`（在れば）
 * (5) 全文の取り方 — 具体的な id か検索の手掛かり（`retrievalHintFor`）。
 *
 * **「全文は省略した」とだけ書かない。** 取り方が無い断り書きは、依頼者が
 * 明示的に禁止した形である。
 */
export function closedRedeliveryNotice(event: InboxEvent, commitment: Commitment): string {
  const closedReason =
    commitment.closedReason === undefined || commitment.closedReason === ''
      ? ''
      : `\n閉じた理由: ${commitment.closedReason}`;

  return [
    '[system] **これは再起動後の配り直しである。クローンは既にこの合図を片付けている。**',
    `合図: ${inboxEventShape(event)}`,
    `受け取った時刻: ${event.at}`,
    `片付けた時刻（commitment_close）: ${commitment.closedAt}${closedReason}`,
    '',
    '**本文は全文ではなく、この断り書きに縮めて配っている。** 片付け済みだと分かって' +
      'いるものを、再起動のたびに全文で読み直す費用を払わないためである。',
    retrievalHintFor(event),
    '',
    '片付け済みなので、あらためて手を動かす必要は無い。閉じた判断を思い出せず、' +
      '正しかったか確かめたいときだけ、上の手順で全文を読み直すこと。',
  ].join('\n');
}

/**
 * 全文の取り方（`closedRedeliveryNotice` の (5)）。**型ごとに違う。**
 *
 * `human_message` / `manager_message` / `external` は、この合図が処理される
 * たびに全文が日誌へ書かれる（`human_message` は `Clone#record`、他の2つは
 * `#handle` の型ごとの `#journal` 呼び出し。どちらも配り直しのこの回でも
 * 変わらず書く — `#restoreUnread` / `#handle` の当該コメントを見よ）ので
 * `journal_read` で取れる。
 *
 * **`human_answer` だけは違う。** 案内するのは `journal_read` ではなく
 * `approvals_list id=<approvalId>` である — `tools.ts` の `approvals_list` の
 * doc「答えが付いた件も読める」がその根拠。
 *
 * **#243 で `human_answer` 分岐も `#journal` を呼ぶようになった**（そのターンへ
 * 入った本文を `turnInputEntry` で残す）ので、日誌からも辿れるようにはなった。
 * **それでも案内はこのままにする** — 承認待ちの器は回答そのものを保つ器であって、
 * 日誌の追記は失敗を握り潰す（`#journal` の doc）。**必ず在る側を案内する**方が、
 * 「取り方が分かる体裁のまま実際には取れない」を作らない。
 */
function retrievalHintFor(event: InboxEvent): string {
  switch (event.type) {
    case 'human_answer':
      return (
        `全文の取り方: \`approvals_list\` に \`id: "${event.approvalId}"\` を渡す` +
        '（質問と回答の全文が返る。答えが付いた件も読める）。'
      );
    case 'external':
      return (
        `全文の取り方: \`journal_read\` に \`types: ["external_event"]\` と ` +
        `\`since: "${event.at}"\` を渡して絞り込む（source: ${event.source} の合図が処理される` +
        'たびに、この型で全文が日誌へ書かれる。この配り直しでも直前に書いている）。'
      );
    case 'human_message':
      return (
        `全文の取り方: \`journal_read\` に \`types: ["exchange"]\` と ` +
        `\`since: "${event.at}"\` を渡して絞り込む（会話 id: ${event.conversationId}。この合図が` +
        '配られるたびに、受理の瞬間の追記として全文が日誌へ書かれる。この配り直しでも既に書いて' +
        'ある）。'
      );
    case 'manager_message':
      return (
        `全文の取り方: \`journal_read\` に \`types: ["exchange"]\` と ` +
        `\`since: "${event.at}"\` を渡して絞り込む（マネージャー ${event.managerId} からの` +
        `${event.kind} が処理されるたびに、"[${event.managerId}/${event.kind}] " で始まる全文が` +
        '日誌へ書かれる。この配り直しでも直前に書いている）。'
      );
    // 台帳に載らない型（`commitmentFor` が `null` を返す）。`closedRedeliveryNotice`
    // はここへは来ない — `#redeliveredClosed` に載る id は必ず `commitmentFor` が
    // 非 null を返した合図の id である（`#restoreUnread` の doc）。
    case 'timer':
    case 'self_initiative':
    case 'distill':
      return '';
  }
}

/**
 * 合図から、台帳へ開く未了を作る。開かないものは `null`。
 *
 * **判定の基準は「誰かが渡してきたか」である。** 人間の発言・人間の回答・マネージャー
 * からの一件・外部イベントは、届いた時点で「始末をつける相手」が居る。時間起点の発火と
 * 発意 tick は起こされたこと自体であって渡されたものではないので開かない
 * （`Clone#commit` の doc に理由の全文）。
 *
 * **本文は全文を入れる。** 台帳の `body` を要約にすると、頼まれた内容そのものが
 * 二度と取れなくなる（切るのは表示側の仕事である）。
 */
export function commitmentFor(event: InboxEvent): Commitment | null {
  const base = { id: event.id, at: event.at };
  switch (event.type) {
    case 'human_message':
      return { ...base, origin: 'human', source: event.conversationId, body: event.text };
    // 人間が承認待ちへ答えた一件。**これも未了である** — 答えを受け取っただけでは
    // 何も進んでおらず、止まっているマネージャーへ `manager_send` で返して初めて
    // 仕事が再開する。宛先を添え損ねて再開しなかった前例があり（AGENTS.md「委譲」）、
    // そのとき人間の側からは「答えたのだから進んでいる」ようにしか見えない。
    case 'human_answer':
      return {
        ...base,
        origin: 'human',
        source: event.approvalId,
        body: `承認待ち ${event.approvalId} への回答: ${event.answer}`,
      };
    case 'manager_message':
      return {
        ...base,
        origin: 'manager',
        source: event.managerId,
        body: `[${event.kind}] ${event.text}`,
        // **`bodyMarkup` が指すのは `event.text`（接頭辞を除いた本体）である。**
        // `body` は `[${event.kind}] ` を前置した形なので、この印をそのまま
        // 持ち越すと、指す対象は接頭辞を含まない本体のまま揃う（表示側
        // `apps/web/app/routes/commitments.tsx` は接頭辞を剥がしてから
        // `bodyMarkup` を当てる、という前提が両側で一致している）。
        //
        // **印が無いイベント（`event.markup === undefined`）では、
        // `bodyMarkup` も立てず `undefined` のままにする。** 既定へ倒さない
        // （`textMarkupSchema` の doc、`packages/core/src/schema.ts`）。
        ...(event.markup === undefined ? {} : { bodyMarkup: event.markup }),
      };
    case 'external':
      return {
        ...base,
        origin: 'external',
        source: event.source,
        body: renderPayload(event.payload),
      };
    case 'timer':
    case 'self_initiative':
    case 'distill':
      return null;
  }
}

/**
 * 中身を持たない「見に行け」の合図か。
 *
 * 時間起点の発火と発意 tick だけがこれに当たる。どちらも materialize されるのは
 * 処理の瞬間（そこで最新の状況をまとめ直す）なので、読まれる前の重複には情報が無い。
 */
function isTick(event: InboxEvent): boolean {
  return event.type === 'self_initiative' || event.type === 'timer';
}

function isSameTick(a: InboxEvent, b: InboxEvent): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'self_initiative') return true;
  if (a.type === 'timer' && b.type === 'timer') {
    // 対象日が違えば別の仕事（別の日の日報は畳めない）。手で起こした分と定期の
    // 発火も別物である（前者は予定をずらさない＝記録先が違う）ので畳まない。
    return a.kind === b.kind && a.target === b.target && a.cause === b.cause;
  }
  return false;
}

/** 外部から届いた中身を、そのままクローンに読ませられる形にする。 */
function renderPayload(payload: unknown): string {
  // 中身なしの通知（source だけ）もある。`undefined` という文字列を読ませない。
  if (payload === undefined || payload === null || payload === '') {
    return '（中身のない通知。source だけが届いた。）';
  }
  const body = typeof payload === 'string' ? payload : safeJson(payload);
  return body.length > EXTERNAL_PAYLOAD_LIMIT
    ? `${body.slice(0, EXTERNAL_PAYLOAD_LIMIT)}\n…（以下省略）`
    : body;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

interface Block {
  type?: string;
  text?: unknown;
  name?: unknown;
}

function contentBlocks(message: unknown): Block[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

/**
 * assistant メッセージの text ブロックを1本に繋いだもの。
 *
 * **失敗の印が付いたメッセージの本文を取り出すためにある**（`sdk-failure.ts` の
 * `assistantFailureOf` へ渡す材料）。応答の積み上げ側（`#dispatch` の `assistant`）が
 * ブロックごとに `emit` するのと役割が違うので、そちらは書き換えていない。
 */
function assistantTextOf(message: unknown): string {
  let text = '';
  for (const block of contentBlocks(message)) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * どの層の手だったかを `PostToolUse` の合図から決める。
 *
 * **`agent_id` で見る**（SDK: "Use this field (not agent_type) to distinguish
 * subagent calls from main-thread calls"）。クローンは preset 一式を持つので
 * `Task` も持っており、サブエージェントの中の道具実行もこのフックを通って来る。
 * ここを分けないと「クローンが自分で叩いた回数」がサブエージェントの分だけ
 * 膨らみ、**日誌が答えるべき問い（自分でやったのか委ねたのか）に嘘の数を返す。**
 */
function cloneToolActor(
  hook: { agent_id?: unknown; agent_type?: unknown } | null | undefined,
  mainThreadActor: string,
): string {
  if (typeof hook?.agent_id !== 'string' || hook.agent_id.length === 0) return mainThreadActor;
  const type =
    typeof hook.agent_type === 'string' && hook.agent_type.length > 0
      ? hook.agent_type
      : UNKNOWN_AGENT_TYPE;
  return `${CLONE_SUB_ACTOR_PREFIX}${type}`;
}

/** `result` に載っている拒否の記録（authoritative な側）。無ければ空。 */
function permissionDenialsOf(message: SDKMessage): unknown[] {
  const denials = (message as { permission_denials?: unknown }).permission_denials;
  return Array.isArray(denials) ? denials.filter((entry) => entry !== null) : [];
}

function textDelta(event: unknown): string | null {
  const candidate = event as {
    type?: string;
    delta?: { type?: string; text?: unknown };
  };
  if (candidate.type !== 'content_block_delta') return null;
  if (candidate.delta?.type !== 'text_delta') return null;
  return typeof candidate.delta.text === 'string' ? candidate.delta.text : null;
}

/**
 * 失敗を1行の理由にする。
 *
 * **`runner.ts` の `resultText()` と役割は同じだが、共有化はしない** — あちらは
 * `result` の本文と `subtype` のどちらか一方だけを返す作り（本文があれば本文、
 * 無ければ `（結果なしで終了: subtype）`）だが、ここは**両方を必ず載せる**。
 * 支出上限のとき SDK は `subtype: 'error_during_execution'` と
 * `result: "You've hit your individual spend limit..."` を両方運んでくる。
 * 片方だけにすると「上限で止まった」と「ただ失敗した」が区別できなくなる
 * （`runner.ts` の `else` 側のコメントと同じ理由）。5行程度の重複は許容する。
 *
 * **印の出どころ（`via`）も載せる。** `assistant.error` で止まったのか、
 * `result.subtype` が失敗だったのか、`subtype: 'success'` なのに `is_error` が
 * 立っていたのかは、**次に同じことが起きたときの掘り始めの位置が違う**。
 */
function failureReason(failure: SdkFailure, message: SDKMessage): string {
  const body =
    failure.text.length > 0
      ? failure.text
      : resultBody(message).length > 0
        ? resultBody(message)
        : (resultErrorLines(message)[0] ?? '（本文なし）');
  return `結果なしで終了: ${failure.code}（${failure.via}） / ${body}`;
}

/**
 * `result.result`（本文）だけを取り出す。無ければ空文字。
 *
 * `resultFailureReason` と同じ材料を見るが、あちらは `subtype` と結合した
 * 表示用の1行を作る一方、こちらは `classifyUsageNotice` に渡す生の文言が要る
 * （SDK の上限の文言は `result` にしか乗らない）。
 */
function resultBody(message: SDKMessage): string {
  const candidate = message as { result?: unknown };
  return typeof candidate.result === 'string' ? candidate.result : '';
}

/**
 * `rate_limit_event` の `status: 'rejected'` を上限の合図に仕立てる。
 *
 * **文言を捏造しない。** SDK の上限プレフィックス集合に文言を足すのではなく、
 * `rate_limit_info` が持つ構造化事実（`kind` ＝ `rateLimitType`）をそのまま
 * 添えるだけにする。`classifyUsageNotice` を通していないので `text` は
 * 「SDK が出した文言そのまま」ではないが、`status: 'rejected'` 自体が
 * SDK 側の権威ある値であり、これも自前の正規表現ではない。
 */
function rejectedRateLimitNotice(facts: RateLimitFacts): UsageLimitNotice {
  return {
    kind: 'reached',
    text: `rate_limit_event: status=rejected${facts.kind === undefined ? '' : `（kind: ${facts.kind}）`}`,
  };
}

/**
 * 蒸留に渡す末尾。全文はアーカイブに残っているので、ここでは直近だけでよい。
 * 行の途中と壊れた文字で始めないように整える。
 */
function tailOf(transcript: string): string {
  if (transcript.length <= DISTILL_TRANSCRIPT_TAIL_BYTES) return transcript;
  const cut = transcript.slice(-DISTILL_TRANSCRIPT_TAIL_BYTES);
  const newline = cut.indexOf('\n');
  return newline === -1 ? cut : cut.slice(newline + 1);
}
