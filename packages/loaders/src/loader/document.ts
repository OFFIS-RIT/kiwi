import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GraphDocumentLoader, GraphLoader, LoadedGraphDocument } from "../types";

export class LoadGraphDocumentError extends Schema.TaggedErrorClass<LoadGraphDocumentError>()(
    "LoadGraphDocumentError",
    {
        message: Schema.String,
        cause: Schema.Unknown,
    }
) {}

export const loadGraphDocumentEffect = Effect.fn("loadGraphDocumentEffect")(function* (loader: GraphLoader) {
    if (isGraphDocumentEffectLoader(loader)) {
        return yield* loader
            .getDocumentEffect()
            .pipe(
                Effect.mapError(
                    (cause) => new LoadGraphDocumentError({ message: "Failed to load graph document.", cause })
                )
            );
    }

    if (isGraphDocumentLoader(loader)) {
        return yield* Effect.tryPromise({
            try: () => loader.getDocument(),
            catch: (cause) => new LoadGraphDocumentError({ message: "Failed to load graph document.", cause }),
        });
    }

    if (isGraphTextEffectLoader(loader)) {
        const text = yield* loader
            .getTextEffect()
            .pipe(
                Effect.mapError((cause) => new LoadGraphDocumentError({ message: "Failed to load graph text.", cause }))
            );
        return { text };
    }

    const text = yield* Effect.tryPromise({
        try: () => loader.getText(),
        catch: (cause) => new LoadGraphDocumentError({ message: "Failed to load graph text.", cause }),
    });
    return { text };
});

export function loadGraphDocument(loader: GraphLoader): Promise<LoadedGraphDocument> {
    return Effect.runPromise(loadGraphDocumentEffect(loader));
}

function isGraphDocumentLoader(loader: GraphLoader): loader is GraphDocumentLoader {
    return "getDocument" in loader && typeof loader.getDocument === "function";
}

function isGraphDocumentEffectLoader(
    loader: GraphLoader
): loader is GraphLoader & Required<Pick<GraphDocumentLoader, "getDocumentEffect">> {
    return "getDocumentEffect" in loader && typeof loader.getDocumentEffect === "function";
}

function isGraphTextEffectLoader(
    loader: GraphLoader
): loader is GraphLoader & Required<Pick<GraphLoader, "getTextEffect">> {
    return "getTextEffect" in loader && typeof loader.getTextEffect === "function";
}
