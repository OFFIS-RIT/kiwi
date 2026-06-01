import { describe, expect, mock, test } from "bun:test";

import { describeOCRImages, getExtensionForMimeType, processOCRImages } from "../ocr-image";

describe("processOCRImages", () => {
    test("uploads extracted images and replaces fences with escaped image tags", async () => {
        const uploadedNames: string[] = [];
        const describeImage = mock(async (image: { id: string }) => {
            if (image.id === "img-1") {
                return 'Chart <A> & "B"';
            }

            return "Diagram 2";
        });
        const uploadImage = mock(async (name: string, _content: Uint8Array, storage: { imagePrefix: string }) => {
            uploadedNames.push(name);
            return {
                key: `${storage.imagePrefix}/${name}`,
            };
        });

        const text = ["Before", ":::IMG-img-1:::", "Middle", ":::IMG-img-2:::", "After"].join("\n");

        const output = await processOCRImages(
            text,
            [
                { id: "img-1", type: "image/png", content: new Uint8Array([1]) },
                { id: "img-2", type: "image/webp", content: new Uint8Array([2]) },
            ],
            {} as never,
            { bucket: "bucket", imagePrefix: "graphs/g-1/f-1.pdf/f-1/images" },
            { describeImage, uploadImage }
        );

        expect(output).toContain(
            '<image id="img-1" key="graphs/g-1/f-1.pdf/f-1/images/img-1.png">Chart &lt;A&gt; &amp; &quot;B&quot;</image>'
        );
        expect(output).toContain('<image id="img-2" key="graphs/g-1/f-1.pdf/f-1/images/img-2.webp">Diagram 2</image>');
        expect(output).not.toMatch(/:::IMG-img-/);
        expect(uploadImage).toHaveBeenCalledTimes(2);
        expect(uploadedNames.sort()).toEqual(["img-1.png", "img-2.webp"]);
        expect(uploadImage).toHaveBeenCalledWith(expect.any(String), expect.any(Uint8Array), {
            bucket: "bucket",
            imagePrefix: "graphs/g-1/f-1.pdf/f-1/images",
        });
    });

    test("processes images in configured image concurrency batches", async () => {
        const previousConcurrency = process.env.AI_IMAGE_CONCURRENCY;
        process.env.AI_IMAGE_CONCURRENCY = "2";
        let active = 0;
        let maxActive = 0;
        const describeImage = mock(async (image: { id: string }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return image.id;
        });
        const uploadImage = mock(async (name: string, _content: Uint8Array, storage: { imagePrefix: string }) => ({
            key: `${storage.imagePrefix}/${name}`,
        }));

        const images = Array.from({ length: 5 }, (_, index) => ({
            id: `img-${index + 1}`,
            type: "image/png",
            content: new Uint8Array([index]),
        }));
        const text = images.map((image) => `:::IMG-${image.id}:::`).join("\n");

        try {
            await processOCRImages(
                text,
                images,
                {} as never,
                { bucket: "bucket", imagePrefix: "graphs/g-1/f-1.pdf/f-1/images" },
                { describeImage, uploadImage }
            );

            expect(maxActive).toBe(2);
            expect(describeImage).toHaveBeenCalledTimes(5);
            expect(uploadImage).toHaveBeenCalledTimes(5);
        } finally {
            if (previousConcurrency === undefined) {
                delete process.env.AI_IMAGE_CONCURRENCY;
            } else {
                process.env.AI_IMAGE_CONCURRENCY = previousConcurrency;
            }
        }
    });

    test("reuses one processed image for repeated fences", async () => {
        const describeImage = mock(async () => "Repeated diagram");
        const uploadImage = mock(async (name: string, _content: Uint8Array, storage: { imagePrefix: string }) => ({
            key: `${storage.imagePrefix}/${name}`,
        }));

        const output = await processOCRImages(
            [":::IMG-img-1:::", "Again", ":::IMG-img-1:::"].join("\n"),
            [{ id: "img-1", type: "image/png", content: new Uint8Array([1]) }],
            {} as never,
            { bucket: "bucket", imagePrefix: "graphs/g-1/f-1.pdf/f-1/images" },
            { describeImage, uploadImage }
        );

        expect(output.match(/<image id="img-1"/g) ?? []).toHaveLength(2);
        expect(describeImage).toHaveBeenCalledTimes(1);
        expect(uploadImage).toHaveBeenCalledTimes(1);
    });

    test("deduplicates different image ids with identical content by checksum", async () => {
        const describeImage = mock(async (image: { id: string }) => `Description for ${image.id}`);
        const uploadImage = mock(async (name: string, _content: Uint8Array, storage: { imagePrefix: string }) => ({
            key: `${storage.imagePrefix}/${name}`,
        }));
        const content = new Uint8Array([1, 2, 3, 4]);

        const output = await processOCRImages(
            [":::IMG-img-1:::", ":::IMG-img-2:::"].join("\n"),
            [
                { id: "img-1", type: "image/png", content },
                { id: "img-2", type: "image/png", content: content.slice() },
            ],
            {} as never,
            { bucket: "bucket", imagePrefix: "graphs/g-1/f-1.pdf/f-1/images" },
            { describeImage, uploadImage }
        );

        expect(output).toContain(
            '<image id="img-1" key="graphs/g-1/f-1.pdf/f-1/images/img-1.png">Description for img-1</image>'
        );
        expect(output).toContain(
            '<image id="img-2" key="graphs/g-1/f-1.pdf/f-1/images/img-1.png">Description for img-1</image>'
        );
        expect(describeImage).toHaveBeenCalledTimes(1);
        expect(uploadImage).toHaveBeenCalledTimes(1);
    });

    test("rejects fences without extracted image assets", async () => {
        await expect(
            processOCRImages(
                "Before\n:::IMG-img-missing:::",
                [{ id: "img-1", type: "image/png", content: new Uint8Array([1]) }],
                {} as never,
                { bucket: "bucket", imagePrefix: "graphs/g-1/f-1.pdf/f-1/images" },
                {
                    describeImage: mock(async () => "unused"),
                    uploadImage: mock(async () => ({ key: "unused" })),
                }
            )
        ).rejects.toThrow("Found fence for unknown OCR image img-missing");
    });

    test("rejects extracted images without fences", async () => {
        await expect(
            processOCRImages(
                "No image fences",
                [{ id: "img-1", type: "image/png", content: new Uint8Array([1]) }],
                {} as never,
                { bucket: "bucket", imagePrefix: "graphs/g-1/f-1.pdf/f-1/images" },
                {
                    describeImage: mock(async () => "unused"),
                    uploadImage: mock(async () => ({ key: "unused" })),
                }
            )
        ).rejects.toThrow("Expected at least one fence for OCR image img-1, found 0");
    });

    test("maps supported mime types to deterministic extensions", () => {
        expect(getExtensionForMimeType("image/png")).toBe("png");
        expect(getExtensionForMimeType("image/jpeg")).toBe("jpg");
        expect(getExtensionForMimeType("image/gif")).toBe("gif");
        expect(getExtensionForMimeType("image/webp")).toBe("webp");
        expect(getExtensionForMimeType("image/svg+xml")).toBe("svg");
        expect(getExtensionForMimeType("image/tiff")).toBe("tiff");
        expect(getExtensionForMimeType("application/octet-stream")).toBe("bin");
    });
});

describe("describeOCRImages", () => {
    test("describes duplicate image content once and maps the result to every image id", async () => {
        const content = new Uint8Array([1, 2, 3]);
        const describeImage = mock(async (image: { id: string }) => ` Description for ${image.id} `);

        const descriptions = await describeOCRImages(
            [
                { id: "img-1", type: "image/png", content },
                { id: "img-2", type: "image/png", content: content.slice() },
            ],
            {} as never,
            { describeImage }
        );

        expect(describeImage).toHaveBeenCalledTimes(1);
        expect(descriptions).toEqual(
            new Map([
                ["img-1", "Description for img-1"],
                ["img-2", "Description for img-1"],
            ])
        );
    });
});
