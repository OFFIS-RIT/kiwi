import { beforeEach, describe, expect, test } from "vitest";

import { getLastAppPath, recordLastAppPath } from "./last-app-path";

const KEY = "kiwi-last-app-path";

describe("last-app-path", () => {
    beforeEach(() => {
        window.sessionStorage.clear();
    });

    test("records an in-app path and returns it", () => {
        recordLastAppPath("/team1/project2");
        expect(getLastAppPath()).toBe("/team1/project2");
    });

    test("does not record settings paths (keeps the previous in-app path)", () => {
        recordLastAppPath("/groups");
        recordLastAppPath("/settings?section=appearance");
        expect(getLastAppPath()).toBe("/groups");
    });

    test("returns null when nothing has been recorded", () => {
        expect(getLastAppPath()).toBeNull();
    });

    test("rejects non-relative, protocol-relative, or settings values from storage", () => {
        window.sessionStorage.setItem(KEY, "https://evil.com");
        expect(getLastAppPath()).toBeNull();

        window.sessionStorage.setItem(KEY, "//evil.com");
        expect(getLastAppPath()).toBeNull();

        window.sessionStorage.setItem(KEY, "/settings");
        expect(getLastAppPath()).toBeNull();
    });
});
