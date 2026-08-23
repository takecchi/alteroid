import { z } from 'zod';

import { type RunnerRevisionReport } from './revision.js';
import { jobStatusSchema } from './schema.js';
import { rateLimitFactsSchema, usageLimitNoticeSchema } from './usage-limits.js';
import { usageTotalsSchema } from './usage.js';

/** ISO8601 の日時（offset 必須）。`schema.ts` の同名の private const と同じ形。 */
const isoDateTime = z.string().datetime({ offset: true });

/**
 * デーモン ↔ manager-runner の境界（roadmap M4）。
 *
 * **なぜ分けるのか。** マネージャーはデーモンと同じ器で走る限り、`/proc/1/environ`
 * からデーモンの環境変数（＝記憶ストアの接続情報）に届く。ツールを削って塞ぐのは
 * 禁止されている（north_star 禁止2）ので、**実行環境を分ける**。
 *
 * この境界で守っている向きは2つある。
 *
 * - 下向き（デーモン → runner）: 命令だけが降りる。判断は降ろさない。runner は
 *   SDK セッションの start / send / stop / resume と、その出来事の返送しかしない。
 *   権限の一覧も、確認してよいことの表も runner には無い（判断はクローンの仕事）
 * - 上向き（runner → デーモン）: **接続を張るのは常にデーモン側**である。runner は
 *   デーモンの所在も鍵も持たない。持たせた瞬間、runner の中の子プロセス（＝
 *   マネージャー）がその鍵で記憶へ届く経路ができる
 *
 * だからイベントは「デーモンが開いたストリームを runner が流れ落とす」形にしてある。
 * 逆向きのコールバック URL を足さないこと。
 *
 * **この境界を跨ぐと `undefined` の意味が変わる。実測（#223）:**
 *
 * ```
 * key 無し                 : false   ← 実機（JSON を通った後）
 * key 有り value=undefined : true    ← 同一プロセスのテスト
 * ```
 *
 * **同一プロセスのテストは、この境界の壊れ方を再現しない。** `JSON.stringify`
 * は値が `undefined` のキーを丸ごと落とすので、実機（`apps/runner/src/app.ts`
 * が HTTP で送り出し、デーモン側が `JSON.parse` で受け取る）では**キーが
 * 存在しない**形になる。同一プロセスで組み立てたオブジェクト（`{ input:
 * undefined }` のようなもの）は**キーが残る**ので、zod 4 の必須欄
 * （`z.unknown()` / `z.string()` を `.optional()` なしで書いた欄）でも
 * `safeParse` を通ってしまう ── テストだけが緑で、実機だけが壊れる。
 *
 * だから**この境界の回帰テストは、必ず `JSON.parse(JSON.stringify(...))` を
 * 通すか、HTTP 境界を実際に越える `apps/daemon` 側で書くこと**。同一プロセス
 * のテスト（例: `runner-local.ts` を使うもの）だけでは、この境界がまさに
 * 壊れる形を守れない。
 *
 * 実例が #223 である。走行中の合図（`system/permission_denied`）の `via:
 * 'live'` では `tool_input` が SDK 側に存在せず、`input` を必須のままにして
 * いたため、この形の拒否が**8日間、デーモンへ一切届かなかった**。同一プロセス
 * のテストは（`input` がキーとして残っていたので）その間ずっと緑のままだった。
 */

/**
 * 確認の種別。**質問（`AskUserQuestion`）か実行許可か**を運ぶ。
 *
 * runner 側で決まる（`RunnerSession#onPermission` の `kind`）。`ask` イベント
 * （下）が既にこの値を運んでいるが、`state()` が返す `waiting`（`runnerWaitingSchema`）
 * には運んでいなかった——デーモン再起動後の引き取り（`manager.ts` の
 * `#restoreJobs`）はこちらを通るため、そこだけ種別が消える形になっていた（#334）。
 * 定義を1箇所にして、両方が同じ2値を指すようにする。
 */
export const waitingKindSchema = z.enum(['question', 'permission']);

export type WaitingKind = z.infer<typeof waitingKindSchema>;

/**
 * 1つの確認（許可確認 / 質問）。runner 側で1件だけが返事を待って止まる。
 *
 * **`kind` と `askedAt` はどちらも `.optional()`。** runner とデーモンは別の
 * Railway Service で、別々にデプロイされる。`drainingSeconds` の猶予の間、
 * 畳まれつつある旧 runner は `/health` にも `/managers` にも答え続け、起動時
 * の引き取りがそれを見て「生きている」と判断した直後に SSE が新しい器へ
 * 繋がる、という順序が普通に起きる（`railway/README.md`「4. 落ちた側を待つ /
 * 取り直す」）。その窓では旧 runner の `/managers` 応答にこの2つが乗らない。
 *
 * **必須のままだと `runner-client.ts` の `RunnerHttpClient#list()` が
 * `safeParse` に落ち、`flatMap` で要素ごと黙って捨てる。** すると
 * `manager.ts` の `alive.has(job.id)` が偽になり、`record.waiting = []` で
 * 待っていた確認まで捨てられて、返事待ちのマネージャーだけが起こし直される
 * ——`kind`/`askedAt` を足した本来の目的が、それ自身の必須化で壊れる形に
 * なっていた。**欠けたまま運ぶ。デーモン側で既定値は作らない**
 * （`AGENTS.md`「取れない軸に0の行を作る」——`askedAt` を「取れなければいま」
 * で埋めると、値の意味が経路によって変わってしまう）。
 */
export const runnerWaitingSchema = z.object({
  requestId: z.string(),
  summary: z.string(),
  kind: waitingKindSchema.optional(),
  /**
   * **runner がこの確認を SDK から受け取った時刻**（ISO8601, UTC）。
   *
   * 「回答が来た時刻」でも「デーモンが知った時刻」でもない——値の持ち主は
   * `RunnerSession#onPermission`（`runner.ts`）が確認を組み立てる、その
   * 1箇所だけである（#334。#323 の「報告が何時間も遅れても人間には分から
   * ない」を、待ちの側にも塞ぐ材料）。
   */
  askedAt: isoDateTime.optional(),
});

export type RunnerWaiting = z.infer<typeof runnerWaitingSchema>;

/** runner が持っている1セッションの状態。 */
export const runnerManagerStateSchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  cwd: z.string(),
  request: z.string(),
  waiting: z.array(runnerWaitingSchema),
  sessionId: z.string().optional(),
});

export type RunnerManagerState = z.infer<typeof runnerManagerStateSchema>;

// ---------------------------------------------------------------------------
// デーモン → runner（命令）
// ---------------------------------------------------------------------------

/**
 * 貸し出し期限（lease）の世代番号（fencing token）と、貸し出し先が自分で畳むまでの
 * 猶予（roadmap M5 PR4）。**任意である。**
 *
 * **省略できる。** 名乗らない（＝この口を知らない）古いデーモンとも繋がるため —
 * 無ければ runner は今までどおり動く（`packages/core/src/runner-local.ts` のような、
 * lease を一切知らない既存の呼び出しを1つも壊さない）。
 *
 * runner（`runner.ts` の `Host`）はセッションごとに最後に受け取った `fence` を覚え、
 * それより古い世代の命令を拒む（`RunnerFenceError`）。`ttlMs` は自己失効
 * （`RunnerHostOptions.enforceLease`）が使う — デーモンと連絡が取れないまま
 * この猶予を過ぎたら、runner は自分でこのセッションを畳む。
 */
export const runnerLeaseSchema = z.object({
  fence: z.number().int().nonnegative(),
  ttlMs: z.number().int().positive(),
});

export type RunnerLease = z.infer<typeof runnerLeaseSchema>;

export const runnerStartCommandSchema = z.object({
  managerId: z.string().min(1),
  request: z.string().min(1),
  /** 実プロジェクトの作業ディレクトリ（runner から見たパス）。 */
  cwd: z.string().min(1),
  /** **新しいセッションなので、runner は世代を覚えるだけ**（拒む判定はしない）。 */
  lease: runnerLeaseSchema.optional(),
});

export type RunnerStartCommand = z.infer<typeof runnerStartCommandSchema>;

/**
 * 中断されたセッションの続きへ戻す。
 *
 * `entries` は生ログそのもの。**runner のディスクに残っている前提を置かない** —
 * 器が作り直されていれば消えているので、デーモンが持っている分を渡して
 * materialize させる（SDK の SessionStore.load がこれを返す）。
 */
export const runnerResumeCommandSchema = z.object({
  managerId: z.string().min(1),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  request: z.string().min(1),
  /** resume 直後に流す一言。省略すると開くだけで手は動かない。 */
  message: z.string().optional(),
  entries: z.array(z.unknown()).optional(),
  /**
   * **ここが fencing の主戦場である。** 走っているセッションへ resume が来たとき
   * （器の入れ替え後、旧い器から遅れて届いた命令など）、runner は覚えている世代と
   * 比べる。古ければ `RunnerFenceError` を投げて**このセッションには一切触れない**。
   */
  lease: runnerLeaseSchema.optional(),
});

export type RunnerResumeCommand = z.infer<typeof runnerResumeCommandSchema>;

/**
 * **`lease` を持たせない。** これは既に開いている（＝ `start` / `resume` を通って
 * 世代の検査を済ませた）セッションへ届く命令であって、世代を新しく主張する側では
 * ない。世代で締め出されたプロセスのセッションは、そのプロセス自身が自己失効
 * （`RunnerHostOptions.enforceLease`）で畳むので、この口に世代の検査を重ねる
 * 必要が無い。
 *
 * 検査の口を `start` / `resume` の2つに絞ることで、`RunnerClient.send` / `answer`
 * の署名（`(managerId, text)` / `(managerId, answer)`）を変えずに済む —
 * 命令の意味が変わらないところに新しい任意フィールドを増やさない、というだけの
 * 選択である。
 */
export const runnerMessageCommandSchema = z.object({ text: z.string().min(1) });

/**
 * マネージャーの道具の鍵の差し替え（roadmap M4 の穴埋め）。
 *
 * **なぜ命令として降ろすのか。** 鍵を runner の環境変数で配ると、値は runner の
 * プロセスが起動した瞬間に凍る。人間が鍵を直しても、器を作り直すまで届かない —
 * つまり「鍵を直す」と「走行中の仕事を失う」が同じ操作になる。ここを通せば、
 * 器はそのままで鍵だけが回る。
 *
 * これは判断ではなく事実の伝達である（何を許すかの表ではない）。
 */
export const runnerCredentialSchema = z.object({
  /**
   * 環境変数の名前そのもの。**自由な文字列にしない。**
   *
   * ここを緩くしていたせいで `../../../etc/cron.d/x` のような名前がそのまま
   * ファイル名になり、root で器の外へ書けた。名前は器の中のファイル名になるので、
   * パスとして解釈されうる形を最初から名前として認めない。
   */
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z][A-Z0-9_]*$/, '鍵の名前は英大文字・数字・_ のみ'),
  /** 空文字は「鍵を外す」。未設定へ戻す意思を表せるようにしてある。 */
  value: z.string(),
});

export const runnerSetCredentialsCommandSchema = z.object({
  credentials: z.array(runnerCredentialSchema).min(1),
});

export type RunnerSetCredentialsCommand = z.infer<typeof runnerSetCredentialsCommandSchema>;

/** 鍵が合っているかを**値を出さずに**照合するための指紋。 */
export const runnerCredentialFingerprintSchema = z.object({
  name: z.string(),
  /** sha256（16進）の先頭12桁。 */
  sha256: z.string(),
  updatedAt: z.string(),
});

export type RunnerCredentialFingerprint = z.infer<typeof runnerCredentialFingerprintSchema>;

/**
 * 実行環境プロファイル（`.zprofile` 相当）の差し替え。
 *
 * **なぜ命令として降ろすのか。** 鍵と同じ理由である。runner の環境変数として
 * 配ると値は起動時に凍り、人間が直しても器を作り直すまで届かない。加えて、
 * **runner に記憶ストアを読ませない**という境界がある以上、runner が自分で
 * 取りに行くことはできない（M4 受け入れ基準3）。だから降ろす。
 *
 * 中身は解釈しない。**環境変数の一覧を持たない**のがこの口の要点で、名前検査を
 * 足したくなったら、それは `credentials` の口の仕事である。
 */
export const runnerSetProfileCommandSchema = z.object({
  /** シェルスクリプトそのもの。空文字は「プロファイルを外す」。 */
  script: z.string(),
});

export type RunnerSetProfileCommand = z.infer<typeof runnerSetProfileCommandSchema>;

/** 置いてあるプロファイルの同一性。**本文は返さない。** */
export const runnerProfileFingerprintSchema = z.object({
  /** 人間が書いた本文の sha256（16進）先頭12桁。 */
  sha256: z.string(),
  bytes: z.number(),
  updatedAt: z.string(),
});

export type RunnerProfileFingerprint = z.infer<typeof runnerProfileFingerprintSchema>;

/**
 * 差し替えの結果。**「置けた」で終わらせない。**
 *
 * プロファイルは人間が書いたシェルスクリプトなので、構文を間違えれば読み込みが
 * 失敗する。そのまま置くと、以後すべてのコマンドが壊れた環境で走り、原因は
 * どこにも出ない。だから置いた直後に1度評価して、**結果を人間へ返す**。
 */
export const runnerProfileResultSchema = z.object({
  profile: runnerProfileFingerprintSchema.optional(),
  /** 置いたものが実際に読めたか。 */
  ok: z.boolean(),
  /** 読めなかった理由。 */
  error: z.string().optional(),
  /** プロファイルが出した出力（人間が原因を見るための窓）。 */
  output: z.string().optional(),
  /** 評価の結果、実際に増減した環境変数の名前。**値は返さない。** */
  names: z.array(z.string()).optional(),
});

export type RunnerProfileResult = z.infer<typeof runnerProfileResultSchema>;

/**
 * 実行環境の資源。**フィールド名を `capacity` にしないのは意図である。**
 *
 * 「収容能力」と読める語をプロトコルに置くと、次に触る人がそれを上限として使い
 * 始める。`capacity` があれば「capacity を超えたら断る」は自然な実装に見えるが、
 * それは定員であって能力の削除である（north_star 禁止2 / roadmap M5 の地雷）。
 * ここにあるのは**いま器がどうなっているか**の観測値だけで、置ける・置けないの
 * 判断は含まない。
 *
 * 材料はそれぞれ**独立して省略できる。** 器によって読めるものが違い（cgroup を
 * 持たない器、資源を報告しない古い runner）、**報告できないことを理由に宛先から
 * 外すのはデグレードである**（roadmap M5 受け入れ基準5 — runner 数を増減しても
 * 能力削減が入らない）。欠けた材料をどう扱うかは配置側にある（`select`）。
 */
