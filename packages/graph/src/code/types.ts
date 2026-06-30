export type TreeSitterLanguage = unknown;

export type TreeSitterPoint = {
    row: number;
    column: number;
};

export type TreeSitterNode = {
    type: string;
    text: string;
    startIndex: number;
    endIndex: number;
    startPosition: TreeSitterPoint;
    endPosition: TreeSitterPoint;
    namedChildCount: number;
    parent: TreeSitterNode | null;
    namedChild: (index: number) => TreeSitterNode | null;
    childForFieldName: (name: string) => TreeSitterNode | null;
};

export type TreeSitterTree = {
    rootNode: TreeSitterNode;
};

export type TreeSitterParser = {
    setLanguage: (language: TreeSitterLanguage) => void;
    parse: (source: string) => TreeSitterTree | null;
};

export type CodeLanguage = "javascript" | "typescript" | "tsx" | "rust" | "zig" | "c";

export type ImportResolutionMode = "relative" | "zig" | "rust" | "c-local" | "external";

export type CodeRepositoryFile = {
    fileId: string;
    repositoryUrl: string;
    repositoryName: string;
    commitSha: string;
    branch?: string;
    defaultBranch?: string;
    path: string;
    content: string;
};

export type CodeManifestFile = {
    fileId: string;
    repositoryUrl: string;
    repositoryName: string;
    commitSha: string;
    path: string;
    language: CodeLanguage;
    entityId: string;
};

export type CodeManifestDefinition = {
    entityId: string;
    fileId: string;
    path: string;
    repositoryUrl: string;
    repositoryName: string;
    commitSha: string;
    simpleName: string;
    qualifiedName: string;
    type: string;
};

export type CodeManifestExport = CodeManifestDefinition & {
    exportedName: string;
    exportedPath: string;
};

export type CodeRepositoryManifest = {
    files: CodeManifestFile[];
    definitions: CodeManifestDefinition[];
    exports: CodeManifestExport[];
};

export type ParsedCodeFile = CodeRepositoryFile & {
    language: CodeLanguage;
    root: TreeSitterNode;
};

export type Definition = CodeManifestDefinition & {
    node: TreeSitterNode;
    parentQualifiedName?: string;
};

export type ImportBinding = {
    imported: string;
    local: string;
};

export type ImportRecord = {
    node: TreeSitterNode;
    specifier: string;
    resolutionMode: ImportResolutionMode;
    defaultImport?: string;
    namespaceImport?: string;
    namedImports: ImportBinding[];
    importAllDefinitions?: boolean;
};

export type ExportRecord =
    | {
          node: TreeSitterNode;
          kind: "local";
          exportedName: string;
          localName: string;
      }
    | {
          node: TreeSitterNode;
          kind: "reexport";
          exportedName: string;
          importedName: string;
          specifier: string;
          resolutionMode: ImportResolutionMode;
      }
    | {
          node: TreeSitterNode;
          kind: "export-all";
          specifier: string;
          resolutionMode: ImportResolutionMode;
      };
