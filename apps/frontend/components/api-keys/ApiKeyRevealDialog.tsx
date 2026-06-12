"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

type ApiKeyRevealDialogProps = {
    apiKey: string | null;
    onOpenChange: (open: boolean) => void;
};

export function ApiKeyRevealDialog({ apiKey, onOpenChange }: ApiKeyRevealDialogProps) {
    const t = useAppTranslations();
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        if (!apiKey) return;
        void copyToClipboard(apiKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <Dialog open={apiKey !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("apiKey.created")}</DialogTitle>
                    <DialogDescription>{t("apiKey.created.description")}</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="flex items-start gap-2">
                        <code className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 text-sm font-mono">
                            {apiKey}
                        </code>
                        <Button variant="outline" size="icon" className="shrink-0" onClick={handleCopy}>
                            {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("apiKey.created.warning")}</p>
                </div>
            </DialogContent>
        </Dialog>
    );
}