export const runnerExecutionResourcesSchema = z.object({
  /**
   * 使える CPU。**`os.cpus().length` ではない。**
   *
   * `os` が返すのはホストのコア数で、cgroup で絞られた器でもホストの数を答える。
   * 同じホストに並んだ runner が全部同じ数を名乗るので、資源で選んでいるつもりで
   * 登録順に選んでいるのと変わらなくなる（`readExecutionResources` に実測がある）。
   * `source` はどちらを読めたかの記録である。
   */
  cpu: z.object({ cores: z.number().positive(), source: z.enum(['cgroup', 'os']) }).optional(),
  /**
   * メモリ。**`os.totalmem()` ではない**（理由は `cpu` と同じ）。
   *
   * `usedBytes` からは**読み捨てできるページキャッシュを引いてある。** 引かないと、
   * 何もしていない器がファイルを読んだ分だけ「使用中」に見える。
   */
  memory: z
    .object({
      limitBytes: z.number().positive(),
      usedBytes: z.number().nonnegative(),
      source: z.enum(['cgroup', 'os']),
    })
    .optional(),
  /**
   * プロセス数（cgroup v2 の `pids.current` / `pids.max`。#315）。**器の合計**で
   * あって、内訳ではない——何が持っているかはこの数字からは分からない
   * （`runner_list` の出力側で毎回そう断る）。
   *
   * **`source` を持たない。** `cpu` / `memory` は cgroup が無ければ `os`
   * （ホストの値）へ倒れられるが、pids には倒れる先が無い——「ホストの pids
   * 上限」という概念自体が存在しない（`readExecutionResources` の doc）。だから
   * cgroup から読めなければ、この材料はまるごと省略される（0 でも `unknown`
   * でもない——AGENTS.md「取れない軸に 0 の行を作らない」）。
   */
  pids: z.object({ current: z.number().nonnegative(), max: z.number().positive() }).optional(),
});

export type RunnerExecutionResources = z.infer<typeof runnerExecutionResourcesSchema>;

/**
 * 配置の材料。実行環境の資源に、いま抱えているセッション数を足したもの。
 *
 * `managers` は M4 から `/health` が返している（**新しく足す材料は CPU とメモリの
 * 2つだけである**）。これは「新しい1本の取り分」を見るためにあって、「何本まで」を
 * 決めるためではない。
 */
export const runnerPlacementResourcesSchema = runnerExecutionResourcesSchema.extend({
  managers: z.number().int().nonnegative().optional(),
  /**
   * まだデーモンへ送り出せていない出来事の件数（#358）。**「収容能力」でも
   * 「配達の失敗」でもない** — `Outbox.pending` の写しで、listener が付いたまま
   * 溜まっている分も含む（`apps/runner/src/app.ts` の `Outbox.pending` の doc）。
   *
   * **0件でもキーは省かれない**（`apps/runner/src/app.ts` の `/health` は
   * `pendingEvents: outbox.pending` を無条件で書く）。ここが
   * `oldestPendingAt`（次項）と違うのはそのためである——「未送出が何件か」は
   * 0件のときも正しく測れる軸なので、AGENTS.md「取れない軸に0の行を作る」は
   * 当たらない（当たるのは「いちばん古いものの時刻」の側で、0件のときは
   * そもそも「いちばん古いもの」が存在しない）。`.optional()` にしてあるのは
   * この機能より前の runner が欄自体を持たない窓のためである。
   */
  pendingEvents: z.number().int().nonnegative().optional(),
  /**
   * 未送出のうち、いちばん古いものが積まれた時刻（#358）。
   *
   * **「マネージャーが報告を生成した時刻」ではない。** runner が `Outbox` へ
   * 積んだ時刻である（`Outbox.oldestPendingAt` の doc）。1件も無ければ
   * runner 側がキーごと省く。
   */
  oldestPendingAt: isoDateTime.optional(),
});

export type RunnerPlacementResources = z.infer<typeof runnerPlacementResourcesSchema>;

/**
 * **`lease` を持たせない。** `runnerMessageCommandSchema` と同じ理由（あのコメントを
 * 参照）——確認の返事は既に開いているセッション宛の命令であって、世代を新しく
 * 主張する側ではない。
 */
export const runnerAnswerCommandSchema = z.object({
  requestId: z.string().min(1),
  message: z.string(),
  decision: z.enum(['allow', 'deny']).optional(),
});

export type RunnerAnswerCommand = z.infer<typeof runnerAnswerCommandSchema>;

// ---------------------------------------------------------------------------
// runner → デーモン（出来事）
// ---------------------------------------------------------------------------

/**
 * runner から降りてくる出来事。
 *
 * ここに流れるのは**事実だけ**である。「これは人間に聞くべきか」といった判断は
 * 混ぜない（判断はクローンが記憶を根拠に行う — PRD「権限境界」）。
 */
