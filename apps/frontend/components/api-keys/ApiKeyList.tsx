"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useLanguage } from "@/providers/LanguageProvider";
import { authClient } from "@kiwi/auth/client";
import { Clock, Key, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type ApiKey = {
    id: string;
    name: string | null;
    start: string | null;
    prefix: string | null;
    createdAt: Date;
    expiresAt: Date | null;
    lastRequest: Date | null;
};

export function ApiKeyList() {
    const { t } = useLanguage();
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [loading, setLoading] = useState(true);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteKey, setConfirmDeleteKey] = useState<ApiKey | null>(null);

    const loadKeys = useCallback(async () => {
        setLoading(true);
        try {
            const { data, error } = await authClient.apiKey.list();

            if (error) {
                throw error;
            }

            setKeys(data?.apiKeys ?? []);
        } catch {
            toast.error(t("apiKey.error.loading"));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        void loadKeys();
    }, [loadKeys]);

    const handleDelete = async () => {
        if (!confirmDeleteKey) return;
        const keyId = confirmDeleteKey.id;
        setConfirmDeleteKey(null);
        setDeletingId(keyId);
        try {
            const { error } = await authClient.apiKey.delete({ keyId });

            if (error) {
                throw error;
            }

            setKeys((prev) => prev.filter((k) => k.id !== keyId));
            toast.success(t("apiKey.deleted"));
        } catch {
            toast.error(t("error.saving"));
        } finally {
            setDeletingId(null);
        }
    };

    const isExpired = (key: ApiKey) => key.expiresAt && new Date(key.expiresAt) < new Date();

    const formatDate = (date: Date | null) => {
        if (!date) return null;
        return new Date(date).toLocaleDateString(undefined, {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
        });
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (keys.length === 0) {
        return <p className="py-12 text-center text-sm text-muted-foreground">{t("apiKey.no.keys")}</p>;
    }

    return (
        <>
            <div className="space-y-1">
                {keys.map((key, index) => (
                    <div key={key.id}>
                        <div className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                                <Key className="h-4 w-4 text-primary" />
                            </div>

                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium">
                                        {key.name || t("apiKey.unnamed")}
                                    </span>
                                    {isExpired(key) && (
                                        <Badge variant="destructive" className="h-4 px-1.5 py-0 text-[10px]">
                                            {t("apiKey.expired")}
                                        </Badge>
                                    )}
                                </div>
                                <span className="block truncate text-xs text-muted-foreground">
                                    {key.start ?? key.prefix ?? ""}...
                                </span>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                    <span className="flex items-center gap-1">
                                        <Clock className="h-3 w-3" />
                                        {key.lastRequest
                                            ? t("apiKey.lastUsed", { date: formatDate(key.lastRequest)! })
                                            : t("apiKey.neverUsed")}
                                    </span>
                                    {!isExpired(key) && (
                                        <span>
                                            {key.expiresAt
                                                ? t("apiKey.expiresOn", { date: formatDate(key.expiresAt)! })
                                                : t("apiKey.noExpiry")}
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className="flex shrink-0 items-center">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:bg-destructive/10"
                                    onClick={() => setConfirmDeleteKey(key)}
                                    disabled={deletingId === key.id}
                                    title={t("apiKey.delete")}
                                >
                                    {deletingId === key.id ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Trash2 className="h-3.5 w-3.5" />
                                    )}
                                </Button>
                            </div>
                        </div>
                        {index < keys.length - 1 && <Separator className="mx-3" />}
                    </div>
                ))}
            </div>
            <Dialog
                open={confirmDeleteKey !== null}
                onOpenChange={(open) => {
                    if (!open) setConfirmDeleteKey(null);
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("apiKey.delete.confirm.title")}</DialogTitle>
                        <DialogDescription>
                            {t("apiKey.delete.confirm.description", {
                                name: confirmDeleteKey?.name || t("apiKey.unnamed"),
                            })}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmDeleteKey(null)}>
                            {t("apiKey.cancel")}
                        </Button>
                        <Button variant="destructive" onClick={handleDelete}>
                            {t("apiKey.delete")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
