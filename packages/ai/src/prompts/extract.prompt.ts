export const extractPrompt = (entityTypes: string[], documentName: string, metadata?: string) => `
# Task Context
You are tasked with extracting **structured entity and relationship information** from the provided text. The process must capture **all details explicitly present in the text**, without omission.

# Background Data
- **Entity_types:** ${entityTypes.join(", ")}
- **Document_name:** ${documentName}
${
    metadata
        ? `
- **Document_metadata:** ${metadata}
`
        : ""
}

The document name may contain hints about the primary entity (e.g., *“House Data X”* → inferred entity: *“HOUSE X”*). Use it only if the text itself does not clearly specify an entity.

# Detailed Task Description & Rules
- If the text includes relevant information that cannot be confidently assigned to a specific entity, extract it as a FACT entity with a name in the format "FACT: <SHORT TITLE>" (all-caps) and describe the full information in the description.
- If the text primarily consists of **factual, tabular, or key–value data** (e.g., “Size: 120m2”, “Bathrooms: 3”) and does not explicitly name multiple entities or relationships, you must still extract the information by **inferring a single implicit entity**.
- This implicit entity should represent the main subject of the text (e.g., “HOUSE”, “CAR”, “PRODUCT”, “PROJECT”) based on context, document type, or the document name.
- For non-English technical, legal, or domain-specific terms, keep the original term and add a short English explanation in parentheses (e.g., "Hundesteuer (dog license fee)"). Do not translate every non-English word; apply this only to specialized terms.

## Entity Extraction
1. Identify all entities of the specified types ${entityTypes.join(", ")}.
2. For each entity, extract:
    - **entity_name:** The name of the entity, written in **ALL CAPITAL LETTERS**.
      - If the text does not explicitly name any entity, infer one implicit entity representing the subject of the document.
      - If using type FACT, use the format "FACT: <SHORT TITLE>" (all-caps).
      - Use the **document_name** as a hint.

   - **entity_type:** One of the provided types ${entityTypes.join(", ")}.
   - **entity_description:** A comprehensive description of all attributes, roles, activities, events, timelines, frequencies, or other explicit details in the text.
     - Include factual or key–value information if present.
     - Do **not** omit any explicit information.

## Relationship Extraction
1. From the identified entities, determine all clear relationships between pairs of entities.
2. For each relationship, extract:
   - **source_entity:** name of the source entity.
   - **target_entity:** name of the target entity.
   - **relationship_description:** detailed explanation of how and why the entities are related, based strictly on the text.
   - **relationship_strength:** a numeric score (0.0–1.0) indicating the strength of the relationship (higher = stronger).
3. If the text only describes a single implicit entity (e.g., factual data only), return an **empty array** for "relationships".

# Examples
## Example 1 — Regular entity & relationship text
**Entity_types:** ORGANIZATION, PERSON
**Document_name:** “Central Institution Policy”
**Text:**
The Verdantis Central Institution is scheduled to meet on Monday and Thursday.
The institution will release its latest policy decision on Thursday at 1:30 p.m. PDT, followed by a press conference where Central Institution Chair Martin Smith will take questions.
Investors expect the Market Strategy Committee to keep its benchmark interest rate steady in the range of 3.5 Percent - 3.75 Percent.

**Output:**
{
  "entities": [
    {
      "name": "VERDANTIS CENTRAL INSTITUTION",
      "type": "ORGANIZATION",
      "description": "The Verdantis Central Institution is an organization that meets on Mondays and Thursdays, issues policy decisions including one scheduled for Thursday at 1:30 p.m. PDT, and hosts press conferences after policy releases."
    },
    {
      "name": "MARTIN SMITH",
      "type": "PERSON",
      "description": "Martin Smith is the Chair of the Verdantis Central Institution and is scheduled to answer questions at a press conference following the Thursday policy release."
    },
    {
      "name": "MARKET STRATEGY COMMITTEE",
      "type": "ORGANIZATION",
      "description": "The Market Strategy Committee is part of the Verdantis Central Institution and is expected to keep the benchmark interest rate steady in the range of 3.5 Percent - 3.75 Percent."
    }
  ],
  "relationships": [
    {
      "source_entity": "MARTIN SMITH",
      "target_entity": "VERDANTIS CENTRAL INSTITUTION",
      "description": "Martin Smith serves as the Chair of the Verdantis Central Institution and represents the institution in public press conferences.",
      "strength": 0.9
    },
    {
      "source_entity": "MARKET STRATEGY COMMITTEE",
      "target_entity": "VERDANTIS CENTRAL INSTITUTION",
      "description": "The Market Strategy Committee operates under the Verdantis Central Institution and makes decisions about the benchmark interest rate.",
      "strength": 0.8
    }
  ]
}

## Example 2 — Factual / Attribute-oriented data
**Entity_types:** PROPERTY
**Document_name:** “House Data X”
**Text:**
Size: 120m2
Persons: 4
Bathrooms: 3

**Output:**
{
  "entities": [
    {
      "name": "HOUSE X",
      "type": "PROPERTY",
      "description": "A house named X with a size of 120 square meters, suitable for 4 persons, and containing 3 bathrooms."
    }
  ],
  "relationships": []
}

# Thinking Step by Step
Think step-by-step and extract all entities and relationships as specified.

# Output Formatting
The output must be a single valid JSON object in this structure:
{
  "entities": [
    {
      "name": "string",
      "type": "string",
      "description": "string"
    }
  ],
  "relationships": [
    {
      "source_entity": "string",
      "target_entity": "string",
      "description": "string",
      "strength": "float"
    }
  ]
}
Do not include any commentary, explanations, or text outside of the JSON.
Always return valid JSON, even if no entities or relationships are found (use empty arrays in that case).
Make sure to follow the rules and output format carefully.
`;

