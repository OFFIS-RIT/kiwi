import type { ActualTextSpan, PageText, TextChar, TextDirection, TextLine, TextSpan, Word } from "./types";
import {
    INLINE_TOKEN_CONNECTORS,
    LIGATURE_EXPANSIONS,
    TEXT_CHAR_DEDUPE_TOLERANCE,
    TEXT_DEFAULT_X_TOLERANCE_RATIO,
    TEXT_DEFAULT_Y_TOLERANCE,
    TEXT_DEFAULT_Y_TOLERANCE_RATIO,
    WORD_BOUNDARY_PUNCTUATION,
} from "./constants";
import { average, getTop, median, overlapLength, squashWhitespace, unionBoxes } from "./geometry";
import { orderItemsByReadingLayout } from "./layout";

const STRONG_INLINE_TOKEN_CONNECTORS = new Set(["_", "/", "\\", "+", "=", "^", "~", "*"]);
const STREAM_ORDER_BACKWARD_MOVEMENT_RATIO = 0.25;
const RTL_BACKWARD_MOVEMENT_RATIO = 0.8;

type LineInfo = {
    line: TextLine;
    chars: TextChar[];
    visibleChars: TextChar[];
    medianFontSize: number;
};

export function tidyPageText(pageText: PageText): PageText {
    const horizontalLines: TextLine[] = [];
    const verticalChars: TextChar[] = [];

    for (const line of pageText.lines) {
        const chars = getPreparedLineChars(line);
        if (chars.length === 0) {
            horizontalLines.push({ ...line, direction: "horizontal" });
            continue;
        }

        const { horizontal: horizontalSubset, vertical: verticalSubset } = splitLineCharsByDirection(chars);
        const visibleHorizontalChars = horizontalSubset.filter(
            (char) => getExpandedCharText(char.char).trim().length > 0
        );
        const visibleVerticalChars = verticalSubset.filter((char) => getExpandedCharText(char.char).trim().length > 0);

        if (visibleHorizontalChars.length > 0) {
            for (const segment of splitHorizontalTextLine(horizontalSubset)) {
                const horizontalLine = createSyntheticTextLine(segment, "horizontal");
                if (horizontalLine) {
                    horizontalLines.push(horizontalLine);
                }
            }
            verticalChars.push(...visibleVerticalChars);
            continue;
        }

        if (
            visibleVerticalChars.length > 0 ||
            (verticalSubset.length > 0 && inferLineDirection(line, chars) === "vertical")
        ) {
            verticalChars.push(...verticalSubset);
            continue;
        }

        for (const segment of splitHorizontalTextLine(chars)) {
            const horizontalLine = createSyntheticTextLine(segment, "horizontal");
            if (horizontalLine) {
                horizontalLines.push(horizontalLine);
            }
        }
    }

    const lines = orderItemsByReadingLayout(
        [...mergeDetachedScriptLines(horizontalLines), ...buildVerticalTextLines(verticalChars)],
        (line) => line.bbox,
        pageText.width
    );
    return {
        ...pageText,
        lines,
        text: lines
            .map((line) => getLineText(line))
            .filter(Boolean)
            .join("\n"),
    };
}

export function applyActualTextToPageText(pageText: PageText, spans: ActualTextSpan[]): PageText {
    if (spans.length === 0) {
        return pageText;
    }

    const flattened = pageText.lines.flatMap((line, lineIndex) =>
        line.spans.flatMap((span, spanIndex) =>
            span.chars.map((char, charIndex) => ({ char, lineIndex, spanIndex, charIndex }))
        )
    );
    const accepted = selectNonOverlappingActualTextSpans(spans)
        .map((span) => {
            const matched = flattened
                .filter((entry) => {
                    const sequenceIndex = entry.char.sequenceIndex;
                    return (
                        typeof sequenceIndex === "number" &&
                        sequenceIndex >= span.startSequenceIndex &&
                        sequenceIndex <= span.endSequenceIndex
                    );
                })
                .sort((left, right) => (left.char.sequenceIndex ?? 0) - (right.char.sequenceIndex ?? 0));
            if (matched.length === 0) {
                return null;
            }

            return {
                span,
                matched,
                replacement: createActualTextReplacementChar(
                    matched.map((entry) => entry.char),
                    span.text
                ),
            };
        })
        .filter(
            (entry): entry is { span: ActualTextSpan; matched: typeof flattened; replacement: TextChar } =>
                entry !== null
        );
    if (accepted.length === 0) {
        return pageText;
    }

    const replacementBySequence = new Map<number, TextChar>();
    const skippedSequences = new Set<number>();
    for (const entry of accepted) {
        const first = entry.matched[0]?.char.sequenceIndex;
        if (typeof first !== "number") {
            continue;
        }

        replacementBySequence.set(first, entry.replacement);
        for (const match of entry.matched.slice(1)) {
            if (typeof match.char.sequenceIndex === "number") {
                skippedSequences.add(match.char.sequenceIndex);
            }
        }
    }

    const lines = pageText.lines
        .map((line) => {
            const spans = line.spans
                .map((span) => {
                    const chars: TextChar[] = [];
                    for (const char of span.chars) {
                        const sequenceIndex = char.sequenceIndex;
                        if (typeof sequenceIndex === "number") {
                            const replacement = replacementBySequence.get(sequenceIndex);
                            if (replacement) {
                                chars.push(replacement);
                                continue;
                            }
                            if (skippedSequences.has(sequenceIndex)) {
                                continue;
                            }
                        }

                        chars.push(char);
                    }

                    const bbox = unionBoxes(chars.map((char) => char.bbox));
                    if (!bbox) {
                        return null;
                    }

                    return {
                        ...span,
                        text: chars.map((char) => char.char).join(""),
                        chars,
                        bbox,
                    };
                })
                .filter((span): span is TextSpan => span !== null && span.chars.length > 0);
            if (spans.length === 0) {
                return null;
            }

            const chars = spans.flatMap((span) => span.chars);
            const bbox = unionBoxes(chars.map((char) => char.bbox));
            if (!bbox) {
                return null;
            }

            return {
                ...line,
                text: spans.map((span) => span.text).join(""),
                spans,
                bbox,
                baseline: average(chars.map((char) => char.baseline)),
            };
        })
        .filter((line): line is TextLine => line !== null);

    return {
        ...pageText,
        lines,
        text: lines.map((line) => line.text).join("\n"),
    };
}

