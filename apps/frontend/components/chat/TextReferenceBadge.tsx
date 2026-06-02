"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchSourceReference, getApiAssetUrl } from "@/lib/api/projects";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useApiClient } from "@/providers/ApiClientProvider";
import type { ApiSourceReference } from "@/types/api";
import { useQuery } from "@tanstack/react-query";
import type { ResolvedCitationFence } from "@kiwi/ai/citation";
import { Copy, Download, Loader2 } from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
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
type SourceReferencePdfRegionRect = SourceReferencePdfRegion["rectangles"][number];
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
    crop: SourceReferencePdfRegion["crop"];
    regions: SourceReferencePdfRegion[];
};

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
        <div className="relative overflow-hidden rounded-md border bg-white">
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

function PDFRegionPreview({ alt, group, src }: { alt: string; group: PDFRegionPreviewGroup; src: string }) {
    const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
    const imageWidth = getPositiveImageDimension(group.width, 1200);
    const imageHeight = getPositiveImageDimension(group.height, 1600);
    const cropWidth = Math.max(group.crop.width, 0.01);
    const cropHeight = Math.max(group.crop.height, 0.01);

    return (
        <div
            className="relative overflow-hidden rounded-md border bg-white"
            style={{
                aspectRatio: `${Math.max(1, imageWidth * cropWidth)} / ${Math.max(1, imageHeight * cropHeight)}`,
            }}
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
                    className="absolute max-w-none"
                    style={{
                        left: `${(-group.crop.left / cropWidth) * 100}%`,
                        top: `${(-group.crop.top / cropHeight) * 100}%`,
                        width: `${100 / cropWidth}%`,
                        height: `${100 / cropHeight}%`,
                    }}
                    onLoad={() => setStatus("loaded")}
                    onError={() => setStatus("error")}
                />
            )}
            {status !== "error"
                ? group.regions.map((region, regionIndex) =>
                      region.rectangles.map((rectangle, rectangleIndex) => {
                          const relative = toCropRelativeRect(rectangle, group.crop);

                          return (
                              <div
                                  key={`${region.chunk_id}-${regionIndex}-${rectangleIndex}`}
                                  data-testid="pdf-source-region-highlight"
                                  aria-hidden="true"
                                  className="pointer-events-none absolute rounded-[2px] border border-yellow-500/70 bg-yellow-300/35 shadow-[0_0_0_1px_rgba(250,204,21,0.2)]"
                                  style={{
                                      left: toPercent(relative.left),
                                      top: toPercent(relative.top),
                                      width: toPercent(relative.width),
                                      height: toPercent(relative.height),
                                  }}
                              />
                          );
                      })
                  )
                : null}
        </div>
    );
}

function groupPDFRegions(regions: SourceReferencePdfRegion[]): PDFRegionPreviewGroup[] {
    const groups = new Map<string, PDFRegionPreviewGroup>();

    for (const region of regions) {
        const key = `${region.image_path}:${region.page}`;
        const crop = normalizeCrop(region.crop);
        const existing = groups.get(key);

        if (!existing) {
            groups.set(key, {
                key,
                page: region.page,
                imagePath: region.image_path,
                width: getPositiveImageDimension(region.width, 1200),
                height: getPositiveImageDimension(region.height, 1600),
                crop,
                regions: [region],
            });
            continue;
        }

        existing.crop = unionCrops(existing.crop, crop);
        existing.regions.push(region);
    }

    return [...groups.values()];
}

function normalizeCrop(crop: SourceReferencePdfRegion["crop"]): SourceReferencePdfRegion["crop"] {
    let left = clampRatio(crop.left);
    let top = clampRatio(crop.top);
    let right = clampRatio(crop.left + Math.max(crop.width, 0.01));
    let bottom = clampRatio(crop.top + Math.max(crop.height, 0.01));

    if (right <= left) {
        right = Math.min(1, left + 0.01);
        left = Math.max(0, right - 0.01);
    }
    if (bottom <= top) {
        bottom = Math.min(1, top + 0.01);
        top = Math.max(0, bottom - 0.01);
    }

    return {
        left,
        top,
        width: right - left,
        height: bottom - top,
    };
}

