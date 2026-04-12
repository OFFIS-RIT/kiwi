import { describe, expect, mock, test } from "bun:test";

import { getExtensionForMimeType, processOCRImages } from "../ocr-image";

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
            { bucket: "bucket", imagePrefix: "graphs/g-1/derived/f-1/images" },
            { describeImage, uploadImage }
        );

        expect(output).toContain(
            '<image id="img-1" key="graphs/g-1/derived/f-1/images/img-1.png">Chart &lt;A&gt; &amp; &quot;B&quot;</image>'
        );
        expect(output).toContain('<image id="img-2" key="graphs/g-1/derived/f-1/images/img-2.webp">Diagram 2</image>');
        expect(output).not.toMatch(/:::IMG-img-/);
        expect(uploadImage).toHaveBeenCalledTimes(2);
        expect(uploadedNames.sort()).toEqual(["img-1.png", "img-2.webp"]);
        expect(uploadImage).toHaveBeenCalledWith(expect.any(String), expect.any(Uint8Array), {
            bucket: "bucket",
            imagePrefix: "graphs/g-1/derived/f-1/images",
        });
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