export function selectNonOverlappingActualTextSpans(spans: ActualTextSpan[]): ActualTextSpan[] {
    const accepted: ActualTextSpan[] = [];
    const sorted = [...spans].sort((left, right) => {
        const leftLength = left.endSequenceIndex - left.startSequenceIndex;
        const rightLength = right.endSequenceIndex - right.startSequenceIndex;
        if (leftLength !== rightLength) {
            return leftLength - rightLength;
        }

        return left.startSequenceIndex - right.startSequenceIndex;
    });

    for (const span of sorted) {
        if (
            accepted.some(
                (existing) =>
                    span.startSequenceIndex <= existing.endSequenceIndex &&
                    span.endSequenceIndex >= existing.startSequenceIndex
            )
        ) {
            continue;
        }

        accepted.push(span);
    }

    return accepted.sort((left, right) => left.startSequenceIndex - right.startSequenceIndex);
}

export function createActualTextReplacementChar(chars: TextChar[], text: string): TextChar {
    const bbox = unionBoxes(chars.map((char) => char.bbox)) ?? chars[0]!.bbox;
    return {
        char: text,
        bbox,
        fontSize: median(chars.map((char) => char.fontSize)) || chars[0]!.fontSize,
        fontName: chars[0]?.fontName ?? "",
        baseline: average(chars.map((char) => char.baseline)),
        sequenceIndex: chars[0]?.sequenceIndex,
    };
}

export function inferLineDirection(line: TextLine, chars = getPreparedLineChars(line)): TextDirection {
    const visibleChars = chars.filter((char) => getExpandedCharText(char.char).trim().length > 0);
    const samples = visibleChars.length > 0 ? visibleChars : chars;
    if (samples.length === 0) {
        return line.direction ?? "horizontal";
    }

    const verticalCount = samples.filter((char) => inferTextCharDirection(char) === "vertical").length;
    if (verticalCount >= Math.ceil(samples.length * 0.6)) {
        return "vertical";
    }

    return line.direction ?? "horizontal";
}

export function splitHorizontalTextLine(chars: TextChar[]): TextChar[][] {
    const ordered = dedupeTextChars(sortTextChars(chars));
    if (ordered.length === 0) {
        return [];
    }

    const visibleChars = ordered.filter((char) => getExpandedCharText(char.char).trim().length > 0);
    const averageWidth = average(visibleChars.map((char) => char.bbox.width)) || 4;
    const medianFontSize = median(visibleChars.map((char) => char.fontSize)) || 12;
    const breakThreshold = Math.max(24, averageWidth * 4.5, medianFontSize * 2.4);
    const groups: TextChar[][] = [[]];

    for (let index = 0; index < ordered.length; index += 1) {
        const char = ordered[index]!;
        const current = groups[groups.length - 1]!;
        const previousVisible = [...current]
            .reverse()
            .find((entry) => getExpandedCharText(entry.char).trim().length > 0);
        const nextVisible = ordered.slice(index + 1).find((entry) => getExpandedCharText(entry.char).trim().length > 0);
        const text = getExpandedCharText(char.char);

        if (text.trim().length === 0) {
            const wideWhitespace = char.bbox.width >= breakThreshold;
            const gapToNext = nextVisible ? nextVisible.bbox.x - (char.bbox.x + char.bbox.width) : 0;
            if (wideWhitespace || gapToNext >= breakThreshold * 0.5) {
                if (current.length > 0) {
                    groups.push([]);
                }
                continue;
            }
        }

        if (previousVisible) {
            const gap = char.bbox.x - (previousVisible.bbox.x + previousVisible.bbox.width);
            if (gap >= breakThreshold) {
                groups.push([]);
            }
        }

        groups[groups.length - 1]!.push(char);
    }

    const visibleGroups = groups.filter((group) =>
        group.some((char) => getExpandedCharText(char.char).trim().length > 0)
    );
    if (visibleGroups.length !== 2) {
        return [ordered];
    }

    const proseLikeGroups = visibleGroups.filter((group) => {
        const text = squashWhitespace(reconstructTextFromChars(group));
        return text.length >= 20 && /\s/.test(text);
    });
    return proseLikeGroups.length === 2 ? visibleGroups : [ordered];
}

