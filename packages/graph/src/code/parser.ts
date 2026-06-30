import { createRequire } from "node:module";
import path from "node:path";
import type { CodeLanguage, CodeRepositoryFile, ParsedCodeFile, TreeSitterLanguage, TreeSitterParser } from "./types";

const require = createRequire(import.meta.url);
const Parser = require("tree-sitter") as { new (): TreeSitterParser };
const C = require("tree-sitter-c") as TreeSitterLanguage;
const Bash = require("tree-sitter-bash") as TreeSitterLanguage;
const Java = require("tree-sitter-java") as TreeSitterLanguage;
const Cpp = require("tree-sitter-cpp") as TreeSitterLanguage;
const CSharp = require("tree-sitter-c-sharp") as TreeSitterLanguage;
const Go = require("tree-sitter-go") as TreeSitterLanguage;
const JavaScript = require("tree-sitter-javascript") as TreeSitterLanguage;
const Rust = require("tree-sitter-rust") as TreeSitterLanguage;
const Php = require("tree-sitter-php") as {
    php: TreeSitterLanguage;
};
const Python = require("tree-sitter-python") as TreeSitterLanguage;
const TypeScript = require("tree-sitter-typescript") as {
    typescript: TreeSitterLanguage;
    tsx: TreeSitterLanguage;
};
const Zig = require("@tree-sitter-grammars/tree-sitter-zig") as TreeSitterLanguage;
const Kotlin = require("@tree-sitter-grammars/tree-sitter-kotlin") as TreeSitterLanguage;

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
        case ".java":
            return "java";
        case ".kt":
        case ".kts":
            return "kotlin";
        case ".py":
        case ".pyi":
        case ".pyw":
            return "python";
        case ".go":
            return "go";
        case ".cc":
        case ".cpp":
        case ".cxx":
        case ".c++":
        case ".hh":
        case ".hpp":
        case ".hxx":
        case ".h++":
            return "cpp";
        case ".cs":
            return "csharp";
        case ".php":
        case ".phtml":
            return "php";
        case ".sh":
        case ".bash":
        case ".zsh":
            return "bash";
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
        case "java":
            return Java;
        case "kotlin":
            return Kotlin;
        case "python":
            return Python;
        case "go":
            return Go;
        case "cpp":
            return Cpp;
        case "csharp":
            return CSharp;
        case "php":
            return Php.php;
        case "bash":
            return Bash;
    }
}
