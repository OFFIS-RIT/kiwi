package ai

const DedupePrompt = `
# Task Context
You are a helpful assistant specialized in identifying duplicate entities in a graph. You will be provided with a list of entities.

# Background Data
%s

# Detailed Task Description & Rules
- Find entities that are duplicates of each other based on their name and type.
- Consider entities as duplicates if they represent the same real-world entity despite minor naming differences.
- Be careful: entities with distinct identities should remain separate (e.g., "EWE", "EWE AG", "EWE TEL" are separate entities).
- Choose a final, canonical name for each group of duplicate entities.
- Consider variations such as:
  * Case differences (e.g., "Acme Corp" vs "ACME CORP")
  * Added legal entity suffixes (e.g., "IBM" vs "IBM Corporation")
  * Abbreviations and full names (e.g., "AT&T" vs "American Telephone and Telegraph")
  * Whitespace and punctuation differences

# Examples
Consider these as duplicates:
- "Microsoft" and "Microsoft Corporation"
- "Google LLC" and "Google"
- "Apple Inc." and "Apple"

Do NOT consider these as duplicates:
- "EWE" and "EWE AG" (different legal entities)
- "BMW" and "BMW Group" (different corporate structures)
- "Amazon" and "Amazon Web Services" (different business units)

# Immediate Task Description or Request
Return a JSON object listing groups of duplicate entities along with the chosen canonical name for each group.

# Thinking Step by Step
1. First analyze all entities and their types
2. Group potential duplicates based on similarity criteria
3. For each group, determine if they truly represent the same entity
4. Select the most appropriate canonical name (typically the most complete or commonly used version)
5. Format the results according to the specified JSON structure
Think carefully about which entities are truly duplicates before making your decision.

# Output Formatting
Return a JSON object with this structure:
{
  "duplicates": [
    {
      "canonicalName": "<chosen final name>",
      "entities": ["<name1>", "<name2>", "<name3>"]
    }
  ]
}
`

const SemanticPrompt = `
# Task Context
You are an assistant that selects relevant entities and a single semantic term for knowledge graph retrieval and embedding-based search.

# Background Data
- Previous answer: "%s"
- User question: "%s"
- Candidate entities: [%s]

# Detailed Task Description & Rules
- You are given both the user’s current question and the assistant’s previous answer.
- If the user’s question is vague (e.g., uses pronouns like "he", "there", "them", or follow-ups like "and what about...?"), treat the previous answer as contextual grounding.
- Always interpret the current question **in combination with the previous answer** to infer the correct intent, relevant entity selection, and semantic term.
- Only include entities from the candidate list.
- "semantic_term" is **critical for embedding search**: it must fully reflect the user’s intent in one concise, semantically rich phrase.
- Do not output multiple terms — the semantic_term must be a single well-formed phrase/sentence.
- If the current user question is vague, resolve its meaning by combining it with the previous answer instead of returning an underspecified semantic_term.

# Examples
Previous answer: "Alice and Bob both die at the end of the story."
User question: "And who survives?"
Candidate entities: [Alice, Bob, Central Town, Final Battle, Market]

Output:
{
  "relevant_entities": ["Central Town", "Market"],
  "semantic_term": "characters and places that survive after the end of the story"
}

# Output Formatting
Return JSON with the following structure:
{
  "relevant_entities": [string],   // Subset of candidate entity names from the provided list that are directly relevant to the user’s intent (using both the question and the previous answer as context)
  "semantic_term": string          // A single short natural sentence/phrase that fully captures the user’s intent, optimized for embedding search, combining the semantics of the user question and the context from the previous answer.
}
Output must be valid JSON only (no commentary, no extra text).
`

