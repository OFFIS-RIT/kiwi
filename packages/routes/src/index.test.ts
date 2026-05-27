import { describe, expect, test } from "bun:test";
import { getProjectFileProxyPath } from ".";

describe("project file proxy paths", () => {
    test("builds filename-bearing page-aware paths", () => {
        expect(
            getProjectFileProxyPath("graph 1", "file/1", {
                fileName: "Water report #1.pdf",
                page: 5,
            })
        ).toBe("/graphs/graph%201/files/file%2F1/Water%20report%20%231.pdf#page=5");
    });

    test("adds tokens before page fragments", () => {
        expect(
            getProjectFileProxyPath("graph-1", "file-1", {
                fileName: "source.pdf",
                page: 3,
                token: "abc.123",
            })
        ).toBe("/graphs/graph-1/files/file-1/source.pdf?token=abc.123#page=3");
    });

    test("omits invalid page fragments", () => {
        expect(getProjectFileProxyPath("graph-1", "file-1", { page: 0 })).toBe("/graphs/graph-1/files/file-1");
    });
});
