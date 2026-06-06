import type { GraphBinaryLoader, GraphLoader } from "..";

export class CSVLoader implements GraphLoader {
    readonly filetype = "csv";

    constructor(private options: { loader: GraphBinaryLoader }) {}

    async getText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        return new TextDecoder().decode(content);
    }
}
