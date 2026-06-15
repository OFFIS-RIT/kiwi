import { createRequire } from "node:module";
import path from "node:path";
import type { CodeLanguage, CodeRepositoryFile, ParsedCodeFile, TreeSitterLanguage, TreeSitterParser } from "./types";

const require = createRequire(import.meta.url);
const Parser = require("tree-sitter") as { new (): TreeSitterParser };
const C = require("tree-sitter-c") as TreeSitterLanguage;
const JavaScript = require("tree-sitter-javascript") as TreeSitterLanguage;
const Rust = require("tree-sitter-rust") as TreeSitterLanguage;
const TypeScript = require("tree-sitter-typescript") as {
    typescript: TreeSitterLanguage;
    tsx: TreeSitterLanguage;
};
const Zig = require("@tree-sitter-grammars/tree-sitter-zig") as TreeSitterLanguage;

export function parseCodeFile(file: CodeRepositoryFile): ParsedCodeFile[] {
    const language = detectCodeLanguage(file.path);
    if (!language) {
        return [];
    }

    const parser = new Parser();
    parser.setLanguage(languageGrammar(language));
    const tree = parser.parse(file.content);
    if (!tree) {
        return [];
    }

    return [{ ...file, language, root: tree.rootNode }];
}

function detectCodeLanguage(filePath: string): CodeLanguage | null {
    switch (path.posix.extname(filePath).toLowerCase()) {
        case ".js":
            return "javascript";
        case ".jsx":
        case ".tsx":
            return "tsx";
        case ".ts":
        case ".mts":
        case ".cts":
            return "typescript";
        case ".rs":
            return "rust";
        case ".zig":
            return "zig";
        case ".c":
        case ".h":
            return "c";
        default:
            return null;
    }
}

function languageGrammar(language: CodeLanguage): TreeSitterLanguage {
    switch (language) {
        case "javascript":
            return JavaScript;
        case "tsx":
            return TypeScript.tsx;
        case "typescript":
            return TypeScript.typescript;
        case "rust":
            return Rust;
        case "zig":
            return Zig;
        case "c":
            return C;
    }
}
