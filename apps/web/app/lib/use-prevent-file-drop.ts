import { useEffect } from 'react';

/** ドラッグ中の中身にファイルを含むか。文字・リンクのドラッグは含まない。 */
function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes('Files');
}

function preventFileDefault(event: DragEvent) {
  if (carriesFiles(event)) event.preventDefault();
}

/**
 * ウィンドウのどこに落としても、ファイルのドロップでブラウザの標準の動作（そのタブでファイルを
 * 開くか、ダウンロードする）を走らせない。アプリを離れて会話の表示や書きかけが失われるのを防ぐ（#3780）。
 *
 * - `Files` を含むドラッグだけを止める。文字のドラッグや入力欄の中のドロップは今のまま動く。
 * - bubble 段階の window で受ける。React のイベントは root 要素で処理されるので、入力欄
 *   （`ChatComposer`）の `onDrop` が先に添付として処理し、ここは取りこぼした場所だけを止める。
 * - 全画面で効くよう `root.tsx` の `App` から呼ぶ（チャット以外の画面でも同じ事故が起きる）。
 */
export function usePreventWindowFileDrop() {
  useEffect(() => {
    window.addEventListener('dragover', preventFileDefault);
    window.addEventListener('drop', preventFileDefault);
    return () => {
      window.removeEventListener('dragover', preventFileDefault);
      window.removeEventListener('drop', preventFileDefault);
    };
  }, []);
}
