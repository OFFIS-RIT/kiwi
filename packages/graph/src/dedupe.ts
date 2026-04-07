import { ulid } from "ulid";
import type { Entity, Graph, Relationship, Source, Unit } from ".";

const exactOnlyTypes = new Set(["DATE", "FACT"]);
const organizationSuffixes = new Set([
    "AG",
    "BV",
    "CO",
    "COMPANY",
    "CORP",
    "CORPORATION",
    "GMBH",
    "INC",
    "INCORPORATED",
    "LIMITED",
    "LLC",
    "LTD",
    "NV",
    "PLC",
    "SA",
    "SAS",
]);
const connectorTokens = new Set(["A", "AN", "AND", "AT", "BY", "FOR", "FROM", "IN", "OF", "ON", "THE", "TO", "WITH"]);

const normalizeWhitespace = (value: string) =>
    value
        .trim()
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ");

const tokenize = (value: string) => {
    const normalized = normalizeWhitespace(value)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/&/g, " AND ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

    return normalized ? normalized.split(/\s+/) : [];
};

const normalizeName = (value: string) => tokenize(value).join(" ");

const stripOrganizationSuffixes = (tokens: string[]) => {
    const stripped = [...tokens];

    while (stripped.length > 1) {
        const lastToken = stripped[stripped.length - 1];

        if (!lastToken || !organizationSuffixes.has(lastToken)) {
            break;
        }

        stripped.pop();
    }

    return stripped;
};

const getSignificantTokens = (tokens: string[]) =>
    stripOrganizationSuffixes(tokens).filter((token) => !connectorTokens.has(token));

const buildAcronym = (tokens: string[]) => {
    const significantTokens = getSignificantTokens(tokens);

    if (significantTokens.length < 2) {
        return "";
    }

    return significantTokens.map((token) => token[0] ?? "").join("");
};

const isAcronymToken = (tokens: string[]) => tokens.length === 1 && /^[\p{L}\p{N}]{2,10}$/u.test(tokens[0] ?? "");

const areAcronymVariants = (leftTokens: string[], rightTokens: string[]) => {
    const leftNormalized = leftTokens.join(" ");
    const rightNormalized = rightTokens.join(" ");

    if (isAcronymToken(leftTokens) && buildAcronym(rightTokens) === leftNormalized) {
        return true;
    }

    if (isAcronymToken(rightTokens) && buildAcronym(leftTokens) === rightNormalized) {
        return true;
    }

    return false;
};

const arePeopleDuplicates = (leftName: string, rightName: string) => {
    const leftTokens = tokenize(leftName);
    const rightTokens = tokenize(rightName);

    if (leftTokens.length < 2 || rightTokens.length < 2) {
        return false;
    }

    const leftFirst = leftTokens[0];
    const rightFirst = rightTokens[0];
    const leftLast = leftTokens[leftTokens.length - 1];
    const rightLast = rightTokens[rightTokens.length - 1];

    return leftFirst === rightFirst && leftLast === rightLast;
};

const areEntitiesDuplicates = (left: Entity, right: Entity) => {
    if (left.type !== right.type) {
        return false;
    }

    const leftNormalized = normalizeName(left.name);
    const rightNormalized = normalizeName(right.name);

    if (!leftNormalized || !rightNormalized) {
        return false;
    }

    if (leftNormalized === rightNormalized) {
        return true;
    }

    if (exactOnlyTypes.has(left.type)) {
        return false;
    }

    if (left.type === "PERSON") {
        return arePeopleDuplicates(left.name, right.name);
    }

    const leftBase = stripOrganizationSuffixes(tokenize(left.name)).join(" ");
    const rightBase = stripOrganizationSuffixes(tokenize(right.name)).join(" ");

    if (leftBase && rightBase && leftBase === rightBase) {
        return true;
    }

    return areAcronymVariants(tokenize(left.name), tokenize(right.name));
};

const chooseCanonicalEntity = (entities: Entity[]) =>
    entities.reduce((best, current) => {
        if (current.sources.length !== best.sources.length) {
            return current.sources.length > best.sources.length ? current : best;
        }

        const currentDescriptionLength = normalizeWhitespace(current.description ?? "").length;
        const bestDescriptionLength = normalizeWhitespace(best.description ?? "").length;

        if (currentDescriptionLength !== bestDescriptionLength) {
            return currentDescriptionLength > bestDescriptionLength ? current : best;
        }

        const currentNameLength = normalizeName(current.name).length;
        const bestNameLength = normalizeName(best.name).length;

        if (currentNameLength !== bestNameLength) {
            return currentNameLength > bestNameLength ? current : best;
        }

        return current.id < best.id ? current : best;
    });

