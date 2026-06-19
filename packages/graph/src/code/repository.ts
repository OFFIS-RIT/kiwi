import path from "node:path";
import type { Entity, Graph, Relationship, Source, TextUnitSourceChunk, Unit } from "..";
import { definitionKey, entityName, fileEntityId, fileEntityName, stableId } from "./identity";
import { buildManifestExports, collectImports, parseHeritage, resolveImportTargetPath } from "./imports";
import { parseCodeFile } from "./parser";
import { callName, collectDefinitions, nodeSnippet, spanSize, walk } from "./syntax";
import type {
    CodeManifestDefinition,
    CodeManifestExport,
    CodeManifestFile,
    CodeRepositoryFile,
    CodeRepositoryManifest,
    Definition,
    ImportRecord,
    ParsedCodeFile,
    TreeSitterNode,
} from "./types";

export { isSupportedCodePath } from "./file-path";
export type { CodeManifestDefinition, CodeManifestFile, CodeRepositoryFile, CodeRepositoryManifest } from "./types";

export function buildCodeRepositoryManifest(files: CodeRepositoryFile[]): CodeRepositoryManifest {
    const parsedFiles = files.flatMap(parseCodeFile);
    const manifestFiles = parsedFiles.map((file) => manifestFile(file));
    const definitions = parsedFiles.flatMap((file) =>
        collectDefinitions(file).map(({ node: _node, ...definition }) => definition)
    );
    const exports = buildManifestExports(parsedFiles, manifestFiles, definitions);

    return {
        files: manifestFiles,
        definitions,
        exports,
    };
}

export function buildCodeFileGraph(file: CodeRepositoryFile, manifest: CodeRepositoryManifest): Graph {
    const parsed = parseCodeFile(file)[0];
    if (!parsed) {
        return {
            id: stableId("code_graph", file.repositoryUrl, file.commitSha, file.path),
            units: [],
            entities: [],
            relationships: [],
        };
    }

    return new CodeFileGraphBuilder(parsed, manifest).build();
}

class CodeFileGraphBuilder {
    private readonly units: Unit[] = [];
    private readonly entitiesById = new Map<string, Entity>();
    private readonly relationshipsById = new Map<string, Relationship>();
    private readonly definitions: Definition[];
    private readonly definitionsBySimpleName: Map<string, Definition>;
    private readonly manifestFilesByPath: Map<string, CodeManifestFile>;
    private readonly manifestDefinitionsByPathAndName: Map<string, CodeManifestDefinition>;
    private readonly manifestDefinitionsByPath: Map<string, CodeManifestDefinition[]>;
    private readonly manifestExportsByPathAndName: Map<string, CodeManifestExport>;
    private readonly importTargetsByLocalName = new Map<string, Entity>();
    private readonly namespaceImportPathsByLocalName = new Map<string, string>();
    private readonly externalNamespaceImportSpecifiersByLocalName = new Map<string, string>();
    private readonly wildcardExternalImportSpecifiers = new Set<string>();
    private fileEntity!: Entity;

    constructor(
        private readonly file: ParsedCodeFile,
        manifest: CodeRepositoryManifest
    ) {
        this.definitions = collectDefinitions(file);
        this.definitionsBySimpleName = new Map(
            this.definitions.map((definition) => [definition.simpleName, definition])
        );
        this.manifestFilesByPath = new Map(manifest.files.map((file) => [file.path, file]));
        this.manifestDefinitionsByPathAndName = new Map(
            manifest.definitions.map((definition) => [
                definitionKey(definition.path, definition.simpleName),
                definition,
            ])
        );
        this.manifestDefinitionsByPath = new Map<string, CodeManifestDefinition[]>();
        for (const definition of manifest.definitions) {
            const definitions = this.manifestDefinitionsByPath.get(definition.path) ?? [];
            definitions.push(definition);
            this.manifestDefinitionsByPath.set(definition.path, definitions);
        }
        this.manifestExportsByPathAndName = new Map(
            (manifest.exports ?? []).map((entry) => [definitionKey(entry.exportedPath, entry.exportedName), entry])
        );
    }

