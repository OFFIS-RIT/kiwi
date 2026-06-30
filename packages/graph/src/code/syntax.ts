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
    if (
        node.type === "method_invocation" ||
        node.type === "member_call_expression" ||
        node.type === "nullsafe_member_call_expression"
    ) {
        const rawObject = fieldText(node, "object");
        const object = rawObject === "$this" ? "this" : rawObject;
        const name = fieldText(node, "name");
        return object && name ? `${object}.${name}` : (name ?? null);
    }

    if (node.type === "scoped_call_expression") {
        const scope = childForField(node, "scope")?.text ?? node.namedChild(0)?.text;
        const name = fieldText(node, "name");
        return scope && name ? `${scope}.${name}` : (name ?? null);
    }

    if (node.type === "new_expression") {
        const constructor = childForField(node, "constructor") ?? node.namedChild(0);
        return constructor ? (memberLikeName(constructor) ?? firstIdentifier(constructor)) : null;
    }

    if (node.type === "object_creation_expression" || node.type === "constructor_invocation") {
        return firstIdentifier(node);
    }

    if (node.type === "macro_invocation") {
        return fieldText(node, "macro") ?? firstIdentifier(node);
    }

    if (node.type === "command") {
        return firstIdentifier(childForField(node, "name") ?? node) ?? null;
    }

    const callee = childForField(node, "function") ?? node.namedChild(0);
    if (!callee) return null;
    if (
        callee.type === "identifier" ||
        callee.type === "field_identifier" ||
        callee.type === "property_identifier" ||
        callee.type === "name" ||
        callee.type === "word"
    ) {
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
            const className = file.language === "kotlin" || file.language === "zig" ? enclosingClassName(node) : null;
            return className
                ? definition(file, node, simpleName, `${className}.${simpleName}`, "CODE_METHOD", className)
                : definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "function_signature": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            const className = enclosingClassName(node);
            return className
                ? definition(file, node, simpleName, `${className}.${simpleName}`, "CODE_METHOD", className)
                : definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "method_signature":
        case "abstract_method_signature":
        case "method_elem": {
            const simpleName = fieldText(node, "name");
            const className = enclosingClassName(node);
            if (!simpleName || !className) return null;
            return definition(file, node, simpleName, `${className}.${simpleName}`, "CODE_METHOD", className);
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
            const simpleName =
                file.language === "python" || file.language === "bash" || file.language === "php"
                    ? fieldText(node, "name")
                    : cFunctionName(node);
            if (!simpleName) return null;
            const className =
                file.language === "python" || file.language === "cpp" || file.language === "php"
                    ? (enclosingClassName(node) ?? cQualifiedFunctionParent(node))
                    : null;
            return className
                ? definition(file, node, simpleName, `${className}.${simpleName}`, "CODE_METHOD", className)
                : definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "declaration": {
            const simpleName = cFunctionName(node);
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_FUNCTION");
        }
        case "constructor_declaration":
        case "compact_constructor_declaration":
        case "primary_constructor":
        case "secondary_constructor": {
            const className = enclosingClassName(node);
            if (!className) return null;
            return definition(file, node, "constructor", `${className}.constructor`, "CODE_METHOD", className);
        }
        case "class_declaration":
        case "abstract_class_declaration":
        case "class_definition":
        case "class_specifier":
        case "struct_specifier":
        case "struct_declaration":
        case "record_declaration":
        case "annotation_type_declaration":
        case "object_declaration": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_CLASS");
        }
        case "union_specifier": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_UNION");
        }
        case "enum_declaration":
        case "enum_item":
        case "enum_specifier": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_ENUM");
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
        case "trait_declaration": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_TRAIT");
        }
        case "type_spec": {
            const simpleName = fieldText(node, "name");
            const type = childForField(node, "type");
            if (!simpleName || !type) return null;
            if (type.type === "struct_type") return definition(file, node, simpleName, simpleName, "CODE_CLASS");
            if (type.type === "interface_type") return definition(file, node, simpleName, simpleName, "CODE_INTERFACE");
            return definition(file, node, simpleName, simpleName, "CODE_TYPE");
        }
        case "type_alias_declaration":
        case "type_alias_statement":
        case "type_item":
        case "type_alias":
        case "type_definition":
        case "alias_declaration":
        case "concept_definition": {
            const rawName =
                fieldText(node, "name") ??
                fieldText(node, "left") ??
                fieldText(node, "declarator") ??
                firstIdentifier(node);
            const simpleName = simpleIdentifierName(rawName);
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_TYPE");
        }
        case "macro_definition":
        case "preproc_function_def":
        case "preproc_def": {
            const simpleName = fieldText(node, "name") ?? firstIdentifier(node);
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_MACRO");
        }
        case "const_item":
        case "static_item": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_CONSTANT");
        }
        case "package_clause":
        case "package_header":
        case "package_declaration":
        case "namespace_definition":
        case "file_scoped_namespace_declaration":
        case "namespace_declaration":
        case "mod_item": {
            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(file, node, simpleName, simpleName, "CODE_MODULE");
        }
        case "test_declaration": {
            const simpleName = zigTestName(node);
            return definition(file, node, simpleName, simpleName, "CODE_TEST");
        }
        case "method_definition":
        case "method_declaration": {
            const simpleName = fieldText(node, "name");
            const className = file.language === "go" ? goReceiverTypeName(node) : enclosingClassName(node);
            if (!simpleName || !className) return null;
            return definition(file, node, simpleName, `${className}.${simpleName}`, "CODE_METHOD", className);
        }
        case "public_field_definition":
        case "field_definition": {
            const value = childForField(node, "value");
            if (!value || !isFunctionValue(value)) return null;
            const simpleName = fieldText(node, "name");
            const className = enclosingClassName(node);
            if (!simpleName || !className) return null;
            return definition(file, node, simpleName, `${className}.${simpleName}`, "CODE_METHOD", className);
        }
        case "variable_declaration": {
            if (file.language !== "zig") return null;
            return zigVariableDefinition(file, node);
        }
        case "variable_declarator": {
            const value = childForField(node, "value");
            if (!value || (!isFunctionValue(value) && value.type !== "class" && value.type !== "class_expression")) {
                return null;
            }

            const simpleName = fieldText(node, "name");
            if (!simpleName) return null;
            return definition(
                file,
                node,
                simpleName,
                simpleName,
                value.type === "class" || value.type === "class_expression" ? "CODE_CLASS" : "CODE_FUNCTION"
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

    if (node.type === "scoped_identifier" || node.type === "qualified_identifier") {
        const object =
            childForField(node, "path")?.text ?? childForField(node, "scope")?.text ?? node.namedChild(0)?.text;
        const property = childForField(node, "name")?.text ?? node.namedChild(1)?.text;
        return object && property ? `${object}.${property}` : (property ?? null);
    }

    if (node.type === "navigation_expression") {
        const object = node.namedChild(0)?.text;
        const property = node.namedChild(1)?.text;
        return object && property ? `${object}.${property}` : (property ?? null);
    }

    if (node.type === "attribute") {
        const object = childForField(node, "object")?.text ?? node.namedChild(0)?.text;
        const property = childForField(node, "attribute")?.text ?? node.namedChild(1)?.text;
        return object && property ? `${object}.${property}` : (property ?? null);
    }

    if (
        node.type === "member_access_expression" ||
        node.type === "nullsafe_member_access_expression" ||
        node.type === "scoped_property_access_expression" ||
        node.type === "class_constant_access_expression"
    ) {
        const object =
            childForField(node, "expression")?.text ??
            childForField(node, "object")?.text ??
            childForField(node, "scope")?.text ??
            node.namedChild(0)?.text;
        const property =
            childForField(node, "name")?.text ??
            childForField(node, "property")?.text ??
            childForField(node, "field")?.text ??
            node.namedChild(1)?.text;
        return object && property ? `${object}.${property}` : (property ?? null);
    }

    if (node.type === "selector_expression") {
        const object = childForField(node, "operand")?.text ?? node.namedChild(0)?.text;
        const property = childForField(node, "field")?.text ?? node.namedChild(1)?.text;
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

    return simpleIdentifierName(fieldText(functionDeclarator, "declarator") ?? firstIdentifier(functionDeclarator));
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
    if (
        node.type === "identifier" ||
        node.type === "field_identifier" ||
        node.type === "type_identifier" ||
        node.type === "property_identifier" ||
        node.type === "name" ||
        node.type === "qualified_name" ||
        node.type === "relative_name" ||
        node.type === "namespace_name" ||
        node.type === "word"
    ) {
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
        if (
            current.type === "class_declaration" ||
            current.type === "abstract_class_declaration" ||
            current.type === "class_definition" ||
            current.type === "class_specifier" ||
            current.type === "struct_specifier" ||
            current.type === "struct_declaration" ||
            current.type === "record_declaration" ||
            current.type === "interface_declaration" ||
            current.type === "trait_declaration" ||
            current.type === "trait_item" ||
            current.type === "enum_declaration" ||
            current.type === "object_declaration"
        ) {
            return fieldText(current, "name");
        }
        if (current.type === "type_spec") {
            return fieldText(current, "name");
        }
        if (current.type === "variable_declaration") {
            const zigName = zigVariableDeclaratorName(current);
            if (zigName) return zigName;
        }
        current = current.parent;
    }
    return null;
}

function goReceiverTypeName(node: TreeSitterNode): string | null {
    return findNodeByType(childForField(node, "receiver"), "type_identifier")?.text ?? null;
}

function simpleIdentifierName(value: string | null): string | null {
    if (!value) return null;
    return (
        value
            .replace(/^[$\\]+/u, "")
            .split(/::|\.|\\/u)
            .at(-1)
            ?.replace(/^~/u, "")
            .trim() || null
    );
}

function isFunctionValue(node: TreeSitterNode): boolean {
    return (
        node.type === "arrow_function" ||
        node.type === "function" ||
        node.type === "function_expression" ||
        node.type === "generator_function" ||
        node.type === "generator_function_declaration" ||
        node.type === "anonymous_function" ||
        node.type === "arrow_function_expression"
    );
}

function zigVariableDefinition(file: ParsedCodeFile, node: TreeSitterNode): Definition | null {
    const simpleName = zigVariableDeclaratorName(node);
    if (!simpleName) return null;
    const value = zigVariableValue(node);
    if (!value) return null;

    switch (value.type) {
        case "struct_declaration":
        case "opaque_declaration":
            return definition(file, node, simpleName, simpleName, "CODE_CLASS");
        case "enum_declaration":
            return definition(file, node, simpleName, simpleName, "CODE_ENUM");
        case "union_declaration":
            return definition(file, node, simpleName, simpleName, "CODE_UNION");
        default:
            return null;
    }
}

function zigVariableDeclaratorName(node: TreeSitterNode): string | null {
    for (const child of namedChildren(node)) {
        if (child.type === "identifier") {
            return child.text;
        }
    }
    return null;
}

function zigVariableValue(node: TreeSitterNode): TreeSitterNode | null {
    return (
        namedChildren(node).find((child) =>
            ["struct_declaration", "enum_declaration", "union_declaration", "opaque_declaration"].includes(child.type)
        ) ?? null
    );
}

function zigTestName(node: TreeSitterNode): string {
    const named = namedChildren(node).find((child) => child.type === "identifier" || child.type === "string");
    return named ? `test:${named.text.replace(/^["']|["']$/gu, "")}` : `test:${node.startPosition.row + 1}`;
}

function cQualifiedFunctionParent(node: TreeSitterNode): string | null {
    const declarator = childForField(node, "declarator");
    const functionDeclarator = findNodeByType(declarator, "function_declarator");
    const declaratorText = fieldText(functionDeclarator ?? node, "declarator") ?? functionDeclarator?.text ?? "";
    const segments = declaratorText.split("::");
    return segments.length > 1 ? simpleIdentifierName(segments.at(-2) ?? null) : null;
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
