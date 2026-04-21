import { tool } from "ai";
import { z } from "zod";

const askQuestionSchema = z.object({
    questions: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(3)
        .describe("Up to 3 short questions to show to the user. Ask only what is required to continue."),
    reason: z
        .string()
        .trim()
        .describe("Optional short explanation shown to the user about why these questions are needed.")
        .optional(),
});

export const askQuestionTool = () =>
    tool({
        description:
            "Ask the user up to 3 clarification questions when required information is missing and cannot be reliably inferred from the graph, sources, or prior messages. This is a client-executed tool: call it to display questions to the user, then continue only after the user's answers are returned as the tool result.",
        inputSchema: askQuestionSchema,
    });

const tools = {
    ask_clarifying_questions: askQuestionTool,
};

export default tools;
