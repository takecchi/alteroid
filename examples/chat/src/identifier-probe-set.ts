import type { ProbeUtterance } from "./probe-set.js";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "./probe-set.js";

/**
 * 識別子・固有名詞を含む probe set（Issue #109、#106 が名指しした用途）。
 *
 * **背景**: `retrieval` ベンチの probe 7件（`./probe-set.js`）は**すべて日本語の query**
 * で、ASCII の識別子・固有名詞を含む query が0件である。Issue #106 の報告者の用途は
 * 「固有名詞と識別子が多い」（人名・チャンネル名・社内システム名・案件コード・チケット番号。
 * 例: `PROJ-1234` と `PROJ-5678` の取り違え）——⟹ 報告者が困っている領域を、既存ベンチは
 * 1件も測っていなかった。
 *
 * 既存の `retrieval` はカセット（`examples/chat/cassettes/retrieval.json`）の鍵が
 * **入力文字列の SHA-256** であり、記録に無い入力は `RecordedEmbeddingProvider`/
 * `RecordedLLMProvider` が例外にする。⟹ probe を1件足すたびに録り直しが要る。
 * `@mnemora/local-embedding`（鍵もカセットも要らない、ADR 0085）を使うことで、
 * この制約なしに probe を足せる——それがこの第2の probe set をここに置く理由である。
 *
 * ⛔ **`./probe-set.js` は1文字も変更していない**（haystack 生成関数・topic keyword
 * 検査関数だけを import して再利用する）。
 *
 * ⚠ **この probe set は `./probe-set.js` と狙いが「逆」である。**
 *
 * - 既存（`./probe-set.js`）: gold の質問は gold の事実と**内容語を共有しない**。
 *   擬似 embedding が持つのは文字コードに由来する語彙的な重なりだけなので、内容語を
 *   共有しない質問は擬似物では引けず、**本物の埋め込みでしか引けない**ことを確かめる。
 * - こちら（識別子 probe）: **query に識別子そのものを含める**——「その文字列を含むか」
 *   で引きたいのが Issue #106 の報告者の要求そのものだからである。
 *
 * distractor は**「同じ書式・違う識別子」**にする（例: `PROJ-1234` に対する
 * `PROJ-5678`）。これが gold より上に来たら「書式は合っているが対象が違う」ものを
 * 返しているということであり、まさに #106 が報告した失敗そのものである。
 *
 * **何件で覆うか**: Issue #106 が名指しした5領域（人名・チャンネル名・社内システム名・
 * 案件コード・チケット番号）を、まず12件（領域あたり2〜3件）で覆う。
 * ⚠ **ADR 0033 §3 は「標本7件からは失敗率も成功率も主張しない」と書いている**——
 * 12件という標本数についても同じ規律を適用する。ここから言えるのは
 * 「12件のうちこの arm が何件引けたか」までであり、「識別子一般でどの程度の成功率が
 * 出るか」を統計的に主張できる件数ではない（測定結果の報告に明記する）。
 */
export interface IdentifierProbe {
  id: string;
  /** Issue #106 が名指しした5領域のどれを代表するか。 */
  category: "person" | "channel" | "system" | "project-code" | "ticket";
  /** 会話の冒頭付近で1度だけ表明される、識別子を含む事実。これが gold。 */
  fact: string;
  /** 終盤に投げる質問。**識別子そのものを含む**（既存 probe-set.ts とは逆）。 */
  query: string;
  /** 同じ書式・違う識別子の記憶。gold より上に来たら「書式は合うが対象が違う」。 */
  distractor: string;
}

