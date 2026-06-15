import path from "node:path";

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".rs", ".zig", ".c", ".h"]);

export function isSupportedCodePath(filePath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}
