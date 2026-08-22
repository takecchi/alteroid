/**
 * 版（コミット sha）の**型と言い方**だけを持つ、ブラウザが読める軽い口。
 *
 * **実行時の依存を1つも持たない。** これは意図的な分離である — `@alteroid/core/revision`
 * として subpath で出しており、**ブラウザ（apps/web）はここだけを読む**
 * （`usage-format.ts` と同じ理由）。
 *
 * 隣の `revision.ts` は焼き込み（`generated/canon.ts`。正典の全文で約 95KB）と zod を
 * 読むので、そこから画面へ言い方を配ると、**「版を1行出す」ためにその全部が初期
 * チャンクへ入る。** かといって画面側に文言を書き写すと、状態が増えたときにそこだけ
 * 古くなる（`unknown` と `unheard` の区別が画面でだけ消えるのが、最も起こりやすい
 * 壊れ方である）。
 *
 * **「取れなかった」を「取れた」に見せてはいけない**という約束は `revision.ts` の
 * 冒頭が持つ。ここはその約束の**表示側**であって、埋める側ではない。
 */

/**
 * どこから取れた値か。
 *
 * - `'build'` — `ALTEROID_BUILD_REV` を焼き込み時に渡された（`write-canon.mjs`）
 * - `'workspace'` — 焼き込み時の git 作業ツリーから `git rev-parse HEAD` で拾った
 * - `'env'` — 実行時の `ALTEROID_BUILD_REV`（人間が手で置いた値）
 * - `'platform'` — 実行時の `RAILWAY_GIT_COMMIT_SHA`（Railway がデプロイごとに注入）
 */
export type RevisionSource = 'build' | 'workspace' | 'env' | 'platform';

/**
 * いま走っているプロセスの版。
 *
 * **不変条件: `commit` と `short` は必ず揃って `null` になるか、揃って値を持つ。**
 * ただし `source` はそれとは独立に `null` になりうる——`commit`/`short` が値を
 * 持っていても `source` だけ `null` という組み合わせが実際に起きる（優先順位1
 * の焼き込み分岐で、`baked.revision` は非空なのに `baked.source` が `'build'` /
 * `'workspace'` のどちらでもないとき）。**「commit が在れば source も必ず在る」
 * とは読まないこと。** いまの `write-canon.mjs` は `''` / `'build'` /
 * `'workspace'` しか書かないのでこの組み合わせには実際には到達しないが、
 * `resolveBuildRevision` の実装は到達を許している——**返る値は正直**（「sha は
 * 分かるが出所の分類は分からない」）で、doc がそれより強い制限を書くと、次に
 * 読む人は「doc が嘘だ」と実装のほうを直しに行く。
 */
export interface BuildRevision {
  /**
   * フル sha（40桁）。取れなければ `null`。
   *
   * コミット sha は**秘密ではない**（公開リポジトリを指すポインタである）ので、
   * 伏せない。**この判断は「このリポジトリが公開である」という前提に乗っている。
   * 非公開になったら成り立たない。**（いまこの値が出るのは認証の内側だけ
   * ——`GET /runners` は認証必須、runner の `/health` は制御面の合鍵の内側
   * ——なので、この判断が実際に効いている場面は無い。**前提が変わったときに
   * 読む場所として置いてある。**）
   */
  commit: string | null;
  /** 表示用の短縮。取れなければ `null`。 */
  short: string | null;
  source: RevisionSource | null;
}

/**
 * runner 1台についての版の報告。**器から返ってきた応答の中身だけを表す。**
 *
 * - `known` — 版が返ってきた
 * - `unknown` — 器には繋がった（`/health` が応答した）が、器自身が自分の版を
 *   知らない（`resolveBuildRevision` が全部 `null` を返した、または `revision`
 *   フィールド自体を持たない古い runner）
 *
 * **「そもそも訊けていない」はここには無い。** それは応答の中身ではなく
 * 「応答が無かった」ことなので、この型の外（呼び出し側 — 名簿を持つ
 * `runner-protocol.ts` の `RunnerRevisionStatus`）でしか判定できない。
 */