export function inferTextCharDirection(char: TextChar): TextDirection {
    return char.bbox.width >= Math.max(char.bbox.height * 1.05, char.fontSize * 0.75) ? "vertical" : "horizontal";
}

export function splitLineCharsByDirection(chars: TextChar[]): { horizontal: TextChar[]; vertical: TextChar[] } {
    const horizontal = new Set<TextChar>();
    const vertical = new Set<TextChar>();

    for (const char of chars) {
        if (inferTextCharDirection(char) === "vertical") {
            vertical.add(char);
            continue;
        }

        horizontal.add(char);
    }

    for (const run of getVerticalCharRuns(chars, vertical)) {
        if (!isInlineHorizontalGlyphRun(run, chars, horizontal)) {
            continue;
        }

        for (const char of run) {
            vertical.delete(char);
            horizontal.add(char);
        }
    }

    return {
        horizontal: chars.filter((char) => horizontal.has(char)),
        vertical: chars.filter((char) => vertical.has(char)),
    };
}

function getVerticalCharRuns(chars: TextChar[], vertical: Set<TextChar>): TextChar[][] {
    const ordered = orderTextCharsForInlineRecovery(chars);
    const runs: TextChar[][] = [];
    let current: TextChar[] = [];

    for (const char of ordered) {
        if (vertical.has(char)) {
            current.push(char);
            continue;
        }

        if (current.length > 0) {
            runs.push(current);
            current = [];
        }
    }

    if (current.length > 0) {
        runs.push(current);
    }

    return runs;
}

function orderTextCharsForInlineRecovery(chars: TextChar[]): TextChar[] {
    if (chars.every((char) => typeof char.sequenceIndex === "number")) {
        return [...chars].sort((left, right) => (left.sequenceIndex ?? 0) - (right.sequenceIndex ?? 0));
    }

    return sortTextChars(chars);
}

function isInlineHorizontalGlyphRun(run: TextChar[], chars: TextChar[], horizontal: Set<TextChar>): boolean {
    const visibleRun = run.filter((char) => getExpandedCharText(char.char).trim().length > 0);
    if (visibleRun.length === 0 || visibleRun.length !== run.length) {
        return false;
    }

    const ordered = orderTextCharsForInlineRecovery(chars);
    const firstRunIndex = ordered.indexOf(run[0]!);
    const lastRunIndex = ordered.indexOf(run[run.length - 1]!);
    if (firstRunIndex < 0 || lastRunIndex < firstRunIndex) {
        return false;
    }

    const previous = findAdjacentVisibleHorizontalChar(ordered.slice(0, firstRunIndex).reverse(), horizontal);
    const next = findAdjacentVisibleHorizontalChar(ordered.slice(lastRunIndex + 1), horizontal);
    if (!previous || !next) {
        return false;
    }

    const runBox = unionBoxes(visibleRun.map((char) => char.bbox));
    if (!runBox) {
        return false;
    }

    const fontSize = median([...visibleRun, previous, next].map((char) => char.fontSize)) || previous.fontSize;
    const tolerance = Math.max(3, fontSize * 0.35);
    const runBaseline = average(visibleRun.map((char) => char.baseline));
    if (Math.abs(previous.baseline - runBaseline) > tolerance || Math.abs(next.baseline - runBaseline) > tolerance) {
        return false;
    }

    const gapBefore = runBox.x - (previous.bbox.x + previous.bbox.width);
    const gapAfter = next.bbox.x - (runBox.x + runBox.width);
    return gapBefore >= -tolerance && gapBefore <= tolerance && gapAfter >= -tolerance && gapAfter <= tolerance;
}

function findAdjacentVisibleHorizontalChar(chars: TextChar[], horizontal: Set<TextChar>): TextChar | null {
    return chars.find((char) => horizontal.has(char) && getExpandedCharText(char.char).trim().length > 0) ?? null;
}

export function buildVerticalTextLines(chars: TextChar[]): TextLine[] {
    if (chars.length === 0) {
        return [];
    }

    return clusterVerticalTextChars(chars)
        .flatMap(splitVerticalTextCluster)
        .map((group) => createSyntheticTextLine(group, "vertical"))
        .filter((line): line is TextLine => line !== null);
}

export function clusterVerticalTextChars(chars: TextChar[]): TextChar[][] {
    const ordered = dedupeTextChars([...chars]).sort(
        (left, right) => getTextCharCenterX(left) - getTextCharCenterX(right)
    );
    const clusters: TextChar[][] = [];

    for (const char of ordered) {
        const current = clusters[clusters.length - 1];
        if (!current) {
            clusters.push([char]);
            continue;
        }

        const fontSize = median(current.map((entry) => entry.fontSize)) || char.fontSize;
        if (
            Math.abs(getTextCharCenterX(char) - average(current.map(getTextCharCenterX))) <= Math.max(4, fontSize * 0.9)
        ) {
            current.push(char);
            continue;
        }

        clusters.push([char]);
    }

    return clusters;
}