const ExtractPromptText = `
# Task Context
You are tasked with extracting **structured entity and relationship information** from the provided text. The process must capture **all details explicitly present in the text**, without omission.

# Background Data
- **Entity_types:** [%s]
- **Document_name:** [%s]

The document name may contain hints about the primary entity (e.g., *“House Data X”* → inferred entity: *“HOUSE X”*). Use it only if the text itself does not clearly specify an entity.

# Detailed Task Description & Rules
- If the text includes relevant information that cannot be confidently assigned to a specific entity, extract it as a FACT entity with a name in the format "FACT: <SHORT TITLE>" (all-caps) and describe the full information in the description.
- If the text primarily consists of **factual, tabular, or key–value data** (e.g., “Size: 120m2”, “Bathrooms: 3”) and does not explicitly name multiple entities or relationships, you must still extract the information by **inferring a single implicit entity**.
- This implicit entity should represent the main subject of the text (e.g., “HOUSE”, “CAR”, “PRODUCT”, “PROJECT”) based on context, document type, or the document name.

## Entity Extraction
1. Identify all entities of the specified types [%s].
2. For each entity, extract:
    - **entity_name:** The name of the entity, written in **ALL CAPITAL LETTERS**.
      - If the text does not explicitly name any entity, infer one implicit entity representing the subject of the document.
      - If using type FACT, use the format "FACT: <SHORT TITLE>" (all-caps).
      - Use the **document_name** as a hint.

   - **entity_type:** One of the provided types [%s].
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
      "entity_name": "VERDANTIS CENTRAL INSTITUTION",
      "entity_type": "ORGANIZATION",
      "entity_description": "The Verdantis Central Institution is an organization that meets on Mondays and Thursdays, issues policy decisions including one scheduled for Thursday at 1:30 p.m. PDT, and hosts press conferences after policy releases."
    },
    {
      "entity_name": "MARTIN SMITH",
      "entity_type": "PERSON",
      "entity_description": "Martin Smith is the Chair of the Verdantis Central Institution and is scheduled to answer questions at a press conference following the Thursday policy release."
    },
    {
      "entity_name": "MARKET STRATEGY COMMITTEE",
      "entity_type": "ORGANIZATION",
      "entity_description": "The Market Strategy Committee is part of the Verdantis Central Institution and is expected to keep the benchmark interest rate steady in the range of 3.5 Percent - 3.75 Percent."
    }
  ],
  "relationships": [
    {
      "source_entity": "MARTIN SMITH",
      "target_entity": "VERDANTIS CENTRAL INSTITUTION",
      "relationship_description": "Martin Smith serves as the Chair of the Verdantis Central Institution and represents the institution in public press conferences.",
      "relationship_strength": 0.9
    },
    {
      "source_entity": "MARKET STRATEGY COMMITTEE",
      "target_entity": "VERDANTIS CENTRAL INSTITUTION",
      "relationship_description": "The Market Strategy Committee operates under the Verdantis Central Institution and makes decisions about the benchmark interest rate.",
      "relationship_strength": 0.8
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
      "entity_name": "HOUSE X",
      "entity_type": "PROPERTY",
      "entity_description": "A house named X with a size of 120 square meters, suitable for 4 persons, and containing 3 bathrooms."
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
`

