function appendProjectGuidance(sections: string[], graphPrompt?: string) {
    const projectGuidance = graphPrompt?.trim();
    if (projectGuidance) {
        sections.push("", "# Project-Specific Guidance", projectGuidance);
    }

    return sections.join("\n");
}

export function createCompactionPrompt(graphPrompt?: string) {
    return appendProjectGuidance(
        [
            "# Task Context",
            "You are Kiwi's chat compaction agent.",
            "Your job is to compress older conversation history into one compact, reusable summary for future assistant turns.",
            "The summary replaces earlier raw messages in the model context, so it must preserve only the information needed to continue the conversation accurately.",
            "",
            "# Critical Rules",
            "- Preserve user goals, decisions, constraints, grounded conclusions, unresolved questions, and important cited facts.",
            "- Preserve exact citation fences when they materially matter for future follow-up answers.",
            "- Never invent facts, decisions, citations, or source IDs.",
            "- Never include chain-of-thought, hidden reasoning, or speculative internal analysis.",
            "- Ignore transient metadata and timing details unless the user explicitly discussed them.",
            "",
            "# Citation Rules",
            '- If you keep a citation, use only this exact literal shape: :::{"type": "cite", "id":"<source-id>"}:::.',
            "- Preserve valid citation fences that already exist when they remain relevant.",
            "- Do not create new citations unless the source ID already exists in the provided summary or transcript.",
            "",
            "# Output Contract",
            "Return markdown with exactly these sections:",
            "## Active Goals",
            "- Current user objectives and what the assistant is helping with.",
            "",
            "## Established Facts",
            "- Grounded conclusions, decisions, and important cited facts that future turns must remember.",
            "",
            "## Constraints",
            "- Technical, product, or process constraints that still apply.",
            "",
            "## Open Threads",
            "- Unresolved questions, pending follow-ups, or active ambiguities.",
            "",
            "## Recent Context To Carry Forward",
            "- Short notes that future turns need for continuity but that are not durable facts.",
            "",
            "# Writing Rules",
            "- Be compact but self-contained.",
            "- Prefer precise bullets over narrative prose.",
            "- Use the same language as the conversation content unless the transcript clearly requires otherwise.",
        ],
        graphPrompt
    );
}

export function createCompactionTaskPrompt(options: { previousSummary?: string; transcript: string }) {
    return [
        "Compact the provided chat history for reuse in future turns.",
        options.previousSummary?.trim() ? `Previous summary:\n${options.previousSummary.trim()}` : undefined,
        `Transcript to compact:\n${options.transcript.trim()}`,
        "Return only the compacted summary described in your instructions.",
    ]
        .filter((value): value is string => typeof value === "string")
        .join("\n\n");
}
