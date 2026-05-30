"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchSourceReference, getApiAssetUrl } from "@/lib/api/projects";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useApiClient } from "@/providers/ApiClientProvider";
import type { ApiSourceReference } from "@/types/api";
import type { ResolvedCitationFence } from "@kiwi/ai/citation";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import Image from "next/image";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
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

function PDFRegionPreview({ alt, region, src }: { alt: string; region: SourceReferencePdfRegion; src: string }) {
    const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
    const imageWidth = getPositiveImageDimension(region.width, 1200);
    const imageHeight = getPositiveImageDimension(region.height, 1600);
    const cropWidth = Math.max(region.crop.width, 0.01);
    const cropHeight = Math.max(region.crop.height, 0.01);

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
                        left: `${(-region.crop.left / cropWidth) * 100}%`,
                        top: `${(-region.crop.top / cropHeight) * 100}%`,
                        width: `${100 / cropWidth}%`,
                        height: `${100 / cropHeight}%`,
                    }}
                    onLoad={() => setStatus("loaded")}
                    onError={() => setStatus("error")}
                />
            )}
            {status !== "error"
                ? region.rectangles.map((rectangle, index) => {
                      const relative = toCropRelativeRect(rectangle, region.crop);

                      return (
                          <div
                              key={`${region.chunk_id}-${index}`}
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
                : null}
        </div>
    );
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
    const getUnknownErrorLabel = useEffectEvent(() => t("error.unknown"));
    const [isLoadingReference, setIsLoadingReference] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reference, setReference] = useState<ApiSourceReference | null>(null);

    useEffect(() => {
        if (!open || !projectId) {
            return;
        }

        let isCancelled = false;

        const loadReference = async () => {
            setIsLoadingReference(true);
            setError(null);
            setReference(null);
            try {
                const loadedReference = await fetchSourceReference(apiClient, projectId, citation.sourceId);
                if (!isCancelled) {
                    setReference(loadedReference);
                }
            } catch (err) {
                if (!isCancelled) {
                    setError(err instanceof Error ? err.message : getUnknownErrorLabel());
                }
            } finally {
                if (!isCancelled) {
                    setIsLoadingReference(false);
                }
            }
        };

        void loadReference();

        return () => {
            isCancelled = true;
        };
    }, [apiClient, citation.sourceId, open, projectId]);

    const unit = reference?.unit ?? null;
    const textChunks = useMemo(
        () => reference?.chunks.filter((chunk): chunk is SourceTextChunk => chunk.type === "text") ?? [],
        [reference?.chunks]
    );
    const imageChunks = useMemo(
        () => reference?.chunks.filter((chunk): chunk is SourceImageChunkRecord => chunk.type === "image") ?? [],
        [reference?.chunks]
    );
    const copyText = useMemo(() => textChunks.map((chunk) => chunk.text).join("\n\n"), [textChunks]);

    const copyToClipboard = () => {
        if (copyText) {
            void navigator.clipboard.writeText(copyText);
        }
    };

    const handleDownload = async () => {
        if (!projectId) return;

        setIsDownloading(true);
        setError(null);
        try {
            await openCitationSourceFile(apiClient, projectId, citation);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("error.unknown"));
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[80vh] w-full max-w-6xl flex-col overflow-hidden sm:max-w-[60vw]">
                <DialogHeader className="shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        <ExternalLink className="h-4 w-4" />
                        {t("text.reference")} #{index + 1}
                    </DialogTitle>
                    <DialogDescription>
                        {t("reference.id")}: {citation.sourceId}
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1">
                    <ScrollArea className="h-full pr-1">
                        <div className="flex flex-col gap-4">
                            {error && (
                                <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                                    <p className="font-medium text-destructive">{t("error.loading")}</p>
                                    <p className="text-sm text-destructive/80">{error}</p>
                                </div>
                            )}

                            <div className="flex flex-col gap-4">
                                {isLoadingReference ? (
                                    <div className="flex min-h-40 items-center justify-center rounded-md border text-muted-foreground">
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        {t("loading")}
                                    </div>
                                ) : (
                                    <>
                                        {reference?.pdf_regions.map((region, regionIndex) => (
                                            <PDFRegionPreview
                                                key={`${region.chunk_id}-${region.page}-${regionIndex}`}
                                                region={region}
                                                src={getApiAssetUrl(apiClient, region.image_path)}
                                                alt={`${unit?.file_name ?? citation.fileName} page ${region.page}`}
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

                                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                                    <p>
                                        {t("file")}: {unit?.file_name ?? citation.fileName}
                                    </p>
                                </div>

                                {projectId && (
                                    <div className="flex justify-end">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleDownload}
                                            disabled={isDownloading}
                                        >
                                            {isDownloading ? (
                                                <Loader2 data-icon="inline-start" className="animate-spin" />
                                            ) : null}
                                            {citation.fileName}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </ScrollArea>
                </div>
            </DialogContent>
        </Dialog>
    );
}
