export type RequestInformation = {
    currentDate?: string;
    currentWeekday?: string;
    userName?: string;
};

const PROMPT_LINE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

function formatUtcDate(date: Date) {
    const year = date.getUTCFullYear();
    const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
    const day = `${date.getUTCDate()}`.padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function sanitizePromptLine(value?: string | null) {
    return value?.replace(PROMPT_LINE_CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

export function createRequestInformation(options: { now?: Date; userName?: string | null } = {}): RequestInformation {
    const now = options.now ?? new Date();
    const userName = sanitizePromptLine(options.userName);

    return {
        currentDate: formatUtcDate(now),
        currentWeekday: new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(now),
        ...(userName ? { userName } : {}),
    };
}

export function createRequestInformationSection(info?: RequestInformation) {
    if (!info) {
        return [];
    }

    const lines = [
        info.currentDate ? `Current date: ${info.currentDate}` : undefined,
        info.currentWeekday ? `Current weekday: ${info.currentWeekday}` : undefined,
        info.userName ? `Requesting user: ${info.userName}` : undefined,
    ].filter((line): line is string => typeof line === "string");

    return lines.length > 0 ? ["## Request information", ...lines] : [];
}
