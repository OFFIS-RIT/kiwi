import { readFile } from "node:fs/promises";
import type { GraphLoader } from "..";

export class IOLoader implements GraphLoader {
    constructor(private file: string) {}

    async getText(): Promise<string> {
        const content = await readFile(this.file);
        return content.toString();
    }

    async getBinary(): Promise<ArrayBuffer> {
        const content = await readFile(this.file);
        return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    }
}