const chooseCanonicalName = (entities: Entity[]) => {
    const uniqueNames = [...new Set(entities.map((entity) => normalizeWhitespace(entity.name)).filter(Boolean))];

    return uniqueNames.reduce((best, current) => {
        if (!best) {
            return current;
        }

        const bestTokens = getSignificantTokens(tokenize(best));
        const currentTokens = getSignificantTokens(tokenize(current));

        if (currentTokens.length !== bestTokens.length) {
            return currentTokens.length > bestTokens.length ? current : best;
        }

        const bestLength = normalizeName(best).length;
        const currentLength = normalizeName(current).length;

        if (currentLength !== bestLength) {
            return currentLength > bestLength ? current : best;
        }

        return current < best ? current : best;
    }, "");
};

const chooseCanonicalDescription = (entities: Entity[]) =>
    entities.reduce((best, current) => {
        const description = normalizeWhitespace(current.description ?? "");
        return description.length > best.length ? description : best;
    }, "");

const mergeSources = (sources: Source[]) => {
    const merged = new Map<string, Source>();

    for (const source of sources) {
        if (!merged.has(source.id)) {
            merged.set(source.id, source);
        }
    }

    return [...merged.values()];
};

const mergeUnits = (units: Unit[]) => {
    const merged = new Map<string, Unit>();

    for (const unit of units) {
        if (!merged.has(unit.id)) {
            merged.set(unit.id, unit);
        }
    }

    return [...merged.values()];
};

const normalizeRelationshipPair = (sourceId: string, targetId: string) => {
    if (sourceId <= targetId) {
        return { sourceId, targetId };
    }

    return { sourceId: targetId, targetId: sourceId };
};

const buildRelationshipKey = (sourceId: string, targetId: string) => {
    const normalized = normalizeRelationshipPair(sourceId, targetId);

    return `${normalized.sourceId}::${normalized.targetId}`;
};

export function dedupe(graph: Graph): Graph {
    const parents = graph.entities.map((_, index) => index);

    const find = (index: number): number => {
        if (parents[index] !== index) {
            parents[index] = find(parents[index] ?? index);
        }

        return parents[index] ?? index;
    };

    const union = (leftIndex: number, rightIndex: number) => {
        const leftRoot = find(leftIndex);
        const rightRoot = find(rightIndex);

        if (leftRoot !== rightRoot) {
            parents[rightRoot] = leftRoot;
        }
    };

    for (let leftIndex = 0; leftIndex < graph.entities.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < graph.entities.length; rightIndex += 1) {
            if (areEntitiesDuplicates(graph.entities[leftIndex]!, graph.entities[rightIndex]!)) {
                union(leftIndex, rightIndex);
            }
        }
    }

    const groups = new Map<number, number[]>();

    for (let index = 0; index < graph.entities.length; index += 1) {
        const root = find(index);
        const group = groups.get(root);

        if (group) {
            group.push(index);
            continue;
        }

        groups.set(root, [index]);
    }

    const sortedGroups = [...groups.values()].sort((left, right) => (left[0] ?? 0) - (right[0] ?? 0));
    const entityIdMap = new Map<string, string>();
    const dedupedEntities = sortedGroups.map((group) => {
        const entities = group.map((index) => graph.entities[index]!);
        const canonicalEntity = chooseCanonicalEntity(entities);
        const mergedEntity: Entity = {
            ...canonicalEntity,
            name: chooseCanonicalName(entities) || canonicalEntity.name,
            description: chooseCanonicalDescription(entities),
            sources: mergeSources(entities.flatMap((entity) => entity.sources)),
        };

        for (const entity of entities) {
            entityIdMap.set(entity.id, canonicalEntity.id);
        }

        return mergedEntity;
    });

    const relationshipMap = new Map<string, Relationship>();

    for (const relationship of graph.relationships) {
        const sourceId = entityIdMap.get(relationship.sourceId);
        const targetId = entityIdMap.get(relationship.targetId);

        if (!sourceId || !targetId || sourceId === targetId) {
            continue;
        }

        const normalizedPair = normalizeRelationshipPair(sourceId, targetId);
        const key = buildRelationshipKey(normalizedPair.sourceId, normalizedPair.targetId);
        const existingRelationship = relationshipMap.get(key);

        if (existingRelationship) {
            existingRelationship.sources = mergeSources([...existingRelationship.sources, ...relationship.sources]);
            existingRelationship.strength = Math.max(existingRelationship.strength, relationship.strength);

            const existingDescription = normalizeWhitespace(existingRelationship.description ?? "");
            const relationshipDescription = normalizeWhitespace(relationship.description ?? "");
            if (relationshipDescription.length > existingDescription.length) {
                existingRelationship.description = relationshipDescription;
            }

            continue;
        }

        relationshipMap.set(key, {
            ...relationship,
            sourceId: normalizedPair.sourceId,
            targetId: normalizedPair.targetId,
            description: normalizeWhitespace(relationship.description ?? ""),
            sources: mergeSources([...relationship.sources]),
        });
    }

    return {
        id: ulid(),
        units: mergeUnits(graph.units),
        entities: dedupedEntities,
        relationships: [...relationshipMap.values()],
    };
}
