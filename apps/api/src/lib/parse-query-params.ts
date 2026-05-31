export function parseListNumber(value: string | undefined, options: { minimum: number; maximum: number }) {
    if (!value) {
        return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < options.minimum) {
        return undefined;
    }

    return Math.min(parsed, options.maximum);
}
