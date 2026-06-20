import * as Effect from "effect/Effect";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadTextUnitWithFile, toTextUnitRecord } from "../../../lib/text-unit-record";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";

export function getTextUnit(input: { user: AuthUser; graphId: string; unitId: string }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                yield* assertCanViewGraph(input.user, input.graphId);

                const unit = yield* loadTextUnitWithFile(input.graphId, input.unitId);
                if (!unit) {
                    return yield* Effect.fail(
                        makeApiError(404, API_ERROR_CODES.TEXT_UNIT_NOT_FOUND, "Text unit not found")
                    );
                }

                return toTextUnitRecord(input.graphId, unit);
            }),
            (defect) => Effect.fail(defect)
        ),
        toApiError
    );
}
