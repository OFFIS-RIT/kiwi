import type { GraphBinaryLoader, GraphLoader } from "..";
import { extractExcel } from "./excel/parser/document";

export class ExcelLoader implements GraphLoader {
    readonly filetype = "xlsx";

    constructor(private options: { loader: GraphBinaryLoader }) {}

    async getText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        const data = extractExcel(content);
        return data.text;
    }
}
