export const descriptionPromp = (name: string, descriptions: string[]) => `
# Task Context
You are a highly detail-oriented assistant responsible for creating a complete and comprehensive summary based only on the information provided below.

# Background Data
-- Data --
entity_name: ${name}
entity_descriptions:
${descriptions.join("\n")}

# Detailed Task Description & Rules
- The input consists of multiple descriptive segments related to the same entity or its relationships.
- Your task is to merge these into one unified description that includes every relevant detail from the segments, without omitting anything important.
- Do not leave out any specific detail, especially about actions, events, quantities, frequencies, or timelines (e.g., if races are mentioned, include how often they occurred, when, and under what conditions).
- If the descriptions contain overlapping information, merge them into a single coherent narrative.
- If there are contradictions, include both versions clearly.
- Use third person at all times and explicitly include entity names to preserve full context.
- The description must be short and compact: at most 100 words, preferably one to four clear sentences.
- Only use the information given in the segments. Do not infer, assume, or add external knowledge.
- For non-English technical, legal, or domain-specific terms, keep the original term and add a short English explanation in parentheses (e.g., "Hundesteuer (dog license fee)"). Do not translate every non-English word; apply this only to specialized terms.

# Output Formatting
- Return plain text only. Do not use markdown, lists, bullet points, or meta-comments.
- Do not add introductions, explanations, or closing remarks. Output only the final comprehensive description.
`;

export const updateDescriptionPromp = (name: string, descriptions: string[], currentDescription: string) => `
# Task Context
You are a highly detail-oriented assistant responsible for updating an existing summary with new information.

# Background Data
-- Data --
**entity_name:** ${name}
**current_description:**
${currentDescription}
**new_entity_descriptions:**
${descriptions.join("\n")}

# Detailed Task Description & Rules
- You are given an existing description and new descriptive segments for the same entity.
- Merge the new information into the existing description, creating one unified description.
- Give equal weight to existing and new information - revise as needed based on new details.
- Do not leave out any specific detail from either the existing description or new segments.
- If there are contradictions, include both versions clearly.
- Use third person at all times and explicitly include entity names to preserve full context.
- The description must be short and compact: at most 100 words, preferably one to four clear sentences.
- Only use the information given. Do not infer, assume, or add external knowledge.
- For non-English technical, legal, or domain-specific terms, keep the original term and add a short English explanation in parentheses (e.g., "Hundesteuer (dog license fee)"). Do not translate every non-English word; apply this only to specialized terms.

# Output Formatting
- Return plain text only. Do not use markdown, lists, bullet points, or meta-comments.
- Do not add introductions, explanations, or closing remarks. Output only the final comprehensive description.
`;
