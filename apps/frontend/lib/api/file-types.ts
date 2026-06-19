import type {
    FileTypeConfigListResponse,
    FileTypeConfigPatchInput,
    FileTypeConfigPatchResponse,
    FileTypeConfigRecord,
    FileTypeValue,
} from "@kiwi/contracts";
import { unwrapApiResponse, type KiwiApiClient } from "./client";

function fileTypePath(fileType: FileTypeValue): string {
    return `/file-types/${encodeURIComponent(fileType)}`;
}

export async function fetchFileTypeConfigs(client: KiwiApiClient): Promise<FileTypeConfigRecord[]> {
    const response = await client.get<FileTypeConfigListResponse>("/file-types/");
    return unwrapApiResponse(response);
}

export async function updateFileTypeConfig(
    client: KiwiApiClient,
    fileType: FileTypeValue,
    input: FileTypeConfigPatchInput
): Promise<FileTypeConfigRecord> {
    const response = await client.patch<FileTypeConfigPatchResponse>(fileTypePath(fileType), input);
    return unwrapApiResponse(response);
}
