import type { Relationships, XMLNodeLike } from "./types";
import { childElements, getAttribute } from "./xml";

const DEFAULT_RELATIONSHIP_ATTRIBUTE_NAMES = [
    "r:id",
    "id",
    "r:embed",
    "embed",
    "r:link",
    "link",
    "r:dm",
    "r:lo",
    "r:qs",
    "r:cs",
] as const;

export function findRelationshipByType(relationships: Relationships, type: string) {
    for (const relationship of relationships.values()) {
        if (relationship.type === type) {
            return relationship;
        }
    }

    return null;
}

export async function getPartRelationshipsFromCache(args: {
    partPath: string;
    cache: Map<string, Relationships>;
    loadRelationships: (partPath: string) => Promise<Relationships>;
}): Promise<Relationships> {
    const cached = args.cache.get(args.partPath);
    if (cached) {
        return cached;
    }

    const relationships = await args.loadRelationships(args.partPath);
    args.cache.set(args.partPath, relationships);
    return relationships;
}

export function collectRelationshipIds(
    node: XMLNodeLike,
    attributeNames: readonly string[] = DEFAULT_RELATIONSHIP_ATTRIBUTE_NAMES
): string[] {
    const ids = new Set<string>();
    const visit = (current: XMLNodeLike) => {
        for (const attributeName of attributeNames) {
            const value = getAttribute(current, attributeName);
            if (value) {
                ids.add(value);
            }
        }

        for (const child of childElements(current)) {
            visit(child);
        }
    };

    visit(node);
    return [...ids];
}

export async function extractRelatedPartTextFromNode(args: {
    node: XMLNodeLike;
    relationships: Relationships;
    readPartText: (partPath: string) => Promise<string>;
    formatText: (parts: string[]) => string;
}): Promise<string> {
    const relationshipIds = collectRelationshipIds(args.node);
    if (relationshipIds.length === 0) {
        return "";
    }

    const parts: string[] = [];
    const seen = new Set<string>();
    for (const relationshipId of relationshipIds) {
        const relationship = args.relationships.get(relationshipId);
        if (!relationship || relationship.external || seen.has(relationship.target)) {
            continue;
        }

        seen.add(relationship.target);
        const text = await args.readPartText(relationship.target);
        if (text) {
            parts.push(text);
        }
    }

    return args.formatText(parts);
}
