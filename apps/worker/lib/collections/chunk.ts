const DEFAULT_CHUNK_SIZE = 1000;

export function chunkItems<T>(items: T[], size = DEFAULT_CHUNK_SIZE): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}
