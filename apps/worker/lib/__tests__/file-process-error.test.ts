import { describe, expect, test } from "bun:test";

import { classifyFileProcessError } from "../file-process-error";

describe("classifyFileProcessError", () => {
    test("does not classify infrastructure timeout errors as file complexity", () => {
        expect(classifyFileProcessError(new Error("Postgres connection timeout"))).toBe("INTERNAL_SERVER_ERROR");
        expect(classifyFileProcessError(new Error("S3 request timeout while fetching object"))).toBe(
            "INTERNAL_SERVER_ERROR"
        );
    });

    test("does not classify connection pool pressure as file complexity", () => {
        expect(classifyFileProcessError(new Error("remaining connection slots are reserved: too many connections"))).toBe(
            "INTERNAL_SERVER_ERROR"
        );
    });

    test("classifies file-scoped size and complexity errors", () => {
        expect(classifyFileProcessError(new Error("File too large for extraction"))).toBe("FILE_TOO_LARGE_OR_COMPLEX");
        expect(classifyFileProcessError(new Error("Too many rows in worksheet"))).toBe("FILE_TOO_LARGE_OR_COMPLEX");
        expect(classifyFileProcessError(new Error("Model context length exceeded"))).toBe("FILE_TOO_LARGE_OR_COMPLEX");
    });
});