export const IDENTIFIER_PROBES: IdentifierProbe[] = [
  // --- 案件コード（project code） ---
  {
    id: "project-code-a",
    category: "project-code",
    fact: "PROJ-1234 の要件定義は来週までに終わらせる予定です。",
    query: "PROJ-1234 の要件定義はいつ終わりますか?",
    distractor: "PROJ-5678 の要件定義はまだ着手していません。",
  },
  {
    id: "project-code-b",
    category: "project-code",
    fact: "PROJ-9021 の予算は300万円で承認されました。",
    query: "PROJ-9021 の予算はいくらで承認されましたか?",
    distractor: "PROJ-9042 の予算は500万円で承認されました。",
  },
  // --- チケット番号（ticket number） ---
  {
    id: "ticket-a",
    category: "ticket",
    fact: "TICKET-48213 はログイン画面が表示されない不具合の報告です。",
    query: "TICKET-48213 はどんな不具合の報告でしたか?",
    distractor: "TICKET-48214 はログアウトができない不具合の報告です。",
  },
  {
    id: "ticket-b",
    category: "ticket",
    fact: "INC-77021 は本番環境の障害チケットで、対応者は山田さんです。",
    query: "INC-77021 の対応者は誰ですか?",
    distractor: "INC-77022 はステージング環境の障害チケットで、対応者は伊藤さんです。",
  },
  // --- 社内システム名（internal system name） ---
  {
    id: "system-a",
    category: "system",
    fact: "社内システム SYS-AT01(勤怠管理)の管理者は佐藤さんです。",
    query: "SYS-AT01 の管理者は誰ですか?",
    distractor: "社内システム SYS-EX02(経費精算)の管理者は鈴木さんです。",
  },
  {
    id: "system-b",
    category: "system",
    fact: "社内システム SYS-HR07(人事評価)は今月末にメンテナンス予定です。",
    query: "SYS-HR07 はいつメンテナンス予定ですか?",
    distractor: "社内システム SYS-CR09(顧客管理)は来月末にメンテナンス予定です。",
  },
  // --- チャンネル名（channel name） ---
  {
    id: "channel-a",
    category: "channel",
    fact: "#proj-alpha チャンネルは新商品開発チームの連絡用です。",
    query: "#proj-alpha チャンネルは何のためのものですか?",
    distractor: "#proj-beta チャンネルは旧商品保守チームの連絡用です。",
  },
  {
    id: "channel-b",
    category: "channel",
    fact: "#team-fizz は東京オフィスの雑談チャンネルです。",
    query: "#team-fizz はどこのオフィスの雑談チャンネルですか?",
    distractor: "#team-buzz は大阪オフィスの雑談チャンネルです。",
  },
  {
    id: "channel-c",
    category: "channel",
    fact: "#incident-2024-08 は8月に起きた障害の振り返り専用チャンネルです。",
    query: "#incident-2024-08 は何のための専用チャンネルですか?",
    distractor: "#incident-2024-09 は9月に起きた障害の振り返り専用チャンネルです。",
  },
  // --- 人名（person / employee identifier） ---
  {
    id: "person-a",
    category: "person",
    fact: "従業員番号 EMP-1042 の担当者は経理部の高橋さんです。",
    query: "従業員番号 EMP-1042 の担当者は誰ですか?",
    distractor: "従業員番号 EMP-1043 の担当者は総務部の渡辺さんです。",
  },
  {
    id: "person-b",
    category: "person",
    fact: "従業員番号 EMP-2088 の担当者は開発部の中村さんです。",
    query: "従業員番号 EMP-2088 の担当者は誰ですか?",
    distractor: "従業員番号 EMP-2089 の担当者は営業部の小林さんです。",
  },
  {
    id: "person-c",
    category: "person",
    fact: "Slack ハンドル @yamada.taro は経理部の山田太郎さんのアカウントです。",
    query: "Slack ハンドル @yamada.taro は誰のアカウントですか?",
    distractor: "Slack ハンドル @yamada.jiro は総務部の山田次郎さんのアカウントです。",
  },
];

// ---------------------------------------------------------------------------
// 識別子の重なり検査(機械的) — `./probe-set.js` の `PROBE_TOPIC_KEYWORDS` /
// `findTopicKeywordViolations` と同じ形の検査を、識別子側にも用意する。
// ---------------------------------------------------------------------------

/**
 * probe ごとの識別子(fact/query/distractor に登場する識別子そのもの)。
 * `./probe-set.js` の `PROBE_TOPIC_KEYWORDS` と同じ理由で、`IDENTIFIER_PROBES` から
 * 自動導出せず人手で書き出す。`IDENTIFIER_PROBES` に probe を足したら、ここにも
 * 対応する識別子を足すこと。
 */
