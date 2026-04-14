import { error as logError } from "@kiwi/logger";
import { Result } from "better-result";

type ToolRunOptions = {
    title: string;
    name: string;
    hints: string[];
};

function describeFailure(error: unknown) {
    if (error instanceof Error && /^Invalid .* cursor$/iu.test(error.message)) {
        return {
            summary: "the provided cursor is invalid for this lookup",
            hints: [
                "retry without a cursor to restart from the first page",
                "reuse cursors only with the same query and filters",
            ],
        };
    }

    return {
        summary: "the lookup could not be completed",
        hints: [],
    };
}

export async function runToolSafely(
    options: ToolRunOptions,
    run: () => Promise<string>
): Promise<string> {
    const result = await Result.tryPromise(run);

    if (result.isErr()) {
        logError("ai tool execution failed", { toolName: options.name, error: result.error });

        const failure = describeFailure(result.error);
        const hints = [...failure.hints, ...options.hints].filter(
            (hint, index, array) => array.indexOf(hint) === index
        );

        return [
            `## ${options.title}`,
            `- unavailable: ${failure.summary}`,
            ...hints.map((hint) => `- hint: ${hint}`),
        ].join("\n");
    }

    return result.value;
}
