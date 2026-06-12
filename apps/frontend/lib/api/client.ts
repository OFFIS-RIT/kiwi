import type { KiwiAuthClient } from "@kiwi/auth/client";
import type { ApiErrorCode, ApiResponse, ErrorResponse, SuccessfulResponse } from "@kiwi/contracts";

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

type RequestOptions = {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
    isFormData?: boolean;
    suppressErrorLog?: (error: ApiError) => boolean;
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

export type KiwiApiClient = {
    baseURL: string;
    get: <T>(endpoint: string) => Promise<T>;
    getQuietly: <T>(endpoint: string, suppressErrorLog: (error: ApiError) => boolean) => Promise<T>;
    post: <T>(endpoint: string, body?: unknown) => Promise<T>;
    postFormData: <T>(endpoint: string, formData: FormData) => Promise<T>;
    sendFormDataWithProgress: <T>(
        method: "POST" | "PATCH",
        endpoint: string,
        formData: FormData,
        onProgress?: (progress: number, loaded: number, total: number) => void
    ) => Promise<T>;
    postFormDataWithProgress: <T>(
        endpoint: string,
        formData: FormData,
        onProgress?: (progress: number, loaded: number, total: number) => void
    ) => Promise<T>;
    patchFormDataWithProgress: <T>(
        endpoint: string,
        formData: FormData,
        onProgress?: (progress: number, loaded: number, total: number) => void
    ) => Promise<T>;
    patch: <T>(endpoint: string, body: unknown) => Promise<T>;
    delete: <T>(endpoint: string, body?: unknown) => Promise<T>;
};

export function createKiwiApiClient(baseURL: string, authClient: KiwiAuthClient): KiwiApiClient {
    async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
        const { method = "GET", body, headers = {}, isFormData = false, suppressErrorLog } = options;
        const requestHeaders: Record<string, string> = { ...headers };
        if (!isFormData && body) requestHeaders["Content-Type"] = "application/json";

        const response = await fetch(`${baseURL}${endpoint}`, {
            method,
            credentials: "include",
            headers: requestHeaders,
            body: isFormData ? (body as FormData) : body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            if (response.status === 401) void authClient.signOut();
            const errorBody = await response.text().catch(() => "");
            const parsedError = errorBody ? tryParseJson<ErrorResponse>(errorBody) : null;
            const apiError = new ApiError(
                isErrorResponse(parsedError) ? parsedError.message : `Request failed: ${response.statusText}`,
                response.status,
                response.statusText,
                errorBody,
                isErrorResponse(parsedError) ? parsedError.code : undefined,
                isErrorResponse(parsedError) ? parsedError : undefined
            );
            if (errorBody && !suppressErrorLog?.(apiError)) console.error(`API Error [${endpoint}]:`, errorBody);
            throw apiError;
        }

        if (response.status === 204) return null as T;
        return response.json();
    }

    const client: KiwiApiClient = {
        baseURL,
        get: (endpoint) => request(endpoint),
        getQuietly: (endpoint, suppressErrorLog) => request(endpoint, { suppressErrorLog }),
        post: (endpoint, body) => request(endpoint, { method: "POST", body }),
        postFormData: (endpoint, formData) => request(endpoint, { method: "POST", body: formData, isFormData: true }),
        sendFormDataWithProgress: <T>(
            method: "POST" | "PATCH",
            endpoint: string,
            formData: FormData,
            onProgress?: (progress: number, loaded: number, total: number) => void
        ) =>
            new Promise<T>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open(method, `${baseURL}${endpoint}`);
                xhr.withCredentials = true;
                if (onProgress) {
                    xhr.upload.onprogress = (event) => {
                        if (event.lengthComputable) {
                            onProgress((event.loaded / event.total) * 100, event.loaded, event.total);
                        }
                    };
                }
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        if (xhr.status === 204) return resolve(null as T);
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch {
                            resolve(xhr.responseText as unknown as T);
                        }
                    } else {
                        if (xhr.status === 401) void authClient.signOut();
                        const parsedError = tryParseJson<ErrorResponse>(xhr.responseText);
                        reject(
                            new ApiError(
                                isErrorResponse(parsedError)
                                    ? parsedError.message
                                    : `Request failed: ${xhr.statusText}`,
                                xhr.status,
                                xhr.statusText,
                                xhr.responseText,
                                isErrorResponse(parsedError) ? parsedError.code : undefined,
                                isErrorResponse(parsedError) ? parsedError : undefined
                            )
                        );
                    }
                };
                xhr.onerror = () => reject(new Error("Network request failed"));
                xhr.send(formData);
            }),
        postFormDataWithProgress: (endpoint, formData, onProgress) =>
            client.sendFormDataWithProgress("POST", endpoint, formData, onProgress),
        patchFormDataWithProgress: (endpoint, formData, onProgress) =>
            client.sendFormDataWithProgress("PATCH", endpoint, formData, onProgress),
        patch: (endpoint, body) => request(endpoint, { method: "PATCH", body }),
        delete: (endpoint, body) => request(endpoint, { method: "DELETE", body }),
    };

    return client;
}

export function unwrapApiResponse<T>(response: ApiResponse<T>): T {
    return (response as SuccessfulResponse<T>).data;
}