function unionCrops(
    first: SourceReferencePdfRegion["crop"],
    second: SourceReferencePdfRegion["crop"]
): SourceReferencePdfRegion["crop"] {
    const left = Math.min(first.left, second.left);
    const top = Math.min(first.top, second.top);
    const right = Math.max(first.left + first.width, second.left + second.width);
    const bottom = Math.max(first.top + first.height, second.top + second.height);

    return {
        left,
        top,
        width: Math.max(0.01, right - left),
        height: Math.max(0.01, bottom - top),
    };
}

function toCropRelativeRect(
    rectangle: SourceReferencePdfRegionRect,
    crop: SourceReferencePdfRegion["crop"]
): SourceReferencePdfRegionRect {
    const cropWidth = Math.max(crop.width, 0.01);
    const cropHeight = Math.max(crop.height, 0.01);
    const left = clampRatio((rectangle.left - crop.left) / cropWidth);
    const top = clampRatio((rectangle.top - crop.top) / cropHeight);
    const right = clampRatio((rectangle.left + rectangle.width - crop.left) / cropWidth);
    const bottom = clampRatio((rectangle.top + rectangle.height - crop.top) / cropHeight);

    return {
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
    };
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
    const textChunks = useMemo(
        () => reference?.chunks.filter((chunk): chunk is SourceTextChunk => chunk.type === "text") ?? [],
        [reference?.chunks]
    );
    const imageChunks = useMemo(
        () => reference?.chunks.filter((chunk): chunk is SourceImageChunkRecord => chunk.type === "image") ?? [],
        [reference?.chunks]
    );
    const pdfRegionGroups = useMemo(() => groupPDFRegions(reference?.pdf_regions ?? []), [reference?.pdf_regions]);
    const copyText = useMemo(() => textChunks.map((chunk) => chunk.text).join("\n\n"), [textChunks]);
    const sourceFileName = unit?.file_name ?? citation.fileName;

    const copyToClipboard = () => {
        if (copyText) {
            void navigator.clipboard.writeText(copyText);
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
            <DialogContent
                aria-describedby={undefined}
                className="flex max-h-[80vh] w-full max-w-6xl flex-col overflow-hidden sm:max-w-[60vw]"
            >
                <DialogHeader className="shrink-0 pr-8 sm:flex-row sm:items-center sm:justify-between">
                    <DialogTitle>{t("text.reference")} #{index + 1}</DialogTitle>
                    {projectId && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleDownload}
                            disabled={isDownloading}
                            className="max-w-full justify-start gap-2 sm:max-w-sm"
                            title={sourceFileName}
                        >
                            {isDownloading ? (
                                <Loader2 data-icon="inline-start" className="animate-spin" />
                            ) : (
                                <Download data-icon="inline-start" />
                            )}
                            <span className="truncate">{sourceFileName}</span>
                        </Button>
                    )}
                </DialogHeader>

                <div
                    data-testid="text-reference-dialog-body"
                    className="min-h-0 max-h-[calc(80vh-6rem)] overflow-y-auto pr-1"
                >
                    <div className="flex flex-col gap-4">
                        {error && (
                            <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                                <p className="font-medium text-destructive">{t("error.loading")}</p>
                                <p className="text-sm text-destructive/80">{error}</p>
                            </div>
                        )}

                        <div className="flex flex-col gap-4">
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
                                        />
                                    ))}
                                    {imageChunks.map((chunk) => (
                                        <SourceImageChunk
                                            key={chunk.chunk_id}
                                            chunk={chunk}
                                            src={getApiAssetUrl(apiClient, chunk.image_path)}
                                        />
                                    ))}
                                    <TextChunksPanel chunks={textChunks} onCopy={copyToClipboard} />
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