export function splitVerticalTextCluster(cluster: TextChar[]): TextChar[][] {
    const ordered = sortVerticalTextChars(cluster);
    if (ordered.length === 0) {
        return [];
    }

    const groups: TextChar[][] = [[ordered[0]!]];
    for (const char of ordered.slice(1)) {
        const current = groups[groups.length - 1]!;
        const previous = current[current.length - 1]!;
        const fontSize = median(current.map((entry) => entry.fontSize)) || char.fontSize;
        const verticalGap = Math.abs(getTextCharCenterY(char) - getTextCharCenterY(previous));
        const sequenceGap =
            typeof previous.sequenceIndex === "number" && typeof char.sequenceIndex === "number"
                ? Math.abs(char.sequenceIndex - previous.sequenceIndex)
                : 1;

        if (
            verticalGap > Math.max(fontSize * 3, 18) ||
            (sequenceGap > 2 && verticalGap > Math.max(fontSize * 1.5, 10))
        ) {
            groups.push([char]);
            continue;
        }

        current.push(char);
    }

    return groups.filter((group) => group.some((char) => getExpandedCharText(char.char).trim().length > 0));
}

export function createSyntheticTextLine(chars: TextChar[], direction: TextDirection): TextLine | null {
    const orderedChars = direction === "vertical" ? sortVerticalTextChars(chars) : sortTextChars(chars);
    const bbox = unionBoxes(orderedChars.map((char) => char.bbox));
    if (!bbox) {
        return null;
    }

    const text =
        direction === "vertical"
            ? reconstructVerticalTextFromChars(orderedChars)
            : cleanupExtractedTextSpacing(reconstructTextFromChars(orderedChars));
    const normalized = squashWhitespace(text);
    if (!normalized) {
        return null;
    }

    const fontSize = median(orderedChars.map((char) => char.fontSize)) || 0;
    const fontName = orderedChars[0]?.fontName ?? "";
    const baseline =
        direction === "vertical"
            ? average(orderedChars.map(getTextCharCenterY))
            : (orderedChars[0]?.baseline ?? bbox.y);

    return {
        text: normalized,
        bbox,
        baseline,
        direction,
        spans: [
            {
                text: normalized,
                bbox,
                chars: orderedChars,
                fontSize,
                fontName,
            },
        ],
    };
}

function mergeDetachedScriptLines(lines: TextLine[]): TextLine[] {
    const lineInfos = lines.map((line) => {
        const chars = getPreparedLineChars(line);
        const visibleChars = chars.filter((char) => getExpandedCharText(char.char).trim().length > 0);
        return {
            line,
            chars,
            visibleChars,
            medianFontSize: median(visibleChars.map((char) => char.fontSize)) || 0,
        };
    });
    const additions = new Map<number, TextChar[]>();
    const consumed = new Set<number>();

    for (let index = 0; index < lineInfos.length; index += 1) {
        const candidate = lineInfos[index];
        if (!candidate || !isDetachedScriptLineCandidate(candidate.visibleChars)) {
            continue;
        }

        const targetIndex = findDetachedScriptLineTarget(index, lineInfos);
        if (targetIndex === null) {
            continue;
        }

        consumed.add(index);
        additions.set(targetIndex, [...(additions.get(targetIndex) ?? []), ...candidate.chars]);
    }

    return lineInfos
        .map((entry, index) => {
            if (consumed.has(index)) {
                return null;
            }

            const extraChars = additions.get(index);
            if (!extraChars || extraChars.length === 0) {
                return entry.line;
            }

            return createSyntheticTextLine([...entry.chars, ...extraChars], "horizontal") ?? entry.line;
        })
        .filter((line): line is TextLine => line !== null);
}

function isDetachedScriptLineCandidate(chars: TextChar[]): boolean {
    return (
        chars.length > 0 &&
        chars.length <= 4 &&
        chars.every((char) => getExpandedCharText(char.char).trim().length > 0)
    );
}

function findDetachedScriptLineTarget(candidateIndex: number, lineInfos: LineInfo[]): number | null {
    const candidate = lineInfos[candidateIndex];
    if (!candidate || candidate.medianFontSize <= 0) {
        return null;
    }

    const candidateBox = unionBoxes(candidate.visibleChars.map((char) => char.bbox));
    if (!candidateBox) {
        return null;
    }

    let best: { index: number; distance: number } | null = null;
    for (let index = 0; index < lineInfos.length; index += 1) {
        if (index === candidateIndex) {
            continue;
        }

        const target = lineInfos[index];
        if (!target || target.medianFontSize <= 0 || candidate.medianFontSize > target.medianFontSize * 0.9) {
            continue;
        }

        if (!isDetachedScriptLineTarget(candidate, candidateBox, target)) {
            continue;
        }

        const distance = Math.abs(candidate.line.baseline - target.line.baseline);
        if (!best || distance < best.distance) {
            best = { index, distance };
        }
    }

    return best?.index ?? null;
}