export const IDENTIFIER_TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "project-code-a": ["PROJ-1234", "PROJ-5678"],
  "project-code-b": ["PROJ-9021", "PROJ-9042"],
  "ticket-a": ["TICKET-48213", "TICKET-48214"],
  "ticket-b": ["INC-77021", "INC-77022"],
  "system-a": ["SYS-AT01", "SYS-EX02"],
  "system-b": ["SYS-HR07", "SYS-CR09"],
  "channel-a": ["#proj-alpha", "#proj-beta"],
  "channel-b": ["#team-fizz", "#team-buzz"],
  "channel-c": ["#incident-2024-08", "#incident-2024-09"],
  "person-a": ["EMP-1042", "EMP-1043"],
  "person-b": ["EMP-2088", "EMP-2089"],
  "person-c": ["@yamada.taro", "@yamada.jiro"],
};

const ALL_IDENTIFIER_KEYWORDS: string[] = Object.values(IDENTIFIER_TOPIC_KEYWORDS).flat();

export interface IdentifierKeywordViolation {
  index: number;
  text: string;
  keyword: string;
}

/**
 * `./probe-set.js` の `findTopicKeywordViolations` と同じ形の検査を、識別子の集合に対して
 * 行う。haystack の各文が `IDENTIFIER_PROBES` の識別子を(偶然にも)含んでいないかを
 * 機械的に見る。空配列を返せば「重なり無し」。
 *
 * `./probe-set.js` の `findTopicKeywordViolations` はキーワード集合を内部に固定している
 * ため(`ALL_TOPIC_KEYWORDS`)そのままでは呼べない——ロジックは同じだが、対象の
 * キーワード集合(`ALL_IDENTIFIER_KEYWORDS`)が違うので、ここで独立に実装する。
 */
export function findIdentifierTopicKeywordViolations(
  utterances: readonly string[],
): IdentifierKeywordViolation[] {
  const violations: IdentifierKeywordViolation[] = [];
  utterances.forEach((text, index) => {
    for (const keyword of ALL_IDENTIFIER_KEYWORDS) {
      if (text.includes(keyword)) {
        violations.push({ index, text, keyword });
      }
    }
  });
  return violations;
}

// ---------------------------------------------------------------------------
// 密な haystack(識別子が密な干し草) — マネージャー指示(#106 の再点検)
//
// **背景**: 上の12 probe を `sparse`(= `./probe-set.js` の既定 haystack、話題語ベースで
// 識別子を1件も含まない)で走らせたところ、全12 probe が hit@1 だった(2026-09-10 実測、
// `identifier-probe-baseline.json` の `identifiers` 群)。
//
// ⚠ **これを「probe が易しすぎた」と即断しない。**`TICKET-48213`/`TICKET-48214` は
// 1文字違いで、query は両者と「不具合の報告」という語彙を共有しており、識別子だけが
// 弁別子である——それを正しく1位にできたのは実際の発見である。
//
// 🔑 **ただし #106 の逐語(Issue #106)はこう書いている**:
// 「ベクタ検索だと、同じ形式の別の識別子(`PROJ-5678`)が近傍に来て、欲しいものが
// 埋もれます」。**「近傍に来て埋もれる」は、同じ書式の識別子が"多数"居る状況を指す**
// ——`sparse` 条件は probe ごとに distractor 1件しか同じ書式の競合を置いておらず、
// この状況を表していない。
//
// ⟹ **`dense` 条件を第2の haystack として足す**——`IDENTIFIER_PROBES` が使う9つの
// 書式ファミリー(`PROJ-`/`TICKET-`/`INC-`/`SYS-`/`EMP-`/`#proj-`/`#team-`/
// `#incident-2024-`/`@<surname>.<given>`)それぞれについて、**probe の識別子とは別の
// 値**を持つ干し草を計60件、決定的に(乱数無しで)生成する。`./probe-set.js` の
// `buildHaystackUtterance` と同じ「直積で一意性を作る」考え方を踏襲するが、ここでは
// 「書式ファミリー × ファミリー内の連番/語」の2軸で一意にする(意味的な話題は
// ファミリーごとに固定の文で足りる——変える軸は識別子そのものであり、`buildHaystackUtterance`
// のように3軸を混ぜる必要が無い)。
//
// 🔴 **この段では、まだ結果を見ていない。**設計はここで確定し、下の
// `DENSE_IDENTIFIER_FAMILIES`/件数/識別子の値を**測定前に固定する**——
// 「まだ1.0だからもっと難しくしよう」を避けるため、値を見てからここを書き直さない。
// ---------------------------------------------------------------------------

