"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchSourceReference, getApiAssetUrl } from "@/lib/api/projects";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useApiClient } from "@/providers/ApiClientProvider";
import type { ApiSourceReference } from "@/types/api";
import { useQuery } from "@tanstack/react-query";
import type { ResolvedCitationFence } from "@kiwi/ai/citation";
import { Copy, Download, Loader2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openCitationSourceFile } from "./citation-file";

type TextReferenceBadgeProps = {
    citation: ResolvedCitationFence;
    index: number;
    onSelect: () => void;
};

type TextReferenceDialogProps = {
    citation: ResolvedCitationFence;
    index: number;
    projectId?: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

type SourceReferenceChunk = ApiSourceReference["chunks"][number];
type SourceReferencePdfRegion = ApiSourceReference["pdf_regions"][number];
type SourceTextChunk = Extract<SourceReferenceChunk, { type: "text" }>;
type SourceImageChunkRecord = Extract<SourceReferenceChunk, { type: "image" }>;

export const SOURCE_REFERENCE_STALE_TIME_MS = 5 * 60 * 1000;
export const SOURCE_REFERENCE_GC_TIME_MS = 15 * 60 * 1000;

export function sourceReferenceQueryKey(projectId: string | undefined, sourceId: string) {
    return ["source-reference", projectId, sourceId] as const;
}

type PDFRegionPreviewGroup = {
    key: string;
    page: number;
    imagePath: string;
    width: number;
    height: number;
    regions: SourceReferencePdfRegion[];
};

type HighlightRectangle = {
    left: number;
    top: number;
    width: number;
    height: number;
};

const HIGHLIGHT_MERGE_TOLERANCE = 0.004;
const FULL_PAGE_RECTANGLE_TOLERANCE = 0.002;

export function mergeHighlightRectangles(rectangles: HighlightRectangle[]): HighlightRectangle[] {
    const merged = rectangles.map((rectangle) => ({
        left: clampRatio(rectangle.left),
        top: clampRatio(rectangle.top),
        width: clampRatio(rectangle.width),
        height: clampRatio(rectangle.height),
    }));

    let didMerge = true;
    while (didMerge) {
        didMerge = false;

        for (let index = 0; index < merged.length && !didMerge; index += 1) {
            for (let otherIndex = index + 1; otherIndex < merged.length; otherIndex += 1) {
                const current = merged[index]!;
                const other = merged[otherIndex]!;
                if (!rectanglesTouch(current, other)) {
                    continue;
                }

                merged[index] = unionRectangles(current, other);
                merged.splice(otherIndex, 1);
                didMerge = true;
                break;
            }
        }
    }

    return merged;
}

function rectanglesTouch(a: HighlightRectangle, b: HighlightRectangle): boolean {
    return (
        a.left <= b.left + b.width + HIGHLIGHT_MERGE_TOLERANCE &&
        b.left <= a.left + a.width + HIGHLIGHT_MERGE_TOLERANCE &&
        a.top <= b.top + b.height + HIGHLIGHT_MERGE_TOLERANCE &&
        b.top <= a.top + a.height + HIGHLIGHT_MERGE_TOLERANCE
    );
}

function unionRectangles(a: HighlightRectangle, b: HighlightRectangle): HighlightRectangle {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    const right = Math.max(a.left + a.width, b.left + b.width);
    const bottom = Math.max(a.top + a.height, b.top + b.height);

    return { left, top, width: right - left, height: bottom - top };
}

function isFullPageRectangle(rectangle: HighlightRectangle): boolean {
    return (
        rectangle.left <= FULL_PAGE_RECTANGLE_TOLERANCE &&
        rectangle.top <= FULL_PAGE_RECTANGLE_TOLERANCE &&
        rectangle.left + rectangle.width >= 1 - FULL_PAGE_RECTANGLE_TOLERANCE &&
        rectangle.top + rectangle.height >= 1 - FULL_PAGE_RECTANGLE_TOLERANCE
    );
}

function isPageLevelRegion(region: SourceReferencePdfRegion): boolean {
    return region.kind === "page" || region.rectangles.some(isFullPageRectangle);
}

export function TextReferenceBadge({ citation, index, onSelect }: TextReferenceBadgeProps) {
    const t = useAppTranslations();

    return (
        <Badge
            variant="outline"
            asChild
            className="mx-0.5 inline-flex cursor-pointer items-center border-2 text-xs transition-colors hover:border-primary/40 hover:bg-primary/10"
        >
            <button
                type="button"
                title={`${t("text.reference")} ${index + 1}: ${citation.sourceId}`}
                onClick={onSelect}
            >
                {index + 1}
            </button>
        </Badge>
    );
}

function TextChunksPanel({ chunks, onCopy }: { chunks: SourceTextChunk[]; onCopy: () => void }) {
    const t = useAppTranslations();

    if (chunks.length === 0) {
        return null;
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
                <h4 className="font-medium">{t("text.content")}</h4>
                <Button variant="outline" size="sm" onClick={onCopy} className="flex items-center gap-2">
                    <Copy data-icon="inline-start" />
                    {t("copy")}
                </Button>
            </div>

            <div className="flex max-h-[50vh] flex-col gap-2 overflow-auto rounded-md border p-3">
                {chunks.map((chunk) => (
                    <div
                        key={chunk.chunk_id}
                        className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm leading-relaxed"
                    >
                        {chunk.text}
                    </div>
                ))}
            </div>
        </div>
    );
}

function SourceImageChunk({ chunk, src }: { chunk: SourceImageChunkRecord; src: string }) {
    const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

    return (
        <div className="relative overflow-hidden bg-white">
            {status === "loading" ? (
                <div className="absolute inset-0 flex min-h-40 items-center justify-center bg-muted/30 text-muted-foreground">
                    <Loader2 className="animate-spin" />
                </div>
            ) : null}
            {status === "error" ? (
                <div className="flex min-h-40 items-center justify-center p-4 text-sm text-destructive">
                    {chunk.alt}
                </div>
            ) : (
                <Image
                    src={src}
                    alt={chunk.alt}
                    width={1200}
                    height={900}
                    unoptimized
                    crossOrigin="use-credentials"
                    className="block h-auto w-full"
                    onLoad={() => setStatus("loaded")}
                    onError={() => setStatus("error")}
                />
            )}
        </div>
    );
}

function PDFRegionPreview({
    alt,
    group,
    src,
    autoScrollToHighlight = false,
    onImageLoad,
}: {
    alt: string;
    group: PDFRegionPreviewGroup;
    src: string;
    autoScrollToHighlight?: boolean;
    onImageLoad?: () => void;
}) {
    const t = useAppTranslations();
    const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
    const firstHighlightRef = useRef<HTMLDivElement | null>(null);
    const didAutoScroll = useRef(false);
    const imageWidth = getPositiveImageDimension(group.width, 1200);
    const imageHeight = getPositiveImageDimension(group.height, 1600);
    const { highlightRectangles, hasPageLevelHighlight } = useMemo(() => {
        const rectangles: HighlightRectangle[] = [];
        let hasPageLevel = false;

        for (const region of group.regions) {
            if (isPageLevelRegion(region)) {
                hasPageLevel = true;
                continue;
            }

            rectangles.push(...region.rectangles);
        }

        return {
            highlightRectangles: mergeHighlightRectangles(rectangles),
            hasPageLevelHighlight: hasPageLevel,
        };
    }, [group.regions]);

    const handleLoaded = () => {
        setStatus("loaded");
        onImageLoad?.();

        if (autoScrollToHighlight && !didAutoScroll.current && firstHighlightRef.current) {
            didAutoScroll.current = true;
            const highlight = firstHighlightRef.current;
            requestAnimationFrame(() => highlight.scrollIntoView({ behavior: "smooth", block: "start" }));
        }
    };

    return (
        <div
            className={`relative overflow-hidden bg-white ${
                hasPageLevelHighlight ? "ring-1 ring-inset ring-sky-500/70" : ""
            }`}
        >
            {status === "loading" ? (
                <div className="absolute inset-0 flex min-h-40 items-center justify-center bg-muted/30 text-muted-foreground">
                    <Loader2 className="animate-spin" />
                </div>
            ) : null}
            {status === "error" ? (
                <div className="flex min-h-40 items-center justify-center p-4 text-sm text-destructive">{alt}</div>
            ) : (
                <Image
                    src={src}
                    alt={alt}
                    width={imageWidth}
                    height={imageHeight}
                    unoptimized
                    crossOrigin="use-credentials"
                    className="block h-auto w-full"
                    onLoad={handleLoaded}
                    onError={() => setStatus("error")}
                />
            )}
            {status !== "error"
                ? highlightRectangles.map((rectangle, rectangleIndex) => (
                      <div
                          key={`${rectangle.left}-${rectangle.top}-${rectangle.width}-${rectangle.height}`}
                          ref={rectangleIndex === 0 ? firstHighlightRef : undefined}
                          data-testid="pdf-source-region-highlight"
                          data-pdf-highlight=""
                          aria-hidden="true"
                          className="pointer-events-none absolute scroll-mt-4 rounded-[2px] border border-sky-600/60 bg-sky-400/20 mix-blend-multiply"
                          style={{
                              left: toPercent(rectangle.left),
                              top: toPercent(rectangle.top),
                              width: toPercent(rectangle.width),
                              height: toPercent(rectangle.height),
                          }}
                      />
                  ))
                : null}
            {status !== "error" && hasPageLevelHighlight ? (
                <>
                    <div
                        ref={highlightRectangles.length === 0 ? firstHighlightRef : undefined}
                        data-pdf-highlight=""
                        data-pdf-page-highlight=""
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0 top-0 h-2 w-full scroll-mt-4"
                    />
                    <div
                        data-testid="pdf-source-page-highlight"
                        aria-hidden="true"
                        className="pointer-events-none absolute left-2 top-2 rounded-sm border border-sky-600/40 bg-white/90 px-2 py-1 text-[11px] font-medium text-sky-900 shadow-sm"
                    >
                        {t("source.fullPage")}
                    </div>
                </>
            ) : null}
        </div>
    );
}

function groupPDFRegions(regions: SourceReferencePdfRegion[]): PDFRegionPreviewGroup[] {
    const groups = new Map<string, PDFRegionPreviewGroup>();

    for (const region of regions) {
        const key = `${region.image_path}:${region.page}`;
        const existing = groups.get(key);

        if (!existing) {
            groups.set(key, {
                key,
                page: region.page,
                imagePath: region.image_path,
                width: getPositiveImageDimension(region.width, 1200),
                height: getPositiveImageDimension(region.height, 1600),
                regions: [region],
            });
            continue;
        }

        existing.regions.push(region);
    }

    return [...groups.values()];
}

function clampRatio(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(1, value));
}

