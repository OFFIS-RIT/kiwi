"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { downloadProjectFile } from "@/lib/api/projects";
import { useLanguage } from "@/providers/LanguageProvider";
import type { CitationPartData } from "@kiwi/ai/ui";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import React, { useState } from "react";

type TextReferenceBadgeProps = {
    citation: CitationPartData;
    index: number;
    projectId?: string;
};

export function TextReferenceBadge({ citation, index, projectId }: TextReferenceBadgeProps) {
    const { t } = useLanguage();
    const [isOpen, setIsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const excerpt = (citation.excerpt ?? citation.description ?? "").replace(/\s+/g, " ").trim();

    const copyToClipboard = () => {
        if (excerpt) {
            navigator.clipboard.writeText(excerpt);
        }
    };

    const handleDownload = async () => {
        if (!projectId) return;

        setIsLoading(true);
        setError(null);
        try {
            const downloadUrl = await downloadProjectFile(projectId, citation.fileKey);
            window.open(downloadUrl, "_blank");
        } catch (err) {
            setError(err instanceof Error ? err.message : t("error.unknown"));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                <Badge
                    variant="outline"
                    className="mx-0.5 inline-flex cursor-pointer items-center border-2 text-xs transition-colors hover:border-primary/40 hover:bg-primary/10"
                    title={`${t("text.reference")} ${index + 1}: ${citation.sourceId}`}
                >
                    {index + 1}
                </Badge>
            </DialogTrigger>
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
                                        className="flex items-center gap-2"
                                    >
                                        <Copy className="h-3 w-3" />
                                        {t("copy")}
                                    </Button>
                                </div>

                                <div className="max-h-[50vh] w-full overflow-auto rounded-md border">
                                    <div className="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed">
                                        {excerpt}
                                    </div>
                                </div>

                                {citation.description && citation.description !== excerpt && (
                                    <div className="space-y-1 text-sm text-muted-foreground">
                                        <p>{citation.description}</p>
                                    </div>
                                )}

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
                                            disabled={isLoading}
                                        >
                                            {isLoading ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
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