function isDetachedScriptLineTarget(
    candidate: LineInfo,
    candidateBox: TextChar["bbox"],
    target: LineInfo
): boolean {
    const horizontalSlack = Math.max(4, target.medianFontSize * 0.5);
    const candidateCenterX = candidateBox.x + candidateBox.width / 2;
    const targetRight = target.line.bbox.x + target.line.bbox.width;
    if (candidateCenterX < target.line.bbox.x - horizontalSlack || candidateCenterX > targetRight + horizontalSlack) {
        return false;
    }

    const verticalOverlap = Math.min(getTop(candidateBox), getTop(target.line.bbox)) - Math.max(candidateBox.y, target.line.bbox.y);
    const baselineDelta = Math.abs(candidate.line.baseline - target.line.baseline);
    if (verticalOverlap <= 0 && baselineDelta > Math.max(6, target.medianFontSize * 0.6)) {
        return false;
    }

    return candidate.visibleChars.some((candidateChar) =>
        target.visibleChars.some((targetChar) => isScriptLikeTextChar(targetChar, candidateChar))
    );
}

export function sortVerticalTextChars(chars: TextChar[]): TextChar[] {
    return [...chars].sort((left, right) => {
        if (typeof left.sequenceIndex === "number" && typeof right.sequenceIndex === "number") {
            if (left.sequenceIndex !== right.sequenceIndex) {
                return left.sequenceIndex - right.sequenceIndex;
            }
        }

        return getTextCharCenterY(right) - getTextCharCenterY(left);
    });
}

export function reconstructVerticalTextFromChars(chars: TextChar[]): string {
    const parts: string[] = [];

    for (const char of sortVerticalTextChars(dedupeTextChars(chars))) {
        const text = getExpandedCharText(char.char);
        if (text.trim().length === 0) {
            if (parts.length > 0 && parts[parts.length - 1] !== " ") {
                parts.push(" ");
            }
            continue;
        }

        parts.push(text);
    }

    return parts.join("").replace(/\s+/g, " ").trim();
}

export function getTextCharCenterX(char: TextChar): number {
    return char.bbox.x + char.bbox.width / 2;
}

export function getTextCharCenterY(char: TextChar): number {
    return char.bbox.y + char.bbox.height / 2;
}

export function extractWords(pageText: PageText): Word[] {
    const words: Word[] = [];

    for (let lineIndex = 0; lineIndex < pageText.lines.length; lineIndex += 1) {
        const line = pageText.lines[lineIndex];
        if (!line) {
            continue;
        }

        const chars = getPreparedLineChars(line);
        if (chars.length === 0) {
            const text = getLineText(line);
            if (text) {
                words.push({ text, bbox: line.bbox, lineIndex });
            }
            continue;
        }

        if (inferLineDirection(line, chars) === "vertical") {
            const text = getLineText(line);
            if (text) {
                words.push({ text, bbox: line.bbox, lineIndex });
            }
            continue;
        }

        let currentChars: TextChar[] = [];
        for (let index = 0; index < chars.length; index += 1) {
            const char = chars[index];
            if (!char) {
                continue;
            }

            const text = getExpandedCharText(char.char);

            if (text.trim().length === 0) {
                pushWord(words, currentChars, lineIndex);
                currentChars = [];
                continue;
            }

            if (isWordBoundaryPunctuation(text)) {
                pushWord(words, currentChars, lineIndex);
                pushWord(words, [{ ...char, char: text }], lineIndex);
                currentChars = [];
                continue;
            }

            const previous = currentChars[currentChars.length - 1];
            if (
                previous &&
                textCharBeginsNewWord(previous, char) &&
                !shouldKeepCharsJoined(previous, char, char.bbox.x - (previous.bbox.x + previous.bbox.width))
            ) {
                pushWord(words, currentChars, lineIndex);
                currentChars = [];
            }

            currentChars.push(char);
        }

        pushWord(words, currentChars, lineIndex);
    }

    return words;
}

export function pushWord(words: Word[], chars: TextChar[], lineIndex: number): void {
    if (chars.length === 0) {
        return;
    }

    const text = squashWhitespace(reconstructTextFromChars(chars));
    if (!text) {
        return;
    }

    const bbox = unionBoxes(chars.map((char) => char.bbox));
    if (!bbox) {
        return;
    }

    words.push({ text, bbox, lineIndex });
}

export function getLineText(line: TextLine): string {
    const chars = getPreparedLineChars(line);
    if (chars.length === 0) {
        return squashWhitespace(line.text);
    }

    if (inferLineDirection(line, chars) === "vertical") {
        return reconstructVerticalTextFromChars(chars);
    }

    return squashWhitespace(cleanupExtractedTextSpacing(reconstructTextFromChars(chars)));
}

