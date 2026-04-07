import { describe, expect, test } from "bun:test";
import { normalizeKeyvals } from "../normalize";

describe("normalizeKeyvals", () => {
    test("normalizes scalar values", () => {
        const payload = normalizeKeyvals(["userId", "123", "attempt", 2, "ok", true, "value", null]);

        expect(payload.invalidKeyvals).toBeFalse();
        expect(payload.attributes).toEqual({
            userId: "123",
            attempt: 2,
            ok: true,
            value: null,
        });
    });

    test("normalizes dates and structured values", () => {
        const date = new Date("2026-04-07T10:00:00.000Z");
        const payload = normalizeKeyvals(["at", date, "meta", { source: "api" }, "tags", ["a", "b"]]);

        expect(payload.attributes).toEqual({
            at: "2026-04-07T10:00:00.000Z",
            meta: JSON.stringify({ source: "api" }),
            tags: JSON.stringify(["a", "b"]),
        });
    });

    test("flattens errors", () => {
        const error = new Error("boom");
        error.name = "BoomError";

        const payload = normalizeKeyvals(["error", error]);

        expect(payload.attributes["error.name"]).toBe("BoomError");
        expect(payload.attributes["error.message"]).toBe("boom");
        expect(payload.attributes["error.stack"]).toBeString();
    });

    test("drops undefined values", () => {
        const payload = normalizeKeyvals(["optional", undefined, "required", "ok"]);

        expect(payload.attributes).toEqual({
            required: "ok",
        });
    });

    test("marks odd keyvals", () => {
        const payload = normalizeKeyvals(["userId", "123", "orphan"]);

        expect(payload.invalidKeyvals).toBeTrue();
        expect(payload.attributes["log.invalid_keyvals"]).toBeTrue();
        expect(payload.attributes["log.unpaired_value"]).toBe("orphan");
    });
});
