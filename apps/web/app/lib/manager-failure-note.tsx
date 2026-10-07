import type { ReactNode } from 'react';

import type { ManagerStatus } from '@alteroid/logic';

// 「もう続かない」と言い切らない: send() は status を見ずに resume を試みうるため
// 「セッションは生きているので」という字面を使わない: 生きている3値の文言と紛れるため
// core の値を import しない: eslint.config.js の @alteroid/core バレル制限のため
export function terminalFailureNote(status: ManagerStatus): ReactNode | null {
  if (status === 'failed' || status === 'lost') {
    return (
      <>
        <strong className="font-medium">この仕事はもう終わっている</strong>
        。セッションそのものが、
        <strong className="font-medium">依頼者が望まない終わり方で既に終端している</strong>
        。続けたいなら話しかけて resume を試みるしかなく、届く保証は無い。
      </>
    );
  }
  if (status === 'stopped') {
    return (
      <>
        <strong className="font-medium">この仕事はもう終わっている</strong>
        。このセッションは、その後
        <strong className="font-medium">
          人間・クローンが明示的に停止させ、確かめたうえで既に終端している
        </strong>
        。続けたいなら話しかけて resume を試みるしかなく、届く保証は無い。
      </>
    );
  }
  return null;
}