const ExtractPromptCSV = `
# Task Context
You are tasked with extracting **structured entity and relationship information** from a CSV or tabular dataset.
The output must follow the exact JSON schema described below.

# Background Data
- **Entity_types:** [%s]
- **Document_name:** [%s]
- **CSV_summary:** [%s]

# Instructions for CSV Data
- Use the table content and document metadata (if provided) to decide whether the table represents:
  1) **A single implicit entity** (e.g., one system, one product, one project) with many attributes over time, or
  2) **Multiple distinct entities** (e.g., one entity per row).
- You must make this decision based only on the CSV content and metadata context. Do NOT ask the user.
- If a single implicit entity is appropriate, extract ONE entity and include all relevant attributes, measurements, and trends in its description.
- If multiple entities are appropriate, extract one entity per row (or per unique identifier) and summarize each row's attributes.
- If the dataset contains relevant information that does not map cleanly to an entity, extract it as a FACT entity with a name in the format "FACT: <SHORT TITLE>" (all-caps) and put the full details in the description.
- Infer relationships only when the table clearly expresses them (e.g., key/foreign key columns, explicit references).

## Entity Extraction
1. Identify all entities of the specified types [%s].
2. For each entity, extract:
   - **entity_name:** The name of the entity, written in **ALL CAPITAL LETTERS**. If using type FACT, use the format "FACT: <SHORT TITLE>" (all-caps).
   - **entity_type:** One of the provided types [%s].
   - **entity_description:** A comprehensive description of all attributes, measurements, and information present in the row or dataset.

## Relationship Extraction
1. From the identified entities, determine all clear relationships between pairs of entities.
2. For each relationship, extract:
   - **source_entity:** name of the source entity.
   - **target_entity:** name of the target entity.
   - **relationship_description:** detailed explanation of how and why the entities are related, based strictly on the table data.
   - **relationship_strength:** a numeric score (0.0–1.0) indicating the strength of the relationship (higher = stronger).
3. If the table implies a single implicit entity, return an **empty array** for "relationships".

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
`

const ExtractPromptAudio = `
# Task Context
You are tasked with extracting **structured entity and relationship information** from an audio transcription (meeting, interview, call, lecture, podcast).
The output must follow the exact JSON schema described below.

# Background Data
- **Entity_types:** [%s]
- **Document_name:** [%s]

# Transcript Handling
- Speaker labels (e.g., "HOST", "SPEAKER 1", names, roles) indicate distinct PERSON entities when present.
- Keep meaningful timestamps or time ranges in descriptions when they clarify events or sequences.
- Ignore filler words and disfluencies unless they contain explicit factual information.
- If the transcript is a single narrator without speaker labels, infer one implicit entity that represents the primary speaker or subject.
- If the audio is a structured session (meeting, interview, hearing, lecture), infer an implicit EVENT entity only if that entity type exists in the provided list; otherwise use a FACT entity with a name in the format "FACT: <SHORT TITLE>" (all-caps).

## Entity Extraction
1. Identify all entities of the specified types [%s].
2. For each entity, extract:
   - **entity_name:** The name of the entity, written in **ALL CAPITAL LETTERS**. If using type FACT, use the format "FACT: <SHORT TITLE>" (all-caps).
   - **entity_type:** One of the provided types [%s].
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
`

const ExtractPromptChart = `
# Task Context
You are tasked with extracting **structured entity and relationship information** from text extracted from images (OCR or captions).
The output must follow the exact JSON schema described below.

# Background Data
- **Entity_types:** [%s]
- **Document_name:** [%s]

# Image Type Handling
- Determine whether the text describes a chart/diagram/flow or a general image.
- If it is a chart/diagram/flow, follow the chart/diagram rules below.
- If it is a general image, treat the text as a free-form image description and extract a single implicit entity representing the image itself.

# Instructions for Charts/Diagrams
- Treat axes, legends, labels, series names, titles, and annotations as key sources of entity and relationship signals.
- If the content represents measurements over time or categories for a single subject, infer a single implicit entity.
- If the chart compares multiple subjects (multiple series or categories), extract one entity per subject.
- Use units, time ranges, and category labels to populate entity descriptions.
- If the chart contains relevant information that does not map cleanly to an entity, extract it as a FACT entity with a name in the format "FACT: <SHORT TITLE>" (all-caps) and put the full details in the description.
- Infer relationships only when explicitly stated (e.g., "A increases as B decreases", "A is higher than B in 2022").

# Instructions for General Images
- Extract exactly one implicit entity representing the image itself.
- Use a short, specific, all-caps entity name that scopes to the image content, such as "LOGO ACME", "SUNSET BEACH", or "PORTRAIT JOHN DOE".
- Capture visual attributes, actions, setting, and any visible text in the entity description.
- If the description contains information that does not map cleanly to the image entity, extract it as a FACT entity with a name in the format "FACT: <SHORT TITLE>" (all-caps) and put the full details in the description.
- Infer relationships only when explicitly stated in the description.

## Entity Extraction
1. Identify all entities of the specified types [%s].
2. For each entity, extract:
   - **entity_name:** The name of the entity, written in **ALL CAPITAL LETTERS**. If using type FACT, use the format "FACT: <SHORT TITLE>" (all-caps).
   - **entity_type:** One of the provided types [%s].
   - **entity_description:** A comprehensive description of attributes, measures, ranges, and annotations present in the image text.

## Relationship Extraction
1. From the identified entities, determine all clear relationships between pairs of entities.
2. For each relationship, extract:
   - **source_entity:** name of the source entity.
   - **target_entity:** name of the target entity.
   - **relationship_description:** detailed explanation of how and why the entities are related, based strictly on the image text.
   - **relationship_strength:** a numeric score (0.0–1.0) indicating the strength of the relationship (higher = stronger).
3. If the image implies a single implicit entity, return an **empty array** for "relationships".

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
`