    build(): Graph {
        this.fileEntity = this.addEntity({
            id: fileEntityId(this.file.repositoryUrl, this.file.commitSha, this.file.path),
            name: fileEntityName(this.file),
            type: "CODE_FILE",
            source: this.sourceFor({
                description: `Source file ${this.file.path} in ${this.file.repositoryName} at ${this.file.commitSha}.`,
                text: this.file.path,
            }),
        });

        for (const definition of this.definitions) {
            this.addDefinition(definition);
        }

        this.indexImports();
        this.indexCallsAndHeritage();

        return {
            id: stableId("code_graph", this.file.repositoryUrl, this.file.commitSha, this.file.path),
            units: this.units,
            entities: [...this.entitiesById.values()],
            relationships: [...this.relationshipsById.values()],
        };
    }

    private addDefinition(definition: Definition) {
        const entity = this.addEntity({
            id: definition.entityId,
            name: entityName(definition),
            type: definition.type,
            source: this.sourceFor({
                node: definition.node,
                description: [
                    `Defines ${definition.type.toLowerCase()} ${definition.qualifiedName} in ${this.file.path}.`,
                    nodeSnippet(this.file, definition.node),
                ].join("\n\n"),
            }),
        });

        const parent = definition.parentQualifiedName
            ? this.definitions.find((candidate) => candidate.qualifiedName === definition.parentQualifiedName)
            : undefined;

        this.addRelationship({
            source: parent ? this.entityForManifestDefinition(parent) : this.fileEntity,
            target: entity,
            kind: "CONTAINS",
            strength: 1,
            node: definition.node,
            description: parent
                ? `${parent.qualifiedName} contains ${definition.qualifiedName}.`
                : `${this.file.path} contains ${definition.qualifiedName}.`,
        });
    }

    private indexImports() {
        for (const importRecord of collectImports(this.file.root, this.file.language)) {
            const targetPath = resolveImportTargetPath(importRecord, this.file.path, this.manifestFilesByPath);
            const targetFile = targetPath ? this.manifestFilesByPath.get(targetPath) : undefined;
            const targetEntity = targetFile
                ? this.fileEntityForManifest(targetFile)
                : this.externalModuleEntity(importRecord);

            this.addRelationship({
                source: this.fileEntity,
                target: targetEntity,
                kind: "IMPORTS",
                strength: 0.9,
                node: importRecord.node,
                description: `${this.file.path} imports ${importRecord.specifier}.`,
            });

            if (!targetPath) {
                if (importRecord.importAllDefinitions) {
                    this.wildcardExternalImportSpecifiers.add(importRecord.specifier);
                }

                for (const binding of importRecord.namedImports) {
                    this.importTargetsByLocalName.set(
                        binding.local,
                        this.externalSymbolEntity(importRecord.specifier, binding.imported, importRecord.node)
                    );
                }

                if (importRecord.defaultImport) {
                    this.importTargetsByLocalName.set(
                        importRecord.defaultImport,
                        this.externalSymbolEntity(importRecord.specifier, "default", importRecord.node)
                    );
                    this.externalNamespaceImportSpecifiersByLocalName.set(
                        importRecord.defaultImport,
                        importRecord.specifier
                    );
                }

                if (importRecord.namespaceImport) {
                    this.importTargetsByLocalName.set(importRecord.namespaceImport, targetEntity);
                    this.externalNamespaceImportSpecifiersByLocalName.set(
                        importRecord.namespaceImport,
                        importRecord.specifier
                    );
                }
                continue;
            }

            if (importRecord.importAllDefinitions) {
                for (const definition of this.manifestDefinitionsByPath.get(targetPath) ?? []) {
                    this.importTargetsByLocalName.set(
                        definition.simpleName,
                        this.entityForManifestDefinition(definition)
                    );
                }
            }

            for (const binding of importRecord.namedImports) {
                const targetDefinition = this.resolveImportedDefinition(targetPath, binding.imported);
                if (targetDefinition) {
                    this.importTargetsByLocalName.set(
                        binding.local,
                        this.entityForManifestDefinition(targetDefinition)
                    );
                }
            }

            if (importRecord.defaultImport) {
                const defaultTarget = this.resolveImportedDefinition(targetPath, "default");
                this.importTargetsByLocalName.set(
                    importRecord.defaultImport,
                    defaultTarget ? this.entityForManifestDefinition(defaultTarget) : targetEntity
                );
            }

            if (importRecord.namespaceImport) {
                this.namespaceImportPathsByLocalName.set(importRecord.namespaceImport, targetPath);
                this.importTargetsByLocalName.set(importRecord.namespaceImport, targetEntity);
            }
        }
    }