export type IdentifierHaystackKind = "sparse" | "dense";

interface DenseIdentifierFamily {
  /** probe の `category` と対応させるための識別名(表示・集計には使わない、設計メモ)。 */
  id: string;
  /** このファミリーが提供する干し草の件数。 */
  count: number;
  /** ファミリー内の連番(0始まり)から、`IDENTIFIER_PROBES` に無い新しい識別子を作る。 */
  identifierAt: (n: number) => string;
  /** 識別子を埋め込んだ、ありふれた事務連絡文(意味は無害・probe の話題とは無関係)。 */
  sentenceFor: (identifier: string) => string;
}

/**
 * `IDENTIFIER_PROBES`(12件)が使う書式ファミリーごとに、**probe が使っていない値**で
 * 干し草を作る。件数の合計が `DEFAULT_DENSE_HAYSTACK_SIZE`(60)になるよう固定した
 * (`sparse` 条件の既定 haystack 件数 `DEFAULT_HAYSTACK_SIZE` と同程度)。
 *
 * ⚠ **`IDENTIFIER_TOPIC_KEYWORDS` に登場する既存24件の識別子とは重ならない値域を
 * 選んである**(番号は既存より大きい/一致しない範囲、語は既存に無い単語)。
 * その保証は「番号を選んだ」だけでは終わらない——`buildIdentifierProbeSetConversation`
 * が `findIdentifierTopicKeywordViolations` で機械的に再検査し、万一重なっていれば
 * 構築時に例外にする(このコメントの主張を実行時にも裏付ける)。
 */
const DENSE_IDENTIFIER_FAMILIES: readonly DenseIdentifierFamily[] = [
  {
    id: "project-code",
    count: 8,
    identifierAt: (n) => `PROJ-${2001 + n}`,
    sentenceFor: (id) => `${id} の進捗確認ミーティングは来週に設定されました。`,
  },
  {
    id: "ticket",
    count: 8,
    identifierAt: (n) => `TICKET-${60001 + n}`,
    sentenceFor: (id) => `${id} は担当者未定のまま一次受付だけ済んでいます。`,
  },
  {
    id: "incident",
    count: 8,
    identifierAt: (n) => `INC-${90001 + n}`,
    sentenceFor: (id) => `${id} は影響範囲の調査が完了し、復旧対応に移りました。`,
  },
  {
    id: "system",
    count: 6,
    identifierAt: (n) => `SYS-QA${String(n + 1).padStart(2, "0")}`,
    sentenceFor: (id) => `社内システム ${id} は来期にバージョンアップが予定されています。`,
  },
  {
    id: "employee",
    count: 6,
    identifierAt: (n) => `EMP-${5001 + n}`,
    sentenceFor: (id) => `従業員番号 ${id} は先月付けで部署異動になりました。`,
  },
  {
    id: "proj-channel",
    count: 6,
    identifierAt: (n) => `#proj-${["gamma", "delta", "epsilon", "zeta", "eta", "theta"][n % 6]}`,
    sentenceFor: (id) => `${id} チャンネルには週次の定例議事録が投稿されています。`,
  },
  {
    id: "team-channel",
    count: 6,
    identifierAt: (n) => `#team-${["quux", "corge", "grault", "garply", "waldo", "fred"][n % 6]}`,
    sentenceFor: (id) => `${id} チャンネルは他部署合同の情報共有に使われています。`,
  },
  {
    id: "incident-channel",
    count: 6,
    identifierAt: (n) => `#incident-2024-${String(n + 1).padStart(2, "0")}`,
    sentenceFor: (id) => `${id} は該当月に発生した軽微な障害の記録用チャンネルです。`,
  },
  {
    id: "handle",
    count: 6,
    identifierAt: (n) =>
      `@${
        [
          "suzuki.saburo",
          "tanaka.shiro",
          "sato.goro",
          "ito.rokuro",
          "watanabe.shichiro",
          "nakamura.hachiro",
        ][n % 6]
      }`,
    sentenceFor: (id) => `Slack ハンドル ${id} は最近入社したメンバーのアカウントです。`,
  },
];

