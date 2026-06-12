import { DEFAULT_FILE_TYPE_CHUNKING, isGraphChunkerKind, type GraphChunkerKind } from "../chunking/factory";
import type { GraphFileType } from "../file-type";
import {
    DEFAULT_DOCUMENT_MODES,
    DEFAULT_FILE_FORMATS,
    isGraphDocumentMode,
    type GraphDocumentMode,
    type GraphLoaderKind,
} from "../loader/factory";

export type FileTypeProcessingConfig = {
    loader: GraphLoaderKind;
    chunker: GraphChunkerKind;
    chunkSize: number | null;
    documentMode: GraphDocumentMode | null;
};

export type FileTypeProcessingOverrides = {
    chunker?: string | null;
    chunkSize?: number | null;
    documentMode?: string | null;
};

export function defaultFileTypeProcessingConfig(fileType: GraphFileType): FileTypeProcessingConfig {
    const chunking = DEFAULT_FILE_TYPE_CHUNKING[fileType];

    return {
        loader: DEFAULT_FILE_FORMATS[fileType].loaderKind,
        chunker: chunking.chunker,
        chunkSize: chunking.chunkSize,
        documentMode: DEFAULT_DOCUMENT_MODES[fileType],
    };
}

export function resolveFileTypeProcessingConfig(
    fileType: GraphFileType,
    overrides?: FileTypeProcessingOverrides | null
): FileTypeProcessingConfig {
    const defaults = defaultFileTypeProcessingConfig(fileType);
    if (!overrides) {
        return defaults;
    }

    return {
        // Loaders are fixed per file type for now; detection picks the actual loader.
        loader: defaults.loader,
        chunker: isGraphChunkerKind(overrides.chunker) ? overrides.chunker : defaults.chunker,
        chunkSize: overrides.chunkSize ?? defaults.chunkSize,
        documentMode: isGraphDocumentMode(overrides.documentMode) ? overrides.documentMode : defaults.documentMode,
    };
}

export function fileTypeSupportsChunkSize(fileType: GraphFileType): boolean {
    return DEFAULT_FILE_TYPE_CHUNKING[fileType].chunkSize !== null;
}

export function fileTypeSupportsDocumentMode(fileType: GraphFileType): boolean {
    return DEFAULT_DOCUMENT_MODES[fileType] !== null;
}
