import type { GraphBinaryLoader } from "@kiwi/graph";
import { PDFLoader } from "@kiwi/graph/loader/pdf";

export function buildPDFLoaderOptions(
    loader: GraphBinaryLoader,
    model: ConstructorParameters<typeof PDFLoader>[0]["model"] | undefined,
    storage: NonNullable<ConstructorParameters<typeof PDFLoader>[0]["storage"]>
): {
    loader: GraphBinaryLoader;
    mode: ConstructorParameters<typeof PDFLoader>[0]["mode"];
    model: NonNullable<ConstructorParameters<typeof PDFLoader>[0]["model"]>;
    storage: NonNullable<ConstructorParameters<typeof PDFLoader>[0]["storage"]>;
} {
    if (!model) {
        throw new Error("PDF hybrid mode requires an image-capable model");
    }

    return {
        loader,
        mode: "hybrid",
        model,
        storage,
    };
}
