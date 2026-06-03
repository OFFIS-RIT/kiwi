import { childElements, findFirstChild, getAttribute } from "../ooxml/xml";
import type { XMLNodeLike } from "../ooxml/types";
import { formatInlineText } from "./text";

export type InlineFormat = {
    bold: boolean;
    italic: boolean;
    strike: boolean;
    underline: boolean;
};

export type InlineSink = {
    onText: (text: string) => void;
    onImage: (id: string) => void;
    onPageBreak: (source: "explicit" | "rendered") => void;
    onFieldStart?: () => void;
    onFieldSeparator?: () => void;
    onFieldEnd?: () => void;
    onInstructionText?: (text: string) => void;
};

export const PLAIN_INLINE_FORMAT: InlineFormat = {
    bold: false,
    italic: false,
    strike: false,
    underline: false,
};

const SYMBOL_FONT_CHARACTERS = new Map<string, Map<number, string>>([
    [
        "symbol",
        new Map([
            [0xb7, "•"],
            [0xa7, "▪"],
        ]),
    ],
    [
        "wingdings",
        new Map([
            [0xfc, "✓"],
            [0xfe, "■"],
            [0xa8, "→"],
        ]),
    ],
    [
        "webdings",
        new Map([
            [0x6e, "■"],
            [0x61, "✓"],
        ]),
    ],
]);

type FieldEvent =
    | { kind: "text"; text: string }
    | { kind: "image"; id: string }
    | { kind: "pageBreak"; source: "explicit" | "rendered" };

type FieldFrame = {
    instructionParts: string[];
    collectingResult: boolean;
    hyperlinkTarget: string | null;
    events: FieldEvent[];
};

export function createFieldAwareSink(
    sink: InlineSink,
    markdown: boolean
): { sink: InlineSink; flush: () => void } {
    const fieldStack: FieldFrame[] = [];

    const emitEvent = (event: FieldEvent) => {
        switch (event.kind) {
            case "text":
                sink.onText(event.text);
                break;
            case "image":
                sink.onImage(event.id);
                break;
            case "pageBreak":
                sink.onPageBreak(event.source);
                break;
        }
    };

    const queueEvent = (event: FieldEvent) => {
        const currentField = fieldStack.at(-1);
        if (!currentField) {
            emitEvent(event);
            return;
        }

        if (!currentField.collectingResult) {
            return;
        }

        currentField.events.push(applyFieldTargetToEvent(event, currentField.hyperlinkTarget, markdown));
    };

    const closeField = () => {
        const field = fieldStack.pop();
        if (!field) {
            return;
        }

        const parent = fieldStack.at(-1);
        if (parent?.collectingResult) {
            parent.events.push(...field.events);
            return;
        }

        for (const event of field.events) {
            emitEvent(event);
        }
    };

    return {
        sink: {
            ...sink,
            onText: (text) => queueEvent({ kind: "text", text }),
            onImage: (id) => queueEvent({ kind: "image", id }),
            onPageBreak: (source) => queueEvent({ kind: "pageBreak", source }),
            onFieldStart: () => {
                fieldStack.push({
                    instructionParts: [],
                    collectingResult: false,
                    hyperlinkTarget: null,
                    events: [],
                });
            },
            onFieldSeparator: () => {
                const currentField = fieldStack.at(-1);
                if (!currentField) {
                    return;
                }

                currentField.collectingResult = true;
                currentField.hyperlinkTarget = extractHyperlinkTargetFromFieldInstruction(
                    currentField.instructionParts.join("")
                );
            },
            onFieldEnd: () => {
                closeField();
            },
            onInstructionText: (text) => {
                const currentField = fieldStack.at(-1);
                if (currentField && text) {
                    currentField.instructionParts.push(text);
                }
            },
        },
        flush: () => {
            while (fieldStack.length > 0) {
                closeField();
            }
        },
    };
}

export function renderReferenceText(kind: "Footnote" | "Endnote" | "Comment", text: string): string {
    return `[${kind}: ${text}]`;
}

export function getFieldSimpleHyperlinkTarget(node: XMLNodeLike): string | null {
    const instruction = getAttribute(node, "w:instr", "instr");
    return instruction ? extractHyperlinkTargetFromFieldInstruction(instruction) : null;
}

export function decodeRunSymbol(node: XMLNodeLike): string | null {
    const hexValue = getAttribute(node, "w:char", "char");
    if (!hexValue) {
        return null;
    }

    const parsed = Number.parseInt(hexValue, 16);
    if (!Number.isInteger(parsed) || parsed < 0) {
        return null;
    }

    const font = normalizeSymbolFont(getAttribute(node, "w:font", "font"));
    const directMatch = font ? SYMBOL_FONT_CHARACTERS.get(font)?.get(parsed) : undefined;
    if (directMatch) {
        return directMatch;
    }

    const lowByteMatch = font ? SYMBOL_FONT_CHARACTERS.get(font)?.get(parsed & 0xff) : undefined;
    if (lowByteMatch) {
        return lowByteMatch;
    }

    if (parsed >= 0x20 && parsed <= 0x10ffff && !isPrivateUseCodePoint(parsed)) {
        return decodeNumericCharacter(parsed);
    }

    return null;
}

export function getPreferredAlternateContentBranch(node: XMLNodeLike): XMLNodeLike | null {
    let fallback: XMLNodeLike | null = null;
    for (const child of childElements(node)) {
        const name = child.localName ?? child.nodeName ?? "";
        if (name === "Choice" || name === "mc:Choice") {
            return child;
        }

        if ((name === "Fallback" || name === "mc:Fallback") && !fallback) {
            fallback = child;
        }
    }

    return fallback;
}

function applyFieldTargetToEvent(event: FieldEvent, hyperlinkTarget: string | null, markdown: boolean): FieldEvent {
    if (!hyperlinkTarget || !markdown || event.kind !== "text") {
        return event;
    }

    return {
        kind: "text",
        text: formatInlineText(event.text, PLAIN_INLINE_FORMAT, hyperlinkTarget, true),
    };
}

function extractHyperlinkTargetFromFieldInstruction(instruction: string): string | null {
    if (!instruction) {
        return null;
    }

    if (/\bHYPERLINK\b/i.test(instruction)) {
        const localAnchor = instruction.match(/\\l\s+"([^"]+)"/i)?.[1];
        if (localAnchor) {
            return `#${localAnchor}`;
        }

        const targetMatch = instruction.match(/\bHYPERLINK\b\s+(?:"([^"]+)"|([^\s\\][^\s]*))/i);
        return targetMatch?.[1] ?? targetMatch?.[2] ?? null;
    }

    const bookmarkFieldMatch = instruction.match(/\b(?:REF|PAGEREF|NOTEREF)\b\s+("?)([^"\\\s]+)\1/i);
    if (bookmarkFieldMatch?.[2]) {
        return `#${bookmarkFieldMatch[2]}`;
    }

    const includeTextMatch = instruction.match(/\bINCLUDETEXT\b\s+(?:"([^"]+)"|([^\s\\][^\s]*))/i);
    return includeTextMatch?.[1] ?? includeTextMatch?.[2] ?? null;
}

function normalizeSymbolFont(value: string | null): string | null {
    return value ? value.trim().toLowerCase().replace(/\s+/g, " ") : null;
}

function isPrivateUseCodePoint(codePoint: number): boolean {
    return (
        (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
        (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
        (codePoint >= 0x100000 && codePoint <= 0x10fffd)
    );
}

function decodeNumericCharacter(codePoint: number): string {
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        return "";
    }

    try {
        return String.fromCodePoint(codePoint);
    } catch {
        return "";
    }
}
