import type { GraphBinaryLoader } from "@kiwi/graph";
import { PDFLoader } from "@kiwi/graph/loader/pdf";

export function buildPDFLoaderOptions(
    loader: GraphBinaryLoader,
    model?: ConstructorParameters<typeof PDFLoader>[0]["model"]
): {
    loader: GraphBinaryLoader;
    mode: ConstructorParameters<typeof PDFLoader>[0]["mode"];
    model: NonNullable<ConstructorParameters<typeof PDFLoader>[0]["model"]>;
} {
    if (!model) {
        throw new Error("PDF full OCR requires an image-capable model");
    }

    return {
        loader,
        mode: "ocr",
        model,
    };
}
