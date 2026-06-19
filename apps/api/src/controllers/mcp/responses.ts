export function mcpJsonRpcErrorResponse(status: number, code: number, message: string) {
    return new Response(
        JSON.stringify({
            jsonrpc: "2.0",
            error: {
                code,
                message,
            },
            id: null,
        }),
        {
            status,
            headers: {
                "content-type": "application/json",
            },
        }
    );
}
