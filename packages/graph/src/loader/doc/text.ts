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

export function cleanInlineText(value: string): string {
    if (isSingleCleanLine(value)) {
        return value.trim();
    }

    const lines = value
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));

    return lines.join("\n");
}

function isSingleCleanLine(value: string): boolean {
    let previousWasSpace = false;

    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        switch (code) {
            case 9:
            case 10:
            case 11:
            case 12:
            case 13:
                return false;
            case 32:
                if (previousWasSpace) {
                    return false;
                }

                previousWasSpace = true;
                break;
            default:
                if (code > 127 && /\s/u.test(value[index] ?? "")) {
                    return false;
                }

                previousWasSpace = false;
                break;
        }
    }

    return true;
}

export function clampHeadingLevel(level: number): number {
    return Math.min(6, Math.max(1, level));
}

export function detectHeadingLevel(value: string): number | null {
    const match = value.match(/heading\s*([1-6])/i);
    return match ? clampHeadingLevel(Number(match[1])) : null;
}
