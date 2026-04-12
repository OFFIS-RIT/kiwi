/**
 * Centralized API client with consistent error handling and request configuration.
 * All API requests go through this module to ensure consistent authentication and error handling.
 * @module api/client
 */

import { authClient } from "@kiwi/auth/client";
import type { ApiErrorCode, ApiResponse, ErrorResponse, SuccessfulResponse } from "@kiwi/api/types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

/**
 * Custom error class for API failures with detailed status information.
 */
export class ApiError extends Error {
    constructor(
        message: string,
        public status: number,
        public statusText: string,
        public body?: string,
        public code?: ApiErrorCode,
        public response?: ErrorResponse
    ) {
        super(message);
        this.name = "ApiError";
    }
}

/**
 * Request configuration options.
 */
type RequestOptions = {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
    isFormData?: boolean;
};

function tryParseJson<T>(value: string): T | null {
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

function isErrorResponse(value: unknown): value is ErrorResponse {
    return !!value && typeof value === "object" && "status" in value && "message" in value && "code" in value;
}

/**
 * Core fetch wrapper with authentication and error handling
 */
async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, headers = {}, isFormData = false } = options;

    const requestHeaders: Record<string, string> = {
        ...headers,
    };

    // Don't set Content-Type for FormData - browser will set it with boundary
    if (!isFormData && body) {
        requestHeaders["Content-Type"] = "application/json";
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method,
        credentials: "include",
        headers: requestHeaders,
        body: isFormData ? (body as FormData) : body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
        if (response.status === 401) {
            void authClient.signOut();
        }
        const errorBody = await response.text().catch(() => "");
        const parsedError = errorBody ? tryParseJson<ErrorResponse>(errorBody) : null;
        if (errorBody) {
            console.error(`API Error [${endpoint}]:`, errorBody);
        }
        throw new ApiError(
            isErrorResponse(parsedError) ? parsedError.message : `Request failed: ${response.statusText}`,
            response.status,
            response.statusText,
            errorBody,
            isErrorResponse(parsedError) ? parsedError.code : undefined,
            isErrorResponse(parsedError) ? parsedError : undefined
        );
    }

    // Handle 204 No Content
    if (response.status === 204) {
        return null as T;
    }

    return response.json();
}

/**
 * Typed API client with methods for common HTTP operations.
 * Automatically handles authentication, JSON serialization, and error handling.
 */
export const apiClient = {
    get: <T>(endpoint: string) => request<T>(endpoint),

    post: <T>(endpoint: string, body?: unknown) => request<T>(endpoint, { method: "POST", body }),

    postFormData: <T>(endpoint: string, formData: FormData) =>
        request<T>(endpoint, { method: "POST", body: formData, isFormData: true }),

    sendFormDataWithProgress: <T>(
        method: "POST" | "PATCH",
        endpoint: string,
        formData: FormData,
        onProgress?: (progress: number, loaded: number, total: number) => void
    ) => {
        return new Promise<T>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method, `${API_BASE_URL}${endpoint}`);
            xhr.withCredentials = true;

            if (onProgress) {
                xhr.upload.onprogress = (event) => {
                    if (event.lengthComputable) {
                        const percentComplete = (event.loaded / event.total) * 100;
                        onProgress(percentComplete, event.loaded, event.total);
                    }
                };
            }

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    if (xhr.status === 204) {
                        resolve(null as T);
                        return;
                    }
                    try {
                        const response = JSON.parse(xhr.responseText);
                        resolve(response);
                    } catch {
                        resolve(xhr.responseText as unknown as T);
                    }
                } else {
                    if (xhr.status === 401) {
                        void authClient.signOut();
                    }
                    const parsedError = tryParseJson<ErrorResponse>(xhr.responseText);
                    reject(
                        new ApiError(
                            isErrorResponse(parsedError) ? parsedError.message : `Request failed: ${xhr.statusText}`,
                            xhr.status,
                            xhr.statusText,
                            xhr.responseText,
                            isErrorResponse(parsedError) ? parsedError.code : undefined,
                            isErrorResponse(parsedError) ? parsedError : undefined
                        )
                    );
                }
            };

            xhr.onerror = () => {
                reject(new Error("Network request failed"));
            };

            xhr.send(formData);
        });
    },

    postFormDataWithProgress: <T>(
        endpoint: string,
        formData: FormData,
        onProgress?: (progress: number, loaded: number, total: number) => void
    ) => apiClient.sendFormDataWithProgress<T>("POST", endpoint, formData, onProgress),

    patchFormDataWithProgress: <T>(
        endpoint: string,
        formData: FormData,
        onProgress?: (progress: number, loaded: number, total: number) => void
    ) => apiClient.sendFormDataWithProgress<T>("PATCH", endpoint, formData, onProgress),

    patch: <T>(endpoint: string, body: unknown) => request<T>(endpoint, { method: "PATCH", body }),

    delete: <T>(endpoint: string, body?: unknown) => request<T>(endpoint, { method: "DELETE", body }),
};

export function unwrapApiResponse<T>(response: ApiResponse<T>): T {
    return (response as SuccessfulResponse<T>).data;
}

/**
 * A parsed SSE frame with event type and JSON data.
 */
export type SSEFrame = {
    event: string;
    data: unknown;
};

/**
 * Real SSE parser that reads `event:` + `data:` frames from a streaming response.
 * Supports multi-line `data:` fields. Dispatches on blank line (per SSE spec).
 * Handles EOF gracefully even without a `done` event.
 *
 * @param endpoint - API endpoint path
 * @param body - Request body to send as JSON
 * @param onEvent - Callback invoked for each parsed SSE frame
 * @param onError - Optional error callback
 * @returns Promise that resolves when the stream ends
 */
export async function streamSSERequest(
    endpoint: string,
    body: unknown,
    onEvent: (frame: SSEFrame) => void,
    onError?: (error: Error) => void
): Promise<void> {
    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            if (response.status === 401) {
                void authClient.signOut();
            }
            const errorBody = await response.text().catch(() => "");
            console.error(`SSE Error [${endpoint}]:`, errorBody);
            throw new ApiError(
                `SSE request failed: ${response.statusText}`,
                response.status,
                response.statusText,
                errorBody
            );
        }

        if (!response.body) {
            throw new Error("Response body is null");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";
        let currentDataLines: string[] = [];

        const dispatchEvent = () => {
            if (currentDataLines.length === 0 && !currentEvent) return;

            const rawData = currentDataLines.join("\n");
            const eventType = currentEvent || "message";

            let parsedData: unknown;
            try {
                parsedData = rawData ? JSON.parse(rawData) : {};
            } catch {
                // If data isn't valid JSON, pass it as a string
                parsedData = rawData;
            }

            onEvent({ event: eventType, data: parsedData });

            // Reset for next frame
            currentEvent = "";
            currentDataLines = [];
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (line === "") {
                        // Blank line = end of SSE frame, dispatch
                        dispatchEvent();
                    } else if (line.startsWith("event:")) {
                        currentEvent = line.slice(6).trim();
                    } else if (line.startsWith("data:")) {
                        currentDataLines.push(line.slice(5).trimStart());
                    } else if (line.startsWith(":")) {
                        // SSE comment, ignore
                    }
                }
            }

            // Handle any remaining buffered event at EOF
            if (currentDataLines.length > 0 || currentEvent) {
                dispatchEvent();
            }
        } finally {
            reader.releaseLock();
        }
    } catch (error) {
        const err = error instanceof Error ? error : new Error("Unknown error");
        onError?.(err);
        throw err;
    }
}

export { API_BASE_URL };
