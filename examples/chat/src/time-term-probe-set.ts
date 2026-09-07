/**
 * 「内容は同一・`occurredAt` だけ違う」ペアの probe set。
 *
 * 狙い: 時間項2つ(`freshness`・`decay`)を意味的類似度(`similarity`)から分離して測る。
 * `docs/decisions/` の ADR 0033 が測った `retrieval-quality`(既存 `probe-set.ts`)は、
 * gold/distractor が**別内容**であり、「なぜその順位になったか」に `similarity` と
 * `freshness` の両方が絡みうる。この arm はペアの2件の本文を厳密に同一にすることで、
 * `DeterministicEmbeddingProvider`(同じテキストに常に同じベクトルを返す、
 * `packages/testkit/src/__fixtures__/deterministic-embedding-provider.ts`)の性質上
 * `similarity` を構成上ぴったり同じにし、順位差が出るなら **それは `freshness` 由来である
 * としか説明できない**状況を作る。
 *
 * ⚠ **既存 `probe-set.ts` とは狙いが逆**である。既存ベンチは「gold は fact/query が
 * 内容語を共有せず、擬似 embedding では引けない」ことを軸に置く(本物の埋め込みでしか
 * 引けないことを確かめるため)。この arm では **`fact` と `query` の語彙をわざと重ねる**
 * ——ペアの2件が確実に候補として recall に返ってくることこそが要であり、
 * 「どうやって引けたか(語彙が重なっているから引けた、で構わない)」はこの arm が
 * 測る対象ではない。測る対象は「返ってきた2件のうちどちらが上に来るか」だけである。
 */
export interface TimeProbe {
  id: string;
  /** 2回 observe する、まったく同一の本文。ペア内で内容を同一にすることが、この arm の要。 */
  fact: string;
  query: string;
  /** newer 側の occurredAt を「今から何日前」にするか。null なら occurredAt を渡さない。 */
  newerDaysAgo: number | null;
  /** older 側。null なら occurredAt を渡さない。 */
  olderDaysAgo: number | null;
  /**
   * `decay` を `freshness` から分離して測る probe だけが持つ(省略可能——既存5 probe は
   * `undefined` のままで、いままでと同じ挙動になる)。newer 側を observe するときに
   * `Clock`(`mutable-clock.ts` の `MutableClock`)を「今から何日前」に置くか。
   * `runTimeTermArm` に `clock` を渡さなければこの欄は無視される。
   */
  newerRecordedDaysAgo?: number;
  /** older 側の recordedDaysAgo。同上。 */
  olderRecordedDaysAgo?: number;
}

/**
 * 8件の probe。前半5件が `freshness` を振り、後半3件(`decay-*`)が `decay` を振る。
 *
 * `fact` は probe ごとに十分違う内容にしてある——`DeterministicLLMProvider`
 * (`packages/testkit/src/__fixtures__/deterministic-llm-provider.ts`)は
 * `completeStructured` が返す `digest` を `userText`(= observe した発話本文そのもの、
 * `extraction.ts` の `buildExtractionPrompt` はラップ文字列を足さずそのまま user
 * メッセージにする)の先頭40字で切るため、**先頭40字が probe 間で衝突すると
 * digest だけでは probe を見分けられなくなる**(この arm 自体は externalId の系譜
 * (`resolveExternalId`)で見分けるため実害は無いが、`TIME_PROBES` 単体の検査
 * (`__tests__/time-term-arm.test.ts`)で機械的に確かめる)。
 */