    private indexCallsAndHeritage() {
        walk(this.file.root, (node) => {
            if (node.type === "call_expression") {
                this.collectCall(node);
                return;
            }

            if (node.type === "class_declaration" || node.type === "interface_declaration") {
                this.collectHeritage(node);
            }
        });
    }

    private collectCall(node: TreeSitterNode) {
        const callerDefinition = this.enclosingDefinition(node);
        const caller = callerDefinition ? this.entityForManifestDefinition(callerDefinition) : this.fileEntity;
        const calleeName = callName(node);
        if (!calleeName) {
            return;
        }

        const target = this.resolveCallee(callerDefinition ?? null, calleeName);
        if (!target) {
            return;
        }

        this.addRelationship({
            source: caller,
            target,
            kind: "CALLS",
            strength: 0.8,
            node,
            description: `${caller.name} calls ${target.name}.`,
        });
    }

    private collectHeritage(node: TreeSitterNode) {
        const sourceDefinition = this.enclosingDefinition(node);
        if (!sourceDefinition) {
            return;
        }

        for (const heritage of parseHeritage(node.text)) {
            const target = this.resolveName(heritage.name);
            if (!target) {
                continue;
            }

            this.addRelationship({
                source: this.entityForManifestDefinition(sourceDefinition),
                target,
                kind: heritage.kind,
                strength: 0.9,
                node,
                description: `${entityName(sourceDefinition)} ${heritage.kind.toLowerCase()} ${target.name}.`,
            });
        }
    }

    private resolveCallee(caller: Definition | null, name: string): Entity | null {
        if (name.includes(".")) {
            const segments = name.split(".");
            const objectName = segments[0];
            const memberPath = segments.slice(1).join(".");
            const finalName = segments.at(-1);

            if ((objectName === "this" || objectName === "self") && finalName && caller) {
                const className = caller.qualifiedName.split(".").at(0);
                const method = this.definitions.find(
                    (definition) => definition.qualifiedName === `${className}.${finalName}`
                );
                if (method) {
                    return this.entityForManifestDefinition(method);
                }
            }

            if (this.file.language === "rust") {
                const rustTarget = this.resolveRustQualifiedCallee(name, finalName);
                if (rustTarget) {
                    return rustTarget;
                }
            }

            if (objectName && finalName) {
                const namespacePath = this.namespaceImportPathsByLocalName.get(objectName);
                if (namespacePath) {
                    const importedDefinition = this.resolveImportedDefinition(namespacePath, finalName);
                    if (importedDefinition) {
                        return this.entityForManifestDefinition(importedDefinition);
                    }
                }

                const externalSpecifier = this.externalNamespaceImportSpecifiersByLocalName.get(objectName);
                if (externalSpecifier && memberPath) {
                    return this.externalSymbolEntity(externalSpecifier, memberPath);
                }
            }

            return objectName ? (this.importTargetsByLocalName.get(objectName) ?? null) : null;
        }

        return this.resolveName(name);
    }

    private resolveName(name: string): Entity | null {
        const definition = this.definitionsBySimpleName.get(name);
        if (definition) {
            return this.entityForManifestDefinition(definition);
        }

        const imported = this.importTargetsByLocalName.get(name);
        if (imported) {
            return imported;
        }

        if (this.wildcardExternalImportSpecifiers.size === 1) {
            return this.externalSymbolEntity([...this.wildcardExternalImportSpecifiers][0]!, name);
        }

        return null;
    }

