import type { KeyboardEvent } from 'react';

/**
 * その Enter が **IME の変換を確定するための Enter** か。真なら送ってはいけない。
 *
 * 変換中でも `input` は飛ぶ（Chrome）ので、下書きには確定前の途中の文字列が
 * 入っている。確定の Enter で送ると、それがそのまま投函される。
 *
 * - `event.isComposing` ではなく `event.nativeEvent.isComposing` を見る。React の
 *   合成イベントの型は `isComposing` を持たない（DOM の `KeyboardEvent` の側にしか無い）
 * - `keyCode === 229` も併せて見る。`isComposing` を立てずに変換確定の Enter を配る
 *   実装が在る（Android の IME や古い WebKit。229 は「IME が処理中」を表す慣用の値）。
 *   ⚠️ 実機での確認はしていない
 *
 * 判断の出どころは会話の入力欄（かつて `apps/web/app/routes/chat.tsx` に在り、いまは
 * `ChatComposer`。`chat.ime-enter.test.tsx` が守っている）。ここはその判断を部品の
 * 側からも使えるように置いたもので、判断そのものは変えていない。
 */
export function isImeConfirmEnter(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
  );
}

/** ⌘ / Ctrl + Enter（送る・確定する）。IME の確定の Enter は含まない。 */
export function isSubmitShortcut(event: KeyboardEvent): boolean {
  if (isImeConfirmEnter(event)) return false;
  return (event.metaKey || event.ctrlKey) && event.key === 'Enter';
}
