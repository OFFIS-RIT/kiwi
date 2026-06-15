const SUPPORTED_CODE_EXTENSIONS: Record<string, true> = {
    ".js": true,
    ".jsx": true,
    ".ts": true,
    ".tsx": true,
    ".mts": true,
    ".cts": true,
};

export function isSupportedCodePath(filePath: string): boolean {
    const normalized = filePath.replaceAll("\\", "/");
    const lastSlash = normalized.lastIndexOf("/");
    const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
    const extensionStart = fileName.lastIndexOf(".");
    if (extensionStart < 0) {
        return false;
    }

    return SUPPORTED_CODE_EXTENSIONS[fileName.slice(extensionStart).toLowerCase()] === true;
}
