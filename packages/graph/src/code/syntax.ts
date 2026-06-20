import type { Definition, ParsedCodeFile, TreeSitterNode } from "./types";
import { stableId } from "./identity";

export function collectDefinitions(file: ParsedCodeFile): Definition[] {
    const definitions: Definition[] = [];

    walk(file.root, (node) => {
        const definition = definitionFromNode(file, node);
        if (definition) {
            definitions.push(definition);
        }
    });

    return definitions;
}

export function walk(node: TreeSitterNode, visit: (node: TreeSitterNode) => void) {
    visit(node);
    for (const child of namedChildren(node)) {
        walk(child, visit);
    }
}

export function childForField(node: TreeSitterNode, fieldName: string): TreeSitterNode | null {
    return node.childForFieldName(fieldName);
}

export function fieldText(node: TreeSitterNode, fieldName: string): string | null {
    return childForField(node, fieldName)?.text ?? null;
}

export function spanSize(node: TreeSitterNode) {
    return node.endIndex - node.startIndex;
}

export function nodeSnippet(file: ParsedCodeFile, node: TreeSitterNode): string {
    return file.content.slice(node.startIndex, node.endIndex).trimEnd();
}

export function callName(node: TreeSitterNode): string | null {
    const callee = childForField(node, "function");
    if (!callee) return null;
    if (callee.type === "identifier" || callee.type === "field_identifier" || callee.type === "property_identifier") {
        return callee.text;
    }

    return memberLikeName(callee);
}

function definitionFromNode(file: ParsedCodeFile, node: TreeSitterNode): Definition | null {
    switch (node.type) {
        case "function_declaration":
        case "generator_function_declaration": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "function_signature": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "function_signature_item":
        case "function_item": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            const parentQualifiedName =
                node.type === "function_signature_item"
                    ? enclosingRustTraitName(node)
                    : enclosingRustImplTypeName(node);
            return parentQualifiedName
                ? definition(
                      file,
                      node,
                      simpleName,
                      `${parentQualifiedName}.${simpleName}`,
                      "CODE_METHOD",
                      parentQualifiedName
                  )
                : definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "function_definition": {
            const simpleName = cFunctionName(node);
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "declaration": {
            const simpleName = cFunctionName(node);
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "class_declaration": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_CLASS");
        }
        case "struct_item": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_CLASS");
        }
        case "interface_declaration":
        case "trait_item": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_INTERFACE");
        }
        case "type_alias_declaration": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_TYPE");
        }
        case "method_definition": {
            const simpleName = fieldText(node, "name");
            const className = enclosingClassName(node);
            if (!simpleName || !className) return null;
            return definition(file, node, simpleName, `${className}.${simpleName}`, "CODE_METHOD", className);
        }
        case "variable_declarator": {
            const value = childForField(node, "value");
            if (!value || !["arrow_function", "function", "class"].includes(value.type)) {
                return null;
            }

            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(
                file,
                node,
                simpleName,
                simpleName,
                value.type === "class" ? "CODE_CLASS" : "CODE_FUNCTION"
            );
        }
        default:
            return null;
    }
}

function definition(
    file: ParsedCodeFile,
    node: TreeSitterNode,
    simpleName: string,
    qualifiedName: string,
    type: string,
    parentQualifiedName?: string
): Definition {
    return {
        entityId: stableId("code_entity", file.repositoryUrl, file.commitSha, file.path, qualifiedName),
        fileId: file.fileId,
        path: file.path,
        repositoryUrl: file.repositoryUrl,
        repositoryName: file.repositoryName,
        commitSha: file.commitSha,
        simpleName,
        qualifiedName,
        type,
        node,
        ...(parentQualifiedName ? { parentQualifiedName } : {}),
    };
}

function namedChildren(node: TreeSitterNode): TreeSitterNode[] {
    const children: TreeSitterNode[] = [];
    for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (child) children.push(child);
    }
    return children;
}

function memberLikeName(node: TreeSitterNode): string | null {
    if (node.type === "member_expression") {
        const object = childForField(node, "object")?.text ?? node.namedChild(0)?.text;
        const property = childForField(node, "property")?.text ?? node.namedChild(1)?.text;
        return object && property ? `${object}.${property}` : (property ?? null);
    }

    if (node.type === "field_expression") {
        const object =
            childForField(node, "object")?.text ?? childForField(node, "value")?.text ?? node.namedChild(0)?.text;
        const property =
            childForField(node, "property")?.text ?? childForField(node, "field")?.text ?? node.namedChild(1)?.text;
        return object && property ? `${object}.${property}` : (property ?? null);
    }

    if (node.type === "scoped_identifier") {
        const object = childForField(node, "path")?.text ?? node.namedChild(0)?.text;
        const property = childForField(node, "name")?.text ?? node.namedChild(1)?.text;
        return object && property ? `${object}.${property}` : (property ?? null);
    }

    return null;
}

function cFunctionName(node: TreeSitterNode): string | null {
    const declarator = childForField(node, "declarator");
    const functionDeclarator = findNodeByType(declarator, "function_declarator");
    if (!functionDeclarator) {
        return null;
    }

    return fieldText(functionDeclarator, "declarator") ?? firstIdentifier(functionDeclarator);
}

function findNodeByType(node: TreeSitterNode | null, type: string): TreeSitterNode | null {
    if (!node) {
        return null;
    }
    if (node.type === type) {
        return node;
    }

    for (const child of namedChildren(node)) {
        const match = findNodeByType(child, type);
        if (match) {
            return match;
        }
    }

    return null;
}

function firstIdentifier(node: TreeSitterNode): string | null {
    if (node.type === "identifier" || node.type === "field_identifier" || node.type === "type_identifier") {
        return node.text;
    }

    for (const child of namedChildren(node)) {
        const match = firstIdentifier(child);
        if (match) {
            return match;
        }
    }

    return null;
}

function enclosingClassName(node: TreeSitterNode): string | null {
    let current = node.parent;
    while (current) {
        if (current.type === "class_declaration") {
            return fieldText(current, "name");
        }
        current = current.parent;
    }
    return null;
}

function enclosingRustImplTypeName(node: TreeSitterNode): string | null {
    let current = node.parent;
    while (current) {
        if (current.type === "impl_item") {
            return fieldText(current, "type");
        }
        current = current.parent;
    }
    return null;
}

function enclosingRustTraitName(node: TreeSitterNode): string | null {
    let current = node.parent;
    while (current) {
        if (current.type === "trait_item") {
            return fieldText(current, "name");
        }
        current = current.parent;
    }
    return null;
}
