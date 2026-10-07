import { useEffect } from 'react';

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes('Files');
}

function preventFileDefault(event: DragEvent) {
  if (carriesFiles(event)) event.preventDefault();
}

// bubble 段階の window で受ける: 入力欄（ChatComposer）の onDrop が先に添付として処理し、ここは取りこぼした場所だけを止めるため
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
