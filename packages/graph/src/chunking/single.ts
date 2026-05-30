import type { GraphChunker, GraphTextChunk } from "..";

export class SingleChunker implements GraphChunker {
    async getChunks(input: string): Promise<string[]> {
        return [input];
    }

    async getChunkSpans(input: string): Promise<GraphTextChunk[]> {
        return [
            {
                content: input,
                startOffset: 0,
                endOffset: input.length,
            },
        ];
    }
}
