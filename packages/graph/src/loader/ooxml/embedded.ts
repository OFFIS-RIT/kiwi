const EMBEDDED_OFFICE_DOCUMENT_PATTERN = /\.(?:docx|pptx|xlsx)$/i;

export type EmbeddedOfficeDocumentReaderOptions = {
    depth: number;
    markdown?: boolean;
};

type EmbeddedOfficeDocumentReader = (
    content: ArrayBuffer,
    options: EmbeddedOfficeDocumentReaderOptions
) => Promise<string>;

export function isEmbeddedOfficeDocumentType(contentType: string, partPath: string): boolean {
    return (
        contentType.includes("wordprocessingml.document") ||
        contentType.includes("presentationml.presentation") ||
        contentType.includes("spreadsheetml.sheet") ||
        EMBEDDED_OFFICE_DOCUMENT_PATTERN.test(partPath)
    );
}

export async function extractEmbeddedOfficeDocumentText(args: {
    content: ArrayBuffer;
    partPath: string;
    contentType?: string;
    depth: number;
    markdown?: boolean;
    maxDepth?: number;
    readers: {
        docx?: EmbeddedOfficeDocumentReader;
        pptx?: EmbeddedOfficeDocumentReader;
        xlsx?: EmbeddedOfficeDocumentReader;
    };
}): Promise<string> {
    if (args.depth >= (args.maxDepth ?? 2)) {
        return "";
    }

    const nextOptions = {
        depth: args.depth + 1,
        markdown: args.markdown,
    } satisfies EmbeddedOfficeDocumentReaderOptions;
    const kind = detectEmbeddedOfficeDocumentKind(args.partPath, args.contentType);

    switch (kind) {
        case "docx":
            return args.readers.docx ? args.readers.docx(args.content, nextOptions) : "";
        case "pptx":
            return args.readers.pptx ? args.readers.pptx(args.content, nextOptions) : "";
        case "xlsx":
            return args.readers.xlsx ? args.readers.xlsx(args.content, nextOptions) : "";
        default:
            return "";
    }
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function detectEmbeddedOfficeDocumentKind(
    partPath: string,
    contentType?: string
): "docx" | "pptx" | "xlsx" | null {
    const normalizedContentType = contentType?.toLowerCase() ?? "";
    if (normalizedContentType.includes("wordprocessingml.document")) {
        return "docx";
    }

    if (normalizedContentType.includes("presentationml.presentation")) {
        return "pptx";
    }

    if (normalizedContentType.includes("spreadsheetml.sheet")) {
        return "xlsx";
    }

    const extension = partPath.split(".").at(-1)?.toLowerCase();
    switch (extension) {
        case "docx":
        case "pptx":
        case "xlsx":
            return extension;
        default:
            return null;
    }
}
