import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { DatabaseError } from "../effect";

describe("DatabaseError", () => {
    test("uses the namespaced Effect tag consumed by API recovery", async () => {
        const recovered = await Effect.runPromise(
            Effect.gen(function* () {
                return yield* new DatabaseError({ cause: "boom" });
            }).pipe(
                Effect.catchTag("@kiwi/db/DatabaseError", (error) =>
                    Effect.succeed({ tag: error._tag, message: error.message })
                )
            )
        );

        expect(recovered).toEqual({ tag: "@kiwi/db/DatabaseError", message: "Database operation failed" });
    });
});
