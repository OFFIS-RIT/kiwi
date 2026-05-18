import type { LanguageModelV3 } from "@ai-sdk/provider";
import { withAiSlot } from "@kiwi/ai/lock";
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

const IMAGE_FENCE_PATTERN = /:::IMG-([^:]+):::/g;
const DEFAULT_IMAGE_BATCH_SIZE = 64;

export async function processOCRImages(
    text: string,
    images: OCRImageAsset[],
    model: LanguageModelV3,
    storage: OCRImageStorage,
    deps: OCRImageDeps = {}
): Promise<string> {
    if (images.length === 0) {
        if (text.match(IMAGE_FENCE_PATTERN)) {
            throw new Error("Found image fences without extracted image assets");
        }

        return text;
    }

    const describeImage = deps.describeImage ?? defaultDescribeImage;
    const uploadImage = deps.uploadImage ?? defaultUploadImage;
    const imageIds = new Set<string>();

    for (const image of images) {
        if (imageIds.has(image.id)) {
            throw new Error(`Duplicate OCR image id ${image.id}`);
        }

        imageIds.add(image.id);
    }

    const referencedIds = new Set<string>();
    for (const match of text.matchAll(IMAGE_FENCE_PATTERN)) {
        const id = match[1] ?? "";
        if (!imageIds.has(id)) {
            throw new Error(`Found fence for unknown OCR image ${id}`);
        }

        referencedIds.add(id);
    }

    for (const image of images) {
        if (!referencedIds.has(image.id)) {
            throw new Error(`Expected at least one fence for OCR image ${image.id}, found 0`);
        }
    }

    const tagsById = new Map<string, string>();
    const batchSize = getImageBatchSize();
    for (let index = 0; index < images.length; index += batchSize) {
        const batch = images.slice(index, index + batchSize);
        const tags = await Promise.all(
            batch.map(async (image) => {
                const description = (await describeImage(image, model)).trim();
                const extension = getExtensionForMimeType(image.type);
                const uploaded = await uploadImage(`${image.id}.${extension}`, image.content, storage);

                return {
                    id: image.id,
                    tag: renderImageTag(image.id, uploaded.key, description),
                };
            })
        );

        for (const tag of tags) {
            tagsById.set(tag.id, tag.tag);
        }
    }

    const output = text.replace(IMAGE_FENCE_PATTERN, (fence, id: string) => {
        const tag = tagsById.get(id);
        if (!tag) {
            throw new Error(`Unresolved OCR image fence ${fence}`);
        }

        return tag;
    });

    return output;
}

function getImageBatchSize(): number {
    const value = Number(process.env.AI_IMAGE_CONCURRENCY);
    return !Number.isFinite(value) || value < 1 ? DEFAULT_IMAGE_BATCH_SIZE : Math.floor(value);
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
