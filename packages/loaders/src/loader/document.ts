import type { GraphDocumentLoader, GraphLoader, LoadedGraphDocument } from "../types";

export async function loadGraphDocument(loader: GraphLoader): Promise<LoadedGraphDocument> {
    if (isGraphDocumentLoader(loader)) {
        return loader.getDocument();
    }

    return { text: await loader.getText() };
}

function isGraphDocumentLoader(loader: GraphLoader): loader is GraphDocumentLoader {
    return "getDocument" in loader && typeof loader.getDocument === "function";
}
