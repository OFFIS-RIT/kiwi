import type { GraphBinaryLoader, GraphLoader } from "..";
import { withAiSlot } from "@kiwi/ai/lock";
import { generateText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";

export class ImageLoader implements GraphLoader {
    constructor(
        private options: {
            loader: GraphBinaryLoader;
            model: LanguageModelV3;
        }
    ) {}

    async getText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        const mimeType = getImageMimeType(content);
        const base64 = Buffer.from(content).toString("base64");

        const { text } = await withAiSlot("image", () =>
            generateText({
                model: this.options.model,
                system: "",
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
}

function getImageMimeType(buffer: ArrayBuffer): string | null {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 12) return null;

    const matches = (offset: number, str: string): boolean => {
        if (offset + str.length > bytes.length) return false;
        for (let i = 0; i < str.length; i++) {
            if (bytes[offset + i] !== str.charCodeAt(i)) return false;
        }
        return true;
    };

    if (bytes[0] === 0x89 && matches(1, "PNG")) {
        return "image/png";
    }

    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }

    if (matches(0, "GIF8")) {
        return "image/gif";
    }

    if (matches(0, "RIFF") && matches(8, "WEBP")) {
        return "image/webp";
    }

    if (matches(0, "BM")) {
        return "image/bmp";
    }

    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
        return "image/x-icon";
    }

    if (
        (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    ) {
        return "image/tiff";
    }

    if (matches(4, "ftyp")) {
        if (bytes.length < 12) return null;
        const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
        if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) {
            return "image/heic";
        }
    }

    if (matches(4, "ftyp")) {
        if (matches(8, "avif") || matches(8, "avis")) {
            return "image/avif";
        }
    }

    try {
        const decoder = new TextDecoder();
        const text = decoder.decode(bytes.slice(0, 256));
        const trimmed = text.trim().toLowerCase();

        if (
            (trimmed.startsWith("<?xml") && trimmed.includes("<svg")) ||
            trimmed.startsWith("<svg") ||
            (trimmed.startsWith("<!--") && trimmed.includes("<svg"))
        ) {
            return "image/svg+xml";
        }
    } catch {
        // Not valid text, ignore
    }

    return null;
}
