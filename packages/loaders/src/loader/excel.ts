import type { GraphBinaryLoader, GraphLoader } from "../types";
import { extractExcel } from "./excel/document";

export class ExcelLoader implements GraphLoader {
    readonly filetype = "xlsx";

    constructor(private options: { loader: GraphBinaryLoader }) {}

    async getText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        const data = await extractExcel(content);
        return data.text;
    }
}
