import type { BoundingBox, PositionedRegion } from "./types";
import { getTop, median, overlapLength } from "./geometry";

export function orderItemsByReadingLayout<T>(items: T[], getBBox: (item: T) => BoundingBox, pageWidth: number): T[] {
    return orderPositionedRegions(
        items.map((item) => createPositionedRegion(item, getBBox(item))),
        pageWidth,
        0
    ).map((region) => region.value);
}

export function createPositionedRegion<T>(value: T, bbox: BoundingBox): PositionedRegion<T> {
    const left = bbox.x;
    const right = bbox.x + bbox.width;
    const top = getTop(bbox);
    const bottom = bbox.y;
    return {
        value,
        bbox,
        left,
        right,
        top,
        bottom,
        width: bbox.width,
        height: bbox.height,
        centerX: left + bbox.width / 2,
        centerY: bottom + bbox.height / 2,
    };
}

export function orderPositionedRegions<T>(
    regions: PositionedRegion<T>[],
    pageWidth: number,
    depth: number
): PositionedRegion<T>[] {
    if (regions.length <= 1 || depth >= 8) {
        return sortRegionsTopLeft(regions);
    }

    const verticalSplit = findVerticalReadingSplit(regions, pageWidth);
    if (verticalSplit) {
        return orderRegionsWithVerticalSplit(verticalSplit, pageWidth, depth + 1);
    }

    const horizontalSplit = findHorizontalReadingSplit(regions);
    if (horizontalSplit) {
        return [
            ...orderPositionedRegions(horizontalSplit.top, pageWidth, depth + 1),
            ...orderPositionedRegions(horizontalSplit.bottom, pageWidth, depth + 1),
        ];
    }

    return sortRegionsTopLeft(regions);
}

export function sortRegionsTopLeft<T>(regions: PositionedRegion<T>[]): PositionedRegion<T>[] {
    return [...regions].sort((left, right) => {
        const topDelta = right.top - left.top;
        if (Math.abs(topDelta) > 1) {
            return topDelta;
        }

        return left.left - right.left;
    });
}

export function findHorizontalReadingSplit<T>(
    regions: PositionedRegion<T>[]
): { top: PositionedRegion<T>[]; bottom: PositionedRegion<T>[] } | null {
    if (regions.length < 3) {
        return null;
    }

    const sorted = sortRegionsTopLeft(regions);
    const heights = sorted.map((region) => region.height).filter((height) => height > 0);
    const baselineGap = Math.max(18, (median(heights) || 12) * 2.5);
    let runningBottom = sorted[0]?.bottom ?? 0;
    let bestIndex = -1;
    let bestGap = 0;

    for (let index = 1; index < sorted.length; index += 1) {
        const region = sorted[index];
        if (!region) {
            continue;
        }

        const gap = runningBottom - region.top;
        if (gap > baselineGap && gap > bestGap) {
            bestGap = gap;
            bestIndex = index;
        }

        runningBottom = Math.min(runningBottom, region.bottom);
    }

    if (bestIndex <= 0 || bestIndex >= sorted.length) {
        return null;
    }

    return {
        top: sorted.slice(0, bestIndex),
        bottom: sorted.slice(bestIndex),
    };
}

