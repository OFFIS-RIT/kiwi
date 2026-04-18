import type { ModelMessage } from "ai";
import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import type {
  ChatMessage,
  MessagePart,
  MessageToolPart,
} from "@kiwi/db/tables/chats";
import { jsonrepair } from "jsonrepair";
import { toModelMessage } from "./index";
import { createChatPrompt } from "./prompts/chat.prompt";
import { listEntitiesTool, searchEntityTool } from "./tools/entity";
import { listFilesTool } from "./tools/file";
import {
  getNeighboursTool,
  getPathBetweenTool,
  getRelationshipsTool,
  searchRelationshipsTool,
} from "./tools/relationship";
import { getSourcesTool } from "./tools/source";
import { askQuestionTool } from "./tools/user";
import type { Adapter, EmbeddingAdapter } from "./index";
import type { ChatMessageMetadata, ChatUIMessage } from "./ui";
export type {
  ChatDataParts,
  ChatMessageMetadata,
  ChatUIMessage,
  CitationPartData,
} from "./ui";

const CLIENT_TOOL_NAMES = new Set(["ask_clarifying_questions"]);
const CITATION_OPEN = ":::{";
const CITATION_CLOSE = ":::";
const STREAM_TOKEN_GUARD_LENGTH = CITATION_OPEN.length - 1;

export type CitationFence = {
  type: "cite";
  id: string;
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

export function buildAdapter(
  type: "openai" | "azure" | "anthropic" | "openaiAPI",
  model: string,
  key: string,
  url?: string,
  resourceName?: string,
): Adapter {
  switch (type) {
    case "openai":
      return { type, model, credentials: { apiKey: key } };
    case "anthropic":
      return { type, model, credentials: { apiKey: key } };
    case "azure":
      return {
        type,
        model,
        credentials: { resourceName: resourceName!, apiKey: key },
      };
    case "openaiAPI":
      return { type, model, credentials: { apiKey: key, url: url! } };
  }
}

export function buildEmbeddingAdapter(
  type: "openai" | "azure" | "openaiAPI",
  model: string,
  key: string,
  url?: string,
  resourceName?: string,
): EmbeddingAdapter {
  switch (type) {
    case "openai":
      return { type, model, credentials: { apiKey: key } };
    case "azure":
      return {
        type,
        model,
        credentials: { resourceName: resourceName!, apiKey: key },
      };
    case "openaiAPI":
      return { type, model, credentials: { apiKey: key, url: url! } };
  }
}

export function buildChatTools(
  graphId: string,
  embeddingModel: EmbeddingModelV3,
) {
  return {
    list_files: listFilesTool(graphId),
    search_entities: searchEntityTool(graphId, embeddingModel),
    list_entities: listEntitiesTool(graphId),
    search_relationships: searchRelationshipsTool(graphId, embeddingModel),
    get_relationships: getRelationshipsTool(graphId),
    get_entity_neighbours: getNeighboursTool(graphId),
    get_path_between_entities: getPathBetweenTool(graphId),
    get_sources: getSourcesTool(graphId, embeddingModel),
    ask_clarifying_questions: askQuestionTool(),
  };
}

export function createChatSystemPrompt(graphPrompt?: string) {
  return createChatPrompt(graphPrompt);
}

function toMessageToolPart(part: {
  type: string;
  toolCallId: string;
  toolName?: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}): MessageToolPart {
  const toolName =
    part.type === "dynamic-tool"
      ? (part.toolName ?? "unknown_tool")
      : part.type.slice("tool-".length);
  const basePart: MessageToolPart = {
    type: "tool",
    toolCallId: part.toolCallId,
    toolName,
    execution: CLIENT_TOOL_NAMES.has(toolName) ? "client" : "server",
    status: "pending",
    args: part.input ?? null,
  };

  switch (part.state) {
    case "output-available":
      return {
        ...basePart,
        status: "completed",
        result: part.output,
      };
    case "output-error":
    case "output-denied":
      return {
        ...basePart,
        status: "failed",
        result: part.errorText ?? "Tool execution failed",
      };
    default:
      return basePart;
  }
}

function toMessageMetadataPart(
  metadata: ChatMessageMetadata,
): MessagePart | null {
  const { createdAt: _, ...storedMetadata } = metadata;
  const hasMetadata = Object.values(storedMetadata).some(
    (value) => value !== undefined,
  );
  if (!hasMetadata) {
    return null;
  }

  return {
    type: "metadata",
    metadata: storedMetadata,
  };
}

function isToolUIPartLike(
  part: ChatUIMessage["parts"][number],
): part is Extract<
  ChatUIMessage["parts"][number],
  { toolCallId: string; state: string }
> {
  return "toolCallId" in part && "state" in part;
}

export function uiMessageToMessageParts(message: ChatUIMessage): MessagePart[] {
  const parts: MessagePart[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text) {
        parts.push({ type: "text", text: part.text });
      }
      continue;
    }

    if (part.type === "reasoning") {
      if (part.text) {
        parts.push({ type: "reasoning", text: part.text });
      }
      continue;
    }

    if (part.type === "data-citation") {
      parts.push({
        type: "citation",
        citation: part.data,
      });
      continue;
    }

    if (isToolUIPartLike(part)) {
      parts.push(
        toMessageToolPart({
          type: part.type,
          toolCallId: part.toolCallId,
          toolName: "toolName" in part ? part.toolName : undefined,
          state: part.state,
          input: "input" in part ? part.input : undefined,
          output: "output" in part ? part.output : undefined,
          errorText: "errorText" in part ? part.errorText : undefined,
        }),
      );
    }
  }

  const metadataPart = toMessageMetadataPart(message.metadata ?? {});
  if (metadataPart) {
    parts.push(metadataPart);
  }

  return parts;
}

