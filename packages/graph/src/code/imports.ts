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
const PYTHON_RESOLVE_EXTENSIONS = [".py", ".pyi", ".pyw"];
const BASH_RESOLVE_EXTENSIONS = [".sh", ".bash", ".zsh"];

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
        case "java":
            return collectJavaImports(root);
        case "kotlin":
            return collectKotlinImports(root);
        case "python":
            return collectPythonImports(root);
        case "go":
            return collectGoImports(root);
        case "cpp":
            return collectCImports(root);
        case "csharp":
            return collectCSharpImports(root);
        case "php":
            return collectPhpImports(root);
        case "bash":
            return collectBashImports(root);
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
                if (record.importedName === "*") {
                    const targetFile = filesByPath.get(targetPath);
                    if (targetFile) {
                        resolved.set(record.exportedName, {
                            entityId: targetFile.entityId,
                            fileId: targetFile.fileId,
                            path: targetFile.path,
                            repositoryUrl: targetFile.repositoryUrl,
                            repositoryName: targetFile.repositoryName,
                            commitSha: targetFile.commitSha,
                            simpleName: record.exportedName,
                            qualifiedName: record.exportedName,
                            type: "CODE_MODULE",
                            exportedName: record.exportedName,
                            exportedPath: filePath,
                        });
                    }
                    continue;
                }

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
    const seen = new Set<string>();
    const add = (kind: "EXTENDS" | "IMPLEMENTS", name: string | undefined) => {
        const normalized = normalizeHeritageName(name);
        if (!normalized) return;
        const key = `${kind}:${normalized}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ kind, name: normalized });
    };

    const extendsList = head.match(/\bextends\s+([^{}]+)/u)?.[1]?.split(/\bimplements\b/u)[0];
    if (extendsList) {
        for (const extended of extendsList.split(",")) {
            add("EXTENDS", extended);
        }
    }

    const implementsMatch = head.match(/\bimplements\s+([^{}]+)/u)?.[1];
    if (implementsMatch) {
        for (const implemented of implementsMatch.split(",")) {
            add("IMPLEMENTS", implemented);
        }
    }

    const pythonBases = head.match(/\bclass\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/u)?.[1];
    if (pythonBases) {
        for (const base of pythonBases.split(",")) {
            add("EXTENDS", base);
        }
    }

    const goStructBody = text.match(/(?:\btype\s+)?[A-Za-z_$][\w$]*\s+struct\s*\{([^}]*)\}/u)?.[1];
    if (goStructBody) {
        for (const line of goStructBody.split(/\r?\n/u)) {
            const embedded = line.trim().match(/^\*?([A-Za-z_$][\w$]*)\b/u)?.[1];
            if (embedded) {
                add("EXTENDS", embedded);
            }
        }
    }

    const colonBases = head.match(
        /\b(?:class|struct|record|interface)\s+[A-Za-z_$][\w$]*(?:\s*<[^>{}]*>)?[^:{]*:\s*([^{}]+)/u
    )?.[1];
    if (colonBases) {
        colonBases.split(",").forEach((base, index) => add(index === 0 ? "EXTENDS" : "IMPLEMENTS", base));
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
            return resolveRelativeImportPath(
                importRecord.specifier,
                currentFilePath,
                filesByPath,
                ECMASCRIPT_RESOLVE_EXTENSIONS
            );
        case "zig":
            return resolveRelativeImportPath(
                importRecord.specifier,
                currentFilePath,
                filesByPath,
                ZIG_RESOLVE_EXTENSIONS
            );
        case "python":
            return resolvePythonImportPath(importRecord.specifier, currentFilePath, filesByPath);
        case "bash":
            return resolveRelativeImportPath(
                importRecord.specifier,
                currentFilePath,
                filesByPath,
                BASH_RESOLVE_EXTENSIONS
            );
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
        if (node.type === "import_statement") {
            const parsed = parseImportStatement(node);
            if (parsed) imports.push(parsed);
            return;
        }

        if (node.type === "variable_declarator") {
            const parsed = parseRequireDeclarator(node);
            if (parsed) imports.push(parsed);
            return;
        }

        if (node.type === "call_expression" && node.parent?.type !== "variable_declarator") {
            const specifier = requireOrDynamicImportSpecifier(node);
            if (specifier) {
                imports.push({
                    node,
                    specifier,
                    resolutionMode: specifier.startsWith(".") ? "relative" : "external",
                    namedImports: [],
                });
            }
        }
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

        const isLocalInclude = rawPath.startsWith('"');
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

function collectPythonImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type === "import_statement") {
            imports.push(...parsePythonImportStatement(node));
            return;
        }

        if (node.type === "import_from_statement") {
            imports.push(...parsePythonFromImport(node));
        }
    });
    return imports;
}

function collectGoImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type !== "import_spec") {
            return;
        }

        const specifier = unquote(fieldText(node, "path") ?? "");
        if (!specifier) {
            return;
        }

        const importName = fieldText(node, "name");
        imports.push({
            node,
            specifier,
            resolutionMode: "external",
            namespaceImport:
                importName && importName !== "." && importName !== "_" ? importName : goImportLocalName(specifier),
            namedImports: [],
            importAllDefinitions: importName === ".",
        });
    });
    return imports;
}

function collectCSharpImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type !== "using_directive") {
            return;
        }

        const body = node.text
            .replace(/^using\s+/u, "")
            .replace(/;$/u, "")
            .trim();
        if (!body) {
            return;
        }

        if (body.startsWith("static ")) {
            imports.push({
                node,
                specifier: body.replace(/^static\s+/u, "").trim(),
                resolutionMode: "external",
                namedImports: [],
                importAllDefinitions: true,
            });
            return;
        }

        const [alias, specifier] = body.split(/\s*=\s*/u);
        const importSpecifier = specifier?.trim() ?? body;
        imports.push({
            node,
            specifier: importSpecifier,
            resolutionMode: "external",
            namespaceImport: specifier ? alias?.trim() : importSpecifier.split(".").at(-1),
            namedImports: [],
            importAllDefinitions: !specifier,
        });
    });
    return imports;
}

function collectPhpImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (
            node.type === "include_expression" ||
            node.type === "include_once_expression" ||
            node.type === "require_expression" ||
            node.type === "require_once_expression"
        ) {
            const specifier = firstQuotedString(node.text);
            if (specifier) {
                imports.push({
                    node,
                    specifier,
                    resolutionMode: specifier.startsWith(".") ? "relative" : "external",
                    namedImports: [],
                    importAllDefinitions: true,
                });
            }
            return;
        }

        if (node.type !== "namespace_use_declaration") {
            return;
        }

        const body = node.text
            .replace(/^use\s+(?:function\s+|const\s+)?/u, "")
            .replace(/;$/u, "")
            .trim();
        for (const segment of body.split(",")) {
            const [specifier, alias] = segment.trim().split(/\s+as\s+/iu);
            if (!specifier) {
                continue;
            }
            const local = alias?.trim() ?? specifier.split("\\").at(-1);
            imports.push({
                node,
                specifier,
                resolutionMode: "external",
                namespaceImport: local,
                namedImports: [],
            });
        }
    });
    return imports;
}

function collectBashImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type !== "command") {
            return;
        }

        const commandName = childForField(node, "name")?.text;
        if (commandName !== "source" && commandName !== ".") {
            return;
        }

        const specifier = unquote(childForField(node, "argument")?.text ?? "");
        if (!specifier) {
            return;
        }

        imports.push({
            node,
            specifier,
            resolutionMode: specifier.startsWith(".") ? "bash" : "external",
            namedImports: [],
            importAllDefinitions: true,
        });
    });
    return imports;
}

function parsePythonImportStatement(node: TreeSitterNode): ImportRecord[] {
    return node.text
        .replace(/^import\s+/u, "")
        .split(",")
        .map((segment) => parseAliasedImportSegment(segment.trim()))
        .filter((parsed): parsed is { specifier: string; local?: string } => Boolean(parsed?.specifier))
        .map(({ specifier, local }) => ({
            node,
            specifier,
            resolutionMode: "python" as const,
            namespaceImport: local ?? specifier.split(".")[0],
            namedImports: [],
        }));
}

function parsePythonFromImport(node: TreeSitterNode): ImportRecord[] {
    const [, moduleName, importList] = /^from\s+(.+?)\s+import\s+(.+)$/u.exec(node.text) ?? [];
    const specifier = moduleName?.trim();
    if (!specifier || !importList) {
        return [];
    }

    const parsedImports = importList
        .replace(/[()]/gu, "")
        .split(",")
        .map((segment) => parseAliasedImportSegment(segment.trim()))
        .filter((parsed): parsed is { specifier: string; local?: string } => Boolean(parsed?.specifier));

    if (/^\.+$/u.test(specifier)) {
        return parsedImports.map(({ specifier: imported, local }) => ({
            node,
            specifier: `${specifier}${imported}`,
            resolutionMode: "python" as const,
            namespaceImport: local ?? imported,
            namedImports: [],
        }));
    }

    if (importList.trim() === "*") {
        return [
            {
                node,
                specifier,
                resolutionMode: "python",
                namedImports: [],
                importAllDefinitions: true,
            },
        ];
    }

    return [
        {
            node,
            specifier,
            resolutionMode: "python",
            namedImports: parsedImports.map(({ specifier: imported, local }) => ({
                imported,
                local: local ?? imported,
            })),
        },
    ];
}

function parseAliasedImportSegment(segment: string): { specifier: string; local?: string } | null {
    const [specifier, alias] = segment.split(/\s+as\s+/iu);
    const trimmedSpecifier = specifier?.trim();
    if (!trimmedSpecifier) {
        return null;
    }
    return { specifier: trimmedSpecifier, ...(alias?.trim() ? { local: alias.trim() } : {}) };
}

function goImportLocalName(specifier: string): string {
    return (
        specifier
            .split("/")
            .at(-1)
            ?.replace(/\.git$/u, "") ?? specifier
    );
}

function collectJavaImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type !== "import_declaration") {
            return;
        }

        const specifier = node.text
            .replace(/^import\s+(?:static\s+)?/u, "")
            .replace(/;$/u, "")
            .trim();
        if (!specifier) {
            return;
        }

        imports.push(jvmImportRecord(node, specifier));
    });
    return imports;
}

function collectKotlinImports(root: TreeSitterNode): ImportRecord[] {
    const imports: ImportRecord[] = [];
    walk(root, (node) => {
        if (node.type !== "import") {
            return;
        }

        const [, body = ""] = /^import\s+(.+)$/u.exec(node.text) ?? [];
        const [specifier = "", alias] = body.split(/\s+as\s+/u);
        if (!specifier.trim()) {
            return;
        }

        imports.push(jvmImportRecord(node, specifier.trim(), alias?.trim()));
    });
    return imports;
}

function jvmImportRecord(node: TreeSitterNode, specifier: string, alias?: string): ImportRecord {
    const wildcardSuffix = ".*";
    if (specifier.endsWith(wildcardSuffix)) {
        return {
            node,
            specifier: specifier.slice(0, -wildcardSuffix.length),
            resolutionMode: "external",
            namedImports: [],
            importAllDefinitions: true,
        };
    }

    const imported = specifier.split(".").at(-1);
    return {
        node,
        specifier,
        resolutionMode: "external",
        namedImports: imported ? [{ imported, local: alias ?? imported }] : [],
    };
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

    const namespaceReExport = node.text.match(/export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/u);
    if (namespaceReExport) {
        const [, exportedName, namespaceSpecifier] = namespaceReExport;
        return namespaceSpecifier
            ? [
                  {
                      node,
                      kind: "reexport",
                      exportedName: exportedName ?? "default",
                      importedName: "*",
                      specifier: namespaceSpecifier,
                      resolutionMode: namespaceSpecifier.startsWith(".") ? "relative" : "external",
                  },
              ]
            : [];
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
    if (
        node.type === "function_declaration" ||
        node.type === "class_declaration" ||
        node.type === "abstract_class_declaration" ||
        node.type === "interface_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "type_alias_declaration"
    ) {
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

function parseRequireDeclarator(node: TreeSitterNode): ImportRecord | null {
    const value = childForField(node, "value");
    const specifier = value ? requireOrDynamicImportSpecifier(value) : null;
    if (!specifier) {
        return null;
    }

    const name = fieldText(node, "name");
    const base = {
        node,
        specifier,
        resolutionMode: specifier.startsWith(".") ? ("relative" as const) : ("external" as const),
    };
    if (!name) {
        return { ...base, namedImports: [] };
    }

    if (name.startsWith("{")) {
        return { ...base, namedImports: parseRequireObjectPattern(name) };
    }

    return { ...base, namespaceImport: name, namedImports: [] };
}

function requireOrDynamicImportSpecifier(node: TreeSitterNode): string | null {
    if (node.type !== "call_expression") {
        return null;
    }
    const callee = childForField(node, "function")?.text ?? node.namedChild(0)?.text;
    if (callee !== "require" && callee !== "import") {
        return null;
    }
    return firstQuotedString(node.text);
}

function parseRequireObjectPattern(pattern: string): ImportBinding[] {
    return pattern
        .replace(/[{}]/gu, "")
        .split(",")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .flatMap((segment) => {
            const [imported, local] = segment.split(/\s*:\s*/u);
            const importedName = imported?.trim();
            if (!importedName || importedName.startsWith("...")) {
                return [];
            }
            return [{ imported: importedName, local: local?.trim() || importedName }];
        });
}

function firstQuotedString(text: string): string | null {
    return /["']([^"']+)["']/u.exec(text)?.[1] ?? null;
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

function resolvePythonImportPath(
    specifier: string,
    currentFilePath: string,
    filesByPath: ReadonlyMap<string, CodeManifestFile>
): string | null {
    const leadingDots = specifier.match(/^\.+/u)?.[0] ?? "";
    const moduleName = specifier.slice(leadingDots.length);
    const modulePath = moduleName.replace(/\./gu, "/");
    const candidates: string[] = [];

    if (leadingDots) {
        let baseDirectory = path.posix.dirname(currentFilePath);
        for (let index = 1; index < leadingDots.length; index += 1) {
            baseDirectory = path.posix.dirname(baseDirectory);
        }
        const basePath = modulePath ? path.posix.join(baseDirectory, modulePath) : baseDirectory;
        candidates.push(...pythonModuleCandidates(basePath));
    } else {
        candidates.push(...pythonModuleCandidates(modulePath));
        const suffixes = pythonModuleCandidates(modulePath).map((candidate) => `/${candidate}`);
        for (const filePath of filesByPath.keys()) {
            if (suffixes.some((suffix) => filePath.endsWith(suffix))) {
                candidates.push(filePath);
            }
        }
    }

    const matches = dedupePaths(candidates).filter((candidate) => filesByPath.has(candidate));
    return matches.length === 1 ? (matches[0] ?? null) : null;
}

function pythonModuleCandidates(basePath: string): string[] {
    return [
        basePath,
        ...PYTHON_RESOLVE_EXTENSIONS.map((extension) =>
            basePath.endsWith(extension) ? basePath : `${basePath}${extension}`
        ),
        path.posix.join(basePath, "__init__.py"),
    ];
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

function normalizeHeritageName(value: string | undefined): string | null {
    const cleaned = value
        ?.trim()
        .replace(/\b(public|private|protected|virtual|override|final|open|abstract|sealed|internal)\b/gu, "")
        .replace(/\([^)]*\)/gu, "")
        .replace(/<[^>]*>/gu, "")
        .trim();
    if (!cleaned) return null;
    return (
        cleaned
            .split(/::|\.|\\/u)
            .at(-1)
            ?.match(/^[A-Za-z_$][\w$]*/u)?.[0] ?? null
    );
}

function dedupePaths(paths: string[]) {
    return [...new Set(paths)];
}

function unquote(value: string): string {
    return value.replace(/^['"<]|[>'"]$/gu, "");
}
