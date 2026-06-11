"use client";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { deleteModel, setDefaultModel } from "@/lib/api/models";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useApiClient } from "@/providers/ApiClientProvider";
import type { AdminModelListItem } from "@kiwi/contracts";
import { Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { MODEL_TYPE_LABEL_KEYS } from "./ModelFormDialog";

type DeleteModelDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    model: AdminModelListItem;
    /** Remaining models of the same type (excluding the one being deleted). */
    siblings: AdminModelListItem[];
    onDeleted: () => void;
};

// The backend promotes the oldest remaining model when a default is deleted;
// preselecting it keeps "confirm without changes" aligned with that behavior.
function oldestModelId(siblings: AdminModelListItem[]): string | null {
    let oldest: AdminModelListItem | null = null;
    for (const sibling of siblings) {
        if (!oldest || sibling.created_at < oldest.created_at) {
            oldest = sibling;
        }
    }
    return oldest?.model_id ?? null;
}

export function DeleteModelDialog({ open, onOpenChange, model, siblings, onDeleted }: DeleteModelDialogProps) {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const [loading, setLoading] = useState(false);

    const promotedId = useMemo(() => oldestModelId(siblings), [siblings]);
    const [newDefaultId, setNewDefaultId] = useState<string | null>(promotedId);

    useEffect(() => {
        if (open) {
            setNewDefaultId(promotedId);
        }
    }, [open, promotedId]);

    const isLastOfType = siblings.length === 0;
    const showDefaultPicker = model.is_default && !isLastOfType;

    const handleDelete = async () => {
        setLoading(true);
        try {
            await deleteModel(apiClient, model.model_id);
        } catch {
            toast.error(t("error.saving"));
            setLoading(false);
            return;
        }

        // The deletion stands even if overriding the auto-promoted default
        // fails — close and refresh either way so the list reflects reality.
        if (showDefaultPicker && newDefaultId && newDefaultId !== promotedId) {
            try {
                await setDefaultModel(apiClient, newDefaultId);
            } catch {
                toast.error(t("settings.models.delete.defaultFailed"));
            }
        }

        setLoading(false);
        onOpenChange(false);
        onDeleted();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("settings.models.delete.title")}</DialogTitle>
                    <DialogDescription>
                        {t("settings.models.delete.confirm", { name: model.display_name })}
                    </DialogDescription>
                </DialogHeader>
                {isLastOfType ? (
                    <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                        <p>
                            {t("settings.models.delete.lastOfType", { type: t(MODEL_TYPE_LABEL_KEYS[model.type]) })}
                            {model.type === "text" ? <> {t("settings.models.delete.lastText")}</> : null}
                        </p>
                    </div>
                ) : null}
                {showDefaultPicker ? (
                    <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">{t("settings.models.delete.defaultNote")}</p>
                        <Label htmlFor="new-default-model">{t("settings.models.delete.newDefault")}</Label>
                        <Select value={newDefaultId ?? undefined} onValueChange={setNewDefaultId}>
                            <SelectTrigger id="new-default-model" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {siblings.map((sibling) => (
                                    <SelectItem key={sibling.model_id} value={sibling.model_id}>
                                        {sibling.display_name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                ) : null}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                        {t("cancel")}
                    </Button>
                    <Button type="button" variant="destructive" onClick={handleDelete} disabled={loading}>
                        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {t("delete")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