export const runnerEventSchema = z.discriminatedUnion('type', [
  /** ストリームの先頭。どの runner に繋がったかを名乗る。 */
  z.object({ type: z.literal('hello'), runnerId: z.string() }),
  z.object({ type: z.literal('session'), managerId: z.string(), sessionId: z.string() }),
  /** SDK が生ログを預けるときの scope。生ログを後から引き当てる鍵になる。 */
  z.object({ type: z.literal('project_key'), managerId: z.string(), projectKey: z.string() }),
  z.object({
    type: z.literal('report'),
    managerId: z.string(),
    text: z.string(),
    status: jobStatusSchema,
    /**
     * **このターンが「報告」ではなく失敗で終わったこと。**
     *
     * 直す前は成否によらず報告が上がっていたので、支出上限の英語文言が
     * そのまま「マネージャーの報告」として台帳（`lastReport`）・日誌・
     * クローンの受信箱へ流れていた（`sdk-failure.ts` の doc）。
     *
     * **`status` では表せない。** あちらは仕事の状態（`done` は「終えて待機中。
     * 話しかければ続く」）で、ここは**その1ターンがどう終わったか**である。
     * 上限に当たった回はセッション自体は生きているので `status` を `failed` へ
     * 倒すと嘘になる（クローンは話しかけ直せる）。
     *
     * `code` は SDK の語そのまま（`billing_error` / `error_during_execution` /
     * `success/429` など）、`via` はどの印で分かったか。**言い換えない** —
     * 次に同じことが起きたときの掘り始めの位置が違う。
     */
    failure: z
      .object({
        code: z.string(),
        via: z.string(),
      })
      .optional(),
    /**
     * **このターンが中身を持たずに終わったこと（構造化された印。文言では判定しない）。**
     *
     * 直す前は、SDK の `result` が `subtype: 'success'` かつ本文が空のとき
     * `runner.ts` の `resultText()` が `（報告なし）` という文字列を作り、
     * `said`（そのターンで実際に喋った本文）も空ならそれがそのまま報告本文に
     * なっていた。台帳・日誌には残るが、クローンの受信箱（`clone.ts` の
     * `post()`）は `report` を無条件に積むので、**中身の無い報告がクローンの
     * ターンを1本焼く**（死んだマネージャーからの「（報告なし）」で実際に
     * 起きた）。
     *
     * **`failure` と同じ作法。** `status` では表せない「その1ターンがどう
     * 終わったか」を運ぶ。`resultText()` / `reportText()` が「SDK の `result`
     * にも `said` にも文字が無かった」と確定させたときだけ立てる —
     * `'（報告なし）'` という**文字列に一致**させて判定してはいない
     * （`sdk-failure.ts` の「検知は構造化された印だけで行う」と同じ理由。
     * 文言判定にすると、マネージャーが本当に「（報告なし）」と書いて報告した
     * 回まで黙って畳んでしまう）。
     *
     * **`z.literal(true).optional()` にしてあるのは、無いことを「中身が
     * あった」の既定値にするため。** 既存の `report` イベント（このフィールドを
     * 送らない runner）を1つも壊さない。
     *
     * **失敗で終わった回（`failure` が付く回）はここに含めない。** 上限に
     * 当たった事実はクローンが知る必要があるので、`failedReportText()` は
     * 必ず本文を作り、`contentless` は立たない。
     */
    contentless: z.literal(true).optional(),
  }),
  /**
   * 委譲1区間ぶんの集計（マネージャーが作業者を投げてから、全員が完了通知を
   * 返し終えるまで）。**1ターン1行ではなく、この区間1行にしてある。**
   *
   * `result` は既に1ターン1件の `report` を上げており、日誌には
   * `exchange with=manager` として残る。**ターンの回数と時刻は既に日誌にある。**
   * 足りないのは「何を契機にそのターンが回ったか」だけなので、1ターン1行を
   * 新設すると日誌でいちばん書き込みの多い経路を二重にすることになる。
   * 集計は整数のカウンタなので構造的に無界にならない（`digest.ts` のような
   * 打ち切り・`omitted()` は要らない）。
   *
   * **落とした先。** 「どの作業者だったか」は載せていない — 作業者ごとの
   * 実行は `tool_use` の日誌（`actor=worker:<id>:<agent>`）に全部ある。
   *
   * ## この集計が数えているのは「マネージャーのターン」だけである
   *
   * `turns` / `byCause` / `toolless` / `submits` はすべてマネージャー自身の
   * セッション（`result` / hook）を見ている。**作業者（Task サブエージェント）
   * が委譲された区間の中で何ターン回ったか・何もせず空回りしたかは、ここには
   * 出てこない。**
   *
   * **そして、これは欠落ではなく構造の性質であり、直せない。** 作業者は
   * マネージャーと**同一の SDK セッション**の中で走るので、`manager.ts` の
   * `case 'usage'` が既に言っているとおり（「その中の作業者（Task subagent）
   * と compaction 自体の分もここに混ざっている — SDK の `modelUsage` が
   * 合算して降ろすので分離できない」）、SDK 側でメッセージ列が層をまたいで
   * 合算されて降りてくる。`usage.ts` の `usageLayerSchema` の doc が言う
   * 「台帳のどの層にも出てこない消費がある」と同じ形の限界で、ここを
   * 作業者層まで分離しようとしないこと。
   *
   * **代わりに立っているのは、マネージャーが作業者の報告を読んで気づくこと
   * である。** 計器がここで止まっている先は、人間の代わりにマネージャーが
   * 埋める — 実例: このフィールドを実装した作業中、作業者が別 PR の CI 完了を
   * 待つあいだに道具を1つも動かさないターンを4回回した（`toolless` の定義に
   * そのまま当てはまる形）。マネージャーがその報告を読んで気づき、指示1本で
   * 止めた。計器の外側で起きたこの1件が、計器が届かない範囲の代替が実際に
   * 機能する形そのものである。
   *
   * **各フィールドの doc にある「例:」は、対応する実在のテスト名
   * （`runner-wakeup.test.ts` の `it(...)` の文言）を必ず伴わせる。** テストの
   * 無い例は、実装が変わったときに黙って嘘になる（テストなら落ちる）。ここの
   * `settled` の doc は一度、直したコードと矛盾する古い読み方を書いたまま
   * レビューを通ってしまった箇所である（この PR 自身の履歴に残っている）。
   */
  z.object({
    type: z.literal('worker_wait'),
    managerId: z.string(),
    /** 区間が開いた時刻（最初の `task_started` で `#openTasks` が 0→1 になった瞬間）。 */
    openedAt: isoDateTime,
    /**
     * この区間で始まった委譲（Task）の件数。`task_started` の**件数**であって
     * 作業者の**人数**ではない — 同じ `task_id` が二度来れば二度数える。
     * `skip_transcript: true` の ambient/housekeeping task も間引かずに含む。
     */
    tasks: z.number().int().nonnegative(),
    /** この区間の間にマネージャーのセッションが回った `result` の回数。 */
    turns: z.number().int().nonnegative(),
    /**
     * ターンが回った契機。**3つの合計は必ず `turns` と一致する**（排他で1件だけ
     * 数えるため）。
     */
    byCause: z.object({
      /** そのターンの間に、クローン・人間からの入力を1件以上消費した。 */
      input: z.number().int().nonnegative(),
      /**
       * 入力は無いが、作業者の完了通知（`task_notification`）を1件以上受けた。
       *
       * **「通知の直後に回ったターン」であって、「その通知が原因でターンが
       * 回った」ことの証明ではない。** 同時に起きただけの可能性（別の理由で
       * 回ったターンに、たまたま通知が重なった）は排除していない。
       */
      notification: z.number().int().nonnegative(),
      /**
       * 入力も完了通知も無いのに回ったターン。**これは消去法で出している値
       * である。** 「入力を消費していない、かつ完了通知も受けていない」を
       * 満たしたターンが全部ここへ落ちる。だから**分類の漏れ（まだ誰も
       * 知らない第4の契機、こちらが読み落としているメッセージ種別）があれば、
       * それも黙ってここへ流れ込む。**「SDK/CLI 側の自己継続である」は
       * *解釈*であって*観測*ではない — alteroid はこの部分のコードを1行も
       * 持たないので直接確かめる手段が無い。ここが支配的なら、プロンプトへ
       * 「待て」を1文足しても何も変わらない可能性が高い（が、それも解釈である）。
       */
      continuation: z.number().int().nonnegative(),
    }),
    /**
     * 道具を1つも動かさなかったターンの数。事故のときの「残り5体を待ちます」
     * だけのターンがこれにあたる。マネージャー自身の道具だけを見る（作業者の
     * 道具は数えない — 混ぜると「マネージャーは何もしていない」が消える）。
     *
     * **言っているのは「マネージャー自身の `PostToolUse` が発火しなかった」
     * ことだけである。** 「何も考えなかった」でも「何も出力しなかった」でも
     * ない — 本文だけ書いて終わったターン（`#said` へ積んだが道具は使わな
     * かった回）もここに入る（例: `runner-wakeup.test.ts` の「本文だけを
     * 話して道具を使わなかったターンも toolless に数える」）。
     */
    toolless: z.number().int().nonnegative(),
    /**
     * この区間で受けた `task_notification` の総数。
     *
     * **`tasks` 以下とは限らない。** 対応する `task_started` を観測していない
     * 通知（`#onTaskNotification` の `had === false` の経路。本来起きない想定
     * だが防御的に数える）も含めているので、`tasks` より大きくなりうる（例:
     * `runner-wakeup.test.ts` の「対応する task_started が無い
     * task_notification も notifications に数え、tasks を超えうる」）。
     */
    notifications: z.number().int().nonnegative(),
    /**
     * この区間で `UserPromptSubmit` がマネージャー自身に発火した回数。
     *
     * **`turns` と食い違うこと自体が観測である。** 一致すれば「`result` は
     * ターンごとに1回出る」という仮説を支持し、食い違えば「SDK 側の自己継続は
     * `UserPromptSubmit` を伴わない」等の可能性を示す。どちらの仮説でも
     * 読める形にしてある。**ただし食い違いの「原因」までは言っていない** —
     * `result` が出ない自己継続・hook が発火しない経路・作業者判定
     * （`agent_id`）の取りこぼし、のどれで起きても同じ食い違いとして見える。
     */
    submits: z.number().int().nonnegative(),
    /**
     * `UserPromptSubmit` の `source` ごとの内訳。**取れた分だけ載せる。**
     * 1件も取れなければ**フィールドごと省く**（`{}` を置かない） — 取れない軸に
     * 0の行を作らない（AGENTS.md 地雷）。
     *
     * **この行を読む人へ。** SDK（0.3.239 の `UserPromptSubmitHookInput.source`）
     * は `'system'` を「他の機械が起こしたターン（peer/channel messages・
     * task notifications・auto-continuation）」と定義している。つまり
     * `sources: { system: N }` の N は「機械に起こされたターン」の数であって、
     * **その内訳（通知なのか SDK の自己継続なのか）ではない** — そこは同じ
     * `'system'` に畳まれていて割れない。`byCause.notification` /
     * `byCause.continuation` のほうは alteroid 側の推定であり、`sources` の
     * `'system'` はその**上位集合を SDK 側から数えた別の観測**である。
     * **両者が食い違うこと自体が観測になる**（片方だけを信じないこと）。
     *
     * **`sources` が無いことは「機械に起こされていない」ではない。** 同じ
     * JSDoc は「Payloads may omit it while the field rolls out」と言っており、
     * 付かない回が今も在る。0.3.237 まではもっと強く「外部のペイロードには
     * 付かない」と書かれていた（経緯は `runner.ts` の `#submitSources` の doc）。
     */
    sources: z.record(z.string(), z.number().int().nonnegative()).optional(),
    /**
     * 区間が閉じる前にセッションが畳まれた（`#finish` / `stop` / 引き継ぎ）。
     *
     * **観測しているのは「`#openTasks` が空になったことをこのセッションが
     * 観測できたか」である。** `#finish` / `stop` / 引き継ぎのどの経路でも、
     * 閉じる瞬間の `#openTasks.size === 0` をそのまま使う（呼び出し側は
     * 真偽値を渡さない）。
     *
     * **`false` の意味: 区間が閉じた瞬間に、まだ完了通知を返していない委譲が
     * 1件以上あった。** 経路は `#finish` / `stop` / 引き継ぎのどれか（例:
     * `runner-wakeup.test.ts` の「task_started が2件で task_notification が
     * 1件だけの状態でセッションが畳まれたら settled: false が上がる（区間が
     * 開いたまま消えない）」）。
     *
     * **`false` は「通知が失われた」ことを意味しない。** 通知がまだ届いて
     * いなかっただけかもしれないし、作業者は仕事を終えていて通知だけが
     * 間に合わなかったのかもしれない。alteroid が観測したのは「閉じた時点
     * では届いていなかった」ことだけである。
     *
     * **`true` でも `turns` が最後の1回を含まないことがある** — 最後の完了
     * 通知の後、`result` が来ないまま畳まれた場合である。この場合
     * `#openTasks` は空（＝ `settled: true`）だが、その回のターンの契機は
     * `byCause` に反映されない。`submits` との突き合わせで気づける形にして
     * ある（`turns` より `submits` が多ければ、`result` を伴わないまま
     * 消費された発火があったことになる。例: `runner-wakeup.test.ts` の
     * 「全員から完了通知を受け切った直後に result なしで畳まれても settled:
     * true が上がる」）。
     *
     * 数え漏れではなく、区間が閉じた瞬間に何を観測できたかという事実である。
     */
    settled: z.boolean(),
  }),
  z.object({
    type: z.literal('ask'),
    managerId: z.string(),
    requestId: z.string(),
    /**
     * **`kind` はここでは元から必須（旧 runner もこの版のときから送っていた）。
     * 触らない。** optional にすべきなのは `runnerWaitingSchema`（`state()` が
     * 返す方）と、この `ask` イベントの `askedAt` の2つだけである
     * （`waitingKindSchema` の doc）。
     */
    kind: waitingKindSchema,
    summary: z.string(),
    /**
     * `runnerWaitingSchema.askedAt` と同じ意味・同じ値（#334）。**こちらは
     * `runnerWaitingSchema` と同じ理由（版のずれ）で `.optional()`** ——
     * `kind` と違い、この欄自体がこの PR で新しく足されたものなので、旧
     * runner の応答には最初から乗らない。
     */
    askedAt: isoDateTime.optional(),
  }),
  /** 確認が解けた（回答・中断・停止）。デーモン側の待ち行列から外す合図。 */
  z.object({ type: z.literal('settled'), managerId: z.string(), requestId: z.string() }),
  /**
   * runner の内側で起きた、記録に残すべき事実。
   *
   * マネージャーの発言ではない（`report` と混ぜない）。**runner が何かを落とす
   * ときの口**である — 上限に達して古い記憶を捨てた、といった事実がどこにも
   * 残らないと、後から表に出た異常を誰も原因へ辿れない（黙って落とさない）。
   */
  z.object({ type: z.literal('note'), managerId: z.string(), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    managerId: z.string(),
    /** `manager:<id>` / `worker:<id>:<agent>`。 */
    actor: z.string(),
    tool: z.string(),
    /**
     * **`.optional()` は冗長ではない。** `PostToolUse` フック（`runner.ts` の
     * `#onPostToolUse`）が受け取る `hook.tool_input` は、SDK 側の事情で
     * 無いことがある。無ければこの欄は `undefined` になり、`JSON.stringify`
     * （HTTP でこのイベントを runner からデーモンへ渡す側）は値が `undefined`
     * の欄をキーごと落とす — 境界の向こうでは `input` というキー自体が
     * 存在しない。
     *
     * **zod 4 では `z.unknown()` はキーの不在を許さない**（zod 3 と違う点）。
     * `input` を必須のままにすると、この形は `runnerEventSchema` の
     * `safeParse` で落ち、`tool_use` イベントがまるごとデーモンに届かない
     * （`permission_denied` の `input` で先に踏んだのと同じ形。Issue #223）。
     *
     * **2箇所同時でなければならない。** ここを緩めるだけだと、`undefined` の
     * `input` が `manager.ts` の `case 'tool_use'` を素通りして日誌へ運ばれる。
     * 日誌側の `schema.ts` の `tool_use` エントリも `input: z.unknown()` の
     * ままだと、こちらは jsonb / JSON 行として直列化されるときに同じ理由で
     * キーが落ち、読み出しの `safeParse` が失敗してその行が跡形もなく消える
     * （Issue #224）。この境界（`schema.ts` 側）も同じ PR で `.optional()`
     * にしてあるので、必須の欄へ `undefined` が届く経路はどこにも開いていない。
     */
    input: z.unknown().optional(),
  }),
  /**
   * 道具の実行が**確認へ上がらずにその場で止められた**（分類器・deny 規則）。
   *
   * `permissionMode: 'auto'` の既定では、SDK が自分で拒否したものは `canUseTool`
   * （＝クローンへの確認）を通らない。**確認の入り口を閉じた側で何が起きたかを
   * 見る口がここである** — 無いと「静かになった」と「起きていない」が区別できず、
   * マネージャーや作業者の手が止まったことにクローンは気づけない（実機で起きた:
   * 作業者が編集を拒否され、報告してくれなければ誰も知らないままだった）。
   *
   * **事実だけを運ぶ。** 「繰り返されているから知らせるべきか」の判断はデーモン側
   * （`manager.ts`）で、runner は1件ずつそのまま降ろす。
   */
  z.object({
    type: z.literal('permission_denied'),
    managerId: z.string(),
    /**
     * SDK の `tool_use_id`。**同じ拒否を二度上げないための鍵**である（生の合図と
     * `result` の記録の両方に同じ拒否が載る）。SDK が付けてこなければ runner が
     * ツール名と入力から作る。
     */
    toolUseId: z.string(),
    tool: z.string(),
    /**
     * **`.optional()` は冗長ではない。** 走行中の合図（SDK の
     * `SDKPermissionDeniedMessage`）には `tool_input` フィールドそのものが
     * 無い（`tool_name` / `tool_use_id` / `message` / `uuid` / `session_id` と
     * 任意の3つだけ）。だから `via: 'live'` のとき `#noteDenial`（`runner.ts`）
     * が読む `denial.tool_input` は必ず `undefined` になり、`JSON.stringify`
     * （`apps/runner/src/app.ts`）は値が `undefined` のキーを丸ごと落とす —
     * HTTP 境界の向こうでは `input` というキー自体が存在しない。
     *
     * **zod 4 では `z.unknown()` はキーの不在を許さない**（zod 3 と違う点）。
     * `input` を必須のままにすると、この形は `safeParse` で
     * `invalid_type: expected "nonoptional", received "undefined"` として
     * 落ち、live の拒否がデーモンに一切届かない。しかも `#denied`
     * （`tool_use_id` による重複排除）が既に立っているので、ターン終わりの
     * authoritative な記録（`via: 'result'`）の再送も止まり、拒否が完全に
     * 失われる。それを防ぐための `.optional()` である。
     *
     * **`via: 'live'` では今後も入らない。** 「何を実行しようとしたか」が
     * 要るなら、この境界の外に別の道がある — `PermissionDenied` フックは
     * `tool_input` を持つ（守備範囲・発火条件はこの PR では未確認。Issue
     * #226 を見ること）。**この欄へ後から詰めようとしないこと** — SDK の
     * 走行中の合図に無い値を runner 側で埋めれば、それは推測であって事実では
     * ない（このファイル冒頭のとおり、ここは事実だけを運ぶ場所である）。
     */
    input: z.unknown().optional(),
    /**
     * どちらの経路で気づいたか。`live` は走行中の合図
     * （`system/permission_denied`）、`result` はターン終わりの記録
     * （`result.permission_denials`。SDK 曰くこちらが authoritative）。
     */
    via: z.enum(['live', 'result']),
    /**
     * なぜ止められたかの人が読める一文（SDK の `decision_reason`）。
     *
     * **`.optional()` は `input` と同じ理由である。** 値が無い回にキーごと落ち
     * （`JSON.stringify` は `undefined` のキーを丸ごと落とす）、zod 4 の
     * `z.string()`（必須）はキーの不在を許さない。ここを必須にすると、値が無い
     * 回の `permission_denied` が丸ごと `safeParse` に落ち、しかも `#denied`
     * （`runner.ts` の重複排除）は既に立っているので `result` 側の再送も
     * 起きない — #223 と同じ形の穴を自分で開けることになる。
     *
     * **`via: 'result'` では必ず欠ける。** `result.permission_denials`
     * （`SDKPermissionDenial`）は `tool_name` / `tool_use_id` / `tool_input`
     * の3つしか持たず、理由の欄が無い。理由が付くのは `via: 'live'` の
     * ときだけである。
     */
    reason: z.string().optional(),
    /**
     * `reason` の分類（SDK の `decision_reason_type`。例:
     * `'classifier'` / `'asyncAgent'` / `'mode'` / `'rule'`）。
     *
     * **`reason` の文字列を解釈して分類し直さないこと。** 分類が要るなら
     * こちらの種別で判定する（`reason` は人間向けの一文で、言い回しは
     * SDK の版で変わりうる。文字列一致に頼らず種別で判定できる形に寄せるのは
     * このリポジトリが繰り返し選んでいる形である）。`.optional()` の理由は
     * `reason` と同じ。
     */
    reasonType: z.string().optional(),
    /**
     * モデルへ実際に返された拒否文（SDK の `message`）。
     *
     * `reason` は人間向け、こちらはモデルが tool_result として受け取った文言
     * そのもの。`.optional()` の理由は `reason` と同じ。
     */
    message: z.string().optional(),
  }),
  /**
   * SDK が報告した消費量の**累積**（`result.modelUsage` の写し）。
   *
   * **累積のまま降ろす。差分は runner で作らない。** 理由が2つある。
   *
   * - **差分は事実ではなく解釈である。** ここに流すのは事実だけ（このファイルの
   *   冒頭）で、「前回からいくら増えたか」は前回を覚えている側の話である
   * - **累積なら再送に耐える。** 器の入れ替えや瞬断で同じイベントが2回届いても、
   *   受け取った側の増分が 0 になるだけで済む。差分を降ろすと**そのまま二重計上**
   *   になり、しかも数字は増えるだけなので誰も気づけない
   *
   * 台帳へ畳むのはデーモン（`manager.ts` の `#onEvent`）である。runner は記憶
   * ストアの鍵を持たないので、そもそもここでは書けない。
   */
  z.object({
    type: z.literal('usage'),
    managerId: z.string(),
    sessionId: z.string().optional(),
    /** モデル id → その時点の累積。 */
    models: z.record(z.string(), usageTotalsSchema),
  }),
  /**
   * 上限に関する SDK の文言（当たった / 課金枠へ移った / 近づいている / 組織方針）。
   *
   * **文言は言い換えずにそのまま運ぶ。** 人間が検索できる形で残らないと、
   * claude.ai の画面と突き合わせられない。分類だけを添える。
   */
  z.object({
    type: z.literal('usage_notice'),
    managerId: z.string(),
    notice: usageLimitNoticeSchema,
  }),
  /**
   * `rate_limit_event` から読めた枠の事実（アカウント単位）。
   *
   * **ターンを回している間しか届かない。** だから使い捨ての probe による定期観測と
   * 併用する（`usage-snapshot.ts`）。こちらは `status` と
   * `overageDisabledReason` を持っているので、probe では取れないことが分かる。
   */
  z.object({
    type: z.literal('rate_limit'),
    managerId: z.string(),
    facts: rateLimitFactsSchema,
  }),
  /** SDK のセッション生ログ（SessionStore のミラー）。永続化はデーモンが行う。 */
  z.object({
    type: z.literal('mirror'),
    managerId: z.string(),
    key: z.object({
      projectKey: z.string(),
      sessionId: z.string(),
      subpath: z.string().optional(),
    }),
    entries: z.array(z.unknown()),
  }),
  /** compaction 直前・停止時の全文。デーモンがアーカイブへ落とす。 */
  z.object({ type: z.literal('archive'), managerId: z.string(), body: z.string() }),
  z.object({
    type: z.literal('closed'),
    managerId: z.string(),
    status: jobStatusSchema,
    reason: z.string(),
    /**
     * **貸し出し期限の自己失効（roadmap M5 PR4）で畳まれたことの構造化された印。
     * 文言では判定しない。**
     *
     * `reason` は人間が読む一文（「デーモンと連絡が取れないので貸し出し期限が
     * 切れた（自己失効）。」を必ず含む）だが、そこへの文字列一致で判定させると、
     * マネージャーが偶然同じ文言を報告に書いた回まで巻き込む——`report` の
     * `failure` / `contentless` が「検知は構造化された印だけで行う」としている
     * のと同じ作法（`sdk-failure.ts` の doc）。
     *
     * **`status` はそれでも `lost` のままである。** `lost`（戻れないと確定した）
     * は runner から見た事実として正しい——このプロセスではもう続けられない。
     * ただし自己失効は「持ち主を失った」わけではなく、生ログさえあれば**別の
     * 器から続けられる**。台帳側（`manager.ts`）がこの印を見て、`status` を
     * 動かさずに貸し出し（`lease`）だけ返し、引き取り直せるようにする——
     * `lost` かつ `selfFenced` が立たない回（resume 不能で `#recoverFromFailedResume`
     * が `unresumable` を返した回）とはここで区別できる。
     *
     * **`z.literal(true).optional()` にしてあるのは、無いことを「自己失効では
     * ない」の既定値にするため。** 既存の `closed` イベント（このフィールドを
     * 送らない runner）を1つも壊さない。
     *
     * 立つのは `RunnerSession#selfFence` を通った1経路だけである。**`stop()`
     * （デーモンからの明示停止・器の `shutdown()`）や、resume 不能で `#finish`
     * へ落ちる経路には立たない**（`runner-fence.test.ts` が固定する）。
     */
    selfFenced: z.literal(true).optional(),
  }),
  /**
   * 前のセッションを開き直せなかった。
   *
   * **`resume` の応答では表せない。** 命令自体は受理され（HTTP 200）、SDK が
   * 「そんな会話は無い」と答えるのはストリームが開いた後だからである。ここを
   * 事実として降ろさないと、デーモン側は「戻せた」と思ったまま台帳を `running`
   * にし、同じ session_id へ何度でも投げ直す（実機で起きたのはこれ）。
   */
  z.object({
    type: z.literal('resume_failed'),
    managerId: z.string(),
    /** 開き直せなかった session id。 */
    sessionId: z.string(),
    reason: z.string(),
    /**
     * 預かった生ログから新しいセッションで組み立て直せたか。
     *
     * `false` なら**その仕事は止まっている**。黙って引き下がったことにしないため、
     * 成否をイベントの側で持つ（受け取ったデーモンが人間とクローンへ出す）。
     */
    recovered: z.boolean(),
  }),
]);

