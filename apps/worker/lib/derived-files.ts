import { deleteFile, getGraphFileArtifactPaths, listFiles } from "@kiwi/files";

export {
    getDerivedFilePrefix,
    getDerivedImagePrefix,
    getDerivedPdfPreviewPrefix,
    getDerivedSourceKey,
    getGraphFileArtifactPaths,
    getProcessingArtifactPrefix,
} from "@kiwi/files";

type DerivedCleanupDeps = {
    listFiles?: (path: string, bucket: string) => Promise<string[]>;
    deleteFile?: (key: string, bucket: string) => Promise<boolean>;
};

export async function deleteGraphFileArtifacts(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        bucket: string;
    },
    deps: DerivedCleanupDeps = {}
): Promise<string[]> {
    const loadKeys = deps.listFiles ?? listFiles;
    const removeKey = deps.deleteFile ?? deleteFile;
    const paths = getGraphFileArtifactPaths(options);
    const listedKeys = await Promise.all(paths.cleanupPrefixes.map((prefix) => loadKeys(prefix, options.bucket)));
    const artifactKeys = [...new Set(listedKeys.flat())];

    await Promise.all(artifactKeys.map((key) => removeKey(key, options.bucket)));

    return artifactKeys;
}

export async function deleteGraphFileProcessingArtifacts(
    options: {
        graphId: string;
        fileId: string;
        fileKey: string;
        bucket: string;
    },
    deps: DerivedCleanupDeps = {}
): Promise<{ deletedKeyCount: number }> {
    const loadKeys = deps.listFiles ?? listFiles;
    const removeKey = deps.deleteFile ?? deleteFile;
    const paths = getGraphFileArtifactPaths(options);
    const artifactKeys = [...new Set(await loadKeys(paths.processingPrefix, options.bucket))];

    await Promise.all(artifactKeys.map((key) => removeKey(key, options.bucket)));

    return { deletedKeyCount: artifactKeys.length };
}