function toToolUIPart(part: MessageToolPart) {
  const type = `tool-${part.toolName}` as `tool-${string}`;

  switch (part.status) {
    case "completed":
      return {
        type,
        toolCallId: part.toolCallId,
        state: "output-available" as const,
        input: part.args,
        output: part.result,
        providerExecuted: part.execution === "server",
      };
    case "failed":
      return {
        type,
        toolCallId: part.toolCallId,
        state: "output-error" as const,
        input: part.args,
        errorText:
          typeof part.result === "string"
            ? part.result
            : JSON.stringify(part.result ?? null),
        providerExecuted: part.execution === "server",
      };
    default:
      return {
        type,
        toolCallId: part.toolCallId,
        state: "input-available" as const,
        input: part.args,
        providerExecuted: part.execution === "server",
      };
  }
}

export function messagePartsToUIMessage(
  message: {
    id: string;
    role: "system" | "user" | "assistant";
    parts: MessagePart[];
    createdAt?: Date | null;
  },
  fallbackMetadata?: ChatMessageMetadata,
): ChatUIMessage {
  const metadataPart = message.parts.find(
    (part): part is Extract<MessagePart, { type: "metadata" }> =>
      part.type === "metadata",
  );
  const uiParts: ChatUIMessage["parts"] = [];

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        uiParts.push({ type: "text", text: part.text });
        break;
      case "reasoning":
        uiParts.push({ type: "reasoning", text: part.text });
        break;
      case "citation":
        uiParts.push({
          type: "data-citation",
          id: part.citation.sourceId,
          data: part.citation,
        });
        break;
      case "tool":
        uiParts.push(toToolUIPart(part) as ChatUIMessage["parts"][number]);
        break;
      case "metadata":
        break;
    }
  }

  const metadata = {
    createdAt: message.createdAt?.toISOString(),
    ...(fallbackMetadata ?? {}),
    ...(metadataPart?.metadata ?? {}),
  } satisfies ChatMessageMetadata;

  return {
    id: message.id,
    role: message.role,
    metadata,
    parts: uiParts,
  };
}

export function toUIMessage(
  message: Pick<
    ChatMessage,
    | "id"
    | "role"
    | "parts"
    | "createdAt"
    | "tokensPerSecond"
    | "timeToFirstToken"
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
  >,
): ChatUIMessage {
  return messagePartsToUIMessage(
    {
      id: message.id,
      role: message.role,
      parts: message.parts,
      createdAt: message.createdAt,
    },
    {
      inputTokens: message.inputTokens ?? undefined,
      outputTokens: message.outputTokens ?? undefined,
      totalTokens: message.totalTokens ?? undefined,
      tokensPerSecond: message.tokensPerSecond ?? undefined,
      timeToFirstToken: message.timeToFirstToken ?? undefined,
    },
  );
}

export function uiMessagesToModelMessages(
  messages: ChatUIMessage[],
): ModelMessage[] {
  return messages.flatMap((message) =>
    toModelMessage({
      id: message.id,
      chatId: "",
      status: "completed",
      role: message.role,
      parts: uiMessageToMessageParts(message),
      tokensPerSecond: null,
      timeToFirstToken: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      createdAt: null,
      updatedAt: null,
    }),
  );
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
    const parsed = JSON.parse(repaired) as Partial<CitationFence>;
    if (
      parsed.type !== "cite" ||
      typeof parsed.id !== "string" ||
      parsed.id.trim().length === 0
    ) {
      return null;
    }

    return {
      type: "cite",
      id: parsed.id.trim(),
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
            raw: `:::{"type": "cite", "id":${JSON.stringify(citation.id)}}:::`,
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
