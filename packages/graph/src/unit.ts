import { ulid } from "ulid";
import { extractPrompt } from "@kiwi/ai/prompts/extract.prompt";
import { generateText, Output } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Graph, GraphFile, Unit } from ".";
import z from "zod";

export async function createUnits(file: GraphFile): Promise<Unit[]> {
    const text = await file.loader.getText();
    const chunks = await file.chunker.getChunks(text);

    return chunks.map((chunk) => ({
        id: ulid(),
        fileId: file.id,
        content: chunk,
    }));
}

const extractOutputSchema = z.object({
    entities: z.array(
        z.object({
            name: z.string().describe("The name of the entity all uppercase."),
            type: z.string().describe("The type of the entity, must be one of the provided ones or FACT"),
            description: z.string().describe("A brief description of the entity. Capturing every detail."),
        })
    ),
    relationships: z.array(
        z.object({
            sourceEntity: z.string().describe("The name of the source entity in uppercase."),
            targetEntity: z.string().describe("The name of the target entity in uppercase."),
            description: z.string().describe("A brief description of the relationship. Capturing every detail."),
            strength: z.number().describe("A number between 0 and 1 indicating the strength of the relationship."),
        })
    ),
});

export async function processUnit(unit: Unit, model: LanguageModelV3): Promise<Graph> {
    const entities = ["ORGANIZATION", "PERSON", "LOCATION", "CONCEPT", "CREATIVE_WORK", "DATE", "PRODUCT", "EVENT"];
    const prompt = extractPrompt(entities, unit.fileId);

    const { output } = await generateText({
        model,
        system: prompt,
        prompt: unit.content,
        output: Output.object({
            description: "The extracted entities and relationships from the text.",
            schema: extractOutputSchema,
        }),
    });

    const entityNameToId = new Map<string, string>();
    const graphEntities = output.entities.map((entity) => {
        const entityId = ulid();

        entityNameToId.set(entity.name, entityId);

        return {
            id: entityId,
            name: entity.name,
            type: entity.type,
            description: "",
            sources: [
                {
                    id: ulid(),
                    unitId: unit.id,
                    description: entity.description,
                },
            ],
        };
    });

    const graphRelationships = output.relationships.flatMap((relationship) => {
        const sourceId = entityNameToId.get(relationship.sourceEntity);
        const targetId = entityNameToId.get(relationship.targetEntity);

        if (!sourceId || !targetId) {
            return [];
        }

        return [
            {
                id: ulid(),
                sourceId,
                targetId,
                strength: relationship.strength,
                description: "",
                sources: [
                    {
                        id: ulid(),
                        unitId: unit.id,
                        description: relationship.description,
                    },
                ],
            },
        ];
    });

    return {
        id: ulid(),
        units: [unit],
        entities: graphEntities,
        relationships: graphRelationships,
    };
}