export const TIME_PROBES: TimeProbe[] = [
  {
    id: "half-life",
    fact: "毎週日曜の朝、ベランダの多肉植物に水をやることにしています。",
    query: "ベランダの多肉植物への水やりはどれくらいの頻度でしていますか?",
    newerDaysAgo: 0,
    olderDaysAgo: 30,
  },
  {
    id: "realistic",
    fact: "通勤電車の中で英単語アプリを開いて毎日十個ずつ覚えています。",
    query: "通勤電車での英単語アプリの勉強はどんな感じですか?",
    newerDaysAgo: 1,
    olderDaysAgo: 4,
  },
  {
    id: "same-occurred-at",
    fact: "週末は近所のジムでキックボクシングのクラスに参加しています。",
    query: "近所のジムのキックボクシングのクラスにはどれくらい通っていますか?",
    newerDaysAgo: 7,
    olderDaysAgo: 7,
  },
  {
    id: "absent",
    fact: "自宅の本棚を整理してミステリー小説だけを一段にまとめました。",
    query: "自宅の本棚のミステリー小説はどんな風に並べていますか?",
    newerDaysAgo: null,
    olderDaysAgo: null,
  },
  {
    id: "far-past",
    fact: "毎朝出勤前にベランダで育てているハーブの葉を摘んでいます。",
    query: "ベランダで育てているハーブについて教えてください。",
    newerDaysAgo: 1,
    olderDaysAgo: 365,
  },
  // -------------------------------------------------------------------------
  // `decay` を `freshness` から分離して測る3件。
  //
  // `occurredAt` は newer/older で**同じ**(7日前)にする——`decay` の起点は
  // `lastReinforcedAt ?? recordedAt` であり `occurredAt` を読まない
  // (`packages/core/src/strategies/scoring.ts`)ため、`occurredAt` を揃えれば
  // `freshness` はペア内で厳密に同じになり、`recordedAt`(= `newerRecordedDaysAgo`/
  // `olderRecordedDaysAgo` 経由で `MutableClock` が振る)だけが違う形になる。
  // -------------------------------------------------------------------------
  {
    id: "decay-half-life",
    fact: "週に一度、水槽の熱帯魚に専用のエサを多めにあげています。",
    query: "水槽の熱帯魚へのエサやりの頻度を教えてください。",
    newerDaysAgo: 7,
    olderDaysAgo: 7,
    newerRecordedDaysAgo: 0,
    olderRecordedDaysAgo: 30,
  },
  {
    id: "decay-realistic",
    fact: "毎晩お風呂上がりに白い毛糸でマフラーを編んでいます。",
    query: "白い毛糸で編んでいるマフラーの進み具合はどうですか?",
    newerDaysAgo: 7,
    olderDaysAgo: 7,
    newerRecordedDaysAgo: 1,
    olderRecordedDaysAgo: 4,
  },
  {
    id: "decay-same-recorded-at",
    fact: "週末の午後に習字教室で楷書の練習をしています。",
    query: "習字教室での楷書の練習はどれくらい続けていますか?",
    newerDaysAgo: 7,
    olderDaysAgo: 7,
    newerRecordedDaysAgo: 1,
    olderRecordedDaysAgo: 1,
  },
];

/** `newer-<id>` の externalId 規約。 */
export function newerExternalId(probeId: string): string {
  return `newer-${probeId}`;
}

/** `older-<id>` の externalId 規約。 */
export function olderExternalId(probeId: string): string {
  return `older-${probeId}`;
}

export interface TimeProbeUtterance {
  externalId: string;
  text: string;
  probeId: string;
  member: "newer" | "older";
  occurredAt: Date | null;
  /**
   * `Clock`(`MutableClock`)をこの時刻に置いてから observe するべきか。`undefined` なら
   * 実時刻のまま(`newerRecordedDaysAgo`/`olderRecordedDaysAgo` を持たない既存5 probe は
   * 常に `undefined`)。
   */
  recordedAt: Date | null;
}

const MS_PER_DAY = 86_400_000;

function daysAgoToDate(now: Date, daysAgo: number | null | undefined): Date | null {
  if (daysAgo === null || daysAgo === undefined) {
    return null;
  }
  return new Date(now.getTime() - daysAgo * MS_PER_DAY);
}

/**
 * probe の newer/older 2件を組み立てる。**本文(`text`)は厳密に同一。**
 * `occurredAt`(と、`decay` 分離 probe だけが持つ `recordedAt`)だけが(在れば)異なる。
 */
export function buildTimeTermConversation(probe: TimeProbe, now: Date): TimeProbeUtterance[] {
  return [
    {
      externalId: newerExternalId(probe.id),
      text: probe.fact,
      probeId: probe.id,
      member: "newer",
      occurredAt: daysAgoToDate(now, probe.newerDaysAgo),
      recordedAt: daysAgoToDate(now, probe.newerRecordedDaysAgo),
    },
    {
      externalId: olderExternalId(probe.id),
      text: probe.fact,
      probeId: probe.id,
      member: "older",
      occurredAt: daysAgoToDate(now, probe.olderDaysAgo),
      recordedAt: daysAgoToDate(now, probe.olderRecordedDaysAgo),
    },
  ];
}