/** `DENSE_IDENTIFIER_FAMILIES` の件数の合計から導く——ここにも 60 を書き写さない。 */
export const DEFAULT_DENSE_HAYSTACK_SIZE: number = DENSE_IDENTIFIER_FAMILIES.reduce(
  (sum, f) => sum + f.count,
  0,
);

/**
 * `index`(0始まり)に対応する、識別子が密な haystack 文を1件返す。
 * ファミリーを跨ぐ累積オフセットで、どのファミリーの何番目かを決める(決定的、乱数無し)。
 */
export function buildDenseIdentifierHaystackUtterance(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `buildDenseIdentifierHaystackUtterance: index は0以上の整数である必要がある(実際: ${index})`,
    );
  }
  let remaining = index;
  for (const family of DENSE_IDENTIFIER_FAMILIES) {
    if (remaining < family.count) {
      const identifier = family.identifierAt(remaining);
      return family.sentenceFor(identifier);
    }
    remaining -= family.count;
  }
  throw new Error(
    `buildDenseIdentifierHaystackUtterance: index ${index} が総件数 ` +
      `${DEFAULT_DENSE_HAYSTACK_SIZE} を超えている`,
  );
}

// ---------------------------------------------------------------------------
// 会話の組み立て
// ---------------------------------------------------------------------------

/** `identifier-gold-<id>` の externalId 規約。`./probe-set.js` の `gold-<id>` と衝突しない
 *  よう別の prefix を使う——同じ会話に両 probe set を混在させることは無いが、テナントを
 *  跨いだ誤集計を防ぐため、名前空間を最初から分けておく。 */
export function identifierGoldExternalId(probeId: string): string {
  return `identifier-gold-${probeId}`;
}

/** `identifier-distractor-<id>` の externalId 規約。 */
export function identifierDistractorExternalId(probeId: string): string {
  return `identifier-distractor-${probeId}`;
}

/** `identifier-filler-NNNN`(4桁ゼロ埋め)の externalId 規約。 */
export function identifierHaystackExternalId(index: number): string {
  return `identifier-filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 identifier probe の gold/distractor + 共有の haystack を1本の会話に組む。
 *
 * `haystackKind`(既定 `"sparse"`)で haystack の生成器を切り替える:
 * - `"sparse"`: `./probe-set.js` の `buildHaystackUtterance` を再利用する(識別子を
 *   1件も含まない、話題語ベースの既定 haystack)。**既定値なので、この引数を渡さない
 *   既存の呼び出し(歯を含む)は1ミリも挙動が変わらない。**
 * - `"dense"`: 上の `buildDenseIdentifierHaystackUtterance`(同じ書式ファミリーの
 *   識別子が密な haystack)。
 *
 * どちらの kind でも、識別子の重なり検査(`findIdentifierTopicKeywordViolations`)は
 * 必ず通す——`dense` は probe の識別子と衝突しない値を選んで設計してあるが、
 * 「選んだつもり」で終わらせず実行時にも再検査する。
 */
export function buildIdentifierProbeSetConversation(
  haystackSize?: number,
  haystackKind: IdentifierHaystackKind = "sparse",
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of IDENTIFIER_PROBES) {
    utterances.push({
      externalId: identifierGoldExternalId(probe.id),
      text: probe.fact,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: identifierDistractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const resolvedSize =
    haystackSize ??
    (haystackKind === "dense" ? DEFAULT_DENSE_HAYSTACK_SIZE : DEFAULT_HAYSTACK_SIZE);
  const buildUtterance =
    haystackKind === "dense" ? buildDenseIdentifierHaystackUtterance : buildHaystackUtterance;

  const haystackTexts: string[] = [];
  for (let i = 0; i < resolvedSize; i += 1) {
    haystackTexts.push(buildUtterance(i));
  }
  const violations = findIdentifierTopicKeywordViolations(haystackTexts);
  if (violations.length > 0) {
    throw new Error(
      `buildIdentifierProbeSetConversation: haystack(${haystackKind}) が識別子 probe の` +
        `識別子と重なっている(${violations.length}件): ${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
  haystackTexts.forEach((text, i) => {
    utterances.push({ externalId: identifierHaystackExternalId(i), text, kind: "haystack" });
  });

  return utterances;
}