export type RunnerEvent = z.infer<typeof runnerEventSchema>;

// ---------------------------------------------------------------------------
// 失敗の種別
// ---------------------------------------------------------------------------

/**
 * runner が返した失敗。**status を落とさずに持ち上げる。**
 *
 * 呼ぶ側が「待てば直る（器の入れ替え中・瞬断）」と「待っても直らない（鍵が違う・
 * 命令の形が悪い）」を区別できないと、設定の誤りを再試行で何分も隠すか、逆に
 * 一時的な失敗で仕事を諦めるかのどちらかになる。**この判断は宛先の実装
 * （HTTP かインプロセスか）に依らない**ので、口の定義と同じ場所に置く。
 */
export class RunnerHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RunnerHttpError';
    this.status = status;
  }
}

/**
 * `start` / `resume` の `lease.fence` が、runner（`runner.ts` の `Host`）が
 * セッションごとに覚えている世代より古かった（roadmap M5 PR4 の fencing）。
 *
 * **投げた側（`Host#resume` / `Host#start`）はこのセッションに一切触れない。**
 * 遅れて届いた古い世代の命令はここで止め、走っているセッションの状態
 * （入力・確認待ち・生ログ）は1文字も変えない。`expected` / `given` を持たせるのは、
 * デーモン側が「なぜ拒まれたか」を人間へそのまま出せるようにするためである。
 *
 * `apps/runner/src/app.ts` はこれを **409** で返す。**500 にしないこと** —
 * `isRetryableRunnerError` は 5xx を「待てば直る」に分類するので、500 のままだと
 * 古い世代の命令が新しい命令へ置き換わらずに延々と挑み直される。409 は
 * 「同じものを投げ直しても同じ答えが返る」側（4xx）として読める。
 */
export class RunnerFenceError extends Error {
  readonly managerId: string;
  /** runner がいま覚えている世代。 */
  readonly expected: number;
  /** 命令に載っていた世代。`expected` より古い。 */
  readonly given: number;

  constructor(input: { managerId: string; expected: number; given: number }) {
    super(
      `manager_id=${input.managerId} の命令が古い世代を名乗っている` +
        `（runner が覚えている世代=${input.expected}, 受け取った世代=${input.given}）。` +
        'このセッションには一切触れていない。',
    );
    this.name = 'RunnerFenceError';
    this.managerId = input.managerId;
    this.expected = input.expected;
    this.given = input.given;
  }
}

/**
 * もう一度投げてよい失敗か。
 *
 * **status が分からない失敗は「待てば直る」側に寄せる。** 経路が切れた
 * （`fetch failed`）・器が起き上がりきっていない、はどちらも status を持たない。
 * ここで諦めると、走行中だった仕事が誰にも拾われないまま `running` で残る。
 *
 * 逆に 4xx は runner が「その命令は受け取れない」と答えているので、同じものを
 * 投げ直しても同じ答えが返る（混雑を表す 408 / 429 だけは別）。
 */
/**
 * **世代で拒まれた**（runner が「その命令はもっと古い世代のものだ」と答えた）。
 *
 * デーモン側から見ると `RunnerHttpError` の 409 として届く（runner 側の
 * `RunnerFenceError` は器の中の型なので、HTTP を跨いだ先には状態番号しか残らない）。
 *
 * **これを「戻せなかった」と同じ扱いにしないこと。** 409 が返るのは、その委譲を
 * **自分より新しい世代の誰かが握っている**ときである — つまりそのセッションは
 * 生きていて、誰かが動かしている。ここで台帳を `lost` にして像から外すと、
 * 「戻せなかった」と読んだクローンが**新しく起こし直して二重実行になる**
 * （fencing が防ごうとしているものそのものへ、fencing の失敗経路から到達する）。
 */
export function isFencedRunnerError(error: unknown): boolean {
  return error instanceof RunnerHttpError && error.status === 409;
}

export function isRetryableRunnerError(error: unknown): boolean {
  if (!(error instanceof RunnerHttpError)) return true;
  if (error.status === 408 || error.status === 429) return true;
  return error.status >= 500;
}

// ---------------------------------------------------------------------------
// デーモン側から見た runner
// ---------------------------------------------------------------------------

/**
 * runner への口。HTTP でも同一プロセスでも、デーモンはこれしか知らない。
 *
 * **デーモンは特定 runner の実装やローカルパスを前提にしない。** ローカル実行の
 * インプロセス実装も、コンテナ越しの HTTP 実装も、ここでは同じ顔をしている。
 */
export interface RunnerClient {
  /**
   * 安定した識別子。`manager_id → runner_id → session_id → workspace` の鎖を
   * JobStore に残すためのもので、runner が増えたときの宛先になる。
   *
   * **⚠️ この欄を人間やクローンへ見せる前に立ち止まること。** 実装（`HttpRunner`）
   * は既定値 `'runner-primary'` を持っていて、`/health` から一度も `runnerId` を
   * 受け取れていなくてもその値が入っている。**そのまま出すと、取れていない値が
   * 取れた値の顔をして出る**（`AGENTS.md`「取れない軸に 0 の行を作る」）。
   * **「聞けたか」を判定するときは、この欄そのものではなく {@link runnerIdKnown}
   * を見ること**（#330）。
   */
  readonly runnerId: string;
  /**
   * `runnerId` が `/health` から実際に受け取れたかどうか（#330）。
   *
   * **`runnerId` は常に文字列を持つ**（既定値 `'runner-primary'` が入っている
   * ことがある）ので、この欄の有無だけでは「聞けたか」を判定できない。
   * `false` のときの `runnerId` は一度も接続できていない段階からの既定値で
   * あって、`/health` が答えた値ではない——出す側はこの欄を先に見て、
   * `false` なら `runnerId` そのものを出さないこと。
   *
   * **`#pump` が書く2行はこの区別を独自の private フラグ（`#runnerIdKnown`）で
   * 持っていた**（#274 / #309 の `label()`）。この欄はそれを `HttpRunner` の
   * 外から読める形へ引き上げたもので、実装（`hello()` が非空文字列を読めたときだけ
   * 立てる）は変えていない。`onSwap` / `onLost` / `GET /runners`（`entries()`）は
   * この欄が入るまで、`entry.client !== null` だけを根拠に `runnerId` を無条件で
   * 出していた——`entry.client !== null` は `hello()` が解決したことしか意味せず、
   * 応答に `runnerId` が入っていたとは限らない。
   *
   * **常に `true` を返してよい実装もある。** `LocalRunner`（同一プロセス構成）は
   * `runnerId` を接続前から自分で確定させているので、「聞けていない」状態が
   * そもそも存在しない。
   */
  readonly runnerIdKnown: boolean;
  /** この runner の既定の作業ディレクトリ（workspace locator の path になる）。 */
  readonly workspacePath: string;
  /**
   * 名乗りの中身（`runnerId` / `workspacePath` と同じ応答 = `hello()` が読む
   * `GET /health`）に含まれていた版。**接続した瞬間に一度だけ読む値であって、
   * heartbeat では更新しない**——それは `identity()` の役目である。新しい口も
   * 新しい呼び出しも増やしていない（`hello()` が既に読んでいる応答の中から、
   * 今まで捨てていた1フィールドを拾うだけ）。
   *
   * **省略できる。** 答えない実装・古い runner（`/health` に `revision` を
   * 持たない）はこの項目自体を持たない。そのときは `#open()` が触らないので
   * 名簿は初期値の `unheard` のまま——「版を名乗った上で分からない」
   * （`unknown`）と混同しない。`LocalRunner`（同一プロセス構成）はこの項目を
   * 実装しないので、常にこの経路を通らず `identity()` の heartbeat（それも
   * 実装していなければ `unheard` のまま）に委ねる。
   */
  readonly revision?: RunnerRevisionReport;
  /**
   * **いまこの宛先に応えているプロセス**（同じ `hello()` の応答に載っている
   * `instanceId`。roadmap M5 PR4）。
   *
   * `revision` と**まったく同じ作法**である — 接続した瞬間に一度だけ読む値で、
   * 新しい口も新しい呼び出しも増やしていない（`hello()` が既に読んでいる応答から
   * 拾うだけ）。heartbeat での更新は `identity()` の役目である。
   *
   * **これが接続の瞬間に要る理由。** `#open()` の直後に走るのはデーモンの引き取り
   * （`takeOver` / `reattachRunner`）で、そこでは貸し出し期限の判定（`lease.ts`）が
   * この値を材料にする。heartbeat の1周（最大 `HEARTBEAT_INTERVAL_MS`）を待つと、
   * **開け直しのたびに「判定材料が無い」状態で引き取りが走る窓**ができる — それは
   * 生きている器の仕事を奪いうる側である。
   *
   * **省略できる。** 名乗らない実装（`LocalRunner`）・古い runner では無い。無いことを
   * 「入れ替わっていない」と読まないこと（`judgeLease` は `undecidable` へ倒れる）。
   */
  readonly instanceId?: string;
  /** イベントの受け取りを始める。**接続を張るのはデーモン側**である。 */
  connect(onEvent: (event: RunnerEvent) => void): Promise<void>;
  /**
   * 生きているかを聞く。**既存の `GET /health` を叩くだけ**で、新しい口は足さない。
   *
   * SSE の `hello` は器が礼儀正しく落ちたときにしか届かない。電源が抜けた器も、
   * ネットワークだけが切れた器も、ストリームは開いたまま何も言わなくなる。
   * この口は**その沈黙を拾うための補完**であって、`hello` の置き換えではない。
   *
   * `signal` は名簿が持つ probe 期限。**返らない1台が名簿全体を止めないため**に、
   * 期限を過ぎたら名簿の側から中断する（受け取った実装は繋ぎを畳むこと）。
   *
   * **省略できる。** 叩く先を持たない実装（同一プロセスなど）まで口を強いると、
   * 「無いので常に失敗」か「嘘の成功」のどちらかを書くことになる。持たない実装は
   * 実装しなくてよく、名簿はそれを「叩く必要が無い＝生きている」と読む。
   */
  ping?(options?: { signal?: AbortSignal }): Promise<void>;
  /**
   * 名乗りの中身を**読むが採らない**口（roadmap M5 PR4 の判定材料）。
   *
   * **`ping` の代わりに叩く。** 同じ `GET /health` なので生死は等しく分かる。
   * 新しい口も足していない（`resources()` / `credentials()` / `profile()` と同じ
   * 作法である）。
   *
   * ## なぜ「読むが採らない」なのか
   *
   * `ping` が本文を読まないのは、**器が入れ替わったときに `runnerId` を黙って
   * 書き換えると台帳の鎖（`manager_id → runner_id`）が音もなく繋ぎ変わる**からで、
   * その判断は正しい。ただしその副作用として、名簿は**器の入れ替えと単なる回復を
   * 区別できなくなっていた**（`#markSeen` に書いてある blocker そのもの）。
   *
   * だからここが返すものは**判定の材料であって、採用する値ではない。** 名簿は
   * `runnerId` を上書きせず、`instanceId` が変わったことを**知らせるだけ**である。
   * 「黙って採る」ことが危険だったのであって、「見る」ことが危険だったのではない。
   *
   * ## `instanceId` は起動ごとに変わる
   *
   * **安定していてはいけない。** `runnerId` は宛先の名前（安定）で、こちらは
   * 「いまその名前に応えているプロセスがどれか」である。器を作り直せば変わる、が
   * この値の唯一の役目である。
   *
   * **省略できる**（`ping` と同じ理由）。答えない実装・古い runner は
   * `instanceId` を持たないので、名簿は入れ替えを**判定しない**（「入れ替わって
   * いない」と読まないこと）。
   *
   * ## `revision` — runner が名乗る自分の版（コミット sha）
   *
   * デーモンと runner は別 Service で別々にデプロイされるので、別コミットで
   * 走る窓ができうる。`known`（版が取れた）と `unknown`（応答はあったが runner
   * 自身が自分の版を知らない）の2値のみを返す — **「そもそも訊けていない」は
   * ここでは表せない**（応答が無かったこと自体はこの口の外、名簿の側で分かる）。
   * `instanceId` と同じく省略できる。
   */
  identity?(options?: {
    signal?: AbortSignal;
  }): Promise<
    { runnerId?: string; instanceId?: string; revision?: RunnerRevisionReport } | undefined
  >;
  /**
   * 配置の材料を聞く（roadmap M5 PR3）。**`ping` に相乗りさせない。**
   *
   * `ping` は同じ `/health` を叩くが**本文を読み捨てる。** 名乗りの中身
   * （`runner_id`）を読んで黙って採ると、器が入れ替わったときに台帳の鎖
   * （`manager_id → runner_id`）が音もなく繋ぎ変わるからで、これは意図した設計で
   * ある（`ping` の項）。読む物を1つ足せば、いつか読んではいけない物も読む口に
   * なる — だから資源は別の口で取る。
   *
   * ここで採るのは資源だけで、`runnerId` / `workspacePath` は**採らない**
   * （`credentials()` / `profile()` が同じ口を同じ作法で叩いているのと同じ形）。
   *
   * `signal` は名簿が持つ配置の期限。**返らない1台が配置全体を止めないため**に、
   * 期限を過ぎたら名簿の側から中断する（受け取った実装は繋ぎを畳むこと）。
   *
   * **省略できる**（`ping` と同じ理由）。答えられない実装まで口を強いると「嘘の
   * 報告」を書くことになる。名簿はそれを**報告しない器**として扱い、
   * **不利にはしない**（`select`）。
   */
  resources?(options?: { signal?: AbortSignal }): Promise<RunnerPlacementResources | undefined>;
  start(command: RunnerStartCommand): Promise<void>;
  resume(command: RunnerResumeCommand): Promise<void>;
  send(managerId: string, text: string): Promise<void>;
  /** `false` = その確認は runner 側に無い（既に解けた / 別の宛先）。 */
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean>;
  stop(managerId: string): Promise<void>;
  /** いま runner が抱えているセッション（再接続時の突き合わせに使う）。 */
  list(): Promise<RunnerManagerState[]>;
  /** runner のローカルにある生ログ。無ければ null。 */
  transcript(managerId: string): Promise<string | null>;
  /**
   * いま runner が配っている鍵の指紋。**値は返らない。**
   *
   * 人間が置いた鍵とマネージャーが握っている鍵が同じかどうかは、これが無いと
   * 誰にも見えない。見えないと「付けた」「付いてない」のすれ違いが起きて、
   * 原因が鍵の権限にあるのか経路にあるのかを誰も切り分けられなくなる。
   */
  credentials(): Promise<RunnerCredentialFingerprint[]>;
  /** 鍵を差し替える。器を作り直さずに鍵を回すための口。 */
  setCredentials(
    credentials: RunnerSetCredentialsCommand['credentials'],
  ): Promise<RunnerCredentialFingerprint[]>;
  /** いま runner に置いてある実行環境プロファイルの指紋。**本文は返らない。** */
  profile(): Promise<RunnerProfileFingerprint | undefined>;
  /**
   * 実行環境プロファイルを差し替える。器を作り直さない。
   *
   * **runner が繋ぎ直すたびに降ろし直すこと。** 器が入れ替われば置いたものは
   * 消えるので、降ろし直さないと「再デプロイしたら鍵が消えた」が起きる。
   */
  setProfile(script: string): Promise<RunnerProfileResult>;
  /**
   * 口を閉じる。
   *
   * インプロセス実装では**セッションごと畳む**（同じプロセスが消えるので）。
   * HTTP 実装では**ストリームを閉じるだけ**で、runner の中のマネージャーは
   * 走り続ける — デーモンの再起動で人の仕事を殺さない。
   */
  close(): Promise<void>;
}

