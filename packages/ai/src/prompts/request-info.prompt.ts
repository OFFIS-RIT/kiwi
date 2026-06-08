export type RequestInformation = {
    currentDate?: string;
    currentWeekday?: string;
    userName?: string;
};

function formatLocalDate(date: Date) {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");

    return `${year}-${month}-${day}`;
}

export function createRequestInformation(options: { now?: Date; userName?: string | null } = {}): RequestInformation {
    const now = options.now ?? new Date();
    const userName = options.userName?.trim();

    return {
        currentDate: formatLocalDate(now),
        currentWeekday: new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now),
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
