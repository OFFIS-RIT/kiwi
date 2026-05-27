import { deleteFile, getDerivedFilePrefix, listFiles } from "@kiwi/files";

export {
    getDerivedFilePrefix,
    getDerivedImagePrefix,
    getDerivedPdfPreviewPrefix,
    getDerivedSourceKey,
} from "@kiwi/files";

type DerivedCleanupDeps = {
    listFiles?: (path: string, bucket: string) => Promise<string[]>;
    deleteFile?: (key: string, bucket: string) => Promise<boolean>;
};

export async function deleteDerivedFileArtifacts(
    graphId: string,
    fileId: string,
    bucket: string,
    deps: DerivedCleanupDeps = {}
): Promise<string[]> {
    const derivedPrefix = getDerivedFilePrefix(graphId, fileId);
    const loadKeys = deps.listFiles ?? listFiles;
    const removeKey = deps.deleteFile ?? deleteFile;
    const derivedKeys = await loadKeys(derivedPrefix, bucket);

    await Promise.all(derivedKeys.map((key) => removeKey(key, bucket)));

    return derivedKeys;
}
