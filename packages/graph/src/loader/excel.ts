import { Effect } from "effect";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { extractExcelEffect } from "./excel/parser/document";

export class ExcelLoader implements GraphLoader {
    readonly filetype = "xlsx";

    constructor(private options: { loader: GraphBinaryLoader }) {}

    async getText(): Promise<string> {
        return Effect.runPromise(this.getTextEffect());
    }

    private getTextEffect(): Effect.Effect<string, unknown> {
        return Effect.gen(this, function* () {
            const content = yield* this.getBinaryEffect();
            const data = yield* extractExcelEffect(content);
            return data.text;
        });
    }

    private getBinaryEffect(): Effect.Effect<ArrayBuffer, unknown> {
        return Effect.tryPromise({
            try: () => this.options.loader.getBinary(),
            catch: (error) => error,
        });
    }
}