export type RunnerRevisionReport =
  | { status: 'known'; commit: string; short: string; source: RevisionSource }
  | { status: 'unknown' };

const SOURCE_LABEL: Record<RevisionSource, string> = {
  build: 'イメージに焼き込み済み',
  workspace: 'ビルド時の作業ツリーから取得',
  env: '実行時に ALTEROID_BUILD_REV で指定',
  platform: 'Railway が実行時に注入',
};

/**
 * 出所の説明（`RevisionSource` の1語を人間の言葉へ）。
 *
 * **画面が独自の短い語に置き換えたくなる場所である。** 置き換えるなら、置き換えた
 * 語もここへ足して1か所に留めること — 同じ状態が口ごとに違う言葉で出ると、読む側は
 * 「別の状態だ」と読む。
 */
export function revisionSourceLabel(source: RevisionSource): string {
  return SOURCE_LABEL[source];
}

/**
 * 版が分かっているときの言い方。**短縮とフル sha を両方出す。**
 *
 * 短縮だけだと読みやすいが `gh api .../compare` へ貼れず、フルだけだと目で
 * 突き合わせられない。**どちらか一方に絞ると、必ずもう一方が要る場面で足りない。**
 */
function describeKnownRevision(commit: string, short: string, source: RevisionSource): string {
  return `${short}（${SOURCE_LABEL[source]}、フル ${commit}）`;
}

/**
 * 人間 / クローン向けの1行。**「不明」に倒すのがここの唯一の仕事である。**
 *
 * 取れなかったときに、それらしい既定値やハイフンではなく明示的に「不明」と言う。
 */
export function describeBuildRevision(rev: BuildRevision): string {
  if (rev.commit === null || rev.short === null || rev.source === null) {
    return 'リビジョン: 不明（焼き込み・実行時の環境変数のどちらからも取れなかった）';
  }
  return `リビジョン: ${describeKnownRevision(rev.commit, rev.short, rev.source)}`;
}

/**
 * 3値（`known` / `unknown` / `unheard`）の1行。**版を出す口はすべてこれを通す。**
 *
 * **なぜ1か所に寄せるのか。** 版を読む口は4つある（クローンの `runner_list` /
 * `self_status`、Web UI の設定画面、CLI の `alteroid runners`）。それぞれが自分で
 * 文言を作ると、**同じ状態が口ごとに違う言葉で出る** — 「不明」と「未確認」の
 * 区別が片方の口でだけ消えるのが最も起こりやすい壊れ方で、そうなると人間は
 * 「runner の設定を疑う」のか「登録・ネットワークを疑う」のかを口によって
 * 取り違える。
 *
 * **引数の型を `RunnerRevisionStatus` で受けないのは import の向きのためである。**
 * `RunnerRevisionStatus` は `runner-protocol.ts` に在り、そちらは（`revision.ts`
 * 経由で）このファイルを import している。ここから逆向きに引くと循環になるので、
 * **同じ形の union をここで書いて受ける**（`RunnerRevisionStatus` はこの union と
 * 構造的に同一なので、そのまま渡せる）。
 */
export function describeRevisionStatus(
  status: RunnerRevisionReport | { status: 'unheard' },
): string {
  switch (status.status) {
    case 'known':
      return describeKnownRevision(status.commit, status.short, status.source);
    // **`unknown` と `unheard` を同じ言葉にしない**（`RunnerRevisionStatus` の doc）。
    // 前者は「訊けたが器が自分の版を知らない」＝器側の設定を疑う、後者は「名乗りを
    // まだ一度も聞けていない」＝登録とネットワークを疑う、で次の手が違う。
    case 'unknown':
      return '不明（応答は返ったが、その器が自分の版を知らない）';
    case 'unheard':
      return '未確認（名乗りをまだ一度も聞けていない）';
  }
}
