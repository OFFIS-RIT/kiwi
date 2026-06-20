import * as Effect from "effect/Effect";
import { getDefaultModelOrganizationId } from "@kiwi/ai/models";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { resolveGraphOwnerRoot } from "../../lib/graph/access";
import type { UploadFileTypeCheck } from "../../lib/graph/route";

export type NewGraphOwner =
    | {
          ownerMode: "team";
          organizationId: string;
          teamId: string;
      }
    | {
          ownerMode: "organization";
          organizationId: string;
      }
    | {
          ownerMode: "graph";
          graphId: string;
      };

export function archiveUploadError(expanded: {
    ok: false;
    kind: "unsupported" | "limit";
    fileName: string;
    message: string;
}) {
    if (expanded.kind === "limit") {
        return makeApiError(413, API_ERROR_CODES.UPLOAD_LIMIT_EXCEEDED, `${expanded.fileName}: ${expanded.message}`);
    }

    return makeApiError(415, API_ERROR_CODES.UNSUPPORTED_FILE_TYPE, `${expanded.fileName}: ${expanded.message}`);
}

export function getGraphOwnerModelOrganizationId(owner: NewGraphOwner) {
    return Effect.gen(function* () {
        if (owner.ownerMode !== "graph") {
            return owner.organizationId;
        }

        const rootOwner = yield* resolveGraphOwnerRoot(owner.graphId);
        if (rootOwner.mode === "user") {
            return yield* getDefaultModelOrganizationId();
        }

        return rootOwner.organizationId;
    });
}

export function unsupportedUploadError(check: Extract<UploadFileTypeCheck, { ok: false }>) {
    return makeApiError(415, API_ERROR_CODES.UNSUPPORTED_FILE_TYPE, `${check.fileName}: ${check.message}`);
}
