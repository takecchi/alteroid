import { describe, expect, it } from 'vitest';

import { MEMORY_TOC_LINE_LIMIT, renderMemoryDocuments } from './memory.js';
import {
  MEMORY_DESCRIPTION_CONTRACT_CORE,
  memoryDescriptionContract,
} from './memory-description-contract.js';
import { buildCloneSystemPrompt, buildDistillPrompt } from './prompt.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// 要旨に「本文を開かなくても守る約束事」と「本文を開く条件」を必ず書かせる約束が、
// 書く道具・システムプロンプト・統合の指示の3か所から落ちていないことを守る（落ちると要旨が約束事の置き場でなくなる）。
const CONTRACT = memoryDescriptionContract(MEMORY_TOC_LINE_LIMIT);

function descriptionOf(tool: string): string {
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return tools.find((entry) => entry.name === tool)?.description ?? '';
}

describe('要旨の約束（約束事と開く条件を要旨に書く）', () => {
  it('約束は2つ（約束事・開く条件）と、約束事を先頭に置くことを言い、本文を書かせない', () => {
    expect(MEMORY_DESCRIPTION_CONTRACT_CORE).toContain('本文を開かなくても守るべき約束事');
    expect(MEMORY_DESCRIPTION_CONTRACT_CORE).toContain('本文をいつ開くべきか');
    expect(MEMORY_DESCRIPTION_CONTRACT_CORE).toContain('約束事を先頭に置く');
    expect(MEMORY_DESCRIPTION_CONTRACT_CORE).toContain('本文の中身そのものは書かない');
  });

  it('fact の切り詰めの長さは、目次の行が実際に切る長さ（MEMORY_TOC_LINE_LIMIT）と同じ数字で言う', () => {
    expect(CONTRACT).toContain(`先頭 ${String(MEMORY_TOC_LINE_LIMIT)} 字`);
    expect(memoryDescriptionContract(123)).toContain('先頭 123 字');
  });

  it.each(['memory_write', 'memory_frontmatter_set'])('%s の説明が約束を載せている', (tool) => {
    expect(descriptionOf(tool)).toContain(CONTRACT);
  });

  it('システムプロンプトが、要旨の約束事は開かずに守り、開く条件なら開くと言い、書く約束も載せている', () => {
    const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });
    expect(prompt).toContain('要旨に書かれた約束事は本文を開かなくても守り');
    expect(prompt).toContain(CONTRACT);
  });

  it('統合の指示が、要旨を直すときの約束と、fact の1行は先頭が載ることを言っている', () => {
    const prompt = buildDistillPrompt('scheduled');
    expect(prompt).toContain(CONTRACT);
    expect(prompt).toContain('約束事と開く条件を先頭に置き、末尾に置かないこと');
  });
});
