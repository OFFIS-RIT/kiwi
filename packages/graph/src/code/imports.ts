import path from "node:path";
import { definitionKey } from "./identity";
import type {
    CodeManifestDefinition,
    CodeManifestExport,
    CodeManifestFile,
    CodeLanguage,
    ExportRecord,
    ImportBinding,
    ImportRecord,
    ImportResolutionMode,
    ParsedCodeFile,
    TreeSitterNode,
} from "./types";
import { childForField, fieldText, walk } from "./syntax";

const ECMASCRIPT_RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"];
const ZIG_RESOLVE_EXTENSIONS = [".zig"];

export function collectImports(root: TreeSitterNode, language: CodeLanguage): ImportRecord[] {
    switch (language) {
        case "javascript":
        case "typescript":
        case "tsx":
            return collectEcmaScriptImports(root);
        case "rust":
            return collectRustImports(root);
        case "zig":
            return collectZigImports(root);
        case "c":
            return collectCImports(root);
    }
}

export function collectExports(file: ParsedCodeFile): ExportRecord[] {
    if (!isEcmaScriptLanguage(file.language)) {
        return [];
    }

    const exports: ExportRecord[] = [];
    walk(file.root, (node) => {
        if (node.type !== "export_statement") {
            return;
        }

        exports.push(...parseExportStatement(node));
    });
    return exports;
}

export function buildManifestExports(
    files: ParsedCodeFile[],
    manifestFiles: CodeManifestFile[],
    definitions: CodeManifestDefinition[]
): CodeManifestExport[] {
    const filesByPath = new Map(manifestFiles.map((file) => [file.path, file]));
    const definitionsByPathAndName = new Map(
        definitions.map((definition) => [definitionKey(definition.path, definition.simpleName), definition])
    );
    const rawExportsByPath = new Map(files.map((file) => [file.path, collectExports(file)]));
    const cache = new Map<string, CodeManifestExport[]>();

    const resolveExportedDefinition = (filePath: string, exportedName: string, stack: Set<string>) => {
        const exportMatch = resolveFileExports(filePath, stack).find((entry) => entry.exportedName === exportedName);
        if (exportMatch) {
            return exportMatch;
        }

        return definitionsByPathAndName.get(definitionKey(filePath, exportedName)) ?? null;
    };

    const resolveFileExports = (filePath: string, stack: Set<string>): CodeManifestExport[] => {
        const cached = cache.get(filePath);
        if (cached) {
            return cached;
        }

        if (stack.has(filePath)) {
            return [];
        }
        stack.add(filePath);

        const resolved = new Map<string, CodeManifestExport>();
        for (const record of rawExportsByPath.get(filePath) ?? []) {
            if (record.kind === "local") {
                const definition = definitionsByPathAndName.get(definitionKey(filePath, record.localName));
                if (definition) {
                    resolved.set(record.exportedName, {
                        ...definition,
                        exportedName: record.exportedName,
                        exportedPath: filePath,
                    });
                }
                continue;
            }

            const targetPath = resolveImportTargetPath(
                {
                    specifier: record.specifier,
                    resolutionMode: record.resolutionMode,
                },
                filePath,
                filesByPath
            );
            if (!targetPath) {
                continue;
            }

            if (record.kind === "reexport") {
                const definition = resolveExportedDefinition(targetPath, record.importedName, stack);
                if (definition) {
                    resolved.set(record.exportedName, {
                        ...definition,
                        exportedName: record.exportedName,
                        exportedPath: filePath,
                    });
                }
                continue;
            }

            for (const definition of resolveFileExports(targetPath, stack)) {
                if (definition.exportedName === "default") {
                    continue;
                }
                resolved.set(definition.exportedName, {
                    ...definition,
                    exportedPath: filePath,
                });
            }
        }

        const exports = [...resolved.values()];
        cache.set(filePath, exports);
        stack.delete(filePath);
        return exports;
    };

    for (const file of files) {
        resolveFileExports(file.path, new Set());
    }

    return [...cache.values()].flat();
}

export function importLocalNames(importRecord: ImportRecord): string[] {
    return [
        ...importRecord.namedImports.map((binding) => binding.local),
        ...(importRecord.defaultImport ? [importRecord.defaultImport] : []),
        ...(importRecord.namespaceImport ? [importRecord.namespaceImport] : []),
    ];
}

