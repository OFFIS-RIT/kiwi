"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/providers/LanguageProvider";
import { authClient } from "@kiwi/auth/client";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";

type CreateApiKeyDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: (key: string) => void;
};

const EXPIRY_OPTIONS = [
    { value: "30d", seconds: 30 * 24 * 60 * 60 },
    { value: "90d", seconds: 90 * 24 * 60 * 60 },
    { value: "1y", seconds: 365 * 24 * 60 * 60 },
    { value: "never", seconds: undefined },
] as const;

export function CreateApiKeyDialog({ open, onOpenChange, onCreated }: CreateApiKeyDialogProps) {
    const { t } = useLanguage();
    const [name, setName] = useState("");
    const [expiry, setExpiry] = useState<string>("never");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name) {
            return;
        }

        setLoading(true);
        try {
            const expiryOption = EXPIRY_OPTIONS.find((o) => o.value === expiry);
            const { data, error } = await authClient.apiKey.create({
                name,
                expiresIn: expiryOption?.seconds,
            });

            if (error) {
                throw error;
            }

            setName("");
            setExpiry("never");
            onOpenChange(false);
            onCreated(data?.key ?? "");
        } catch {
            toast.error(t("error.saving"));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("apiKey.create")}</DialogTitle>
                    <DialogDescription>{t("apiKey.create.description")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="api-key-name">{t("apiKey.name")}</Label>
                        <Input
                            id="api-key-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t("apiKey.name.placeholder")}
                            required
                        />
                    </div>
                    <div className="space-y-2">
                        <Label>{t("apiKey.expiry")}</Label>
                        <Select value={expiry} onValueChange={setExpiry}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="30d">{t("apiKey.expiry.30d")}</SelectItem>
                                <SelectItem value="90d">{t("apiKey.expiry.90d")}</SelectItem>
                                <SelectItem value="1y">{t("apiKey.expiry.1y")}</SelectItem>
                                <SelectItem value="never">{t("apiKey.expiry.never")}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {t("apiKey.create")}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}
