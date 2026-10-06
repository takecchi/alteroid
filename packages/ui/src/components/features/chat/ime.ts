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
  return event.key === 'Enter' && isImeComposing(event);
}

/**
 * そのキー操作が **IME の変換の最中に配られたもの** か（Enter に限らない）。真のとき、画面の
 * 側のキー（Escape で閉じる・Enter で送る）として読んではいけない。Escape は IME が変換の
 * 取り消しに使うので、読むと変換を取り消すつもりで押したキーが編集欄ごと閉じる（#3394）。
 * 見方は `isImeConfirmEnter` と同じ（`isComposing` と `keyCode === 229`）。
 */
export function isImeComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

/** ⌘ / Ctrl + Enter（送る・確定する。どちらの修飾キーでも）。IME の確定の Enter は含まない。 */
export function isSubmitShortcut(event: KeyboardEvent): boolean {
  if (isImeConfirmEnter(event)) return false;
  return (event.metaKey || event.ctrlKey) && event.key === 'Enter';
}

/**
 * 入力欄（`ChatComposer`）の送信のショートカットか。**macOS では ⌘ + Enter だけ、それ以外では
 * Ctrl + Enter だけ**（Enter 単体・Shift + Enter は送らない。textarea の既定の改行のまま）。
 * IME の確定の Enter は含まない。
 */
export function isPlatformSubmitShortcut(event: KeyboardEvent, mac: boolean): boolean {
  if (!isSubmitShortcut(event)) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
