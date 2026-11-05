// 畳みの控え（`fold-state.ts`）が写す digest 側の状態の入れ物。固定の文言・段落・節・依頼の控えを同じ会話の2回目以降に畳む仕組み（#4937）は外してあり、控えは常に空である。
// 残してあるのは、預けた控えの字面（`DigestDeltaState`）と、全文へ戻す経路（`reset` / `forgetFixed`）・預けた控えの書き出しと読み戻し（`exportState` / `importState`）の口だけ:
// 預け先（`SessionsStore` の控え）の保存の中身と書き込みの回数を変えないため。控えの保存を外す PR で、この入れ物ごと消える。

/** `DigestSessionDelta` の控えを JSON にできる形にしたもの（`exportState` / `importState`）。 */
export interface DigestDeltaState {
  sections: { at: string; sections: [string, string][] } | null;
  fixed: string[];
  requests: [string, { text: string; at: string }][];
  paragraphs: string[];
  reports: [string, { key: string; chars: number; at: string }][];
}

export class DigestSessionDelta {
  /**
   * 戻り値は「畳んだ記録が実際に残っていて捨てたか」。控えを持たないので常に偽。
   * 呼び手（`#resetDigestDelta`）の、預けた控えの消し込みは戻り値に依らず先に走る。
   */
  reset(): boolean {
    return false;
  }

  /** 預けた控えの書き出し。控えは常に空なので、空の写しを返す（預け先に書かれる字面は変わらない）。 */
  exportState(): DigestDeltaState {
    return { sections: null, fixed: [], requests: [], paragraphs: [], reports: [] };
  }

  /** 預けた控えの読み戻し。有効だった頃の控えを読み戻すと畳みが復活するので、何も取り込まない。 */
  importState(state: DigestDeltaState): void {
    void state;
  }

  /** 固定の文言の控えだけを捨てる（周期の全文戻し）。控えが無いので何も起きない。 */
  forgetFixed(): void {}
}