export function parseHeritage(text: string): Array<{ kind: "EXTENDS" | "IMPLEMENTS"; name: string }> {
    const items: Array<{ kind: "EXTENDS" | "IMPLEMENTS"; name: string }> = [];
    const head = text.split("{")[0] ?? text;
    const extendsMatch = head.match(/\bextends\s+([A-Za-z_$][\w$]*)/u)?.[1];
    if (extendsMatch) items.push({ kind: "EXTENDS", name: extendsMatch });

    const implementsMatch = head.match(/\bimplements\s+([^{}]+)/u)?.[1];
    if (implementsMatch) {
        for (const implemented of implementsMatch.split(",")) {
            const name = implemented.trim().match(/^([A-Za-z_$][\w$]*)/u)?.[1];
            if (name) items.push({ kind: "IMPLEMENTS", name });
        }
    }

    return items;
}

export function resolveImportTargetPath(
    importRecord: Pick<ImportRecord, "specifier" | "resolutionMode">,
    currentFilePath: string,
    filesByPath: ReadonlyMap<string, CodeManifestFile>
): string | null {
    switch (importRecord.resolutionMode) {
        case "relative":
            return resolveRelativeImportPath(importRecord.specifier, currentFilePath, filesByPath, ECMASCRIPT_RESOLVE_EXTENSIONS);
        case "zig":
            return resolveRelativeImportPath(importRecord.specifier, currentFilePath, filesByPath, ZIG_RESOLVE_EXTENSIONS);
        case "c-local":
            return resolveLocalIncludePath(importRecord.specifier, currentFilePath, filesByPath);
        case "rust":
            return resolveRustImportPath(importRecord.specifier, currentFilePath, filesByPath);
        case "external":
            return null;
    }
}

function collectEcmaScriptImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type !== "import_statement") return;
        const parsed = parseImportStatement(node);
        if (parsed) imports.push(parsed);
    });
    return imports;
}

function collectRustImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type === "mod_item") {
            const moduleName = fieldText(node, "name");
            if (moduleName) {
                imports.push({
                    node,
                    specifier: `self::${moduleName}`,
                    resolutionMode: "rust",
                    namespaceImport: moduleName,
                    namedImports: [],
                });
            }
            return;
        }

        if (node.type !== "use_declaration") {
            return;
        }

        imports.push(...parseRustUseDeclaration(node));
    });
    return imports;
}

function collectZigImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type !== "variable_declaration") {
            return;
        }

        const localName = node.namedChild(0)?.text;
        const builtin = node.namedChild(1);
        const specifier = builtin ? zigImportSpecifier(builtin) : null;
        if (!localName || !specifier) {
            return;
        }

        imports.push({
            node,
            specifier,
            resolutionMode: specifier.endsWith(".zig") ? "zig" : "external",
            namespaceImport: localName,
            namedImports: [],
        });
    });
    return imports;
}

function collectCImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type !== "preproc_include") {
            return;
        }

        const rawPath = childForField(node, "path")?.text ?? "";
        if (!rawPath) {
            return;
        }

        const isLocalInclude = rawPath.startsWith("\"");
        imports.push({
            node,
            specifier: unquote(rawPath),
            resolutionMode: isLocalInclude ? "c-local" : "external",
            namedImports: [],
            importAllDefinitions: true,
        });
    });
    return imports;
}

function parseImportStatement(node: TreeSitterNode): ImportRecord | null {
    const specifier = parseStringSpecifier(node);
    if (!specifier) return null;
    const defaultImport = collectDefaultImport(node);
    const namespaceImport = collectNamespaceImport(node);

    return {
        node,
        specifier,
        resolutionMode: specifier.startsWith(".") ? "relative" : "external",
        namedImports: collectNamedImports(node),
        ...(defaultImport ? { defaultImport } : {}),
        ...(namespaceImport ? { namespaceImport } : {}),
    };
}

function parseExportStatement(node: TreeSitterNode): ExportRecord[] {
    const declaration = childForField(node, "declaration");
    if (declaration) {
        const names = collectDeclarationNames(declaration);
        if (node.text.startsWith("export default ")) {
            const localName = names[0];
            return localName
                ? [
                      {
                          node,
                          kind: "local",
                          exportedName: "default",
                          localName,
                      },
                  ]
                : [];
        }

        return names.map((localName) => ({
            node,
            kind: "local" as const,
            exportedName: localName,
            localName,
        }));
    }

    const value = childForField(node, "value");
    if (value?.type === "identifier" && node.text.startsWith("export default ")) {
        return [
            {
                node,
                kind: "local",
                exportedName: "default",
                localName: value.text,
            },
        ];
    }

    const specifier = parseStringSpecifier(node);
    const exportClause = namedChildren(node).find((child) => child.type === "export_clause");
    if (exportClause && specifier) {
        return collectExportClauseBindings(exportClause).map((binding) => ({
            node,
            kind: "reexport" as const,
            exportedName: binding.local,
            importedName: binding.imported,
            specifier,
            resolutionMode: specifier.startsWith(".") ? "relative" : "external",
        }));
    }

    if (exportClause) {
        return collectExportClauseBindings(exportClause).map((binding) => ({
            node,
            kind: "local" as const,
            exportedName: binding.local,
            localName: binding.imported,
        }));
    }

    return specifier
        ? [
              {
                  node,
                  kind: "export-all",
                  specifier,
                  resolutionMode: specifier.startsWith(".") ? "relative" : "external",
              },
          ]
        : [];
}

