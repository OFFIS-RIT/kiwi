import { createHash } from "node:crypto";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { withAiSlotEffect } from "@kiwi/ai/lock";
import { embeddedImagePrompt } from "@kiwi/ai/prompts/image.prompt";
import { putNamedFile } from "@kiwi/files";
import { generateText } from "ai";

export type OCRImageAsset = {
    id: string;
    type: string;
    content: Uint8Array;
};

type OCRImageStorage = {
    bucket: string;
    imagePrefix: string;
};

type OCRImageEffectDeps = {
    describeImageEffect?: (image: OCRImageAsset, model: LanguageModelV3) => Effect.Effect<string, unknown>;
    uploadImageEffect?: (
        name: string,
        content: Uint8Array,
        storage: OCRImageStorage
    ) => Effect.Effect<{ key: string }, unknown>;
};

type OCRImageDeps = OCRImageEffectDeps & {
    describeImage?: (image: OCRImageAsset, model: LanguageModelV3) => Promise<string>;
    uploadImage?: (name: string, content: Uint8Array, storage: OCRImageStorage) => Promise<{ key: string }>;
};

const IMAGE_FENCE_PATTERN = /:::IMG-([^:]+):::/g;
const DEFAULT_IMAGE_BATCH_SIZE = 64;

export class OCRImageError extends Schema.TaggedErrorClass<OCRImageError>()("OCRImageError", {
    message: Schema.String,
    cause: Schema.Unknown,
}) {}

export function describeOCRImages(
    images: OCRImageAsset[],
    model: LanguageModelV3,
    deps: Pick<OCRImageDeps, "describeImage" | "describeImageEffect"> = {}
): Promise<Map<string, string>> {
    return Effect.runPromise(describeOCRImagesEffect(images, model, deps));
}

export const describeOCRImagesEffect = Effect.fn("describeOCRImagesEffect")(function* (
    images: OCRImageAsset[],
    model: LanguageModelV3,
    deps: Pick<OCRImageDeps, "describeImage" | "describeImageEffect"> = {}
) {
    const describeImage = describeImageEffectForDeps(deps);

    const checksumById = new Map<string, string>();
    const uniqueImages: Array<{ checksum: string; image: OCRImageAsset }> = [];
    const seenChecksums = new Set<string>();

    for (const image of images) {
        const checksum = checksumImageContent(image.content);
        checksumById.set(image.id, checksum);

        if (!seenChecksums.has(checksum)) {
            seenChecksums.add(checksum);
            uniqueImages.push({ checksum, image });
        }
    }

    const descriptionByChecksum = new Map<string, string>();
    const batchSize = yield* getImageBatchSizeEffect();
    for (let index = 0; index < uniqueImages.length; index += batchSize) {
        const batch = uniqueImages.slice(index, index + batchSize);
        const processedImages = yield* Effect.forEach(
            batch,
            ({ checksum, image }) =>
                describeImage(image, model).pipe(
                    Effect.map((description) => ({
                        checksum,
                        description: description.trim(),
                    }))
                ),
            { concurrency: batch.length }
        );

        for (const processedImage of processedImages) {
            descriptionByChecksum.set(processedImage.checksum, processedImage.description);
        }
    }

    const descriptions = new Map<string, string>();
    for (const image of images) {
        const checksum = checksumById.get(image.id);
        const description = checksum ? descriptionByChecksum.get(checksum) : undefined;
        if (description === undefined) {
            return yield* new OCRImageError({
                message: `Missing OCR image description for ${image.id}`,
                cause: "Missing checksum result",
            });
        }

        descriptions.set(image.id, description);
    }

    return descriptions;
});

export function processOCRImages(
    text: string,
    images: OCRImageAsset[],
    model: LanguageModelV3,
    storage: OCRImageStorage,
    deps: OCRImageDeps = {}
): Promise<string> {
    return Effect.runPromise(processOCRImagesEffect(text, images, model, storage, deps));
}