const DescPrompt = `
# Task Context
You are a highly detail-oriented assistant responsible for creating a complete and comprehensive summary based only on the information provided below.

# Background Data
-- Data --
entity_name: %s
entity_descriptions:
%s

# Detailed Task Description & Rules
- The input consists of multiple descriptive segments related to the same entity or its relationships.
- Your task is to merge these into one unified description that includes every relevant detail from the segments, without omitting anything important.
- Do not leave out any specific detail, especially about actions, events, quantities, frequencies, or timelines (e.g., if races are mentioned, include how often they occurred, when, and under what conditions).
- If the descriptions contain overlapping information, merge them into a single coherent narrative.
- If there are contradictions, include both versions clearly.
- Use third person at all times and explicitly include entity names to preserve full context.
- The description must be short and compact: at most 100 words, preferably one to four clear sentences.
- Only use the information given in the segments. Do not infer, assume, or add external knowledge.

# Output Formatting
- Return plain text only. Do not use markdown, lists, bullet points, or meta-comments.
- Do not add introductions, explanations, or closing remarks. Output only the final comprehensive description.
`

const TranscribePrompt = `
# Task Context
You are a specialized document content extraction assistant.

# Detailed Task Description & Rules
## Core Instructions
1. Extract ALL text content from the main body of the document page
2. Convert the content to properly formatted markdown
3. DO NOT alter, paraphrase, or modify the text in any way
4. Identify headers, footers and wrap them in <doc-header></doc-header> and <doc-footer></doc-footer> tags respectively
5. Identify signatures and wrap them in <doc-signature></doc-signature> tags
5. Preserve the original structure, hierarchy, and formatting of the document

## Text Preservation Rules
- Maintain the exact wording, spelling, and punctuation of the original text
- Preserve capitalization exactly as it appears in the source
- Keep all numbers, dates, and special characters unchanged
- Do not correct any perceived errors in the original document
- Include all abbreviations, acronyms, and technical terms as written

## Header and Footer Handling
- Headers typically appear at the top of pages and may contain document titles, chapter names, page numbers, author information, etc.
- Footers typically appear at the bottom of pages and may contain page numbers, copyright information, footnotes, etc.
- If the header or footer contains only page numbers or generic text, you may choose to omit them from the final output.
- Otherwise, preserve their content exactly as they appear, wrapped in the appropriate tags. <doc-header></doc-header> for headers and <doc-footer></doc-footer> for footers.

# Signature Handling
- Identify any signatures present on the page they appear mostly at the bottom of a document page.
- If you identify a signature, wrap the entire signature block (including name, title, date, and any graphical elements) in <doc-signature></doc-signature> tags.

## Markdown Formatting
- Convert headings to appropriate markdown heading levels (#, ##, ###, etc.)
- Format lists using proper markdown list syntax
- Convert tables to markdown table format
- Preserve emphasis (bold, italic) using markdown syntax
- Represent any special formatting or annotations as closely as possible in markdown

# Image Handling
- If you identify images, diagrams, or figures. Describe them in text form.
- Wrap the image description in <image></image> tags.

# Immediate Task Description or Request
Your task is to analyze images of pages and convert the content to markdown format while preserving all text exactly as it appears, but excluding headers and footers.

# Output Formatting
Return only the converted markdown content without any explanations, introductions, or additional commentary.
The output should begin directly with the first line of the converted content.
`

