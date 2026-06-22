import * as Effect from "effect/Effect";
import { resolveRequiredModelAdapter, type AiModelRegistry } from "@kiwi/ai/models";
import { API_ERROR_CODES, errorResponse } from "../../types";
import { inferGraphFileType, type GraphFileType } from "../graph-file-type";

export type FileWithChecksum = {
    file: File;
    checksum: string;
};
export type SupportedFileWithChecksum = FileWithChecksum & {
    type: GraphFileType;
};
type UploadModelFile = {
    type: GraphFileType;
};
export type UploadFileTypeCheck =
    | { ok: true; files: SupportedFileWithChecksum[] }
    | { ok: false; fileName: string; message: string };

type StatusFn = (code: number, body: unknown) => unknown;
type UploadModelResolver = (
    organizationId: string,
    type: "audio" | "video"
) => Effect.Effect<unknown, unknown, AiModelRegistry>;

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

export function assertConfiguredUploadModels(options: {
    organizationId: string;
    files: readonly UploadModelFile[];
    resolveModelAdapter?: UploadModelResolver;
}): Effect.Effect<void, unknown, AiModelRegistry> {
    return Effect.gen(function* () {
        const requiredModelTypes = new Set<"audio" | "video">();
        const resolveModelAdapter = options.resolveModelAdapter ?? resolveRequiredModelAdapter;

        for (const file of options.files) {
            if (file.type === "audio" || file.type === "video") {
                requiredModelTypes.add(file.type);
            }
        }

        yield* Effect.all(
            [...requiredModelTypes].map((type) => resolveModelAdapter(options.organizationId, type)),
            { concurrency: "unbounded", discard: true }
        );
    });
}