export const processOCRImagesEffect = Effect.fn("processOCRImagesEffect")(function* (
    text: string,
    images: OCRImageAsset[],
    model: LanguageModelV3,
    storage: OCRImageStorage,
    deps: OCRImageDeps = {}
) {
    const describeImage = describeImageEffectForDeps(deps);
    const uploadImage = uploadImageEffectForDeps(deps);

    if (images.length === 0) {
        if (text.match(IMAGE_FENCE_PATTERN)) {
            return yield* new OCRImageError({
                message: "Found image fences without extracted image assets",
                cause: "Missing extracted image assets",
            });
        }

        return text;
    }

    const imageIds = new Set<string>();

    for (const image of images) {
        if (imageIds.has(image.id)) {
            return yield* new OCRImageError({
                message: `Duplicate OCR image id ${image.id}`,
                cause: "Duplicate image id",
            });
        }

        imageIds.add(image.id);
    }

    const referencedIds = new Set<string>();
    for (const match of text.matchAll(IMAGE_FENCE_PATTERN)) {
        const id = match[1] ?? "";
        if (!imageIds.has(id)) {
            return yield* new OCRImageError({
                message: `Found fence for unknown OCR image ${id}`,
                cause: "Unknown image fence",
            });
        }

        referencedIds.add(id);
    }

    for (const image of images) {
        if (!referencedIds.has(image.id)) {
            return yield* new OCRImageError({
                message: `Expected at least one fence for OCR image ${image.id}, found 0`,
                cause: "Unreferenced image",
            });
        }
    }

    const tagsById = new Map<string, string>();
    const checksumById = new Map<string, string>();
    const uniqueImages: Array<{ checksum: string; image: OCRImageAsset }> = [];
    const seenChecksums = new Set<string>();
    for (const image of images) {
        const checksum = checksumImageContent(image.content);
        checksumById.set(image.id, checksum);

        if (!seenChecksums.has(checksum)) {
            seenChecksums.add(checksum);
            uniqueImages.push({ checksum, image });
        }
    }

    const processedByChecksum = new Map<string, { key: string; description: string }>();
    const batchSize = yield* getImageBatchSizeEffect();
    for (let index = 0; index < uniqueImages.length; index += batchSize) {
        const batch = uniqueImages.slice(index, index + batchSize);
        const processedImages = yield* Effect.forEach(
            batch,
            ({ checksum, image }) =>
                Effect.gen(function* () {
                    const description = (yield* describeImage(image, model)).trim();
                    const extension = getExtensionForMimeType(image.type);
                    const uploaded = yield* uploadImage(`${image.id}.${extension}`, image.content, storage);

                    return {
                        checksum,
                        key: uploaded.key,
                        description,
                    };
                }),
            { concurrency: batch.length }
        );

        for (const processedImage of processedImages) {
            processedByChecksum.set(processedImage.checksum, {
                key: processedImage.key,
                description: processedImage.description,
            });
        }
    }

    for (const image of images) {
        const checksum = checksumById.get(image.id);
        const processedImage = checksum ? processedByChecksum.get(checksum) : undefined;
        if (!processedImage) {
            return yield* new OCRImageError({
                message: `Missing OCR image checksum result for ${image.id}`,
                cause: "Missing checksum result",
            });
        }

        tagsById.set(image.id, renderImageTag(image.id, processedImage.key, processedImage.description));
    }

    let unresolvedFence: string | undefined;
    const output = text.replace(IMAGE_FENCE_PATTERN, (fence, id: string) => {
        const tag = tagsById.get(id);
        if (!tag) {
            unresolvedFence = fence;
            return fence;
        }

        return tag;
    });

    if (unresolvedFence) {
        return yield* new OCRImageError({
            message: `Unresolved OCR image fence ${unresolvedFence}`,
            cause: "Unresolved image fence",
        });
    }

    return output;
});

function describeImageEffectForDeps(
    deps: Pick<OCRImageDeps, "describeImage" | "describeImageEffect">
): (image: OCRImageAsset, model: LanguageModelV3) => Effect.Effect<string, OCRImageError> {
    if (deps.describeImageEffect) {
        return (image, model) =>
            deps.describeImageEffect!(image, model).pipe(
                Effect.mapError((cause) => toOCRImageError("Failed to describe OCR image.", cause))
            );
    }

    if (deps.describeImage) {
        return (image, model) =>
            Effect.tryPromise({
                try: () => deps.describeImage!(image, model),
                catch: (cause) => toOCRImageError("Failed to describe OCR image.", cause),
            });
    }

    return defaultDescribeImageEffect;
}

function uploadImageEffectForDeps(
    deps: Pick<OCRImageDeps, "uploadImage" | "uploadImageEffect">
): (name: string, content: Uint8Array, storage: OCRImageStorage) => Effect.Effect<{ key: string }, OCRImageError> {
    if (deps.uploadImageEffect) {
        return (name, content, storage) =>
            deps.uploadImageEffect!(name, content, storage).pipe(
                Effect.mapError((cause) => toOCRImageError("Failed to upload OCR image.", cause))
            );
    }

    if (deps.uploadImage) {
        return (name, content, storage) =>
            Effect.tryPromise({
                try: () => deps.uploadImage!(name, content, storage),
                catch: (cause) => toOCRImageError("Failed to upload OCR image.", cause),
            });
    }

    return defaultUploadImageEffect;
}

function toOCRImageError(message: string, cause: unknown): OCRImageError {
    return cause instanceof OCRImageError ? cause : new OCRImageError({ message, cause });
}

const imageBatchSizeConfig = Config.string("AI_IMAGE_CONCURRENCY").pipe(
    Config.withDefault(String(DEFAULT_IMAGE_BATCH_SIZE)),
    Config.map((value) => normalizeImageBatchSize(Number(value)))
);

function getImageBatchSizeEffect(): Effect.Effect<number, OCRImageError> {
    return Effect.suspend(() =>
        imageBatchSizeConfig
            .parse(ConfigProvider.fromEnv())
            .pipe(
                Effect.mapError(
                    (cause) => new OCRImageError({ message: "Invalid OCR image concurrency configuration.", cause })
                )
            )
    );
}

function normalizeImageBatchSize(value: number): number {
    return !Number.isFinite(value) || value < 1 ? DEFAULT_IMAGE_BATCH_SIZE : Math.floor(value);
}

function defaultDescribeImageEffect(
    image: OCRImageAsset,
    model: LanguageModelV3
): Effect.Effect<string, OCRImageError> {
    const mimeType = image.type || "application/octet-stream";
    const base64 = Buffer.from(image.content).toString("base64");

    return Effect.gen(function* () {
        const { text } = yield* withAiSlotEffect("image", (signal) =>
            generateText({
                model,
                system: embeddedImagePrompt,
                temperature: 0.1,
                abortSignal: signal,
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
        ).pipe(Effect.mapError((cause) => toOCRImageError("Failed to describe OCR image.", cause)));

        return text;
    });
}

function checksumImageContent(content: Uint8Array): string {
    return createHash("sha256").update(content).digest("hex");
}

function defaultUploadImageEffect(
    name: string,
    content: Uint8Array,
    storage: OCRImageStorage
): Effect.Effect<{ key: string }, OCRImageError> {
    return putNamedFile(name, content, storage.imagePrefix, storage.bucket).pipe(
        Effect.mapError((cause) => toOCRImageError("Failed to upload OCR image.", cause))
    );
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
