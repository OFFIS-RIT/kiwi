import { deleteFile, listFiles } from "@kiwi/files";

export function getDerivedFilePrefix(graphId: string, fileId: string): string {
    return `graphs/${graphId}/derived/${fileId}`;
}

export function getDerivedImagePrefix(graphId: string, fileId: string): string {
    return `${getDerivedFilePrefix(graphId, fileId)}/images`;
}

export function getDerivedSourceKey(graphId: string, fileId: string): string {
    return `${getDerivedFilePrefix(graphId, fileId)}/source.txt`;
}

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