    private resolveImportedDefinition(
        targetPath: string,
        importedName: string
    ): CodeManifestDefinition | CodeManifestExport | null {
        return (
            this.manifestExportsByPathAndName.get(definitionKey(targetPath, importedName)) ??
            this.manifestDefinitionsByPathAndName.get(definitionKey(targetPath, importedName)) ??
            null
        );
    }

    private enclosingDefinition(node: TreeSitterNode): Definition | null {
        return (
            this.definitions
                .filter(
                    (definition) =>
                        definition.node.startIndex <= node.startIndex && definition.node.endIndex >= node.endIndex
                )
                .sort((left, right) => spanSize(left.node) - spanSize(right.node))[0] ?? null
        );
    }

    private entityForManifestDefinition(definition: CodeManifestDefinition): Entity {
        return this.addEntity({
            id: definition.entityId,
            name: entityName(definition),
            type: definition.type,
        });
    }

    private fileEntityForManifest(file: CodeManifestFile): Entity {
        return this.addEntity({
            id: file.entityId,
            name: fileEntityName(file),
            type: "CODE_FILE",
        });
    }

    private externalModuleEntity(importRecord: ImportRecord): Entity {
        return this.addEntity({
            id: stableId("code_external", this.file.repositoryUrl, this.file.commitSha, importRecord.specifier),
            name: `${this.file.repositoryName}:external:${importRecord.specifier}`,
            type: "CODE_EXTERNAL_MODULE",
            source: this.sourceFor({
                node: importRecord.node,
                description: `External module ${importRecord.specifier} imported by ${this.file.path}.`,
            }),
        });
    }
    private externalSymbolEntity(specifier: string, symbolName: string, node?: TreeSitterNode): Entity {
        return this.addEntity({
            id: stableId("code_external_symbol", this.file.repositoryUrl, this.file.commitSha, specifier, symbolName),
            name: `${this.file.repositoryName}:external:${specifier}#${symbolName}`,
            type: "CODE_EXTERNAL_SYMBOL",
            ...(node
                ? {
                      source: this.sourceFor({
                          node,
                          description: `External symbol ${symbolName} from ${specifier} referenced by ${this.file.path}.`,
                      }),
                  }
                : {}),
        });
    }

    private resolveRustQualifiedCallee(name: string, finalName: string | undefined): Entity | null {
        if (!finalName) {
            return null;
        }

        const pathPrefix = name.slice(0, -(finalName.length + 1));
        const targetPath = this.resolveRustQualifiedTargetPath(pathPrefix);
        if (!targetPath) {
            return null;
        }

        const targetDefinition = this.resolveImportedDefinition(targetPath, finalName);
        return targetDefinition ? this.entityForManifestDefinition(targetDefinition) : null;
    }

    private resolveRustQualifiedTargetPath(pathPrefix: string): string | null {
        if (!pathPrefix) {
            return null;
        }

        if (pathPrefix.startsWith("crate::") || pathPrefix.startsWith("self::") || pathPrefix.startsWith("super::")) {
            return resolveImportTargetPath(
                { specifier: pathPrefix, resolutionMode: "rust" },
                this.file.path,
                this.manifestFilesByPath
            );
        }

        const [rootSegment, ...nestedSegments] = pathPrefix.split("::");
        if (!rootSegment) {
            return null;
        }

        const basePath = this.namespaceImportPathsByLocalName.get(rootSegment);
        if (!basePath) {
            return null;
        }

        return this.resolveRustNestedModulePath(basePath, nestedSegments);
    }