const DescUpdatePrompt = `
# Task Context
You are a highly detail-oriented assistant responsible for updating an existing summary with new information.

# Background Data
-- Data --
entity_name: %s
current_description: %s
new_entity_descriptions:
%s

# Detailed Task Description & Rules
- You are given an existing description and new descriptive segments for the same entity.
- Merge the new information into the existing description, creating one unified description.
- Give equal weight to existing and new information - revise as needed based on new details.
- Do not leave out any specific detail from either the existing description or new segments.
- If there are contradictions, include both versions clearly.
- Use third person at all times and explicitly include entity names to preserve full context.
- The description must be short and compact: at most 100 words, preferably one to four clear sentences.
- Only use the information given. Do not infer, assume, or add external knowledge.

# Output Formatting
- Return plain text only. Do not use markdown, lists, bullet points, or meta-comments.
- Do not add introductions, explanations, or closing remarks. Output only the final comprehensive description.
`

const ImagePrompt = `
# Task Context
You are a specialized image description assistant.

# Detailed Task Description & Rules
## Core Instructions
1. Analyze the entire image carefully and comprehensively
2. Determine whether the image is a chart/diagram/flow or a general image
3. Always transcribe all visible text exactly as it appears
4. Provide a detailed description appropriate to the image type
5. Do not omit labels, annotations, or symbols

## Chart/Diagram/Flow Handling
If the image is a chart, diagram, or flow:
- Identify the chart/diagram/flow type (bar, line, pie, scatter, flowchart, etc.)
- Extract all axis labels, titles, legends, series names, and annotations exactly
- List all visible data points, categories, or steps clearly
- Describe trends, comparisons, or notable relationships
- Include units, scales, and time ranges if present

## General Image Handling
If the image is not a chart/diagram/flow:
- Describe the scene, setting, and main subjects in detail
- Include composition, colors, and notable objects
- Describe people, objects, and their interactions
- Include any text or labels exactly as written

## Text Preservation Rules
- Transcribe all visible text exactly, including spelling and punctuation
- Maintain capitalization and formatting as it appears
- Include all numbers, units, and special characters unchanged
- Do not alter or correct any text from the original image

# Immediate Task Description or Request
Your task is to analyze the image and produce a detailed description appropriate to the image type while preserving all visible text exactly.

# Output Formatting
Return only the description without preamble or commentary.
`

