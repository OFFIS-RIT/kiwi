import type { GraphChunker, TextUnitSourceChunk } from "../types";
import { SemanticChunker } from "../chunking/semantic";

export const DEFAULT_SOURCE_CHUNK_TOKENS = 150;

const IMAGE_TAG_PATTERN = /<image\b([^>]*)>([\s\S]*?)<\/image>/giu;
const SPLITTABLE_SOURCE_TEXT_FILE_TYPES = new Set(["text", "pdf", "doc", "docx", "odt", "ppt", "pptx", "odp"]);
const TOP_LEVEL_IMAGE_FILE_TYPES = new Set(["image", "png", "jpg", "jpeg", "gif", "webp", "svg", "tif", "tiff", "bmp"]);

export async function createSourceChunks(
    content: string,
    options: {
        fileType?: string;
        maxTokens?: number;
        startPage?: number | null;
        endPage?: number | null;
        textChunker?: GraphChunker;
    } = {}
): Promise<TextUnitSourceChunk[]> {
    const startPage = options.startPage ?? null;
    const endPage = options.endPage ?? null;
    const trimmed = content.trim();

    if (isTopLevelImageFileType(options.fileType)) {
        return [
            {
                id: 1,
                type: "image",
                text: trimmed,
                imageId: null,
                imageKey: null,
                startPage,
                endPage,
            },
        ];
    }

    const chunks: TextUnitSourceChunk[] = [];
    let cursor = 0;
    const splitTextChunks = shouldSplitSourceTextChunks(options.fileType);
    const textChunker = splitTextChunks
        ? (options.textChunker ?? new SemanticChunker(options.maxTokens ?? DEFAULT_SOURCE_CHUNK_TOKENS))
        : null;

    const appendTextChunks = async (text: string) => {
        const textChunks = textChunker ? await textChunker.getChunks(text) : [text];

        for (const textChunk of textChunks) {
            const chunkText = textChunk.trim();
            if (chunkText === "") {
                continue;
            }

            chunks.push({
                id: chunks.length + 1,
                type: "text",
                text: chunkText,
                startPage,
                endPage,
            });
        }
    };

    for (const match of trimmed.matchAll(IMAGE_TAG_PATTERN)) {
        const index = match.index ?? 0;
        await appendTextChunks(trimmed.slice(cursor, index));

        const attributes = match[1] ?? "";
        const description = decodeXml(match[2] ?? "").trim();
        chunks.push({
            id: chunks.length + 1,
            type: "image",
            text: description,
            imageId: getXmlAttribute(attributes, "id"),
            imageKey: getXmlAttribute(attributes, "key"),
            startPage,
            endPage,
        });

        cursor = index + match[0].length;
    }

    await appendTextChunks(trimmed.slice(cursor));
    return chunks;
}

function shouldSplitSourceTextChunks(fileType: string | undefined): boolean {
    const normalizedFileType = fileType?.trim().toLowerCase();
    return !normalizedFileType || SPLITTABLE_SOURCE_TEXT_FILE_TYPES.has(normalizedFileType);
}

function isTopLevelImageFileType(fileType: string | undefined): boolean {
    const normalizedFileType = fileType?.trim().toLowerCase();
    return (
        !!normalizedFileType &&
        (normalizedFileType.startsWith("image/") || TOP_LEVEL_IMAGE_FILE_TYPES.has(normalizedFileType))
    );
}

function getXmlAttribute(attributes: string, name: string): string | null {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`${escapedName}\\s*=\\s*"([^"]*)"`, "u").exec(attributes);
    const value = match?.[1];
    return value ? decodeXml(value) : null;
}

function decodeXml(value: string): string {
    return value
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}