    private resolveRustNestedModulePath(basePath: string, nestedSegments: string[]): string | null {
        let currentPath = basePath;
        for (const segment of nestedSegments) {
            const moduleDirectory =
                path.posix.basename(currentPath) === "mod.rs"
                    ? path.posix.dirname(currentPath)
                    : path.posix.join(path.posix.dirname(currentPath), path.posix.basename(currentPath, ".rs"));
            const candidateBase = path.posix.join(moduleDirectory, segment);
            const nextPath =
                [candidateBase, `${candidateBase}.rs`, path.posix.join(candidateBase, "mod.rs")].find((candidate) =>
                    this.manifestFilesByPath.has(candidate)
                ) ?? null;
            if (!nextPath) {
                return null;
            }
            currentPath = nextPath;
        }

        return currentPath;
    }

    private addEntity(input: { id: string; name: string; type: string; source?: Source }): Entity {
        const existing = this.entitiesById.get(input.id);
        if (existing) {
            if (input.source && !existing.sources.some((source) => source.id === input.source?.id)) {
                existing.sources.push(input.source);
            }
            return existing;
        }

        const entity = {
            id: input.id,
            name: input.name,
            type: input.type,
            description: "",
            sources: input.source ? [input.source] : [],
        } satisfies Entity;
        this.entitiesById.set(entity.id, entity);
        return entity;
    }

    private addRelationship(input: {
        source: Entity;
        target: Entity;
        kind: string;
        strength: number;
        node: TreeSitterNode;
        description: string;
    }) {
        const id = stableId(
            "code_relationship",
            this.file.repositoryUrl,
            this.file.commitSha,
            this.file.path,
            input.kind,
            input.source.id,
            input.target.id,
            String(input.node.startIndex),
            String(input.node.endIndex)
        );
        const source = this.sourceFor({
            node: input.node,
            description: input.description,
        });
        const existing = this.relationshipsById.get(id);
        if (existing) {
            if (!existing.sources.some((candidate) => candidate.id === source.id)) {
                existing.sources.push(source);
            }
            existing.strength = Math.max(existing.strength, input.strength);
            return existing;
        }

        const relationship = {
            id,
            sourceId: input.source.id,
            targetId: input.target.id,
            kind: input.kind,
            directed: true,
            strength: input.strength,
            description: "",
            sources: [source],
        } satisfies Relationship;
        this.relationshipsById.set(relationship.id, relationship);
        return relationship;
    }

    private sourceFor(input: { node?: TreeSitterNode; description: string; text?: string }): Source {
        const unit = this.unitFor(input.node, input.text);
        return {
            id: stableId("code_source", unit.id, input.description),
            unitId: unit.id,
            description: input.description,
            sourceChunkIds: [1],
        };
    }

    private unitFor(node?: TreeSitterNode, text?: string): Unit {
        const content = text ?? (node ? nodeSnippet(this.file, node) : this.file.path);
        const id = stableId(
            "code_unit",
            this.file.repositoryUrl,
            this.file.commitSha,
            this.file.path,
            String(node?.startIndex ?? 0),
            String(node?.endIndex ?? 0),
            content
        );
        const existing = this.units.find((unit) => unit.id === id);
        if (existing) {
            return existing;
        }

        const chunk = {
            id: 1,
            type: "text",
            text: content,
            startPage: null,
            endPage: null,
            filePath: this.file.path,
            language: this.file.language,
            ...(node
                ? {
                      startLine: node.startPosition.row + 1,
                      endLine: node.endPosition.row + 1,
                      startColumn: node.startPosition.column + 1,
                      endColumn: node.endPosition.column + 1,
                  }
                : {}),
        } satisfies TextUnitSourceChunk;
        const unit = {
            id,
            fileId: this.file.fileId,
            content,
            startPage: null,
            endPage: null,
            chunks: [chunk],
        } satisfies Unit;
        this.units.push(unit);
        return unit;
    }
}

function manifestFile(file: ParsedCodeFile): CodeManifestFile {
    return {
        fileId: file.fileId,
        repositoryUrl: file.repositoryUrl,
        repositoryName: file.repositoryName,
        commitSha: file.commitSha,
        path: file.path,
        language: file.language,
        entityId: fileEntityId(file.repositoryUrl, file.commitSha, file.path),
    };
}