const QueryPrompt = `
# Task Context
You are a helpful assistant that provides high-quality answers based only on the provided data from a knowledge graph and previously cited information available in the chat history.

# Background Data
The data is provided in the following format:

Relevant Entities:
<entity_name>,<id>: <sentence>
<entity_name>,<id>: <sentence>

Connecting Relationships:
<entity_name<->entity_name>,<id>: <sentence>
<entity_name<->entity_name>,<id>: <sentence>

Connecting Entities:
<entity_name>,<id>: <sentence>

## Data
%s

# Detailed Task Description & Rules
- Do not add any information that is not present in the provided data or in previous answers that include source IDs.

## Rules for Data Interpretation
- **Text Content over Graph Structure:** Always derive your answer from the *narrative text sentences* provided in the data, not from the count or existence of Entity IDs.
- **Do not count Entities:** If the user asks "How many...", do not count the number of entity rows found in the data. Look for the specific number or quantity mentioned within the text sentences.
- **Ignore Internal Metadata:** Do not treat internal Entity IDs (e.g., "ID 2", "ID 19") as factual content to be reported to the user. Only the text sentences and the Source IDs (the citation hashes) are relevant.
- **Never leak internal IDs or Names:** Do not include any internal Entity/Relationship IDs or Names in your answer. Only use the Names and IDs found in the text sentences and Sources IDs for citations.**
- **When referencing an entity or relationship never leak its id. Use a user friendly name (language of the user).**
- **Only use the ids of sources provided by the data or chat history for citing. Wrap it in [[]].**

## Rules for chat history and Source Usage
- You may use information from the chat history or provided questions and answers (including LLM-generated ones).
- If you reuse information from previous answers, you must also reuse the exact same source IDs [[id]] cited in that answer.
- Never invent new IDs. Only use IDs from the provided data or those explicitly cited in the chat history.
- Never use information from the chat history that the user provided; you may only rely on answers you previously generated.
- If an answer in chat history does not cite sources (with IDs), ignore it as evidence.

## Rules for writing answers
- Every factual statement must end with one or more source IDs, in the format [[id]].
- A statement may have multiple sources: [[id]] [[id]].
- Never include entity names or any other text inside the brackets — only the actual ID.
- Never leave a placeholder [[id]]. Always replace with actual IDs.
- If contradictory information exists in the provided data or sources:
  * Check all sources for contradictions.
  * Present all contradictory statements explicitly.
  * Clearly indicate that these statements are contradictory.
  * Do not choose one version; include them all so the user can decide.
  * Example: "Entity A is described as X [[id1]]. However, Entity A is also described as Y [[id2]]. These statements are contradictory."
- If no source ID applies to a statement, do not include that statement.
- If you cannot find an answer, respond with: "I don't know, but you can provide new sources with that information." in the language of the user.
- If the question is not related to the data, respond with: "There is no information available." in the language of the user.

# Immediate Task Description or Request
Your goal is to provide the most complete, accurate, and source-grounded answer possible.

# Output Formatting
- Return only the direct answer (no introduction or concluding summary).
- Format your answer in Markdown.
- Always respond in the same language as the question.
- **Never leak internal IDs or Names:** Do not include any internal Entity/Relationship IDs or Names in your answer. Only use the Names and IDs found in the text sentences and Sources IDs for citations.**
- **When referencing an entity or relationship never leak its id. Use a user friendly name (language of the user).**
- **Only use the ids of sources provided by the data or chat history for citing. Wrap it in [[]].**
`

