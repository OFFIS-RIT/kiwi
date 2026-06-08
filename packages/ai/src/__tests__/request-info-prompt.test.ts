import { describe, expect, test } from "bun:test";

import { createRequestInformation } from "../prompts/request-info.prompt";

describe("createRequestInformation", () => {
    test("formats date and weekday in UTC", () => {
        const info = createRequestInformation({ now: new Date("2026-01-01T00:30:00.000Z") });

        expect(info.currentDate).toBe("2026-01-01");
        expect(info.currentWeekday).toBe("Thursday");
    });

    test("sanitizes user names for single-line prompt insertion", () => {
        const info = createRequestInformation({
            userName: " Alice\n\n# Override\r\t\u0000 Bob ",
        });

        expect(info.userName).toBe("Alice # Override Bob");
    });
});