export function getPreparedLineChars(line: TextLine): TextChar[] {
    return dedupeTextChars(
        sortTextChars(
            line.spans
                .flatMap((span) => span.chars)
                .filter((char) => char.char.length > 0 || char.bbox.width > 0 || char.bbox.height > 0)
        )
    );
}

export function sortTextChars(chars: TextChar[]): TextChar[] {
    if (shouldUseStreamOrder(chars)) {
        return sortTextCharsBySequence(chars);
    }

    return [...chars].sort((left, right) => {
        if (Math.abs(left.bbox.x - right.bbox.x) > 0.001) {
            return left.bbox.x - right.bbox.x;
        }

        if (Math.abs(left.fontSize - right.fontSize) > 0.001) {
            return right.fontSize - left.fontSize;
        }

        if (Math.abs(left.baseline - right.baseline) > 0.001) {
            return left.baseline - right.baseline;
        }

        if (typeof left.sequenceIndex === "number" && typeof right.sequenceIndex === "number") {
            if (left.sequenceIndex !== right.sequenceIndex) {
                return left.sequenceIndex - right.sequenceIndex;
            }
        }

        return left.bbox.y - right.bbox.y;
    });
}

export function shouldUseStreamOrder(chars: TextChar[]): boolean {
    if (chars.length <= 1 || !chars.every((char) => typeof char.sequenceIndex === "number")) {
        return false;
    }

    const visible = sortTextCharsBySequence(chars).filter((char) => getExpandedCharText(char.char).trim().length > 0);
    if (visible.length <= 1) {
        return true;
    }

    let decreasing = 0;
    let hasLargeBackwardJump = false;
    for (let index = 1; index < visible.length; index += 1) {
        const previous = visible[index - 1]!;
        const current = visible[index]!;
        if (current.bbox.x < previous.bbox.x) {
            decreasing += 1;
            const jump = previous.bbox.x - current.bbox.x;
            const jumpThreshold = Math.max(12, Math.min(previous.fontSize, current.fontSize) * 2);
            if (jump > jumpThreshold) {
                hasLargeBackwardJump = true;
            }
        }
    }

    const decreasingRatio = decreasing / (visible.length - 1);

    return (
        decreasingRatio >= RTL_BACKWARD_MOVEMENT_RATIO ||
        (!hasLargeBackwardJump && decreasingRatio < STREAM_ORDER_BACKWARD_MOVEMENT_RATIO)
    );
}

function sortTextCharsBySequence(chars: TextChar[]): TextChar[] {
    return [...chars].sort((left, right) => (left.sequenceIndex ?? 0) - (right.sequenceIndex ?? 0));
}

export function dedupeTextChars(chars: TextChar[], tolerance = TEXT_CHAR_DEDUPE_TOLERANCE): TextChar[] {
    const buckets = new Map<string, TextChar[]>();
    const deduped: TextChar[] = [];

    for (const char of chars) {
        const key = [
            getExpandedCharText(char.char),
            char.fontName,
            Math.round(char.fontSize * 10),
            Math.round(char.baseline * 10),
        ].join("|");
        const seen = buckets.get(key) ?? [];
        if (seen.some((candidate) => isLikelyDuplicateTextChar(candidate, char, tolerance))) {
            continue;
        }

        seen.push(char);
        buckets.set(key, seen);
        deduped.push(char);
    }

    return deduped;
}

export function isLikelyDuplicateTextChar(
    left: TextChar,
    right: TextChar,
    tolerance = TEXT_CHAR_DEDUPE_TOLERANCE
): boolean {
    return (
        getExpandedCharText(left.char) === getExpandedCharText(right.char) &&
        Math.abs(left.bbox.x - right.bbox.x) <= tolerance &&
        Math.abs(left.bbox.y - right.bbox.y) <= tolerance &&
        Math.abs(left.bbox.width - right.bbox.width) <= tolerance &&
        Math.abs(left.bbox.height - right.bbox.height) <= tolerance &&
        Math.abs(left.baseline - right.baseline) <= tolerance
    );
}

export function getExpandedCharText(value: string): string {
    return LIGATURE_EXPANSIONS[value] ?? value;
}

export function isScriptLikeTextChar(previous: TextChar, current: TextChar): boolean {
    const smaller = current.fontSize <= previous.fontSize * 0.9 || previous.fontSize <= current.fontSize * 0.9;
    const baselineDelta = Math.abs(current.baseline - previous.baseline);
    const horizontalProximity =
        current.bbox.x <= previous.bbox.x + previous.bbox.width + Math.max(current.bbox.width, 2);
    return smaller && horizontalProximity && baselineDelta >= Math.min(previous.fontSize, current.fontSize) * 0.15;
}

export function shouldTightlyJoinChars(previous: TextChar, current: TextChar): boolean {
    if (isScriptLikeTextChar(previous, current)) {
        return true;
    }

    const left = getExpandedCharText(previous.char);
    const right = getExpandedCharText(current.char);
    return /^[([{]$/.test(left) || /^[)\]}]$/.test(right);
}