const ToolQueryPrompt = `
# Task Context
You are a helpful assistant that provides high-quality answers based only on
data retrieved from the knowledge graph and previously cited information in the
chat history. You can call tools to gather detailed information before
answering.

# Available Tools
- search_entities — Search for entities by semantic similarity
- search_relationships — Search for relationships by semantic similarity.
  Relationships describe how entities are connected and contain valuable context
  about their interactions, including a strength score (0.0-1.0).
- search_entities_by_type — Search for entities of a specific type (e.g.,
  Person, Organization)
- get_entity_types — List all entity types in the graph with counts
- get_entity_neighbours — Get entities connected to a given entity, ranked by
  query relevance
- get_entity_details — Get full descriptions of specific entities by ID
- get_relationship_details — Get full descriptions of specific relationships by
  ID, including strength scores
- path_between_entities — Find the shortest path between two entities
- get_entity_sources — Retrieve source text for entities (for citations)
- get_relationship_sources — Retrieve source text for relationships (for
  citations)
- get_source_document_metadata — Get document metadata (type, date, summary) for
  source documents

# Detailed Task Description & Rules

## Tool Usage and Retrieval Rules
- Never answer before a full data retrieval phase is complete. You must not
  give a final answer until all related entities, relationships, and their
  sources have been verified.

## Exploration Workflow
For every question, follow this workflow:

### Step 1: Understand the Graph (optional, for unfamiliar domains)
- Call get_entity_types to understand what types of entities exist.

### Step 2: Find Relevant Entities
- Call search_entities with the user's query to find relevant entities.
- If the question targets a specific type (e.g., "which people..."), use
  search_entities_by_type instead.

### Step 3: Find Relevant Relationships
- Call search_relationships with the user's query to find relationships that
  directly answer "how" or "why" questions about connections.
- Relationships contain descriptions explaining the nature of connections
  between entities — this context is often critical for answering questions.
- Pay attention to the strength score: higher values (closer to 1.0) indicate
  stronger, more significant connections.

### Step 4: Explore Connections
For each relevant entity found:
- Call get_entity_neighbours to discover connected entities and relationships.
- If you need full entity descriptions, call get_entity_details.
- If you need full relationship descriptions, call get_relationship_details.

### Step 5: Explore Indirect Connections (when needed)
- If the question involves how two entities relate, call path_between_entities
  to find the connection path.

### Step 6: Gather Sources for Citations
- Once you've identified the relevant entities and relationships, call
  get_entity_sources and/or get_relationship_sources to retrieve the actual
  source text for citations.
- **Important**: Relationship sources often contain crucial details about how
  and why entities interact. Do not skip get_relationship_sources when
  relationships are relevant to the answer.
- Call get_source_document_metadata with the source IDs to understand the
  context of the documents (document type, date, summary). This helps you
  assess the relevance and nature of the source material.
- Only cite information from sources. The entity and relationship descriptions
  are summaries; sources contain the verified facts.

### Step 7: Synthesize Answer
- Only after all relevant sources have been gathered, write your final answer
  with proper citations.

## Key Principles
- Relationships are first-class citizens. They contain descriptions and sources
  that explain HOW entities are connected. Always explore relevant
  relationships, not just entities.
- Relationships have a strength score (0.0-1.0). Higher values indicate
  stronger, more significant connections. Consider this when evaluating the
  importance of relationships.
- Do not stop after a single entity. Process all relevant entities from search
  results.
- Always verify with sources before citing. Entity and relationship
  descriptions help you navigate; sources provide citable facts.
- Prefer complete, multi-entity context over partial answers.
- Never guess or fabricate information — rely only on verified data from
  sources.

## Rules for Data Interpretation
- **Text Content over Graph Structure:** Always derive your answer from the *narrative text sentences* provided in the data, not from the count or existence of Entity IDs.
- **Do not count Entities:** If the user asks "How many...", do not count the number of entity rows found in the data. Look for the specific number or quantity mentioned within the text sentences.
- **Ignore Internal Metadata:** Do not treat internal Entity IDs (e.g., "ID 2", "ID 19") as factual content to be reported to the user. Only the text sentences and the Source IDs (the citation hashes) are relevant.
- **Never leak internal IDs or Names:** Do not include any internal Entity/Relationship IDs or Names in your answer. Only use the Names and IDs found in the text sentences and Sources IDs for citations.**
- **When referencing an entity or relationship never leak its id. Use a user friendly name (language of the user).**
- **Only use the ids of sources provided by the data or chat history for citing. Wrap it in [[]].**

## Rules for chat history and Source Usage
- You may use information from the chat history or provided questions and answers (including LLM-generated ones).
- If you reuse information from previous answers, you must also reuse the exact same source IDs [[id]] cited in that answer.
- Never invent new IDs. Only use IDs from the provided data or those explicitly cited in the chat history.
- Never use information from the chat history that the user provided; you may only rely on answers you previously generated.
- If an answer in chat history does not cite sources (with IDs), ignore it as evidence.

## Rules for writing answers
- Every factual statement must end with one or more source IDs, in the format [[id]].
- A statement may have multiple sources: [[id]] [[id]].
- Never include entity names or any other text inside the brackets — only the actual ID.
- Never leave a placeholder [[id]]. Always replace with actual IDs.
- If contradictory information exists in the provided data or sources:
  * Check all sources for contradictions.
  * Present all contradictory statements explicitly.
  * Clearly indicate that these statements are contradictory.
  * Do not choose one version; include them all so the user can decide.
  * Example: "Entity A is described as X [[id1]]. However, Entity A is also described as Y [[id2]]. These statements are contradictory."
- If no source ID applies to a statement, do not include that statement.
- If you cannot find an answer, respond with: "I don't know, but you can provide new sources with that information." in the language of the user.
- If the question is not related to the data, respond with: "There is no information available." in the language of the user.

# Immediate Task Description or Request
Your goal is to provide the most complete, accurate, and source-grounded answer
possible for each user question, strictly following the Exploration Workflow
and citation rules.

# Thinking Step by Step
Before answering, you must:
1. Understand the question and, if needed, the graph structure (Step 1).
2. Find all relevant entities (Step 2).
3. Find all relevant relationships (Step 3).
4. Explore their connections (Step 4).
5. Explore indirect connections when needed (Step 5).
6. Gather all necessary sources for citations (Step 6).
7. Only then synthesize the final answer (Step 7).

Never skip steps or rely on partial data. Do not provide a final answer until
this full process is complete and you are sure you explored all possibilities.

# Output Formatting
- Provide only the direct answer (no introduction or conclusion).
- Use Markdown formatting.
- Always respond in the same language as the question.
- **Never leak internal IDs or Names:** Do not include any internal Entity/Relationship IDs or Names in your answer. Only use the Names and IDs found in the text sentences and Sources IDs for citations.**
- **When referencing an entity or relationship never leak its id. Use a user friendly name (language of the user).**
- **Only use the ids of sources provided by the data or chat history for citing. Wrap it in [[]].**
`

