import * as Effect from "effect/Effect";
import { API_ERROR_CODES, internalServerError, makeApiError } from "@kiwi/contracts/errors";
import { error as logError } from "@kiwi/logger";
import { env } from "../../../env";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { getOrRenderPDFPreviewPage } from "../../../lib/pdf-preview-cache";
import { getPdfPreviewPageNumbers, parsePageImageParam } from "../../../lib/text-unit-preview";
import { loadTextUnitWithFile } from "../../../lib/text-unit-record";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";

export function renderTextUnitPage(input: { user: AuthUser; graphId: string; unitId: string; page: string }) {
    return Effect.mapError(Effect.catchDefect(Effect.gen(function* () {
        const page = parsePageImageParam(input.page);
        if (page === null) {
            return yield* Effect.fail(makeApiError(404, API_ERROR_CODES.TEXT_UNIT_NOT_FOUND, "Text unit not found"));
        }

        yield* assertCanViewGraph(input.user, input.graphId);

        const unit = yield* loadTextUnitWithFile(input.graphId, input.unitId);
        if (!unit) {
            return yield* Effect.fail(makeApiError(404, API_ERROR_CODES.TEXT_UNIT_NOT_FOUND, "Text unit not found"));
        }
        if (unit.file_type !== "pdf") {
            return yield* Effect.fail(makeApiError(415, API_ERROR_CODES.UNSUPPORTED_FILE_TYPE, "Unsupported file type"));
        }

        const startPage = unit.start_page;
        const endPage = unit.end_page;
        if (startPage === null || endPage === null || page < startPage || page > endPage) {
            return yield* Effect.fail(makeApiError(422, API_ERROR_CODES.INVALID_PAGE_RANGE, "Invalid page range"));
        }

        const previewResult = yield* Effect.matchEffect(
            getOrRenderPDFPreviewPage({
                graphId: input.graphId,
                fileId: unit.project_file_id,
                fileKey: unit.file_key,
                page,
                pagesToRender: getPdfPreviewPageNumbers(startPage, endPage),
                bucket: env.S3_BUCKET,
            }),
            {
                onFailure: (error) =>
                    Effect.gen(function* () {
                        logError("failed to render PDF text unit preview", {
                            graphId: input.graphId,
                            unitId: input.unitId,
                            fileId: unit.project_file_id,
                            page,
                            error,
                        });

                        return yield* Effect.fail(internalServerError("Failed to render PDF preview"));
                    }),
                onSuccess: Effect.succeed,
            }
        );

        if (previewResult.status === "source_missing") {
            return yield* Effect.fail(makeApiError(404, API_ERROR_CODES.INVALID_FILE_IDS, "File not found"));
        }
        if (previewResult.status === "page_missing") {
            return yield* Effect.fail(makeApiError(404, API_ERROR_CODES.INVALID_PAGE_RANGE, "PDF preview page not found"));
        }

        return previewResult.content;
    }), (defect) => Effect.fail(defect)), toApiError);
}