function parseRustUseDeclaration(node: TreeSitterNode): ImportRecord[] {
    const argument = childForField(node, "argument");
    if (!argument) {
        return [];
    }

    if (argument.type === "scoped_use_list") {
        const basePath = childForField(argument, "path")?.text;
        const useList = namedChildren(argument).find((child) => child.type === "use_list");
        if (!basePath || !useList) {
            return [];
        }

        return namedChildren(useList).flatMap((child) => {
            if (child.type === "use_as_clause") {
                return parseRustFlatUse(node, childForField(child, "path")?.text, fieldText(child, "alias"), basePath);
            }
            return parseRustFlatUse(node, child.text, undefined, basePath);
        });
    }

    if (argument.type === "use_as_clause") {
        return parseRustFlatUse(node, childForField(argument, "path")?.text, fieldText(argument, "alias"));
    }

    return parseRustFlatUse(node, argument.text);
}

function parseRustFlatUse(
    node: TreeSitterNode,
    pathText: string | undefined,
    alias?: string | null,
    basePath?: string
): ImportRecord[] {
    if (!pathText) {
        return [];
    }

    const fullPath = basePath ? `${basePath}::${pathText}` : pathText;
    const segments = fullPath.split("::").filter(Boolean);
    if (segments.length === 0) {
        return [];
    }

    const resolutionMode = rustResolutionMode(segments[0] ?? "");
    const lastSegment = segments.at(-1);
    if (!lastSegment) {
        return [];
    }

    if (resolutionMode === "external" && segments.length >= 2) {
        return [
            {
                node,
                specifier: segments.slice(0, -1).join("::"),
                resolutionMode,
                namedImports: [{ imported: lastSegment, local: alias ?? lastSegment }],
            },
        ];
    }

    if (segments.length >= 3) {
        return [
            {
                node,
                specifier: segments.slice(0, -1).join("::"),
                resolutionMode,
                namedImports: [{ imported: lastSegment, local: alias ?? lastSegment }],
            },
        ];
    }

    return [
        {
            node,
            specifier: fullPath,
            resolutionMode,
            namespaceImport: alias ?? lastSegment,
            namedImports: [],
        },
    ];
}

function parseStringSpecifier(node: TreeSitterNode): string | null {
    const source = childForField(node, "source")?.text;
    return source ? unquote(source) : null;
}

function collectNamedImports(node: TreeSitterNode): ImportBinding[] {
    const imports: ImportBinding[] = [];
    walk(node, (candidate) => {
        if (candidate.type !== "import_specifier") {
            return;
        }

        const imported = fieldText(candidate, "name") ?? candidate.text.split(/\s+as\s+/u)[0]?.trim();
        const local = fieldText(candidate, "alias") ?? candidate.text.split(/\s+as\s+/u)[1]?.trim() ?? imported;
        if (imported && local) {
            imports.push({ imported: imported.replace(/^type\s+/u, ""), local });
        }
    });
    return imports;
}

function collectExportClauseBindings(node: TreeSitterNode): ImportBinding[] {
    const bindings: ImportBinding[] = [];
    walk(node, (candidate) => {
        if (candidate.type !== "export_specifier") {
            return;
        }

        const imported = fieldText(candidate, "name") ?? candidate.text.split(/\s+as\s+/u)[0]?.trim();
        const local = fieldText(candidate, "alias") ?? candidate.text.split(/\s+as\s+/u)[1]?.trim() ?? imported;
        if (imported && local) {
            bindings.push({ imported, local });
        }
    });
    return bindings;
}

function collectDeclarationNames(node: TreeSitterNode): string[] {
    if (node.type === "function_declaration" || node.type === "class_declaration") {
        const name = fieldText(node, "name");
        return name ? [name] : [];
    }

    const names: string[] = [];
    walk(node, (candidate) => {
        if (candidate.type === "variable_declarator") {
            const name = fieldText(candidate, "name");
            if (name) {
                names.push(name);
            }
        }
    });
    return names;
}

