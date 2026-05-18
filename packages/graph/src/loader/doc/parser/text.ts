import type { InlinePiece } from "./types";

export function formatInlineText(
    value: string,
    format: { bold: boolean; italic: boolean; strike: boolean; underline: boolean },
    hyperlinkTarget: string | null,
    markdown: boolean
): string {
    if (!markdown) {
        return value;
    }

    const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
    const trailingWhitespace = value.match(/\s*$/)?.[0] ?? "";
    let text = value.trim();
    if (!text) {
        return value;
    }

    if (format.bold && format.italic) {
        text = `***${text}***`;
    } else if (format.bold) {
        text = `**${text}**`;
    } else if (format.italic || format.underline) {
        text = `*${text}*`;
    }

    if (format.strike) {
        text = `~~${text}~~`;
    }

    if (hyperlinkTarget) {
        text = `[${text}](${hyperlinkTarget})`;
    }

    return `${leadingWhitespace}${text}${trailingWhitespace}`;
}

export function mergeInlineTextPieces(pieces: InlinePiece[]): InlinePiece[] {
    return pieces.reduce<InlinePiece[]>((acc, piece) => {
        const previous = acc.at(-1);
        if (piece.kind === "text" && previous?.kind === "text") {
            previous.text += piece.text;
            return acc;
        }

        acc.push(piece);
        return acc;
    }, []);
}

export function cleanInlineText(value: string): string {
    const lines = value
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
        .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));

    return lines.join("\n");
}

export function clampHeadingLevel(level: number): number {
    return Math.min(6, Math.max(1, level));
}

export function detectHeadingLevel(value: string): number | null {
    const match = value.match(/heading\s*([1-6])/i);
    return match ? clampHeadingLevel(Number(match[1])) : null;
}
