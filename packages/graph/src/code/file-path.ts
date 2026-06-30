import path from "node:path";

const SUPPORTED_EXTENSIONS = new Set([
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".rs",
    ".zig",
    ".c",
    ".h",
    ".java",
    ".kt",
    ".kts",
    ".py",
    ".pyi",
    ".pyw",
    ".go",
    ".cc",
    ".cpp",
    ".cxx",
    ".c++",
    ".hh",
    ".hpp",
    ".hxx",
    ".h++",
    ".cs",
    ".php",
    ".phtml",
    ".sh",
    ".bash",
    ".zsh",
]);

export function isSupportedCodePath(filePath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}
