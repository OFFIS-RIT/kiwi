type BinaryResponseOptions = {
    contentType: string;
    cacheControl?: string;
};

export function binaryResponse(content: Uint8Array, options: BinaryResponseOptions): Response {
    return new Response(content as unknown as BodyInit, {
        status: 200,
        headers: {
            "Cache-Control": options.cacheControl ?? "private, max-age=86400",
            "Content-Length": String(content.byteLength),
            "Content-Type": options.contentType,
            "X-Content-Type-Options": "nosniff",
        },
    });
}