function collectDefaultImport(node: TreeSitterNode): string | undefined {
    const clause = namedChildren(node).find((child) => child.type === "import_clause");
    if (!clause) return undefined;

    for (let index = 0; index < clause.namedChildCount; index += 1) {
        const child = clause.namedChild(index);
        if (child?.type === "identifier") {
            return child.text;
        }
    }

    return undefined;
}

function collectNamespaceImport(node: TreeSitterNode): string | undefined {
    let namespaceImport: string | undefined;
    walk(node, (candidate) => {
        if (candidate.type === "namespace_import") {
            namespaceImport = fieldText(candidate, "name") ?? candidate.namedChild(0)?.text ?? undefined;
        }
    });
    return namespaceImport;
}

function zigImportSpecifier(node: TreeSitterNode): string | null {
    if (node.type !== "builtin_function" || node.namedChild(0)?.text !== "@import") {
        return null;
    }

    const argumentList = node.namedChild(1);
    const stringNode = argumentList?.namedChild(0);
    return stringNode ? unquote(stringNode.text) : null;
}

function resolveRelativeImportPath(
    specifier: string,
    currentFilePath: string,
    filesByPath: ReadonlyMap<string, CodeManifestFile>,
    extensions: readonly string[]
): string | null {
    const basePath = path.posix.normalize(path.posix.join(path.posix.dirname(currentFilePath), specifier));
    const candidates = dedupePaths([
        basePath,
        ...extensions.map((extension) => (basePath.endsWith(extension) ? basePath : `${basePath}${extension}`)),
        ...extensions.map((extension) => path.posix.join(basePath, `index${extension}`)),
    ]);

    return candidates.find((candidate) => filesByPath.has(candidate)) ?? null;
}

function resolveLocalIncludePath(
    specifier: string,
    currentFilePath: string,
    filesByPath: ReadonlyMap<string, CodeManifestFile>
): string | null {
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(currentFilePath), specifier));
    return filesByPath.has(candidate) ? candidate : null;
}

function resolveRustImportPath(
    specifier: string,
    currentFilePath: string,
    filesByPath: ReadonlyMap<string, CodeManifestFile>
): string | null {
    const segments = specifier.split("::").filter(Boolean);
    if (segments.length === 0) {
        return null;
    }

    let baseDirectory = rustModuleDirectory(currentFilePath);
    if (segments[0] === "crate") {
        baseDirectory = rustCrateRootDirectory(currentFilePath);
        segments.shift();
    } else if (segments[0] === "self") {
        segments.shift();
    } else if (segments[0] === "super") {
        while (segments[0] === "super") {
            baseDirectory = path.posix.dirname(baseDirectory);
            segments.shift();
        }
        if (segments[0] === "self") {
            segments.shift();
        }
    } else {
        return null;
    }

    if (segments.length === 0) {
        return null;
    }

    const modulePath = path.posix.join(baseDirectory, ...segments);
    const candidates = [`${modulePath}.rs`, path.posix.join(modulePath, "mod.rs")];
    return candidates.find((candidate) => filesByPath.has(candidate)) ?? null;
}

function rustCrateRootDirectory(currentFilePath: string) {
    const segments = currentFilePath.split("/");
    const sourceIndex = segments.lastIndexOf("src");
    if (sourceIndex === -1) {
        return path.posix.dirname(currentFilePath);
    }
    return segments.slice(0, sourceIndex + 1).join("/");
}

function rustModuleDirectory(currentFilePath: string) {
    const baseName = path.posix.basename(currentFilePath);
    if (baseName === "main.rs" || baseName === "lib.rs" || baseName === "mod.rs") {
        return path.posix.dirname(currentFilePath);
    }
    return path.posix.join(path.posix.dirname(currentFilePath), path.posix.basename(currentFilePath, ".rs"));
}

function rustResolutionMode(segment: string): ImportResolutionMode {
    return segment === "crate" || segment === "self" || segment === "super" ? "rust" : "external";
}

function isEcmaScriptLanguage(language: CodeLanguage) {
    return language === "javascript" || language === "typescript" || language === "tsx";
}

function namedChildren(node: TreeSitterNode): TreeSitterNode[] {
    const children: TreeSitterNode[] = [];
    for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (child) {
            children.push(child);
        }
    }
    return children;
}

function dedupePaths(paths: string[]) {
    return [...new Set(paths)];
}

function unquote(value: string): string {
    return value.replace(/^['"<]|[>'"]$/gu, "");
}
