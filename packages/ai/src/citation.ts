import { jsonrepair } from "jsonrepair";

const CITATION_OPEN = ":::{";
const CITATION_CLOSE = ":::";
const STREAM_TOKEN_GUARD_LENGTH = CITATION_OPEN.length - 1;

export type CitationFence = {
  type: "cite";
  sourceId: string;
  unitId?: string;
  fileName?: string;
  fileKey?: string;
};

export type ResolvedCitationFence = CitationFence & {
  unitId: string;
  fileName: string;
  fileKey: string;
};

export type ParsedCitationSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "citation";
      citation: CitationFence;
      raw: string;
    };

export function isResolvedCitationFence(
  citation: CitationFence,
): citation is ResolvedCitationFence {
  return Boolean(citation.unitId && citation.fileName && citation.fileKey);
}

export function stringifyCitationFence(
  citation: CitationFence,
  options?: { forModel?: boolean },
) {
  const payload =
    options?.forModel || !isResolvedCitationFence(citation)
      ? { type: "cite", id: citation.sourceId }
      : {
          type: "cite",
          sourceId: citation.sourceId,
          unitId: citation.unitId,
          fileName: citation.fileName,
          fileKey: citation.fileKey,
        };

  return `:::${JSON.stringify(payload)}:::`;
}

export function parseCitationFence(rawFence: string): CitationFence | null {
  if (!rawFence.startsWith(":::") || !rawFence.endsWith(CITATION_CLOSE)) {
    return null;
  }

  const payload = rawFence.slice(3, -3).trim();
  if (!payload) {
    return null;
  }

  try {
    const repaired = jsonrepair(payload);
    const parsed = JSON.parse(repaired) as Record<string, unknown>;
    if (parsed.type !== "cite") {
      return null;
    }

    const sourceIdValue = parsed.sourceId ?? parsed.id;
    if (typeof sourceIdValue !== "string") {
      return null;
    }

    const sourceId = sourceIdValue.trim();
    if (sourceId.length === 0) {
      return null;
    }

    const unitId =
      typeof parsed.unitId === "string" && parsed.unitId.trim().length > 0
        ? parsed.unitId.trim()
        : undefined;
    const fileNameValue = parsed.fileName ?? parsed.filename;
    const fileName =
      typeof fileNameValue === "string" && fileNameValue.trim().length > 0
        ? fileNameValue.trim()
        : undefined;
    const fileKeyValue = parsed.fileKey ?? parsed.filekey;
    const fileKey =
      typeof fileKeyValue === "string" && fileKeyValue.trim().length > 0
        ? fileKeyValue.trim()
        : undefined;

    return {
      type: "cite",
      sourceId,
      unitId,
      fileName,
      fileKey,
    };
  } catch {
    return null;
  }
}

export function splitTextWithCitationFences(
  text: string,
): ParsedCitationSegment[] {
  const parser = createCitationFenceStreamParser();
  const segments = parser.push(text);
  return [...segments, ...parser.flush()];
}

export function prepareCitationFencesForModel(text: string) {
  return splitTextWithCitationFences(text)
    .map((segment) =>
      segment.type === "text"
        ? segment.text
        : stringifyCitationFence(segment.citation, { forModel: true })
    )
    .join("");
}

export function createCitationFenceStreamParser() {
  let buffer = "";

  const emitTextSegments = (text: string): ParsedCitationSegment[] => {
    return text.length > 0 ? [{ type: "text", text }] : [];
  };

  return {
    push(chunk: string): ParsedCitationSegment[] {
      buffer += chunk;
      const segments: ParsedCitationSegment[] = [];

      while (buffer.length > 0) {
        const startIndex = buffer.indexOf(CITATION_OPEN);
        if (startIndex === -1) {
          if (buffer.length <= STREAM_TOKEN_GUARD_LENGTH) {
            break;
          }

          const text = buffer.slice(0, -STREAM_TOKEN_GUARD_LENGTH);
          buffer = buffer.slice(-STREAM_TOKEN_GUARD_LENGTH);
          segments.push(...emitTextSegments(text));
          break;
        }

        if (startIndex > 0) {
          segments.push(...emitTextSegments(buffer.slice(0, startIndex)));
          buffer = buffer.slice(startIndex);
        }

        const endIndex = buffer.indexOf(CITATION_CLOSE, 3);
        if (endIndex === -1) {
          break;
        }

        const rawFence = buffer.slice(0, endIndex + CITATION_CLOSE.length);
        buffer = buffer.slice(endIndex + CITATION_CLOSE.length);
        const citation = parseCitationFence(rawFence);

        if (citation) {
          segments.push({
            type: "citation",
            citation,
            raw: stringifyCitationFence(citation),
          });
        }
      }

      return segments;
    },
    flush(): ParsedCitationSegment[] {
      if (buffer.length === 0) {
        return [];
      }

      const remaining = buffer;
      buffer = "";
      if (remaining.startsWith(CITATION_OPEN)) {
        return [];
      }
      return emitTextSegments(remaining);
    },
  };
}
