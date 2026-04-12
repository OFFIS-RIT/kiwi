import { API_ERROR_CODES, errorResponse } from "../types";

type RouteStatus = (code: number, body: unknown) => unknown;

export function mapUnitError(status: RouteStatus, error: unknown) {
    if (!(error instanceof Error)) {
        return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }

    if (error.message === API_ERROR_CODES.TEXT_UNIT_NOT_FOUND) {
        return status(404, errorResponse("Text unit not found", API_ERROR_CODES.TEXT_UNIT_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.GRAPH_NOT_FOUND) {
        return status(404, errorResponse("Graph not found", API_ERROR_CODES.GRAPH_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.GROUP_NOT_FOUND) {
        return status(404, errorResponse("Group not found", API_ERROR_CODES.GROUP_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.INVALID_GRAPH_OWNER) {
        return status(400, errorResponse("Invalid graph owner chain", API_ERROR_CODES.INVALID_GRAPH_OWNER));
    }

    if (error.message === API_ERROR_CODES.FORBIDDEN) {
        return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
    }

    return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
}