/**
 * 名簿に載せる1台。**「開いた接続」ではなく「開き方」を取る。**
 *
 * ここが接続そのものだと、名簿を作る前に runner を開き終える必要があり、
 * デーモンは runner が上がるまで待つことになる（起動時に最大2分待って、その間
 * chat も日誌も承認も止まっていた）。開き方を預かれば、**runner が上がっていなくても
 * 名簿には載せられる** — 開くのは背景の仕事になり、失敗しても名簿の側が挑み直せる。
 */
export interface RunnerSource {
  /**
   * 人間が見る宛先（URL か「同一プロセス」）。
   *
   * **`runnerId` は登録時に要求しない。** 繋がるまで分からないからである
   * （`/health` で runner 自身に名乗らせる）。名簿の中で1台を指す鍵はこの label で、
   * 同じ label を登録し直すのは「その宛先を開き直す」意味になる。
   */
  label: string;
  open: () => Promise<RunnerClient>;
}

/**
 * 名簿から見た1台の様子。**生死と接続状態は別物である。**
 *
 * - `connecting` — いま開いている最中（初回）
 * - `connected` — 開けた。委譲を置ける
 * - `unreachable` — 開けなかったが待てば直る種類の失敗。背景で挑み直している
 * - `unusable` — 挑み直しても同じ答えが返る失敗（鍵違い等）。**挑み直さない**
 * - `lost` — 一度は開けたのに、名乗り（`/health`）が返らなくなった。**委譲は置かない**
 *
 * `unreachable` と `lost` は似て見えるが**別物である**。前者は「まだ開けていない」
 * 宛先で、抱えている仕事は無い。後者は「開けていた」宛先で、**走っていた仕事ごと
 * 黙った**可能性がある — あとで移送の契機になるのはこちらだけである。
 */
export type RunnerLiveness = 'connecting' | 'connected' | 'unreachable' | 'unusable' | 'lost';

/**
 * runner 1台についての版の状態。`RunnerRevisionReport`（`known` / `unknown`）に
 * **`unheard`（名乗り自体をまだ一度も聞いていない）を足したもの**である。
 *
 * この3つ目は `identity()` の応答からは作れない — 応答そのものが一度も返って
 * いないことは、応答の中身を見る関数の外（名簿）でしか分からない。**`unknown` と
 * `unheard` を混同しないこと** — 前者は「繋がって名乗ったが版を知らない」、後者は
 * 「名乗りをまだ一度も聞けていない」で、対処が違う（前者は runner 自体の設定を
 * 疑う、後者はネットワーク・登録を疑う）。
 *
 * **`unheard` に `RunnerLiveness['unreachable']` と同じ語を使わなかった理由。**
 * 主語が違う——`RunnerLiveness.unreachable` は「宛先（宛先URL）が開けない」で
 * あり、こちらは「名乗り（`/health` の応答）を聞けていない」である。同じ語を
 * 別の主語へ使うと、読み手は2つを同じ意味として重ねて読む。
 *
 * **`RunnerLiveness` から導出できない。** 一見 `state === 'connected'` なら
 * `known`/`unknown`、それ以外なら `unheard` で足りそうに見えるが、実際には
 * 両方向にずれる（実測は `runner-swap.test.ts` / `apps/daemon/src/app.test.ts`
 * の「runner の版」系）。
 *
 * 1. **`state: 'lost'` でも `known` が残る。** `#markSilent`（このファイル内）は
 *    `state` を `'lost'` にするとき**それまでに学習した情報を捨てない**
 *    （`entry.client` も `entry.revision` もそのまま残る）。黙る直前に聞いた
 *    名乗りが、黙った後も見え続ける
 * 2. **`state: 'connected'` でも `unheard` のことがある——ただし版を名乗らない
 *    runner に限る。** `#open()` は `hello()` が既に読んでいた
 *    `RunnerClient.revision`（`runnerId` / `workspacePath` と同じ応答）を接続
 *    した瞬間に採るので、版を報告できる runner はここで `known` / `unknown`
 *    へ動く——`identity()` の最初の heartbeat（`HEARTBEAT_INTERVAL_MS` 後）を
 *    待たない。**`revision` を実装しない runner（`LocalRunner` 等）だけが
 *    `unheard` のまま残る**——`#open()` は `client.revision === undefined` の
 *    ときは触らないので、`register()` / `adopt()` の初期値が heartbeat の
 *    1周目まで見え続ける
 *
 * だから版の状態は生死とは別の契約として持つ。
 *
 * **`known` は「最後に聞いた名乗り」であって「いま走っている版」ではない。**
 * `state` が `'lost'` のとき、この値は黙る前のものである。単独で読まず `state`
 * と併せて読むこと（当たりのときだけ正しく、外れのときに黙って古い値を返す
 * 計器にしないための注記）。
 */
export type RunnerRevisionStatus = RunnerRevisionReport | { status: 'unheard' };

/**
 * 名簿の1行。**値は返さない**（鍵の指紋と同じ原則で、ここに出るのは状態だけ）。
 *
 * `runnerId` と `workspacePath` が省略されうるのは、**繋がるまで分からない**から
 * である。「登録されているのに繋がっていない」を表せないと、`GET /runners` が
 * 空を返すだけになり、人間には「runner を設定し忘れた」のか「上がってこない」のかが
 * 区別できない。
 */
export interface RunnerEntry {
  label: string;
  state: RunnerLiveness;
  runnerId?: string;
  workspacePath?: string;
  /** 直近の失敗の一行。原因を人間が見るための窓であって、値は載せない。 */
  error?: string;
  /** この状態になった時刻。 */
  since: string;
  /**
   * **いまこの宛先に応えているプロセス**（`identity()` が返す `instanceId`）。
   *
   * `runnerId` が「どの宛先か」で、こちらは「その宛先のどのプロセスか」である。
   * **名乗らない runner では無い**（`identity()` を持たない実装・古い器）。無いことを
   * 「入れ替わっていない」と読まないこと。
   *
   * ## 遷移だけでなく状態としても出す理由
   *
   * 入れ替わった瞬間は `onSwap` で知らせている（#115）が、それは**遷移の知らせ**で
   * あって、後から「いまどのプロセスが応えているのか」を確かめる口ではなかった。
   * 知らせを見落とした後、あるいはデーモン自身が再起動した後は、誰も検算できない。
   * 引き取りの可否（`lease.ts`）はこの値と次の `instanceSince` を材料にするので、
   * **判定に使う値が人間からも見えていないと、判定が正しいかを誰も確かめられない。**
   */
  instanceId?: string;
  /**
   * **そのプロセスを最初に見た時刻。** 入れ替わるたびに更新される。
   *
   * 「入れ替えを観測した時刻」ではなく「いまの相手を初めて見た時刻」である。
   * デーモンが再起動した直後は入れ替えの瞬間を知らないので、**自分が初めて見た
   * 時刻から数える**（知らない時刻を過去に見積もると、まだ畳まれていない器の仕事を
   * 奪いに行く。`lease.ts` の `LEASE_DRAIN_MS` の項）。
   */
  instanceSince?: string;
  /**
   * runner が名乗った版（roadmap M5 相当。「自分がどのコミットで走っているか」）。
   *
   * **常に3値のどれかで、省略されない。** 一度も名乗りを聞けていない間は
   * `{ status: 'unheard' }` のままで、`unknown`（訊けたが runner が知らない）
   * とは区別される。上の `instanceId` と同じく `identity()` の heartbeat で更新する。
   * **`state` が `'lost'` でも古い値が残ることがある**（`RunnerRevisionStatus`
   * の doc）。
   */
  revision: RunnerRevisionStatus;
}

/**
 * runner の名簿。デーモンは**固定 URL ではなくここ**を見る。
 *
 * **動的である**ことがこの層の本体である（roadmap M5）。デーモンは名簿が空のまま
 * 起動してよく、runner は後から載る。載る前に届いた委譲だけが待たされ、chat・日誌・
 * 承認は最初から動く（PRD「自律」— 人間の不在で止まってよいのは承認待ちの仕事だけ）。
 *
 * **`select` に人工的な上限を入れないこと。** 「同時に何本まで」は能力の削除で
 * あって配置の判断ではない（north_star 禁止2）。将来ここで見てよいのは、runner が
 * 報告する CPU・メモリ・稼働セッション数といった**実行環境の資源**である。
 */
export interface RunnerRegistry {
  /** いま開けている runner。**開けていないものは並ばない**（`entries` で見る）。 */
  list(): Promise<RunnerClient[]>;
  get(runnerId: string): Promise<RunnerClient | null>;
  /**
   * 新しい委譲をどの runner に置くか。
   *
   * **必ず返る。** 繋がっていないだけならごく短い猶予のあいだ待つが、それを過ぎたら
   * **分かる形で失敗する** — どの宛先がいまどの状態かを添えて投げる。呼んだ側
   * （クローン）はそれを読んで「少し置いて投げ直す」「人間に知らせる」を選べる。
   *
   * **返らないのは「黙って引き下がる」と同じ欠陥である。** 繋がるまで待つ形にすると、
   * 委譲を呼んだクローンのターンがそのまま張り付き、先に listen した意味が消える
   * （詰まる場所が移るだけになる）。
   *
   * **「常に返す」の意味は、定員で拒まないことである。** 接続がまだ無いことを理由に
   * 失敗するのは定員による拒否ではない。「同時に何本まで」を理由に断ってはいけない
   * （north_star 禁止2）が、宛先が居ないことは隠さずに言う。
   *
   * 失敗は3種類あり、**呼んだ側の対応が変わるので必ず区別する**。
   *
   * - 登録が0台 — 設定の問題。時間では直らない
   * - 登録はあるが、まだどれにも繋がっていない — 時間で解決する可能性がある
   * - 登録が全部 `unusable` — 挑み直さないので、投げ直しても同じ答えが返る
   *
   * **`cwd` はまだ置き先の材料になっていない。** 渡すと `Registry` は受け取るが読まない
   * （実装側の `select` にも同じ注意書きがある）。**「渡しているから効いている」と
   * 読まないこと** — 材料にできるのは workspace がどこにあるかを決めてからで、それは
   * roadmap M5 の「workspace locator の運用選択」である。いま全台が同じ `workspacePath`
   * （`/workspace`）を名乗り、実体だけが別のボリュームなので、パスの一致では
   * どの器のものか区別が付かない。**区別が付かないまま突き合わせる実装を入れると、
   * 効いていない照合を「効いている」と読める形で残すことになる。**
   *
   * **`runnerId` は指名（クローンが置き先を選ぶ口）として読む。** `cwd` とは扱いが
   * 違う——こちらは実装（`Registry#select`）が実際に読み、資源による自動配置
   * （`#place` / `chooseByResources`）を通さずにその器へ置く。**これは配置の指名で
   * あって、本数の制限ではない。** 名指しされた器が開けていて使えるかを確かめる
   * だけで、「同時に何本まで」という上限をここで作らない（north_star 禁止2。
   * このファイル冒頭の `runnerExecutionResourcesSchema` が `capacity` という語を
   * 避けた理由・上の「`select` に人工的な上限を入れないこと」と同じ論法である）。
   *
   * 指名したときの失敗も3種類あり、**どれでも自動配置へは落とさない**（落とすと、
   * クローンの判断が見えないまま自動配置に覆される）。
   *
   * - 名簿のどの器の `runnerId` とも一致しない（ただし `runnerId` は開けてから
   *   しか分からないので、まだ一度も開けていない器があるときは「分からないだけ
   *   かもしれない」と言う——「名簿に無い」と断定しない）
   * - 一致する器はあるが `connected` ではない（state と直近の失敗を添えて言う）
   * - 一致する器が複数開けている（`Registry#get` は線形一致で先に見つかった方を
   *   返す実装なので、指名しても片方に固定できない。roadmap M5 PR4（fencing）待ちの
   *   既知のギャップが、指名を足したことで「クローンの判断が黙って別の器へ向く」形で
   *   表に出る——`docs/roadmap.md` の申し送りそのもの）
   */
  select(input: { cwd?: string; runnerId?: string }): Promise<RunnerClient>;
  /**
   * 名簿に載せる。**開き終わるのを待たずに載る。**
   *
   * 最初の1回はここで試す（開ければ戻った時点で使える）が、**失敗しても投げない** —
   * 開けなかったことは名簿の状態になり、待てば直る種類なら背景で挑み直す。
   */
  register(source: RunnerSource): Promise<void>;
  /** 名簿から外す（背景の挑み直しも畳む）。label は `register` に渡したもの。 */
  unregister(label: string): Promise<void>;
  /** 登録されている全部。繋がっていないものも並ぶ（`GET /runners` の材料）。 */
  entries(): RunnerEntry[];
  /**
   * runner が開けたときに呼ばれる。**後から現れた runner に繋ぐための口**である。
   *
   * これが無いと、デーモン側（`ManagerPool`）はイベントの受け口を開く契機を
   * 起動時にしか持てず、後から載った runner の報告も許可確認も永久に届かない。
   */
  subscribe(onOpen: (runner: RunnerClient) => void): () => void;
  /**
   * 背景の挑み直しを畳む。
   *
   * **開いた runner は閉じない。** 閉じる方針は `ManagerPool` が持っている
   * （デーモンの都合で人の仕事を殺さない）。ここで閉じると方針が2箇所に散る。
   */
  stop(): Promise<void>;
}

