import { deleteFile, getGraphFileArtifactPaths, listFiles } from "@kiwi/files";
import * as Effect from "effect/Effect";

export {
    getDerivedFilePrefix,
    getDerivedImagePrefix,
    getDerivedPdfPreviewPrefix,
    getDerivedSourceKey,
    getGraphFileArtifactPaths,
    getProcessingArtifactPrefix,
} from "@kiwi/files";

type DerivedCleanupDeps = {
    listFiles?: (path: string, bucket: string) => Effect.Effect<string[], unknown>;
    deleteFile?: (key: string, bucket: string) => Effect.Effect<boolean, unknown>;
};

export function deleteGraphFileArtifacts(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        bucket: string;
    },
    deps: DerivedCleanupDeps = {}
): Effect.Effect<string[], unknown> {
    return Effect.gen(function* () {
        const loadKeys = deps.listFiles ?? listFiles;
        const removeKey = deps.deleteFile ?? deleteFile;
        const paths = getGraphFileArtifactPaths(options);
        const listedKeys = yield* Effect.all(
            paths.cleanupPrefixes.map((prefix) => loadKeys(prefix, options.bucket)),
            { concurrency: "unbounded" }
        );
        const artifactKeys = [...new Set(listedKeys.flat())];

        yield* Effect.all(
            artifactKeys.map((key) => removeKey(key, options.bucket)),
            { concurrency: "unbounded" }
        );

        return artifactKeys;
    });
}

export function deleteGraphFileProcessingArtifacts(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        bucket: string;
    },
    deps: DerivedCleanupDeps = {}
): Effect.Effect<{ deletedKeyCount: number }, unknown> {
    return Effect.gen(function* () {
        const loadKeys = deps.listFiles ?? listFiles;
        const removeKey = deps.deleteFile ?? deleteFile;
        const paths = getGraphFileArtifactPaths(options);
        const artifactKeys = [...new Set(yield* loadKeys(paths.processingPrefix, options.bucket))];

        yield* Effect.all(
            artifactKeys.map((key) => removeKey(key, options.bucket)),
            { concurrency: "unbounded" }
        );

        return { deletedKeyCount: artifactKeys.length };
    });
}
