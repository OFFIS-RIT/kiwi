import { ulid } from "ulid";
import type { Entity, Graph, Relationship } from ".";
import { DEFAULT_RELATIONSHIP_KIND, normalizedRelationshipEndpoints, relationshipKey } from "./relationship-key";

const getEntityKey = (entity: Pick<Entity, "name" | "type">) => `${entity.name}::${entity.type}`;

export function mergeGraphs(graphs: Graph[]): Graph;
export function mergeGraphs(left: Graph, right: Graph): Graph;
export function mergeGraphs(input: Graph[] | Graph, right?: Graph): Graph {
    const graphs = Array.isArray(input) ? input : right ? [input, right] : [input];
    const entityIdMap = new Map<string, string>();
    const mergedEntities = new Map<string, Entity>();

    for (const graph of graphs) {
        for (const entity of graph.entities) {
            const key = getEntityKey(entity);
            const existingEntity = mergedEntities.get(key);

            if (existingEntity) {
                entityIdMap.set(entity.id, existingEntity.id);
                existingEntity.sources.push(...entity.sources);

                if (!existingEntity.description && entity.description) {
                    existingEntity.description = entity.description;
                }

                continue;
            }

            mergedEntities.set(key, {
                ...entity,
                sources: [...entity.sources],
            });
            entityIdMap.set(entity.id, entity.id);
        }
    }

    const mergedRelationships = new Map<string, Relationship>();

    for (const graph of graphs) {
        for (const relationship of graph.relationships) {
            const sourceId = entityIdMap.get(relationship.sourceId);
            const targetId = entityIdMap.get(relationship.targetId);

            if (!sourceId || !targetId) {
                continue;
            }

            const endpoints = normalizedRelationshipEndpoints({
                sourceId,
                targetId,
                directed: relationship.directed,
            });
            const key = relationshipKey({
                sourceId: endpoints.sourceId,
                targetId: endpoints.targetId,
                kind: relationship.kind,
                directed: endpoints.directed,
            });
            const existingRelationship = mergedRelationships.get(key);

            if (existingRelationship) {
                existingRelationship.sources.push(...relationship.sources);
                existingRelationship.strength = Math.max(existingRelationship.strength, relationship.strength);

                if (!existingRelationship.description && relationship.description) {
                    existingRelationship.description = relationship.description;
                }

                continue;
            }

            mergedRelationships.set(key, {
                ...relationship,
                sourceId: endpoints.sourceId,
                targetId: endpoints.targetId,
                kind: relationship.kind ?? DEFAULT_RELATIONSHIP_KIND,
                directed: endpoints.directed,
                sources: [...relationship.sources],
            });
        }
    }

    return {
        id: ulid(),
        units: graphs.flatMap((graph) => graph.units),
        entities: [...mergedEntities.values()],
        relationships: [...mergedRelationships.values()],
    };
}