export function cleanupExtractedTextSpacing(value: string): string {
    return value
        .replace(/\s+([,;:!?])/g, "$1")
        .replace(/\s+\.(?!\.)/g, ".")
        .replace(/\s+([+*=^~])/g, "$1")
        .replace(/([+*=^~])\s+/g, "$1")
        .replace(/([([{])\s+/g, "$1")
        .replace(/\s+([)\]}])/g, "$1")
        .trim();
}

export function getAdaptiveTextXTolerance(previous: TextChar, _current: TextChar): number {
    return previous.fontSize * TEXT_DEFAULT_X_TOLERANCE_RATIO;
}

export function getAdaptiveTextYTolerance(previous: TextChar, current: TextChar): number {
    return Math.max(
        TEXT_DEFAULT_Y_TOLERANCE,
        Math.min(previous.fontSize, current.fontSize) * TEXT_DEFAULT_Y_TOLERANCE_RATIO
    );
}

export function textCharBeginsNewWord(previous: TextChar, current: TextChar): boolean {
    if (isScriptLikeTextChar(previous, current)) {
        return false;
    }

    const direction = inferTextCharPairDirection(previous, current);
    const xTolerance = getAdaptiveTextXTolerance(previous, current);
    const yTolerance = getAdaptiveTextYTolerance(previous, current);

    if (direction === "vertical") {
        const ax = previous.bbox.y;
        const bx = getTop(previous.bbox);
        const cx = current.bbox.y;
        const ay = previous.bbox.x;
        const cy = current.bbox.x;
        return cx < ax || cx > bx + yTolerance || Math.abs(cy - ay) > xTolerance;
    }

    const ax = previous.bbox.x;
    const bx = previous.bbox.x + previous.bbox.width;
    const cx = current.bbox.x;
    const ay = previous.bbox.y;
    const cy = current.bbox.y;
    const baselineDelta = Math.abs(current.baseline - previous.baseline);
    return (
        cx < ax ||
        cx > bx + xTolerance ||
        (Math.abs(cy - ay) > yTolerance && baselineDelta > yTolerance)
    );
}

function inferTextCharPairDirection(previous: TextChar, current: TextChar): TextDirection {
    const direction = inferTextCharDirection(previous);
    if (direction === "horizontal" || !looksLikeHorizontalPair(previous, current)) {
        return direction;
    }

    return "horizontal";
}

function looksLikeHorizontalPair(previous: TextChar, current: TextChar): boolean {
    const fontSize = Math.min(previous.fontSize, current.fontSize);
    const tolerance = Math.max(3, fontSize * 0.35);
    const verticalOverlap = overlapLength(previous.bbox.y, getTop(previous.bbox), current.bbox.y, getTop(current.bbox));
    const minimumOverlap = Math.min(previous.bbox.height, current.bbox.height) * 0.6;
    const gap = current.bbox.x - (previous.bbox.x + previous.bbox.width);

    return (
        verticalOverlap >= minimumOverlap &&
        Math.abs(previous.baseline - current.baseline) <= tolerance &&
        gap >= -tolerance &&
        gap <= tolerance
    );
}

export function isWordBoundaryPunctuation(text: string): boolean {
    return text.length === 1 && WORD_BOUNDARY_PUNCTUATION.has(text);
}

export function isInlineTokenConnector(text: string): boolean {
    return text.length === 1 && INLINE_TOKEN_CONNECTORS.has(text);
}

export function hasBoundaryInlineConnector(text: string): boolean {
    return (
        text.length > 0 &&
        (INLINE_TOKEN_CONNECTORS.has(text[0] as string) || INLINE_TOKEN_CONNECTORS.has(text[text.length - 1] as string))
    );
}

export function hasStrongBoundaryInlineConnector(text: string): boolean {
    return (
        text.length > 0 &&
        (STRONG_INLINE_TOKEN_CONNECTORS.has(text[0] as string) ||
            STRONG_INLINE_TOKEN_CONNECTORS.has(text[text.length - 1] as string))
    );
}

export function shouldKeepCharsJoined(previous: TextChar, current: TextChar, gap: number): boolean {
    if (shouldTightlyJoinChars(previous, current)) {
        return true;
    }

    const left = getExpandedCharText(previous.char);
    const right = getExpandedCharText(current.char);
    const joinTolerance = getAdaptiveTextXTolerance(previous, current) * 1.35;
    const connectorJoinTolerance =
        hasStrongBoundaryInlineConnector(left) || hasStrongBoundaryInlineConnector(right)
            ? Math.max(joinTolerance, Math.min(previous.fontSize, current.fontSize) * 1.25)
            : joinTolerance;

    if ((hasBoundaryInlineConnector(left) || hasBoundaryInlineConnector(right)) && gap <= connectorJoinTolerance) {
        return true;
    }

    if (
        ((isLetter(left) && /^\d+$/.test(right)) || (/^\d+$/.test(left) && isLetter(right))) &&
        gap <= joinTolerance
    ) {
        return true;
    }

    return false;
}

export function shouldInsertSpaceBetweenChars(
    previous: TextChar,
    current: TextChar,
    gap: number
): boolean {
    if (gap <= 0 || shouldKeepCharsJoined(previous, current, gap)) {
        return false;
    }

    return textCharBeginsNewWord(previous, current);
}