function toPercent(value: number): string {
    return `${Number((value * 100).toFixed(4))}%`;
}

function getPositiveImageDimension(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : fallback;
}

export function TextReferenceDialog({ citation, index, projectId, open, onOpenChange }: TextReferenceDialogProps) {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const sourceReferenceQuery = useQuery({
        queryKey: sourceReferenceQueryKey(projectId, citation.sourceId),
        queryFn: () => {
            if (!projectId) {
                throw new Error(t("error.unknown"));
            }

            return fetchSourceReference(apiClient, projectId, citation.sourceId);
        },
        enabled: open && Boolean(projectId),
        staleTime: SOURCE_REFERENCE_STALE_TIME_MS,
        gcTime: SOURCE_REFERENCE_GC_TIME_MS,
    });
    const reference = sourceReferenceQuery.data ?? null;
    const referenceError =
        sourceReferenceQuery.error instanceof Error ? sourceReferenceQuery.error.message : t("error.unknown");
    const error = downloadError ?? (sourceReferenceQuery.isError ? referenceError : null);

    const unit = reference?.unit ?? null;
    const sourceFileName = unit?.file_name ?? citation.fileName;
    const textChunks = useMemo(
        () => reference?.chunks.filter((chunk): chunk is SourceTextChunk => chunk.type === "text") ?? [],
        [reference?.chunks]
    );
    const imageChunks = useMemo(
        () => reference?.chunks.filter((chunk): chunk is SourceImageChunkRecord => chunk.type === "image") ?? [],
        [reference?.chunks]
    );
    const pdfRegionGroups = useMemo(() => groupPDFRegions(reference?.pdf_regions ?? []), [reference?.pdf_regions]);
    const firstHighlightGroupKey = useMemo(
        () =>
            pdfRegionGroups.find((group) => group.regions.some((region) => region.rectangles.length > 0))?.key ?? null,
        [pdfRegionGroups]
    );
    const copyText = useMemo(() => textChunks.map((chunk) => chunk.text).join("\n\n"), [textChunks]);

    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const hasLoadedImageRef = useRef(false);
    const [highlightMarkers, setHighlightMarkers] = useState<
        { id: string; top: number; height: number; scrollTop: number }[]
    >([]);

    const measureHighlightMarkers = useCallback(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const { scrollHeight, clientHeight } = container;
        const containerTop = container.getBoundingClientRect().top;
        const scrollTop = container.scrollTop;
        const highlights = Array.from(container.querySelectorAll<HTMLElement>("[data-pdf-highlight]"));

        setHighlightMarkers(
            highlights.map((element, index) => {
                const rect = element.getBoundingClientRect();
                const offsetTop = rect.top - containerTop + scrollTop;
                const center = offsetTop + rect.height / 2;

                return {
                    id: `${index}`,
                    top: scrollHeight > 0 ? Math.min(1, Math.max(0, offsetTop / scrollHeight)) : 0,
                    height: scrollHeight > 0 ? Math.min(1, rect.height / scrollHeight) : 0,
                    scrollTop: Math.max(0, Math.min(scrollHeight - clientHeight, center - clientHeight / 2)),
                };
            })
        );
    }, []);

    useEffect(() => {
        if (!open) {
            setHighlightMarkers([]);
            hasLoadedImageRef.current = false;
            return;
        }

        const container = scrollContainerRef.current;
        if (!container) return;

        // Only re-measure once at least one image has loaded; measuring before
        // that yields wrong positions in not-yet-laid-out (collapsed) previews.
        const observer = new ResizeObserver(() => {
            if (hasLoadedImageRef.current) measureHighlightMarkers();
        });
        observer.observe(container);

        return () => observer.disconnect();
    }, [open, measureHighlightMarkers]);

    const handleImageLoad = useCallback(() => {
        hasLoadedImageRef.current = true;
        requestAnimationFrame(measureHighlightMarkers);
    }, [measureHighlightMarkers]);

    const handleCopyToClipboard = () => {
        if (copyText) {
            void copyToClipboard(copyText);
        }
    };

    const handleDownload = async () => {
        if (!projectId) return;

        setIsDownloading(true);
        setDownloadError(null);
        try {
            await openCitationSourceFile(apiClient, projectId, citation);
        } catch (err) {
            setDownloadError(err instanceof Error ? err.message : t("error.unknown"));
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[80vh] w-full max-w-6xl flex-col overflow-hidden sm:max-w-[60vw]">
                <DialogHeader className="shrink-0">
                    <div className="flex items-center justify-between gap-4 pr-8">
                        <DialogTitle>
                            {t("text.reference")} #{index + 1}
                        </DialogTitle>
                        {projectId && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleDownload}
                                disabled={isDownloading}
                                title={sourceFileName}
                                className="max-w-[50%] shrink-0"
                            >
                                {isDownloading ? (
                                    <Loader2 data-icon="inline-start" className="animate-spin" />
                                ) : (
                                    <Download data-icon="inline-start" />
                                )}
                                <span className="truncate">{sourceFileName}</span>
                            </Button>
                        )}
                    </div>
                    <DialogDescription className={pdfRegionGroups.length > 1 ? undefined : "sr-only"}>
                        {pdfRegionGroups.length > 1
                            ? t("source.pages.other", { count: pdfRegionGroups.length })
                            : `${t("reference.id")}: ${citation.sourceId}`}
                    </DialogDescription>
                </DialogHeader>

                <div className="relative min-h-0 flex-1">
                    <div ref={scrollContainerRef} className="h-full overflow-y-auto rounded-lg border">
                        <div className="flex flex-col gap-4">
                            {error && (
                                <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                                    <p className="font-medium text-destructive">{t("error.loading")}</p>
                                    <p className="text-sm text-destructive/80">{error}</p>
                                </div>
                            )}

                            {sourceReferenceQuery.isLoading ? (
                                <div className="flex min-h-40 items-center justify-center rounded-md border text-muted-foreground">
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    {t("loading")}
                                </div>
                            ) : (
                                <>
                                    {pdfRegionGroups.map((group) => (
                                        <PDFRegionPreview
                                            key={group.key}
                                            group={group}
                                            src={getApiAssetUrl(apiClient, group.imagePath)}
                                            alt={`${sourceFileName} page ${group.page}`}
                                            autoScrollToHighlight={group.key === firstHighlightGroupKey}
                                            onImageLoad={handleImageLoad}
                                        />
                                    ))}
                                    {imageChunks.map((chunk) => (
                                        <SourceImageChunk
                                            key={chunk.chunk_id}
                                            chunk={chunk}
                                            src={getApiAssetUrl(apiClient, chunk.image_path)}
                                        />
                                    ))}
                                    <TextChunksPanel chunks={textChunks} onCopy={handleCopyToClipboard} />
                                </>
                            )}
                        </div>
                    </div>
                    {highlightMarkers.length > 0 && (
                        <div className="pointer-events-none absolute inset-y-2 right-1 w-3">
                            {highlightMarkers.map((marker, index) => (
                                <button
                                    key={marker.id}
                                    type="button"
                                    aria-label={t("source.jump.highlight", { index: index + 1 })}
                                    onClick={() =>
                                        scrollContainerRef.current?.scrollTo({
                                            top: marker.scrollTop,
                                            behavior: "smooth",
                                        })
                                    }
                                    className="pointer-events-auto absolute right-0 min-h-1.5 w-2 rounded-full bg-sky-500/80 transition-colors hover:bg-sky-600"
                                    style={{ top: `${marker.top * 100}%`, height: `${marker.height * 100}%` }}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
