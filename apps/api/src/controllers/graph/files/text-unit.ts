import * as Effect from "effect/Effect";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import type { TextUnitRecord } from "@kiwi/contracts/graphs";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadTextUnitWithFile, toTextUnitRecord } from "../../../lib/text-unit-record";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function getTextUnit(input: { user: AuthUser; graphId: string; unitId: string }) {
    return tryApiPromise(async (): Promise<TextUnitRecord> => {
        await Effect.runPromise(assertCanViewGraph(input.user, input.graphId));

        const unit = await Effect.runPromise(loadTextUnitWithFile(input.graphId, input.unitId));
        if (!unit) {
            throw makeApiError(404, API_ERROR_CODES.TEXT_UNIT_NOT_FOUND, "Text unit not found");
        }

        return toTextUnitRecord(input.graphId, unit);
    });
}