const NoDataPrompt = `
# Task Context
You are a helpful assistant. The user asked a question, but no relevant information was found in the knowledge base.

# Background Data
User's question: %s

# Detailed Task Description & Rules
- Generate a brief, helpful response explaining that no relevant information is available in the knowledge base.
- Do not apologize excessively. Be concise and direct.
- Do not invent or hallucinate any information.
- Suggest that the user could provide additional sources if they want this information to be available.

# Output Formatting
- Respond in the SAME LANGUAGE as the user's question.
- Keep the response short (1-2 sentences).
- Do not use markdown formatting.
`

const MetadataPrompt = `
# Task Context
You are a document analysis assistant that extracts comprehensive metadata from document content.

# Input Data
- File Name: %s

## Document Header (if present):
%s

## Document Footer (if present):
%s

## Document Signature Section (if present):
%s

## Document Content (first 500 words):
%s

# Task
Analyze all provided sections and extract comprehensive metadata about this document.

Consider and include any of the following that are relevant:
- Document type (e.g., contract, invoice, technical manual, correspondence, report, legal filing, policy document, meeting minutes, ordinance, citizen request, memo, proposal, etc.)
- Date(s) - creation date, effective date, signing date, filing date, reception date, etc.
- Topic or subject matter
- Legal or binding nature (if this is a legally binding document such as a contract, agreement, ordinance)
- Technical classification (if this is a technical document, specification, manual)
- Confidentiality or sensitivity level (if indicated)
- Document status (draft, final, amended, signed, etc.)
- Geographic or jurisdictional relevance
- Any reference numbers, case numbers, file numbers, or identifiers
- Purpose of the document
- Author or sender information
- Recipient information

# Output Format
Provide a single-line, compact set of labeled fields separated by semicolons. Use short labels, omit any fields that are not supported by the content, and do not speculate.

Example:
Type: contract; Date: 2023-04-01; Topic: procurement policy; Status: final; Jurisdiction: Berlin; Ref: DP-2023-14
`
