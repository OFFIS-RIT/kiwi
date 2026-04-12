import type { LanguageModelV3 } from "@ai-sdk/provider";
import { withAiSlot } from "@kiwi/ai";
import { embeddedImagePrompt } from "@kiwi/ai/prompts/image.prompt";
import { putNamedFile } from "@kiwi/files";
import { generateText } from "ai";

type OCRImageAsset = {
    id: string;
    type: string;
    content: Uint8Array;
};

type OCRImageStorage = {
    bucket: string;
    imagePrefix: string;
};

type OCRImageDeps = {
    describeImage?: (image: OCRImageAsset, model: LanguageModelV3) => Promise<string>;
    uploadImage?: (name: string, content: Uint8Array, storage: OCRImageStorage) => Promise<{ key: string }>;
};

const IMAGE_FENCE_PATTERN = /:::IMG-[^:]+:::/;

export async function processOCRImages(
    text: string,
    images: OCRImageAsset[],
    model: LanguageModelV3,
    storage: OCRImageStorage,
    deps: OCRImageDeps = {}
): Promise<string> {
    if (images.length === 0) {
        if (IMAGE_FENCE_PATTERN.test(text)) {
            throw new Error("Found image fences without extracted image assets");
        }

        return text;
    }

    const describeImage = deps.describeImage ?? defaultDescribeImage;
    const uploadImage = deps.uploadImage ?? defaultUploadImage;
    const seenIds = new Set<string>();

    for (const image of images) {
        if (seenIds.has(image.id)) {
            throw new Error(`Duplicate OCR image id ${image.id}`);
        }

        seenIds.add(image.id);
        const fence = `:::IMG-${image.id}:::`;
        const occurrences = countOccurrences(text, fence);
        if (occurrences !== 1) {
            throw new Error(`Expected exactly one fence for OCR image ${image.id}, found ${occurrences}`);
        }
    }

    const replacements = await Promise.all(
        images.map(async (image) => {
            const description = (await describeImage(image, model)).trim();
            const extension = getExtensionForMimeType(image.type);
            const uploaded = await uploadImage(`${image.id}.${extension}`, image.content, storage);

            return {
                fence: `:::IMG-${image.id}:::`,
                tag: renderImageTag(image.id, uploaded.key, description),
            };
        })
    );

    let output = text;
    for (const replacement of replacements) {
        output = output.replace(replacement.fence, replacement.tag);
    }

    const remainingFence = output.match(/:::IMG-[^:]+:::/);
    if (remainingFence) {
        throw new Error(`Unresolved OCR image fence ${remainingFence[0]}`);
    }

    return output;
}

async function defaultDescribeImage(image: OCRImageAsset, model: LanguageModelV3): Promise<string> {
    const mimeType = image.type || "application/octet-stream";
    const base64 = Buffer.from(image.content).toString("base64");
    const { text } = await withAiSlot("image", () =>
        generateText({
            model,
            system: embeddedImagePrompt,
            temperature: 0.1,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            image: `data:${mimeType};base64,${base64}`,
                        },
                    ],
                },
            ],
        })
    );

    return text;
}

async function defaultUploadImage(
    name: string,
    content: Uint8Array,
    storage: OCRImageStorage
): Promise<{ key: string }> {
    return putNamedFile(name, content, storage.imagePrefix, storage.bucket);
}

function countOccurrences(text: string, token: string): number {
    let count = 0;
    let index = 0;

    while (true) {
        const nextIndex = text.indexOf(token, index);
        if (nextIndex === -1) {
            return count;
        }

        count += 1;
        index = nextIndex + token.length;
    }
}

function renderImageTag(id: string, key: string, description: string): string {
    return `<image id="${escapeXml(id)}" key="${escapeXml(key)}">${escapeXml(description)}</image>`;
}

function escapeXml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

export function getExtensionForMimeType(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case "image/png":
            return "png";
        case "image/jpeg":
            return "jpg";
        case "image/gif":
            return "gif";
        case "image/webp":
            return "webp";
        case "image/svg+xml":
            return "svg";
        case "image/tiff":
            return "tiff";
        default:
            return "bin";
    }
}