/** 名簿の外へ出す知らせ（いまは「挑み直しても直らない失敗」だけ）。 */
export interface RunnerRegistryOptions {
  /**
   * 挑み直しても直らないと分かった失敗を、人間とクローンへ知らせる。
   *
   * **黙って挑み続けない。** 鍵違いや命令の形の誤りは待っても直らないので、
   * 背景で無限に叩くと設定の誤りが「なぜか繋がらない」として永久に隠れる。
   */
  notify?: (failure: { label: string; error: string }) => void;
  /**
   * 一度は開けた runner が黙ったときに、**1回だけ**呼ばれる。
   *
   * **状態の再計算ではなく遷移である。** 「いま何秒応答が無いか」を都度数える形だと
   * *落ちた瞬間*がどこにも現れず、あとで走っていた仕事を別の器へ移す契機が作れない
   * （roadmap M5 受け入れ基準4）。ここはその瞬間そのものを表す。
   *
   * **ここで移送はしない。** 移送は二重実行を止める仕組み（fencing）が入ってからで、
   * 先に動かすと同じマネージャーが2台で走る。この PR が出すのは知らせだけである。
   */
  onLost?: (lost: { label: string; runnerId?: string; error: string }) => void;
  /**
   * 同じ宛先に、**別のプロセスが応え始めた**ときに呼ばれる（roadmap M5 PR4）。
   *
   * **これは `onLost` では拾えない。** 器が入れ替わっても `/health` は応え続ける
   * ので、生死の判定からは何も起きていないように見える（＝黙って入れ替わる）。
   * roadmap 受け入れ基準6 が「一度開いた宛先が黙って入れ替わった場合は今も
   * 引き取りが走らない」と書いているのがこの状態で、その**判定材料が無い**ことが
   * 直接の原因だった。
   *
   * **ここで引き取り（`takeOver` → `managers.restore()`）はしない。** 入れ替えが
   * 見えるようになっても、「もう動いていない」ことの証明にはまだ足りない —
   * ネットワークだけが分かれた場合、古いプロセスは別のところで走り続けていて
   * 同じ宛先に新しいプロセスが応えうる。**貸し出し期限（lease）が揃って初めて
   * 引き取りの契機にできる。** この口が出すのは知らせだけである。
   *
   * **「1回だけ」は保証しない**（`onLost` とは違う）。入れ替わるたびに呼ばれる。
   */
  onSwap?: (swap: {
    label: string;
    /** 台帳の鎖に使っている宛先の名前。**書き換えていない値である。** */
    runnerId?: string;
    /** 前に応えていたプロセス。 */
    before: string;
    /** いま応えているプロセス。 */
    after: string;
  }) => void;
  /** 挑み直しの間隔（倍々で伸びる）。**回数では諦めない。** 主にテスト用。 */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /**
   * `select` が繋がるのを待つ猶予。**主にテスト用で、既定はコードに固定である。**
   *
   * **環境変数の設定項目にしないこと。** 数値をつまみとして外へ出すと、そこが
   * 実質の制限になる（「委譲は N 秒まで」は定員と同じ形をしている）。ここにあるのは
   * 起動直後の数秒をやり過ごすためだけの猶予で、運用でいじる値ではない。
   */
  selectWaitMs?: number;
}

/**
 * 挑み直しの間隔。**これは能力の上限ではなく、混雑を作らないための間隔である。**
 *
 * 上限で頭打ちにするのは、器が長く戻らないときに秒間何度も叩かないためであって、
 * 諦めるためではない（north_star 禁止2 が禁じているのは実行回数の制限である）。
 */
const REGISTRY_RETRY_BASE_MS = 1_000;
const REGISTRY_RETRY_MAX_MS = 30_000;

/**
 * `select` が繋がるのを待つ猶予。**この長さはコードに固定する。**
 *
 * 起動直後は名簿がまだ開いている最中なので、そこで即座に失敗させると使いにくい。
 * かといって待ち続けるのは「黙って引き下がる」と同じ欠陥である（呼んだ側が状況を
 * 知れない）。数秒だけ待って、あとは**状態を添えて失敗する**。
 *
 * **環境変数に出さないこと。** つまみにすると、そこが実質の制限になる。
 */
const SELECT_WAIT_MS = 3_000;

/**
 * 名乗りを聞きに行く間隔。**この3つの数値はコードに固定する。**
 *
 * **環境変数の設定項目にしないこと。** 「何秒で死んだと見なすか」をつまみとして
 * 外へ出すと、そこが実質の制限になる（長くすれば落ちた器が宛先のまま残り、
 * 短くすれば生きている器が落ちたことにされる）。運用でいじる値ではない。
 */
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * 黙ったままここまで経ったら「落ちた」と見なす（間隔の3回分）。
 *
 * **1回の取りこぼしで動かさない。** 器の再デプロイ中の一瞬や、詰まった1回の応答で
 * 宛先を失うと、生きている runner から仕事を取り上げることになる。
 */
const HEARTBEAT_LOST_MS = 30_000;

/**
 * `runnerId` を、聞けたときだけ含む形で組み立てる（#330）。
 *
 * **出口（`entries()` / `onSwap` / `onLost`）ごとに同じ条件分岐を書かないための
 * 1本。** 「(c) 出口ごとに落とす」を採らなかった理由そのものがこの関数の存在
 * 理由である——3か所に同じ分岐を散らすと、4か所目ができたときに書き忘れる。
 * ここを通せば、次に増える出口も自動でこの判定に乗る。
 *
 * `entry.client !== null` は `hello()` が解決したことしか意味さない。その応答に
 * `runnerId` が実際に入っていたかどうかは `RunnerClient.runnerIdKnown` を見ないと
 * 分からない——見ずに `entry.client.runnerId` を出すと、一度も聞けていない相手に
 * ついて既定値 `'runner-primary'` が「受け取った値」の顔で出る。
 *
 * ⚠️ **この関数が塞ぐのは出口だけである。** `onSwap` がここを通して `runnerId`
 * を渡さなくなったことで、`apps/daemon/src/index.ts` の `takeOverOnSwap` から
 * `reattachRunner(runnerId)`（`packages/core/src/manager.ts` の `#reattach`）へ
 * 既定値が渡る経路は塞がったが、**`#reattach` 自身がいまも `runnerId` の文字列
 * 一致だけで相手（と台帳の対象ジョブ）を決めている**——別の入口から同じ既定値が
 * 渡れば、複数 runner が同じ既定値を名乗ったときに宛先を取り違えうる。この
 * 欠陥自体は #390 へ切った（`#reattach` の在り処は `manager.ts` だが、#322 の
 * 作業と重ならないようこのファイルにポインタだけ置く）。
 */
function heardRunnerIdOf(client: RunnerClient | null): { runnerId?: string } {
  return client !== null && client.runnerIdKnown ? { runnerId: client.runnerId } : {};
}

/**
 * 1台に名乗らせるときの期限。
 *
 * **返らない1台が名簿全体を止めないため**にある。黙って死んだ器は「拒否する」の
 * ではなく「何も返さない」ので、期限が無いと probe がそのまま張り付き、
 * 次の間隔が来ても誰の生死も更新されない。
 */
const HEARTBEAT_PROBE_MS = 5_000;

/**
 * 資源を聞くときの期限。
 *
 * **環境変数の設定項目にしないこと。** つまみとして外へ出すと、そこが実質の制限に
 * なる（`SELECT_WAIT_MS` / `HEARTBEAT_*` に3度書いてあるのと同じ論法である）。
 * これは返らない1台の後ろで委譲を待たせないためだけの期限で、運用でいじる値では
 * ない。**期限を過ぎた1台は宛先から外れるのではなく、「報告しない器」になる。**
 */
const PLACEMENT_PROBE_MS = 2_000;

/**
 * 動的な名簿（roadmap M5）。
 *
 * 既に開いてある `RunnerClient` を渡す形も残してある — 既存の呼び出し（テストを
 * 含む）はそのまま動き、渡した分は「常に開ける開き方」として登録される。
 */
export function createRunnerRegistry(
  runners: RunnerClient[] = [],
  options: RunnerRegistryOptions = {},
): RunnerRegistry {
  const registry = new Registry(options);
  for (const runner of runners) registry.adopt(runner);
  return registry;
}

/** 名簿が1台について持つもの。 */
interface RegistryEntry {
  source: RunnerSource;
  state: RunnerLiveness;
  since: string;
  client: RunnerClient | null;
  error?: string;
  /** 開いている最中（**多重に開きに行かない**ための1本）。 */
  opening: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 次に待つ時間。開けたら忘れる。 */
  delay: number;
  /**
   * 最後に名乗りが返った時刻（ミリ秒）。開けた瞬間を起点にする。
   *
   * **経過時間だけで生死を決めない**（それは `alive` の仕事である）。ここにあるのは
   * 判定の材料であって判定そのものではない。
   */
  lastSeen: number;
  /**
   * **前回の判定結果。** これと突き合わせて初めて「落ちた瞬間」が観測できる。
   *
   * 毎回経過時間を計算し直すだけだと、落ちている間ずっと同じ答えが出るので、
   * 遷移（生きている → 落ちた）が消える。消えると知らせは何度も出るか一度も
   * 出ないかのどちらかになり、あとで移送の契機に使えない。
   */
  alive: boolean;
  /**
   * 最後に名乗ったプロセスの識別子（`identity()` が返す `instanceId`）。
   *
   * **`alive` と同じ形の「前回の値」である。** これと突き合わせて初めて
   * 「入れ替わった瞬間」が観測できる。持たない runner では `undefined` のままで、
   * そのときは**判定しない**（「入れ替わっていない」と読まないこと）。
   */
  instanceId?: string;
  /**
   * `instanceId` を**初めて見た時刻**（入れ替わるたびに置き直す）。
   *
   * 引き取りの可否がこの時刻から猶予を数える（`lease.ts`）。**入れ替えの瞬間では
   * なく「自分が初めて見た時刻」である**ことが要点で、デーモンが再起動した直後は
   * 入れ替えの瞬間を知らないから、知らないものを過去に見積もらないためにこの形に
   * してある。
   */
  instanceSince?: string;
  /**
   * 最後に聞けた版の状態（`RunnerEntry.revision` と同じ形）。
   *
   * **`instanceId` と違って「前回との比較」はしない。** 版の入れ替え自体は
   * `instanceId` の変化で既に検出できているので、ここは単に「最後に聞けた値」を
   * 持つだけでよい。名乗りを一度も聞けていない間は `{ status: 'unheard' }`
   * のまま — 応答が来て初めて `known` / `unknown` へ動く。**`state` が `'lost'`
   * になっても、ここは戻さない**（`#markSilent` は学習済みの情報を捨てない）。
   */
  revision: RunnerRevisionStatus;
}

/**
 * 名簿の内訳を一行に畳む（宛先・状態・直近の失敗。**値は載せない**）。
 *
 * **持ち主を1つにするために外へ出してある。** 宛先が引けなかったことを報告する
 * 場所は名簿の中だけではない（`ManagerPool#send` にもある）。同じものを両方で
 * 組み立てると、**片方だけが 5値を畳んだ形へ倒れても誰も気づけない** — 実際に
 * `send()` の側は状態を1つも見ずに「移送が要る」と恒久の結論を返していた。
 *
 * **`state` を `connected` へ畳まない。** 「まだ開けていない」と「待っても同じ
 * 答えが返る」の違いが、読む側が待つか起こし直すかを決める材料そのものである
 * （`RunnerRegistry#select` の doc が数え上げている3種類がこれである）。
 */
