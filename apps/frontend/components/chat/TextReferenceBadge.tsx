"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { downloadProjectFile, fetchTextUnit } from "@/lib/api/projects";
import { useLanguage } from "@/providers/LanguageProvider";
import type { ResolvedCitationFence } from "@kiwi/ai/citation";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

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

export function TextReferenceBadge({ citation, index, onSelect }: TextReferenceBadgeProps) {
    const { t } = useLanguage();

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

export function TextReferenceDialog({ citation, index, projectId, open, onOpenChange }: TextReferenceDialogProps) {
    const { t } = useLanguage();
    const getUnknownErrorLabel = useEffectEvent(() => t("error.unknown"));
    const [isLoadingUnit, setIsLoadingUnit] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [unitText, setUnitText] = useState<string | null>(null);

    useEffect(() => {
        if (!open || !projectId) {
            return;
        }

        let isCancelled = false;

        const loadUnit = async () => {
            setIsLoadingUnit(true);
            setError(null);
            setUnitText(null);
            try {
                const unit = await fetchTextUnit(projectId, citation.unitId);
                if (!isCancelled) {
                    setUnitText(unit.text);
                }
            } catch (err) {
                if (!isCancelled) {
                    setError(err instanceof Error ? err.message : getUnknownErrorLabel());
                }
            } finally {
                if (!isCancelled) {
                    setIsLoadingUnit(false);
                }
            }
        };

        void loadUnit();

        return () => {
            isCancelled = true;
        };
    }, [citation.unitId, open, projectId]);

    const copyToClipboard = () => {
        if (unitText) {
            navigator.clipboard.writeText(unitText);
        }
    };

    const handleDownload = async () => {
        if (!projectId) return;

        setIsDownloading(true);
        setError(null);
        try {
            const downloadUrl = await downloadProjectFile(projectId, citation.fileKey);
            window.open(downloadUrl, "_blank");
        } catch (err) {
            setError(err instanceof Error ? err.message : t("error.unknown"));
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[80vh] w-full max-w-6xl overflow-hidden sm:max-w-[60vw]">
                <div className="flex h-full flex-col overflow-hidden">
                    <DialogHeader className="shrink-0">
                        <DialogTitle className="flex items-center gap-2">
                            <ExternalLink className="h-4 w-4" />
                            {t("text.reference")} #{index + 1}
                        </DialogTitle>
                        <DialogDescription>
                            {t("reference.id")}: {citation.sourceId}
                        </DialogDescription>
                    </DialogHeader>

                    <ScrollArea className="flex-1 pr-1">
                        <div className="space-y-4">
                            {error && (
                                <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                                    <p className="font-medium text-destructive">{t("error.loading")}</p>
                                    <p className="text-sm text-destructive/80">{error}</p>
                                </div>
                            )}

                            <div className="space-y-4">
                                <div className="flex items-center justify-between gap-2">
                                    <h4 className="font-medium">{t("text.content")}</h4>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={copyToClipboard}
                                        disabled={!unitText}
                                        className="flex items-center gap-2"
                                    >
                                        <Copy className="h-3 w-3" />
                                        {t("copy")}
                                    </Button>
                                </div>

                                <div className="max-h-[50vh] w-full overflow-auto rounded-md border">
                                    <div className="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed">
                                        {isLoadingUnit ? (
                                            <div className="flex items-center gap-2 text-muted-foreground">
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                {t("loading")}
                                            </div>
                                        ) : (
                                            (unitText ?? "")
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-1 text-xs text-muted-foreground">
                                    <p>
                                        {t("file")}: {citation.fileName}
                                    </p>
                                    <p>S3: {citation.fileKey}</p>
                                </div>

                                {projectId && (
                                    <div className="flex justify-end">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleDownload}
                                            disabled={isDownloading}
                                        >
                                            {isDownloading ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
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