export const extractAudioPrompt = (entityTypes: string[], documentName: string) => `
# Task Context
You are tasked with extracting **structured entity and relationship information** from an audio transcription (meeting, interview, call, lecture, podcast).
The output must follow the exact JSON schema described below.

# Background Data
- **Entity_types:** ${entityTypes.join(", ")}
- **Document_name:** ${documentName}

# Transcript Handling
- Speaker labels (e.g., "HOST", "SPEAKER 1", names, roles) indicate distinct PERSON entities when present.
- Keep meaningful timestamps or time ranges in descriptions when they clarify events or sequences.
- Ignore filler words and disfluencies unless they contain explicit factual information.
- If the transcript is a single narrator without speaker labels, infer one implicit entity that represents the primary speaker or subject.
- If the audio is a structured session (meeting, interview, hearing, lecture), infer an implicit EVENT entity only if that entity type exists in the provided list; otherwise use a FACT entity with a name in the format "FACT: <SHORT TITLE>" (all-caps).
- For non-English technical, legal, or domain-specific terms, keep the original term and add a short English explanation in parentheses (e.g., "Hundesteuer (dog license fee)"). Do not translate every non-English word; apply this only to specialized terms.

## Entity Extraction
1. Identify all entities of the specified types ${entityTypes.join(", ")}.
2. For each entity, extract:
   - **entity_name:** The name of the entity, written in **ALL CAPITAL LETTERS**. If using type FACT, use the format "FACT: <SHORT TITLE>" (all-caps).
   - **entity_type:** One of the provided types ${entityTypes.join(", ")}.
   - **entity_description:** A comprehensive description of all explicit statements, decisions, actions, dates, numbers, roles, or commitments tied to the entity.

## Relationship Extraction
1. From the identified entities, determine all clear relationships between pairs of entities.
2. For each relationship, extract:
   - **source_entity:** name of the source entity.
   - **target_entity:** name of the target entity.
   - **relationship_description:** detailed explanation of how and why the entities are related, based strictly on the transcript.
   - **relationship_strength:** a numeric score (0.0–1.0) indicating the strength of the relationship (higher = stronger).
3. If the transcript implies a single implicit entity, return an **empty array** for "relationships".

# Output Formatting
The output must be a single valid JSON object in this structure:
{
  "entities": [
    {
      "entity_name": "string",
      "entity_type": "string",
      "entity_description": "string"
    }
  ],
  "relationships": [
    {
      "source_entity": "string",
      "target_entity": "string",
      "relationship_description": "string",
      "relationship_strength": "float"
    }
  ]
}
Do not include any commentary, explanations, or text outside of the JSON.
Always return valid JSON, even if no entities or relationships are found (use empty arrays in that case).
Make sure to follow the rules and output format carefully.
`;
