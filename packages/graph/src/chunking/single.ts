import type { GraphChunker } from "..";

export class SingleChunker implements GraphChunker {
    async getChunks(input: string): Promise<string[]> {
        return [input];
    }
}
