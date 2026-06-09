import { API_ERROR_CODES, errorResponse } from "../types";
import { inferGraphFileType, type GraphFileType } from "./graph-file-type";

export type FileWithChecksum = {
    file: File;
    checksum: string;
};
export type SupportedFileWithChecksum = FileWithChecksum & {
    type: GraphFileType;
};
export type UploadFileTypeCheck =
    | { ok: true; files: SupportedFileWithChecksum[] }
    | { ok: false; fileName: string; message: string };

type StatusFn = (code: number, body: unknown) => unknown;

export function inferSupportedUploadedFiles(files: FileWithChecksum[]): UploadFileTypeCheck {
    const typedFiles: SupportedFileWithChecksum[] = [];

    for (const fileWithChecksum of files) {
        const type = inferGraphFileType(fileWithChecksum.file);
        typedFiles.push({ ...fileWithChecksum, type });
    }

    return { ok: true, files: typedFiles };
}

export function unsupportedUploadResponse(statusFn: StatusFn, check: Extract<UploadFileTypeCheck, { ok: false }>) {
    return statusFn(415, errorResponse(`${check.fileName}: ${check.message}`, API_ERROR_CODES.UNSUPPORTED_FILE_TYPE));
}
