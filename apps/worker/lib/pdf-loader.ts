import type { GraphBinaryLoader } from "@kiwi/graph";
import { PDFLoader, type PDFMode } from "@kiwi/graph/loader/pdf";

type PDFLoaderOptions = ConstructorParameters<typeof PDFLoader>[0];

export function buildPDFLoaderOptions(
    loader: GraphBinaryLoader,
    model: PDFLoaderOptions["model"] | undefined,
    storage: PDFLoaderOptions["storage"] | undefined,
    mode: PDFMode = "hybrid"
): PDFLoaderOptions {
    const options: PDFLoaderOptions = { loader, mode };

    if (mode === "plain") {
        return options;
    }

    if (!model) {
        throw new Error(`PDF ${mode} mode requires an image-capable model`);
    }

    options.model = model;
    if (storage) {
        options.storage = storage;
    }

    return options;
}
