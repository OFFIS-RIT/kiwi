import type { GraphBinaryLoader, GraphLoader } from "..";
import { parseCSVRows } from "../lib/csv";

export class CSVLoader implements GraphLoader {
    readonly filetype = "csv";

    constructor(private options: { loader: GraphBinaryLoader }) {}

    async getText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        const text = new TextDecoder().decode(content);
        parseCSVRows(text.trim());
        return text;
    }
}