export function findVerticalReadingSplit<T>(
    regions: PositionedRegion<T>[],
    pageWidth: number
): {
    left: PositionedRegion<T>[];
    right: PositionedRegion<T>[];
    spanning: PositionedRegion<T>[];
} | null {
    if (regions.length < 2) {
        return null;
    }

    const centerLeft = pageWidth * 0.45;
    const centerRight = pageWidth * 0.55;
    const narrowRegions = regions.filter(
        (region) => region.width <= pageWidth * 0.55 && (region.right <= centerLeft || region.left >= centerRight)
    );
    if (narrowRegions.length < 2) {
        return null;
    }

    const merged = mergeHorizontalIntervals(narrowRegions.map((region) => ({ start: region.left, end: region.right })));
    if (merged.length < 2) {
        return null;
    }

    const minimumGap = Math.max(24, pageWidth * 0.04);
    let bestGap: { start: number; end: number } | null = null;
    for (let index = 0; index < merged.length - 1; index += 1) {
        const current = merged[index];
        const next = merged[index + 1];
        if (!current || !next) {
            continue;
        }

        const gapWidth = next.start - current.end;
        if (gapWidth < minimumGap) {
            continue;
        }

        if (!bestGap || gapWidth > bestGap.end - bestGap.start) {
            bestGap = { start: current.end, end: next.start };
        }
    }

    if (!bestGap) {
        return null;
    }

    const center = (bestGap.start + bestGap.end) / 2;
    const tolerance = Math.max(6, (bestGap.end - bestGap.start) * 0.15);
    const left = regions.filter((region) => region.right <= center + tolerance);
    const right = regions.filter((region) => region.left >= center - tolerance);
    const spanning = regions.filter((region) => !left.includes(region) && !right.includes(region));
    if (left.length === 0 || right.length === 0) {
        return null;
    }

    const hasParallelContent = left.some((leftRegion) =>
        right.some((rightRegion) =>
            verticalRegionsOverlap(
                leftRegion,
                rightRegion,
                Math.max(8, Math.min(leftRegion.height, rightRegion.height))
            )
        )
    );
    if (!hasParallelContent) {
        return null;
    }

    return { left, right, spanning };
}

export function mergeHorizontalIntervals(
    intervals: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
    const sorted = [...intervals].sort((left, right) => left.start - right.start);
    const merged: Array<{ start: number; end: number }> = [];
    const tolerance = 12;

    for (const interval of sorted) {
        const current = merged[merged.length - 1];
        if (!current || interval.start > current.end + tolerance) {
            merged.push({ ...interval });
            continue;
        }

        current.end = Math.max(current.end, interval.end);
    }

    return merged;
}

export function verticalRegionsOverlap<T>(
    left: PositionedRegion<T>,
    right: PositionedRegion<T>,
    tolerance: number
): boolean {
    return overlapLength(left.bottom, left.top, right.bottom, right.top) > -tolerance;
}

export function orderRegionsWithVerticalSplit<T>(
    split: { left: PositionedRegion<T>[]; right: PositionedRegion<T>[]; spanning: PositionedRegion<T>[] },
    pageWidth: number,
    depth: number
): PositionedRegion<T>[] {
    if (split.spanning.length === 0) {
        return [
            ...orderPositionedRegions(split.left, pageWidth, depth),
            ...orderPositionedRegions(split.right, pageWidth, depth),
        ];
    }

    const spanning = sortRegionsTopLeft(split.spanning);
    const nonSpanning = [...split.left, ...split.right];
    const ordered: PositionedRegion<T>[] = [];
    let currentTop = Number.POSITIVE_INFINITY;

    for (const span of spanning) {
        const above = nonSpanning.filter((region) => region.centerY < currentTop && region.centerY > span.top);
        if (above.length > 0) {
            ordered.push(...orderPositionedRegions(above, pageWidth, depth));
        }

        ordered.push(span);
        currentTop = span.bottom;
    }

    const below = nonSpanning.filter((region) => region.centerY < currentTop);
    if (below.length > 0) {
        ordered.push(...orderPositionedRegions(below, pageWidth, depth));
    }

    return dedupeOrderedRegions(ordered);
}

export function dedupeOrderedRegions<T>(regions: PositionedRegion<T>[]): PositionedRegion<T>[] {
    const seen = new Set<PositionedRegion<T>>();
    const unique: PositionedRegion<T>[] = [];
    for (const region of regions) {
        if (seen.has(region)) {
            continue;
        }
        seen.add(region);
        unique.push(region);
    }
    return unique;
}
