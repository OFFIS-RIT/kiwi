import { deflateSync } from "node:zlib";
import type { PDFImageAsset, PDFRefLike, PDFStreamLike } from "./types";
import { JPEG_MIME_TYPE, PNG_MIME_TYPE, PNG_SIGNATURE } from "./constants";
import { isPDFArray, isPDFName, safelyDecodeStream } from "./geometry";

export function extractPDFImageAsset(stream: PDFStreamLike, resolver?: (ref: PDFRefLike) => unknown): PDFImageAsset {
    const filterNames = getPDFFilterNames(stream.get("Filter", resolver), resolver);

    if (filterNames[0] === "DCTDecode") {
        return { type: JPEG_MIME_TYPE, content: stream.data };
    }

    const decoded = safelyDecodeStream(stream);
    const detectedType = detectEncodedImageMimeType(decoded);
    if (detectedType) {
        return { type: detectedType, content: decoded };
    }

    const encodedType = detectEncodedImageMimeType(stream.data);
    if (encodedType) {
        return { type: encodedType, content: stream.data };
    }

    const png = encodeDecodedPDFImageAsPNG(stream, decoded, resolver);
    return { type: PNG_MIME_TYPE, content: png };
}

export function detectEncodedImageMimeType(bytes: Uint8Array): string | null {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        return JPEG_MIME_TYPE;
    }

    if (startsWithBytes(bytes, PNG_SIGNATURE)) {
        return PNG_MIME_TYPE;
    }

    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return "image/gif";
    }

    if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "image/webp";
    }

    return null;
}

export function encodeDecodedPDFImageAsPNG(
    stream: PDFStreamLike,
    decoded: Uint8Array,
    resolver?: (ref: PDFRefLike) => unknown
): Uint8Array {
    const width = stream.getNumber("Width", resolver)?.value;
    const height = stream.getNumber("Height", resolver)?.value;
    const bitsPerComponent = stream.getNumber("BitsPerComponent", resolver)?.value ?? 8;

    if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0
    ) {
        return decoded;
    }

    const colorSpace = getColorSpaceName(stream.get("ColorSpace", resolver), resolver);
    const rgb = decodedPDFImageToRGB(
        decoded,
        width,
        height,
        bitsPerComponent,
        colorSpace,
        isImageMask(stream, resolver)
    );
    if (!rgb) {
        return decoded;
    }

    return encodeRGBPNG(width, height, rgb);
}

export function decodedPDFImageToRGB(
    decoded: Uint8Array,
    width: number,
    height: number,
    bitsPerComponent: number,
    colorSpace: string | null,
    imageMask: boolean
): Uint8Array | null {
    const pixelCount = width * height;

    if (imageMask || bitsPerComponent === 1) {
        const output = new Uint8Array(pixelCount * 3);
        for (let index = 0; index < pixelCount; index += 1) {
            const byte = decoded[index >> 3] ?? 0;
            const bit = (byte >> (7 - (index % 8))) & 1;
            const value = imageMask ? (bit === 1 ? 0 : 255) : bit * 255;
            output[index * 3] = value;
            output[index * 3 + 1] = value;
            output[index * 3 + 2] = value;
        }
        return output;
    }

    if (bitsPerComponent !== 8) {
        return null;
    }

    if (colorSpace === "DeviceGray" || decoded.length === pixelCount) {
        const output = new Uint8Array(pixelCount * 3);
        for (let index = 0; index < pixelCount; index += 1) {
            const value = decoded[index] ?? 0;
            output[index * 3] = value;
            output[index * 3 + 1] = value;
            output[index * 3 + 2] = value;
        }
        return output;
    }

    if (colorSpace === "DeviceCMYK" || decoded.length >= pixelCount * 4) {
        const output = new Uint8Array(pixelCount * 3);
        for (let index = 0; index < pixelCount; index += 1) {
            const source = index * 4;
            const c = decoded[source] ?? 0;
            const m = decoded[source + 1] ?? 0;
            const y = decoded[source + 2] ?? 0;
            const k = decoded[source + 3] ?? 0;
            output[index * 3] = Math.round(((255 - c) * (255 - k)) / 255);
            output[index * 3 + 1] = Math.round(((255 - m) * (255 - k)) / 255);
            output[index * 3 + 2] = Math.round(((255 - y) * (255 - k)) / 255);
        }
        return output;
    }

    if (colorSpace === "DeviceRGB" || decoded.length >= pixelCount * 3) {
        return decoded.slice(0, pixelCount * 3);
    }

    return null;
}

export function getColorSpaceName(value: unknown, resolver?: (ref: PDFRefLike) => unknown): string | null {
    if (isPDFName(value)) {
        return value.value;
    }

    if (!isPDFArray(value)) {
        return null;
    }

    const first = value.at(0, resolver);
    return isPDFName(first) ? first.value : null;
}

export function isImageMask(stream: PDFStreamLike, resolver?: (ref: PDFRefLike) => unknown): boolean {
    const value = stream.get("ImageMask", resolver);
    return value === true || value === "true";
}

export function encodeRGBPNG(width: number, height: number, rgb: Uint8Array): Uint8Array {
    const stride = width * 3;
    const scanlines = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const targetOffset = y * (stride + 1);
        const sourceOffset = y * stride;
        scanlines[targetOffset] = 0;
        scanlines.set(rgb.subarray(sourceOffset, sourceOffset + stride), targetOffset + 1);
    }

    return joinBytes([
        PNG_SIGNATURE,
        createPNGChunk("IHDR", createPNGHeader(width, height)),
        createPNGChunk("IDAT", deflateSync(scanlines)),
        createPNGChunk("IEND", new Uint8Array()),
    ]);
}

export function createPNGHeader(width: number, height: number): Uint8Array {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 2;
    return header;
}

export function createPNGChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const chunk = new Uint8Array(4 + typeBytes.length + data.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
}

export function joinBytes(chunks: Uint8Array[]): Uint8Array {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

export function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
    if (bytes.length < prefix.length) {
        return false;
    }

    return prefix.every((byte, index) => bytes[index] === byte);
}

export function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

export function getPDFFilterNames(value: unknown, resolver?: (ref: PDFRefLike) => unknown): string[] {
    if (isPDFName(value)) {
        return [value.value];
    }

    if (!isPDFArray(value)) {
        return [];
    }

    const names: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const entry = value.at(index, resolver);
        if (isPDFName(entry)) {
            names.push(entry.value);
        }
    }

    return names;
}
