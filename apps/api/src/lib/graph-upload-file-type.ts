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
type UploadModelResolver = (organizationId: string, type: "audio" | "video", secret: string) => Promise<unknown>;

async function getDefaultUploadModelResolver(): Promise<UploadModelResolver> {
    const { resolveRequiredModelAdapter } = await import("@kiwi/ai/models");
    return resolveRequiredModelAdapter;
}

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

export async function assertConfiguredUploadModels(options: {
    organizationId: string;
    files: SupportedFileWithChecksum[];
    secret: string;
    resolveModelAdapter?: UploadModelResolver;
}) {
    const requiredModelTypes = new Set<"audio" | "video">();
    const resolveModelAdapter = options.resolveModelAdapter ?? (await getDefaultUploadModelResolver());

    for (const file of options.files) {
        if (file.type === "audio" || file.type === "video") {
            requiredModelTypes.add(file.type);
        }
    }

    await Promise.all(
        [...requiredModelTypes].map((type) => resolveModelAdapter(options.organizationId, type, options.secret))
    );
}
