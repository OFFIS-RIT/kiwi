import { deflateSync, inflateSync } from "node:zlib";
import { PNG_SIGNATURE } from "./constants";

type PNGColorType = 0 | 2 | 4 | 6;

type PNGImage = {
    width: number;
    height: number;
    bitDepth: number;
    colorType: PNGColorType;
    bytesPerPixel: number;
    pixels: Uint8Array;
};

const PNG_COLOR_CHANNELS: Record<PNGColorType, number> = {
    0: 1,
    2: 3,
    4: 2,
    6: 4,
};

export type PNGRotation = 0 | 90 | 180 | 270;

export function rotatePNG(image: Uint8Array, rotation: PNGRotation): Uint8Array {
    if (rotation === 0) {
        return image;
    }

    const source = decodePNG(image);
    const rotated = rotatePNGPixels(source, rotation);
    return encodePNG(rotated);
}

function decodePNG(image: Uint8Array): PNGImage {
    if (!hasPNGSignature(image)) {
        throw new Error("Cannot rotate non-PNG OCR image");
    }

    let offset = PNG_SIGNATURE.length;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType: PNGColorType | null = null;
    let interlaceMethod = 0;
    const idatChunks: Uint8Array[] = [];

    while (offset + 12 <= image.length) {
        const length = readUInt32BE(image, offset);
        const type = ascii(image, offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > image.length) {
            throw new Error("Invalid PNG chunk length");
        }

        const data = image.subarray(dataStart, dataEnd);
        if (type === "IHDR") {
            width = readUInt32BE(data, 0);
            height = readUInt32BE(data, 4);
            bitDepth = data[8] ?? 0;
            const nextColorType = data[9] ?? 255;
            if (!isSupportedColorType(nextColorType)) {
                throw new Error(`Unsupported PNG color type ${nextColorType}`);
            }
            colorType = nextColorType;
            interlaceMethod = data[12] ?? 0;
        } else if (type === "IDAT") {
            idatChunks.push(data);
        } else if (type === "IEND") {
            break;
        }

        offset = dataEnd + 4;
    }

    if (width <= 0 || height <= 0 || colorType === null || idatChunks.length === 0) {
        throw new Error("Invalid PNG image");
    }
    if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
    }
    if (interlaceMethod !== 0) {
        throw new Error("Interlaced PNG OCR images are not supported");
    }

    const bytesPerPixel = PNG_COLOR_CHANNELS[colorType];
    const rowLength = width * bytesPerPixel;
    const compressed = concatBytes(idatChunks);
    const raw = inflateSync(compressed);
    const expectedLength = (rowLength + 1) * height;
    if (raw.length < expectedLength) {
        throw new Error("PNG image data is truncated");
    }

    const pixels = new Uint8Array(rowLength * height);
    let inputOffset = 0;
    for (let row = 0; row < height; row += 1) {
        const filter = raw[inputOffset++] ?? 0;
        const rowOffset = row * rowLength;
        const previousRowOffset = rowOffset - rowLength;
        for (let column = 0; column < rowLength; column += 1) {
            const rawValue = raw[inputOffset++] ?? 0;
            const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel]! : 0;
            const up = row > 0 ? pixels[previousRowOffset + column]! : 0;
            const upLeft = row > 0 && column >= bytesPerPixel ? pixels[previousRowOffset + column - bytesPerPixel]! : 0;
            pixels[rowOffset + column] = (rawValue + pngFilterPredictor(filter, left, up, upLeft)) & 0xff;
        }
    }

    return { width, height, bitDepth, colorType, bytesPerPixel, pixels };
}

function rotatePNGPixels(image: PNGImage, rotation: Exclude<PNGRotation, 0>): PNGImage {
    const width = rotation === 180 ? image.width : image.height;
    const height = rotation === 180 ? image.height : image.width;
    const pixels = new Uint8Array(width * height * image.bytesPerPixel);

    for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const { x: targetX, y: targetY } = rotatePixelCoordinate(x, y, image.width, image.height, rotation);
            const sourceOffset = (y * image.width + x) * image.bytesPerPixel;
            const targetOffset = (targetY * width + targetX) * image.bytesPerPixel;
            pixels.set(image.pixels.subarray(sourceOffset, sourceOffset + image.bytesPerPixel), targetOffset);
        }
    }

    return {
        ...image,
        width,
        height,
        pixels,
    };
}

function rotatePixelCoordinate(
    x: number,
    y: number,
    width: number,
    height: number,
    rotation: Exclude<PNGRotation, 0>
): { x: number; y: number } {
    switch (rotation) {
        case 90:
            return { x: height - 1 - y, y: x };
        case 180:
            return { x: width - 1 - x, y: height - 1 - y };
        case 270:
            return { x: y, y: width - 1 - x };
    }
}

function encodePNG(image: PNGImage): Uint8Array {
    const rowLength = image.width * image.bytesPerPixel;
    const raw = new Uint8Array((rowLength + 1) * image.height);
    let outputOffset = 0;
    for (let row = 0; row < image.height; row += 1) {
        raw[outputOffset++] = 0;
        const rowOffset = row * rowLength;
        raw.set(image.pixels.subarray(rowOffset, rowOffset + rowLength), outputOffset);
        outputOffset += rowLength;
    }

    const ihdr = new Uint8Array(13);
    writeUInt32BE(ihdr, 0, image.width);
    writeUInt32BE(ihdr, 4, image.height);
    ihdr[8] = image.bitDepth;
    ihdr[9] = image.colorType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return concatBytes([
        PNG_SIGNATURE,
        createPNGChunk("IHDR", ihdr),
        createPNGChunk("IDAT", deflateSync(raw)),
        createPNGChunk("IEND", new Uint8Array()),
    ]);
}

function pngFilterPredictor(filter: number, left: number, up: number, upLeft: number): number {
    switch (filter) {
        case 0:
            return 0;
        case 1:
            return left;
        case 2:
            return up;
        case 3:
            return Math.floor((left + up) / 2);
        case 4:
            return paethPredictor(left, up, upLeft);
        default:
            throw new Error(`Unsupported PNG filter ${filter}`);
    }
}

function paethPredictor(left: number, up: number, upLeft: number): number {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upLeftDistance = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
        return left;
    }
    if (upDistance <= upLeftDistance) {
        return up;
    }
    return upLeft;
}

function createPNGChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = Buffer.from(type, "ascii");
    const chunk = new Uint8Array(12 + data.length);
    writeUInt32BE(chunk, 0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    writeUInt32BE(chunk, 8 + data.length, crc32(concatBytes([typeBytes, data])));
    return chunk;
}

function hasPNGSignature(image: Uint8Array): boolean {
    return PNG_SIGNATURE.every((byte, index) => image[index] === byte);
}

function isSupportedColorType(value: number): value is PNGColorType {
    return value === 0 || value === 2 || value === 4 || value === 6;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
    return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function writeUInt32BE(bytes: Uint8Array, offset: number, value: number): void {
    new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value >>> 0, false);
}

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
});
