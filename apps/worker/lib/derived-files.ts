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
    fileKey: string,
    fileId: string,
    bucket: string,
    deps: DerivedCleanupDeps = {}
): Promise<string[]> {
    const loadKeys = deps.listFiles ?? listFiles;
    const removeKey = deps.deleteFile ?? deleteFile;
    const prefixes = uniqueStrings([getDerivedFilePrefix(fileKey, fileId), getLegacyDerivedFilePrefix(fileKey, fileId)]);
    const listedKeys = await Promise.all(prefixes.map((prefix) => loadKeys(prefix, bucket)));
    const derivedKeys = uniqueStrings(listedKeys.flat());

    await Promise.all(derivedKeys.map((key) => removeKey(key, bucket)));

    return derivedKeys;
}

function getLegacyDerivedFilePrefix(fileKey: string, fileId: string): string | null {
    const [root, graphId] = fileKey.split("/");

    return root === "graphs" && graphId ? `graphs/${graphId}/derived/${fileId}` : null;
}

function uniqueStrings(values: Array<string | null>): string[] {
    return [...new Set(values.filter((value): value is string => value !== null))];
}
