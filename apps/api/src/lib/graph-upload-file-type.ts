import { env } from "../env";
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
type OptionalMediaConfig = {
    adapter?: string;
    model?: string;
    key?: string;
    url?: string;
    resourceName?: string;
};

export function inferSupportedUploadedFiles(files: FileWithChecksum[]): UploadFileTypeCheck {
    const typedFiles: SupportedFileWithChecksum[] = [];

    for (const fileWithChecksum of files) {
        const type = inferGraphFileType(fileWithChecksum.file);
        const mediaSupport = getMediaTypeSupport(type);
        if (!mediaSupport.ok) {
            return {
                ok: false,
                fileName: fileWithChecksum.file.name,
                message: mediaSupport.message,
            };
        }

        typedFiles.push({ ...fileWithChecksum, type });
    }

    return { ok: true, files: typedFiles };
}

export function unsupportedUploadResponse(statusFn: StatusFn, check: Extract<UploadFileTypeCheck, { ok: false }>) {
    return statusFn(415, errorResponse(`${check.fileName}: ${check.message}`, API_ERROR_CODES.UNSUPPORTED_FILE_TYPE));
}

function getMediaTypeSupport(type: GraphFileType): { ok: true } | { ok: false; message: string } {
    if (type === "audio") {
        return validateTranscriptionConfig("Audio", "AI_AUDIO", {
            adapter: env.AI_AUDIO_ADAPTER,
            model: env.AI_AUDIO_MODEL,
            key: env.AI_AUDIO_KEY,
            url: env.AI_AUDIO_URL,
            resourceName: env.AI_AUDIO_RESOURCE_NAME,
        });
    }

    if (type === "video") {
        return validateTranscriptionConfig("Video", "AI_VIDEO", {
            adapter: env.AI_VIDEO_ADAPTER,
            model: env.AI_VIDEO_MODEL,
            key: env.AI_VIDEO_KEY,
            url: env.AI_VIDEO_URL,
            resourceName: env.AI_VIDEO_RESOURCE_NAME,
        });
    }

    return { ok: true };
}

function validateTranscriptionConfig(
    label: "Audio" | "Video",
    prefix: "AI_AUDIO" | "AI_VIDEO",
    config: OptionalMediaConfig
): { ok: true } | { ok: false; message: string } {
    const adapter = normalizeOptionalString(config.adapter);
    const model = normalizeOptionalString(config.model);
    const key = normalizeOptionalString(config.key);
    const url = normalizeOptionalString(config.url);
    const resourceName = normalizeOptionalString(config.resourceName);

    if (!adapter || !model || !key) {
        return {
            ok: false,
            message: `${label} uploads require ${prefix}_ADAPTER, ${prefix}_MODEL, and ${prefix}_KEY`,
        };
    }

    if (adapter === "anthropic") {
        return {
            ok: false,
            message: `${label} uploads do not support ${prefix}_ADAPTER=anthropic`,
        };
    }

    if (!isSupportedTranscriptionAdapter(adapter)) {
        return {
            ok: false,
            message: `${label} uploads do not support ${prefix}_ADAPTER=${adapter}`,
        };
    }

    if (adapter === "azure" && !resourceName) {
        return {
            ok: false,
            message: `${label} uploads require ${prefix}_RESOURCE_NAME when ${prefix}_ADAPTER is azure`,
        };
    }

    if (adapter === "openaiAPI" && !url) {
        return {
            ok: false,
            message: `${label} uploads require ${prefix}_URL when ${prefix}_ADAPTER is openaiAPI`,
        };
    }

    return { ok: true };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function isSupportedTranscriptionAdapter(value: string): value is "openai" | "azure" | "openaiAPI" {
    return value === "openai" || value === "azure" || value === "openaiAPI";
}
