/**
 * 文脈量の測り（`context-size-measure.ts`）が、本番の組み立て関数の出力を控える置き場。
 * 何も import しない: `vi.mock` の factory がここを読み込むとき、`clone.ts` を引く別の module を経由すると、モックの factory 同士が互いを待って止まるため。
 */

/** `composeTurnInputText` の欄（`TurnInputText`）と同じ名前。包みが記録する。 */
export interface ComposedRecord {
  parts: Record<string, string>;
  composed: string;
  /** 記録した時点までに `buildActivityDigest` が呼ばれた本数。ターンへの割り当てに使う。 */
  digestsBefore: number;
}

export interface DigestRecord {
  shape: string;
  text: string;
}

export const contextSizeRecorder: {
  composed: ComposedRecord[];
  digests: DigestRecord[];
  reset(): void;
} = {
  composed: [],
  digests: [],
  reset() {
    this.composed = [];
    this.digests = [];
  },
};
