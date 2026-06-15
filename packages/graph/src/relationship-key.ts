import type { Relationship } from ".";

export const DEFAULT_RELATIONSHIP_KIND = "RELATED";

export function normalizedRelationshipEndpoints(
    relationship: Pick<Relationship, "sourceId" | "targetId" | "directed">
): { sourceId: string; targetId: string; directed: boolean } {
    const directed = relationship.directed === true;
    const sourceId = directed
        ? relationship.sourceId
        : relationship.sourceId <= relationship.targetId
          ? relationship.sourceId
          : relationship.targetId;
    const targetId = directed
        ? relationship.targetId
        : relationship.sourceId <= relationship.targetId
          ? relationship.targetId
          : relationship.sourceId;

    return { sourceId, targetId, directed };
}

export function relationshipKey(relationship: Pick<Relationship, "sourceId" | "targetId" | "kind" | "directed">) {
    const endpoints = normalizedRelationshipEndpoints(relationship);
    return `${relationship.kind ?? DEFAULT_RELATIONSHIP_KIND}::${endpoints.directed ? "directed" : "undirected"}::${endpoints.sourceId}::${endpoints.targetId}`;
}
