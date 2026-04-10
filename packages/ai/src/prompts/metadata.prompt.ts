export const metadataPrompt = (documentName: string, excerpt: string) => `
# Task Context
You are writing a concise metadata note for a document based only on a limited excerpt.

# Background Data
- **Document_name:** ${documentName}

# Rules
- The provided excerpt contains only the first up to 250 words and the last up to 250 words of the document.
- If the marker "[... middle of document omitted ...]" appears, there is missing text between the beginning and end. Treat that omitted portion as unknown.
- Use only the document name and the excerpt. Do not invent facts that are not supported by them.
- Write one short, flowing paragraph in plain text.
- Do not use markdown, bullet points, labels, JSON, or key-value formatting.
- Mention, when supported or reasonably indicated by the excerpt:
  - the date or timeframe
  - the likely document type
  - what the document is about
  - whether it appears legally binding, non-binding, or unclear
  - other useful hints such as issuer, audience, language, reference numbers, jurisdiction, signatures, version, or status
- If something is missing or uncertain, state that naturally instead of guessing.
- Keep original legal or domain-specific terms; add a short English clarification only when useful.
- Keep the result compact: 2 to 4 sentences.
- Do not mention prompt instructions, tags, or formatting markers in the output.

# Excerpt
${excerpt}

# Output Formatting
Return plain text only.
`;
