"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@kiwi/auth/client";
import { useLanguage } from "@/providers/LanguageProvider";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";

type CreateUserDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
};

export function CreateUserDialog({ open, onOpenChange, onCreated }: CreateUserDialogProps) {
    const { t } = useLanguage();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name || !email || !password) {
            return;
        }

        setLoading(true);
        try {
            const { error } = await authClient.admin.createUser({
                name,
                email,
                password,
                role: "user",
            });

            if (error) {
                throw error;
            }

            setName("");
            setEmail("");
            setPassword("");
            onOpenChange(false);
            onCreated();
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
                    <DialogTitle>{t("admin.create.user")}</DialogTitle>
                    <DialogDescription>{t("admin.create.user.description")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="new-name">{t("auth.name")}</Label>
                        <Input
                            id="new-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t("auth.name.placeholder")}
                            required
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="new-email">{t("auth.email")}</Label>
                        <Input
                            id="new-email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder={t("auth.email.placeholder")}
                            required
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="new-password">{t("auth.password")}</Label>
                        <Input
                            id="new-password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t("auth.password.placeholder")}
                            required
                        />
                    </div>
                    <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {t("admin.create.user")}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}