export function describeRunnerEntries(entries: RunnerEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${entry.label} は ${entry.state}` +
        `${entry.error === undefined ? '' : `（${entry.error}）`}`,
    )
    .join(' / ');
}

class Registry implements RunnerRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #subscribers = new Set<(runner: RunnerClient) => void>();
  /** `select` が繋がるのを待っている分。開けた瞬間に全部起こす。 */
  readonly #waiting = new Set<{
    resolve: (runner: RunnerClient) => void;
    reject: (e: Error) => void;
  }>();
  readonly #notify: ((failure: { label: string; error: string }) => void) | undefined;
  readonly #onLost:
    ((lost: { label: string; runnerId?: string; error: string }) => void) | undefined;
  readonly #onSwap:
    | ((swap: { label: string; runnerId?: string; before: string; after: string }) => void)
    | undefined;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #selectWaitMs: number;
  /** 名乗りを聞きに行く1本。**`stop()` で必ず畳む**（残すとテストがハングする）。 */
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: RunnerRegistryOptions) {
    this.#notify = options.notify;
    this.#onLost = options.onLost;
    this.#onSwap = options.onSwap;
    this.#retryBaseMs = options.retryBaseMs ?? REGISTRY_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxMs ?? REGISTRY_RETRY_MAX_MS;
    this.#selectWaitMs = options.selectWaitMs ?? SELECT_WAIT_MS;

    const heartbeat = setInterval(() => this.#beat(), HEARTBEAT_INTERVAL_MS);
    // 名乗りを聞くことでプロセスの終了を引き延ばさない。
    heartbeat.unref?.();
    this.#heartbeat = heartbeat;
  }

  /** 既に開いてある1台を、開き方として載せる（旧来の呼び出しの受け皿）。 */
  adopt(runner: RunnerClient): void {
    const label = runner.runnerId;
    this.#entries.set(label, {
      source: { label, open: async () => runner },
      state: 'connected',
      since: new Date().toISOString(),
      client: runner,
      opening: null,
      timer: null,
      delay: this.#retryBaseMs,
      lastSeen: Date.now(),
      alive: true,
      revision: { status: 'unheard' },
    });
  }

  /**
   * いま委譲を置ける1台。**`lost` は並ばない。**
   *
   * 落ちたと判定した器を宛先として返すのは「黙って引き下がる」の裏返しで、
   * 新しい仕事を沈黙へ投げ込むことになる。名簿からは消さない（`entries()` には
   * 残って人間から見える）が、置き先としては数えない。
   */
  async list(): Promise<RunnerClient[]> {
    return [...this.#entries.values()].flatMap((entry) =>
      entry.client === null || entry.state === 'lost' ? [] : [entry.client],
    );
  }

  async get(runnerId: string): Promise<RunnerClient | null> {
    for (const entry of this.#entries.values()) {
      if (entry.client?.runnerId === runnerId) return entry.client;
    }
    return null;
  }

  entries(): RunnerEntry[] {
    return [...this.#entries.values()].map((entry) => ({
      label: entry.source.label,
      state: entry.state,
      since: entry.since,
      revision: entry.revision,
      // ⚠️ `workspacePath` にも同じ形の既定値（`HttpRunner` の `''`）があるが、
      // この PR の対象は #330（`runnerId` の3出口）に限る。範囲外として #389 へ切った。
      ...(entry.client === null ? {} : { workspacePath: entry.client.workspacePath }),
      ...heardRunnerIdOf(entry.client),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      // **開けていなくても、最後に名乗ったプロセスは出す。** 黙った器について
      // 「どのプロセスが最後に応えていたか」は、戻ってきたときに同じ器かを
      // 突き合わせる材料である（消すと、黙っている間だけ判定材料が消える）。
      ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
      ...(entry.instanceSince === undefined ? {} : { instanceSince: entry.instanceSince }),
    }));
  }

  subscribe(onOpen: (runner: RunnerClient) => void): () => void {
    this.#subscribers.add(onOpen);
    return () => this.#subscribers.delete(onOpen);
  }

  async register(source: RunnerSource): Promise<void> {
    if (this.#stopped) return;
    const existing = this.#entries.get(source.label);
    // 既に開けている宛先を登録し直しても、繋ぎ直さない（同じものが二重に載らない）。
    if (existing?.state === 'connected') return;
    // 開けていない宛先は、**予約を畳んでから**入れ替える。人間が設定を直して
    // 登録し直した場合、古い開き方で挑み続ける予約が残ると直したものが効かない。
    if (existing !== undefined && existing.timer !== null) clearTimeout(existing.timer);

    const entry: RegistryEntry = {
      source,
      state: 'connecting',
      since: new Date().toISOString(),
      client: null,
      opening: null,
      timer: null,
      delay: this.#retryBaseMs,
      lastSeen: Date.now(),
      alive: true,
      revision: { status: 'unheard' },
    };
    this.#entries.set(source.label, entry);
    await this.#open(entry);
  }

  async unregister(label: string): Promise<void> {
    const entry = this.#entries.get(label);
    if (entry === undefined) return;
    this.#entries.delete(label);
    if (entry.timer !== null) clearTimeout(entry.timer);
    // **外した宛先の口は閉じる。** 名簿から消えたのに SSE だけ残ると、誰も宛先と
    // して選べない runner のイベントがデーモンに流れ続ける。
    await entry.client?.close().catch(() => undefined);
  }

  /**
   * **`cwd` は今も読まない。`runnerId` は読む。** `RunnerRegistry#select` は
   * `{ cwd?; runnerId? }` を渡せる形で宣言してあり、`ManagerPool#start` は `cwd` を
   * 実際に渡している（`manager.ts`）。だが下の仮引数の分解には `runnerId` しか
   * 含めていないので、**`cwd` はこの実装に届いていない。**
   *
   * `cwd` を引数だけ受けて捨てる形にしないのは、受けてあると「読んでいるが効かな
   * かった」に見え、届いていないこと自体が消えるからである。仮引数を作らなければ、
   * 呼び出し側から辿った者がここで必ず気づく。`cwd` が材料にできるようになるのは
   * roadmap M5 の「workspace locator の運用選択」の後である（宣言側の注意書きに
   * 理由を書いた）。
   *
   * **`runnerId` は指名として読む。** 名指しされた器が開けていて使えるなら、点数
   * 計算（`#place`）を通さずそこへ置く。**これは配置の指名であって、本数の制限では
   * ない**（north_star 禁止2。宣言側の doc と同じ論法）。失敗の3種類とその文言は
   * `#selectByName` に持たせてある——どの失敗でも自動配置へは落とさない。
   */
  async select({ runnerId }: { cwd?: string; runnerId?: string } = {}): Promise<RunnerClient> {
    if (runnerId !== undefined) return this.#selectByName(runnerId);

    const until = Date.now() + this.#selectWaitMs;
    for (;;) {
      if (this.#stopped) throw new Error('名簿が停止している');

      // **配置の材料は実行環境の資源だけ**である（定員は作らない）。
      const open = await this.list();
      const first = open[0];
      if (first !== undefined) {
        // 1台しか無いなら聞きに行かない。答えは変わらないのに、委譲を起こす経路へ
        // 往復1回分の待ちを足すだけである。
        if (open.length === 1) return first;
        return await this.#place(open, first);
      }

      // **設定の問題と、時間で解決しうる問題を混ぜない。** 呼んだ側の対応が違う。
      if (this.#entries.size === 0) {
        throw new Error(
          'manager-runner が1台も登録されていない。' +
            'これは設定の問題なので、時間を置いても直らない' +
            '（ALTEROID_RUNNER_URLS / ALTEROID_RUNNER_URL か同一プロセスの runner が要る）。',
        );
      }

      // 挑み直す先が1つも無いなら、待っても誰も来ない。**理由を添えて即座に返す** —
      // ここで待つと、鍵を間違えた人間が「なぜか委譲が返ってこない」を見る。
      const pending = [...this.#entries.values()].filter((entry) => entry.state !== 'unusable');
      if (pending.length === 0) {
        throw new Error(
          `登録されている manager-runner がどれも使えない。挑み直しても同じ答えが返る種類の` +
            `失敗なので、名簿は挑み直していない: ${this.#describeEntries()}`,
        );
      }

      // まだ開いている最中（か、挑み直しの合間）。**ごく短い猶予だけ待つ。**
      const remaining = until - Date.now();
      if (remaining <= 0) throw new Error(this.#notConnectedMessage());
      const opened = await this.#waitForOpen(remaining);
      if (opened === null) throw new Error(this.#notConnectedMessage());
    }
  }

  /**
   * 指名（`runnerId`）で置き先を選ぶ（クローンが器を選ぶ口）。
   *
   * **これは配置の指名であって、本数の制限ではない。** 名指しされた器が使えるかを
   * 確かめるだけで、「同時に何本まで」という上限をここで作らない（north_star
   * 禁止2。`select` 宣言側の doc・`runnerExecutionResourcesSchema` が `capacity`
   * という語を避けた理由と同じ論法）。
   *
   * **待たない。** 資源が無いときの `select` はごく短い猶予（`#selectWaitMs`）だけ
   * 待つが、名前の解決は「いつか開けば分かる」という性質のものではなく、待っても
   * 名乗っていない器の正体は変わらない。呼んだ側（クローン）が「少し置いて
   * 投げ直す」を選べるように、状態をそのまま返す。
   *
   * 失敗は3種類あり、**どれでも自動配置（`#place`）へは絶対に落とさない。** 落とすと
   * クローンが指名した判断が見えないまま自動配置に上書きされる——「指名したのに
   * 別の器で走った」という、観測されない不一致を作ることになる。
   *
   * - 名簿のどの器の `runnerId` とも一致しない。ただし `runnerId` は**開けてから
   *   しか分からない**ので、まだ一度も開けていない器（`unusable` 以外で
   *   `client === null` の分）が残っているなら、「無い」と断定せず「まだ分からない
   *   だけかもしれない」と言う
   * - 一致する器はあるが `state !== 'connected'`（`lost` 等）。state と直近の失敗を
   *   添えて言う
   * - 一致する器が複数開けている。**`Registry#get` は `#entries` を線形一致で
   *   走査し先に見つかった方を返す実装なので、指名しても片方に固定できない**
   *   （`docs/roadmap.md` M5 の申し送り、`get()` の doc に同じ注意がある）。
   *   fencing（roadmap M5 PR4）が無いいまは、これを「一意でない」として拒むのが
   *   誤った器を黙って選ぶよりましである
   */
  #selectByName(runnerId: string): RunnerClient {
    const matches = [...this.#entries.values()].filter(
      (entry) => entry.client?.runnerId === runnerId,
    );

    if (matches.length > 1) {
      throw new Error(
        `runnerId=${runnerId} を名乗る器が ${matches.length} 台開けている（名前が一意でない）。` +
          'Registry#get は線形一致で先に見つかった方を返す実装なので、指名しても片方には' +
          '固定できない（roadmap M5 PR4 の fencing 待ちの既知のギャップ）: ' +
          matches.map((entry) => `${entry.source.label}(${entry.state})`).join(' / '),
      );
    }

    const match = matches[0];
    if (match === undefined) {
      // **まだ開けていない器（`client === null`）が残っているかを見る。** `unusable`
      // は挑み直さないと決めた器なので、これ以上分かるようにはならない——除外する。
      const stillUnknown = [...this.#entries.values()].some(
        (entry) => entry.client === null && entry.state !== 'unusable',
      );
      throw new Error(
        `runnerId=${runnerId} という名前は名簿のどの器の runnerId とも一致しない。` +
          (stillUnknown
            ? 'ただし、まだ一度も開けていないので runnerId が分からない器が残っている' +
              '（開けば一致するかもしれない、「無い」とは断定できない）: '
            : '登録されている器はすべて開き終わっており、それでも一致しなかった: ') +
          this.#describeEntries(),
      );
    }

    if (match.state !== 'connected') {
      throw new Error(
        `runnerId=${runnerId}（${match.source.label}）は名簿にあるが使えない` +
          `（state: ${match.state}${match.error === undefined ? '' : ` / ${match.error}`}）。` +
          '他の器へは自動で落とさない——指名は指名のまま失敗する。',
      );
    }

    const client = match.client;
    // 上のフィルタ（`entry.client?.runnerId === runnerId`）を通った時点で non-null。
    if (client === null) throw new Error(`runnerId=${runnerId} の内部整合性エラー`);
    return client;
  }

  /**
   * 開けている中から置き先を決める。**ここで断ることは無い。**
   *
   * **全台へ同時に聞く**（順番待ちを作らない）。聞けなかった1台は「報告しない器」に
   * 落ちるだけで、配置そのものは期限内に終わる — 資源を聞けなかったことを理由に
   * 宛先から外すと、資源を報告しない器が締め出される（デグレード）。
   */
  async #place(open: readonly RunnerClient[], fallback: RunnerClient): Promise<RunnerClient> {
    const reports = await Promise.all(
      open.map(async (client) => {
        try {
          const resources = await withDeadline(
            (signal) => client.resources?.({ signal }) ?? Promise.resolve(undefined),
            PLACEMENT_PROBE_MS,
            '資源の報告',
          );
          return { client, resources };
        } catch {
          return { client, resources: undefined };
        }
      }),
    );
    return chooseByResources(reports) ?? fallback;
  }

  /**
   * 「まだ繋がっていない」の言い方。**状態と直近の失敗を必ず添える。**
   *
   * 呼んだ側（クローン）がこれを読んで「少し置いて投げ直す」「人間に知らせる」を
   * 選べるようにするためのものである。「繋がりません」だけでは何も判断できない。
   */
  #notConnectedMessage(): string {
    return (
      'いま繋がっている manager-runner が無いので、委譲を置けない。' +
      '名簿は背景で挑み直し・名乗りの確認を続けている（回数では諦めない）ので、' +
      '少し置いて投げ直せば通ることがある: ' +
      this.#describeEntries()
    );
  }

  /** 名簿の内訳を一行に畳む（宛先・状態・直近の失敗。**値は載せない**）。 */
  #describeEntries(): string {
    return describeRunnerEntries(this.entries());
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    // **名乗りを聞く1本を先に畳む。** 畳み残すと、止めたはずの名簿が背景で
    // runner を叩き続ける（テストならそのままハングする）。
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const entry of this.#entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
    }
    for (const waiter of this.#waiting) waiter.reject(new Error('名簿が停止した'));
    this.#waiting.clear();
    this.#subscribers.clear();
  }

  // -------------------------------------------------------------------------
  // 開く
  // -------------------------------------------------------------------------

  /** 1つの宛先を開く。**同じ宛先へ多重に開きに行かない。** */
  #open(entry: RegistryEntry): Promise<void> {
    const already = entry.opening;
    if (already !== null) return already;

    const opening = (async () => {
      try {
        const client = await entry.source.open();
        if (this.#stopped || this.#entries.get(entry.source.label) !== entry) {
          // 開いている間に外された（か止まった）。**握り潰さずに閉じる。**
          await client.close().catch(() => undefined);
          return;
        }
        entry.client = client;
        entry.state = 'connected';
        entry.since = new Date().toISOString();
        delete entry.error;
        entry.delay = this.#retryBaseMs;
        // 開けた瞬間が生存判定の起点。ここを置き忘れると、開いた直後の1台が
        // 「30秒黙っていた」ことにされる。
        entry.lastSeen = Date.now();
        entry.alive = true;
        /*
         * **`hello()` で既に読んでいた名乗りを、ここで採る（新しい呼び出しは増やさない）。**
         *
         * 拾うのは2つで、どちらも同じ応答（`GET /health`）に載っている。
         *
         * - **版**（`revision`）— identity() の heartbeat（最大
         *   `HEARTBEAT_INTERVAL_MS` 後）を待たずに、繋がった瞬間から版が分かる
         *   runner はそう見える（`RunnerRevisionStatus` の doc「2. state:
         *   connected でも unheard のことがある」の窓を、報告できる runner に
         *   ついては塞ぐ）
         * - **いま応えているプロセス**（`instanceId`。roadmap M5 PR4）— 直後の
         *   `#subscribers` はデーモンの引き取りで、そこでは貸し出し期限の判定
         *   （`lease.ts`）がこの値を材料にする。heartbeat の1周を待つと、
         *   **開け直しのたびに「判定材料が無い」状態で引き取りが走る窓**ができる
         *   — それは生きている器の仕事を奪いうる側である
         *
         * **省略している runner（`LocalRunner` 等）では両方 `undefined`** なので、
         * ここでは何も触らず初期値（版は `unheard`、プロセスは無し）のまま残る。
         * 無いことを「変わっていない」と読まないこと。
         */
        this.#noteInstance(entry, entry.lastSeen, {
          ...(client.instanceId === undefined ? {} : { instanceId: client.instanceId }),
          ...(client.revision === undefined ? {} : { revision: client.revision }),
        });
        for (const subscriber of this.#subscribers) subscriber(client);
        for (const waiter of this.#waiting) waiter.resolve(client);
        this.#waiting.clear();
      } catch (error) {
        if (this.#stopped || this.#entries.get(entry.source.label) !== entry) return;
        entry.client = null;
        entry.error = String(error);
        entry.since = new Date().toISOString();
        if (isRetryableRunnerError(error)) {
          // 待てば直る。**回数では諦めない**（諦めた先に残るのは、宛先を失った
          // まま誰にも知らされないデーモンである）。
          entry.state = 'unreachable';
          this.#scheduleOpen(entry);
        } else {
          // 待っても直らない。挑み直さずに知らせる（`select` はこの状態を見る）。
          entry.state = 'unusable';
          this.#notify?.({ label: entry.source.label, error: String(error) });
          this.#failIfAllUnusable();
        }
      } finally {
        entry.opening = null;
      }
    })();

    entry.opening = opening;
    return opening;
  }

  #scheduleOpen(entry: RegistryEntry): void {
    if (this.#stopped || entry.timer !== null) return;
    const delay = entry.delay;
    entry.delay = Math.min(delay * 2, this.#retryMaxMs);
    const timer = setTimeout(() => {
      entry.timer = null;
      if (this.#stopped || this.#entries.get(entry.source.label) !== entry) return;
      void this.#open(entry);
    }, delay);
    // 名簿の挑み直しでプロセスの終了を引き延ばさない。
    timer.unref?.();
    entry.timer = timer;
  }

  // -------------------------------------------------------------------------
  // 生きているかを聞く（roadmap M5）
  //
  // **SSE の `hello` の置き換えではない。** あれは器が礼儀正しく落ちたときにしか
  // 届かない。電源が抜けた器も、ネットワークだけが切れた器も、ストリームは開いた
  // まま何も言わなくなる — その沈黙をここで拾う。
  // -------------------------------------------------------------------------

  /** 名乗りを聞きに行く1周。**全台へ同時に投げる**（順番待ちを作らない）。 */
  #beat(): void {
    if (this.#stopped) return;
    const at = Date.now();
    for (const entry of [...this.#entries.values()]) {
      // 開けていない宛先は挑み直しの担当。ここで二重に叩かない。
      if (entry.client === null) continue;
      // **待たずに次を投げる。** 直列に回すと、返らない1台の後ろに全台が並び、
      // 1台の沈黙が名簿全体の生死判定を止める。
      void this.#probe(entry, at);
    }
  }

  /** 1台に名乗らせる。期限を過ぎたら中断して「返らなかった」として扱う。 */
  async #probe(entry: RegistryEntry, at: number): Promise<void> {
    const client = entry.client;
    if (client === null) return;

    let failure: string | null = null;
    let identity:
      { runnerId?: string; instanceId?: string; revision?: RunnerRevisionReport } | undefined;
    try {
      /*
       * **`identity()` があればそちらを叩く。** 同じ `GET /health` なので生死は
       * 等しく分かり、往復は増えない。読むのは名乗りの中身だが、**採らない**
       * （`#markSeen` が `runnerId` を書き換えないことで守っている）。
       *
       * 両方叩かないのは、10秒ごとに全台へ2往復を投げることになるからである。
       */
      identity = await withDeadline(
        (signal) =>
          client.identity !== undefined
            ? client.identity({ signal })
            : (client.ping?.({ signal }) ?? Promise.resolve()).then(() => undefined),
        HEARTBEAT_PROBE_MS,
      );
    } catch (error) {
      failure = String(error);
    }

    // 聞いている間に外された / 開き直された / 名簿が止まった。**古い答えで上書きしない。**
    if (this.#stopped) return;
    if (this.#entries.get(entry.source.label) !== entry || entry.client !== client) return;

    if (failure === null) {
      this.#markSeen(entry, at, client, identity);
      return;
    }
    this.#markSilent(entry, at, failure);
  }

  /**
   * 名乗りが返った。
   *
   * **黙っていた器が戻ってきたら、そう言う。** 状態を `lost` のままにすると、
   * 生きている runner が宛先から永久に外れる（回復を認めないのは能力の削除である）。
   *
   * **ここで `#subscribers` を呼ばないのは、漏れではなく判断である。** 開けたとき
   * （`#open`）に呼ぶ側はデーモンで引き取り（`takeOver` → `managers.restore()`）に
   * 繋がっているが、`lost` → `connected` の回復はその契機にしない。
   *
   * 理由は、**ここでは器の入れ替えと単なる回復を区別できない**ことである。`ping` は
   * 生死だけを見て名乗りの中身（`runner_id`）を読まない — 読んで黙って書き換えると
   * 台帳の鎖（`manager_id → runner_id`）が音もなく繋ぎ変わるからで、これは意図した
   * 設計である（`RunnerClient.ping`）。その結果、新しいコンテナが `/health` に応え
   * 始めたのか、同じ器が戻ってきただけなのかが、この層からは同じに見える。
   * 区別が付かないまま引き取りを走らせると、**生きている器で走っている仕事を奪いに
   * 行く**＝同じマネージャーが2台で走る。
   *
   * **解決するのは fencing（roadmap M5 PR4）である。** 「引き取ってよいか」を判定
   * できるようになって初めて、この遷移を契機にできる。それまでは知らせるだけに留める。
   *
   * ## 区別だけは付くようになった（それでも引き取りは走らせない）
   *
   * `identity()` を持つ runner については、**入れ替わったこと自体は分かる**
   * （`instanceId` が変わる）。上の「区別できない」はその材料が無かったという話で、
   * いまは `#onSwap` で知らせている。
   *
   * **それでも引き取りの契機にはしない。** 入れ替えが見えることと「もう動いて
   * いない」ことは別である — ネットワークだけが分かれた場合、古いプロセスは別の
   * ところで走り続けていて、同じ宛先に新しいプロセスが応えうる。片側だけで
   * 「もう動いていない」と言うには貸し出し期限（lease）が要る。
   *
   * **`runnerId` は絶対に採らない。** 採れば台帳の鎖が音もなく繋ぎ変わる（`ping` の
   * 項に書いてある元の理由）。ここで見るのは「変わったか」だけで、値は使わない。
   */
  #markSeen(
    entry: RegistryEntry,
    at: number,
    client: RunnerClient,
    identity?: { runnerId?: string; instanceId?: string; revision?: RunnerRevisionReport },
  ): void {
    entry.lastSeen = at;
    // 名乗りの中身（いま応えているプロセスと、その版）を覚えるのは1本に寄せてある
    // （開けた瞬間の探りと、この heartbeat の両方から同じ判定を通すため）。
    this.#noteInstance(entry, at, identity);
    if (entry.alive) {
      // 一時的にこけていただけの失敗は、返ってきた時点で窓から下ろす。
      delete entry.error;
      return;
    }
    entry.alive = true;
    entry.state = 'connected';
    entry.since = new Date().toISOString();
    delete entry.error;
    // 戻ってきた1台は、いま待っている `select` の宛先になれる。
    for (const waiter of this.#waiting) waiter.resolve(client);
    this.#waiting.clear();
  }

  /**
   * 名乗りの中身から「**いまその名前に応えているプロセス**」を覚える。
   *
   * **採るのは `instanceId` だけで、`runnerId` は絶対に採らない。** 採れば台帳の鎖
   * （`manager_id → runner_id`）が音もなく繋ぎ変わる（`RunnerClient.ping` の項）。
   *
   * 開けた直後（`#open`）とハートビート（`#markSeen`）の両方から呼ぶ。**同じ判定を
   * 2箇所に書かないための1本**であって、呼ばれる契機の違いは覚える時刻にしか出ない。
   */
  #noteInstance(
    entry: RegistryEntry,
    at: number,
    identity:
      { runnerId?: string; instanceId?: string; revision?: RunnerRevisionReport } | undefined,
  ): void {
    /*
     * **版は「最後に聞けた値」をそのまま覚える。** `instanceId` と違って前回との
     * 比較はしない — 版の入れ替え自体は `instanceId` の変化で既に検出できているので、
     * ここは持つだけでよい。
     *
     * **`identity` 自体が無い（`identity()` を持たない runner／`ping` だけの旧来
     * 経路）ときは触らない。** `{ status: 'unheard' }` のまま残す — 「訊けたが
     * 分からない」（`unknown`）と混同しない。
     *
     * **`instanceId` を名乗らない相手でも版だけは覚える**ので、この判定は下の
     * 早期 return より前にある（下は「入れ替わりを判定できない」ための return で
     * あって、「何も覚えない」ための return ではない）。
     */
    if (identity?.revision !== undefined) {
      entry.revision = identity.revision;
    }

    const instanceId = identity?.instanceId;
    if (instanceId === undefined || instanceId.length === 0) return;
    const before = entry.instanceId;
    // **初めて聞いた分は入れ替えではない。** 覚えるだけ（覚える前に知らせると、
    // デーモンが起きた直後に必ず1回「入れ替わった」が出る）。
    entry.instanceId = instanceId;
    // 「いまの相手を初めて見た時刻」。**同じ相手なら動かさない**（動かすと、
    // 入れ替わりの猶予がハートビートごとに先送りされ、期限が永久に来ない）。
    if (before !== instanceId || entry.instanceSince === undefined) {
      entry.instanceSince = new Date(at).toISOString();
    }
    if (before === undefined || before === instanceId) return;
    this.#onSwap?.({
      label: entry.source.label,
      // **書き換えていない値をそのまま渡す。** 台帳の鎖はこの名前で繋がっている。
      // **聞けたときだけ渡す（#330）** — `heardRunnerIdOf` の doc を参照。
      ...heardRunnerIdOf(entry.client),
      before,
      after: instanceId,
    });
  }

  /**
   * 名乗りが返らなかった。
   *
   * **直近の失敗は必ず残す**（`GET /runners` の窓）。黙って引き下がると、人間には
   * 「なぜか委譲が届かない」としか見えない。
   *
   * 落ちたと決めるのは**遷移**のときだけで、落ちている間ずっと知らせ続けない。
   */
  #markSilent(entry: RegistryEntry, at: number, error: string): void {
    entry.error = error;
    // 既に落ちたと判定済み。**`onLost` は1回だけ**である。
    if (!entry.alive) return;
    // **1回の取りこぼしでは動かさない。** 器の再デプロイ中の一瞬や詰まった1回の
    // 応答で宛先を失うと、生きている runner から仕事を取り上げることになる。
    if (at - entry.lastSeen < HEARTBEAT_LOST_MS) return;

    entry.alive = false;
    entry.state = 'lost';
    entry.since = new Date().toISOString();
    this.#onLost?.({
      label: entry.source.label,
      // **聞けたときだけ渡す（#330）** — `heardRunnerIdOf` の doc を参照。
      ...heardRunnerIdOf(entry.client),
      error,
    });
  }

  /**
   * 次にどれかが開けるまで、猶予のあいだだけ待つ。時間切れは `null`。
   *
   * **待ちを名簿に残したまま帰らない。** 残すと、`stop` のときに誰も見ていない
   * 拒否が投げられ、時間切れのたびに待ちが積み上がる。
   */
  #waitForOpen(ms: number): Promise<RunnerClient | null> {
    return new Promise<RunnerClient | null>((resolve, reject) => {
      // 先に宣言しないと待ち手が自分を畳めない（呼ばれるのは必ず設定後である）。
      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout>;
      const waiter = {
        resolve: (runner: RunnerClient) => {
          clearTimeout(timer);
          this.#waiting.delete(waiter);
          resolve(runner);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.#waiting.delete(waiter);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        this.#waiting.delete(waiter);
        resolve(null);
      }, ms);
      timer.unref?.();
      this.#waiting.add(waiter);
    });
  }

  /** 待っている `select` に、もう挑み直す先が無いことを伝える（猶予を待たせない）。 */
  #failIfAllUnusable(): void {
    if (this.#waiting.size === 0) return;
    if ([...this.#entries.values()].some((entry) => entry.state !== 'unusable')) return;
    const message =
      '登録されている manager-runner がどれも使えない。挑み直しても同じ答えが返る種類の' +
      `失敗なので、名簿は挑み直していない: ${this.#describeEntries()}`;
    for (const waiter of [...this.#waiting]) waiter.reject(new Error(message));
    this.#waiting.clear();
  }
}

/**
 * 期限付きで待つ。**期限を過ぎたら中断まで伝える。**
 *
 * 競争（`Promise.race`）だけだと、名簿は先へ進めても叩かれた側の繋ぎは開いたまま
 * 残る。黙って死んだ器を10秒ごとに叩けば、返らない繋ぎが積み上がっていく。
 * `signal` を渡し、かつ期限で自分も抜ける — **どちらか片方では足りない**
 * （中断を無視する実装があっても名簿は止まらない、が成り立たなくなる）。
 */
function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  what = '名乗り',
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${ms}ms 以内に${what}が返らなかった`));
    }, ms);
    timer.unref?.();
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      finish();
    };
    let started: Promise<T>;
    try {
      started = run(controller.signal);
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    started.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/**
 * 資源から置き先を決める（roadmap M5 PR3）。**必ず1台返る。**
 *
 * 点数は「メモリの余り × 新しい1本が受け取る CPU」である。
 *
 * - メモリの余り = `(limitBytes - usedBytes) / limitBytes`（0〜1）
 * - 新しい1本が受け取る CPU = `cores / (managers + 1)`
 *
 * **重みを持たないのは意図である。** 掛け算にしてあるので係数が要らず、したがって
 * 外に出す先も無い。重みを設定項目にすれば、そこが実質の定員つまみになる
 * （「メモリの重みを上げる」は「メモリが減ったら断る」に化ける）。`SELECT_WAIT_MS` /
 * `HEARTBEAT_*` に3度書いてあるのと同じ論法である。
 *
 * **報告の無い材料は、見えている器の平均で埋める。** 除外すれば資源を報告しない
 * 古い器が締め出され（roadmap M5 受け入れ基準5 — runner 数を増減しても能力削減が
 * 入らない。禁止2 の「追加制限」でもある）、最良として扱えば余裕のある新しい器が
 * 選ばれなくなる。**どちらも欠陥なので、真ん中に置く** — 平均で埋めた器は、自分が
 * 報告できた材料だけで平均的な器と競う。M4 から `/health` が返している `managers`
 * は古い器も名乗るので、資源を報告しない器も**自分の抱えている本数では競える。**
 *
 * 誰も何も報告しないときは全部の材料が平均に落ち、点数は `1 / (managers + 1)` —
 * つまり**抱えている本数の少ない方**になる。
 *
 * 同点なら登録順の先（`>` で比べている）。**0点でも返る。** 資源を見るのは「どこに
 * 置くか」を決めるためで、「置けるか」を決めるためではない（north_star 禁止2）。
 */
function chooseByResources(
  reports: readonly { client: RunnerClient; resources: RunnerPlacementResources | undefined }[],
): RunnerClient | undefined {
  const rooms = reports.flatMap((r) =>
    r.resources?.memory ? [memoryRoomOf(r.resources.memory)] : [],
  );
  const cores = reports.flatMap((r) => (r.resources?.cpu ? [r.resources.cpu.cores] : []));
  const held = reports.flatMap((r) =>
    r.resources?.managers === undefined ? [] : [r.resources.managers],
  );
  // 誰も報告しないときの 1 は「点数を素通りさせる値」であって、上限ではない。
  const meanRoom = mean(rooms) ?? 1;
  const meanCores = mean(cores) ?? 1;
  const meanHeld = mean(held) ?? 0;

  let best: RunnerClient | undefined;
  let bestScore = -Infinity;
  for (const report of reports) {
    const room = report.resources?.memory ? memoryRoomOf(report.resources.memory) : meanRoom;
    const share =
      (report.resources?.cpu?.cores ?? meanCores) / ((report.resources?.managers ?? meanHeld) + 1);
    const score = room * share;
    if (score > bestScore) {
      bestScore = score;
      best = report.client;
    }
  }
  return best;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** メモリの余り（0〜1）。**使い切っていても 0 で、負にはしない**（0点でも置き先になる）。 */
function memoryRoomOf(memory: { limitBytes: number; usedBytes: number }): number {
  if (!(memory.limitBytes > 0)) return 1;
  return Math.min(1, Math.max(0, (memory.limitBytes - memory.usedBytes) / memory.limitBytes));
}