export function reconstructTextLinesFromChars(chars: TextChar[], tolerance: number): TextChar[][] {
    const prepared = dedupeTextChars(chars);
    const { horizontal: horizontalChars, vertical: verticalChars } = splitLineCharsByDirection(prepared);
    const horizontalLines = reconstructHorizontalTextLines(horizontalChars, tolerance);
    const verticalLines = buildVerticalTextLines(verticalChars).map((line) => getPreparedLineChars(line));

    return [...horizontalLines, ...verticalLines].sort((left, right) => {
        const bboxLeft = unionBoxes(left.map((char) => char.bbox));
        const bboxRight = unionBoxes(right.map((char) => char.bbox));
        if (!bboxLeft || !bboxRight) {
            return 0;
        }

        const topDelta = getTop(bboxRight) - getTop(bboxLeft);
        if (Math.abs(topDelta) > 1) {
            return topDelta;
        }

        return bboxLeft.x - bboxRight.x;
    });
}

export function reconstructHorizontalTextLines(chars: TextChar[], tolerance: number): TextChar[][] {
    const ordered = dedupeTextChars(sortTextChars(chars));
    if (ordered.length === 0) {
        return [];
    }

    const lines: TextChar[][] = [[ordered[0]!]];
    for (const char of ordered.slice(1)) {
        const current = lines[lines.length - 1]!;
        const previous = current[current.length - 1]!;
        const baselineTolerance = Math.max(tolerance, Math.min(previous.fontSize, char.fontSize) * 0.5);
        const startsNewLine =
            Math.abs(char.baseline - previous.baseline) > baselineTolerance && !isScriptLikeTextChar(previous, char);

        if (startsNewLine) {
            lines.push([char]);
            continue;
        }

        current.push(char);
    }

    return lines;
}

export function reconstructLogicalLineText(chars: TextChar[]): string {
    if (chars.length === 0) {
        return "";
    }

    const verticalCount = chars.filter((char) => inferTextCharDirection(char) === "vertical").length;
    if (verticalCount >= Math.ceil(chars.length * 0.6)) {
        return reconstructVerticalTextFromChars(chars);
    }

    return cleanupExtractedTextSpacing(reconstructTextFromChars(chars));
}

export function reconstructTextFromChars(chars: TextChar[]): string {
    const ordered = dedupeTextChars(sortTextChars(chars));
    const output: TextChar[] = [];
    const parts: string[] = [];

    for (let index = 0; index < ordered.length; index += 1) {
        const char = ordered[index]!;
        const text = getExpandedCharText(char.char);
        if (text.trim().length === 0) {
            const previous = output[output.length - 1];
            const nextVisible = ordered
                .slice(index + 1)
                .find((candidate) => getExpandedCharText(candidate.char).trim().length > 0);
            const isSyntheticSpace = typeof char.sequenceIndex === "number" && !Number.isInteger(char.sequenceIndex);
            const shouldIgnoreSyntheticSpace =
                isSyntheticSpace &&
                previous !== undefined &&
                nextVisible !== undefined &&
                !textCharBeginsNewWord(previous, nextVisible);
            if (!shouldIgnoreSyntheticSpace && parts.length > 0 && parts[parts.length - 1] !== " ") {
                parts.push(" ");
            }
            continue;
        }

        const previous = output[output.length - 1];
        if (!previous) {
            output.push(char);
            parts.push(text);
            continue;
        }

        const previousEnd = previous.bbox.x + previous.bbox.width;
        const gap = char.bbox.x - previousEnd;
        const heavyOverlap = char.bbox.x <= previous.bbox.x + Math.min(previous.bbox.width, char.bbox.width) * 0.6;

        if (heavyOverlap) {
            if (isLikelyDuplicateTextChar(previous, char)) {
                continue;
            }

            if (isScriptLikeTextChar(previous, char)) {
                output.push(char);
                parts.push(text);
                continue;
            }

            if (shouldReplaceOverlappingChar(previous, char)) {
                output[output.length - 1] = char;
                parts[parts.length - 1] = text;
                continue;
            }
        }

        if (shouldInsertSpaceBetweenChars(previous, char, gap)) {
            parts.push(" ");
        }

        output.push(char);
        parts.push(text);
    }

    return parts.join("");
}

function isLetter(value: string): boolean {
    return /^\p{L}+$/u.test(value);
}

export function shouldReplaceOverlappingChar(previous: TextChar, current: TextChar): boolean {
    const previousChar = previous.char;
    const currentChar = current.char;

    if (/^[,.;:]$/.test(previousChar) && /[A-Za-z0-9]/.test(currentChar)) {
        return true;
    }

    if (previous.bbox.width >= current.bbox.width * 1.15 && /[A-Z]/.test(previousChar) && /[a-z]/.test(currentChar)) {
        return true;
    }

    if (
        previous.bbox.width >= current.bbox.width * 1.15 &&
        /[A-Za-z]/.test(previousChar) &&
        /[A-Za-z]/.test(currentChar)
    ) {
        return true;
    }

    return false;
}
