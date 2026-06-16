import type { GraphBinaryLoader, GraphLoader } from "../types";

export class CSVLoader implements GraphLoader {
    readonly filetype = "csv";

    constructor(private readonly options: { loader: GraphBinaryLoader }) {}

    async getText(): Promise<string> {
        return new TextDecoder().decode(await this.options.loader.getBinary());
    }
}
