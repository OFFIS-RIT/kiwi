"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useAuthClient } from "@/providers/AuthClientProvider";
import { useAuth } from "@/providers/AuthProvider";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Detects whether a better-auth error indicates the target email is already in
 * use, so we can surface a clear "already registered" message instead of a
 * generic failure. The DB's unique constraint is the actual guard; this only
 * improves the error response on conflict.
 */
function isEmailConflict(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }
    const { code, message, status } = error as { code?: string; message?: string; status?: number };
    if (status === 409 || status === 422) {
        return true;
    }
    return /exist|already|taken|in.?use|unique|duplicate/i.test(`${code ?? ""} ${message ?? ""}`);
}

export function AccountSection() {
    const t = useAppTranslations();
    const authClient = useAuthClient();
    const router = useRouter();
    const { user } = useAuth();

    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");

    const [savingProfile, setSavingProfile] = useState(false);
    const [savingPassword, setSavingPassword] = useState(false);

    useEffect(() => {
        if (user) {
            setName(user.name);
            setEmail(user.email);
        }
        // Depend on primitive identity fields, not the `user` object: AuthProvider
        // rebuilds `user` via useMemo on any session refetch (focus, org switch, role
        // change), and an object dep would wipe in-progress edits on every refetch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id, user?.name, user?.email]);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const nameChanged = !!trimmedName && trimmedName !== user?.name;
    const emailChanged = !!trimmedEmail && trimmedEmail !== user?.email;
    const profileDirty = nameChanged || emailChanged;

    const handleProfileSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!profileDirty) {
            return;
        }

        setSavingProfile(true);
        let anySucceeded = false;
        let failedField: "name" | "email" | null = null;
        try {
            if (nameChanged) {
                const { error } = await authClient.updateUser({ name: trimmedName });
                if (error) {
                    failedField = "name";
                    throw error;
                }
                anySucceeded = true;
            }
            if (emailChanged) {
                const { error } = await authClient.changeEmail({ newEmail: trimmedEmail });
                if (error) {
                    failedField = "email";
                    throw error;
                }
                anySucceeded = true;
            }
            toast.success(t("settings.account.updated"));
        } catch (caught) {
            if (failedField === "email") {
                toast.error(isEmailConflict(caught) ? t("auth.error.email.taken") : t("settings.account.email.error"));
            } else {
                toast.error(t("settings.account.error"));
            }
        } finally {
            // Refresh even on partial success so the synced context no longer reports
            // an already-saved field as dirty (which would re-send it on the next submit).
            if (anySucceeded) {
                router.refresh();
            }
            setSavingProfile(false);
        }
    };

    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!currentPassword || !newPassword) {
            return;
        }
        if (newPassword !== confirmPassword) {
            toast.error(t("auth.error.passwords.mismatch"));
            return;
        }

        setSavingPassword(true);
        try {
            const { error } = await authClient.changePassword({ currentPassword, newPassword });
            if (error) {
                throw error;
            }
            toast.success(t("settings.account.password.updated"));
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
        } catch {
            toast.error(t("settings.account.error"));
        } finally {
            setSavingPassword(false);
        }
    };

    return (
        <section className="flex max-w-2xl flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("settings.section.account")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.account.description")}</p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>{t("settings.account.profile.title")}</CardTitle>
                    <CardDescription>{t("settings.account.profile.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleProfileSubmit} className="flex flex-col gap-4">
                        <div className="flex flex-col gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="account-name">{t("auth.name")}</Label>
                                <Input
                                    id="account-name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={t("auth.name.placeholder")}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="account-email">{t("auth.email")}</Label>
                                <Input
                                    id="account-email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder={t("auth.email.placeholder")}
                                />
                            </div>
                        </div>
                        <div>
                            <Button type="submit" size="sm" disabled={savingProfile || !profileDirty}>
                                {savingProfile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                {t("save.changes")}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("settings.account.password.title")}</CardTitle>
                    <CardDescription>{t("settings.account.password.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
                        <div className="flex flex-col gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="account-current-password">
                                    {t("settings.account.current.password")}
                                </Label>
                                <Input
                                    id="account-current-password"
                                    type="password"
                                    autoComplete="current-password"
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="account-new-password">{t("settings.account.new.password")}</Label>
                                <Input
                                    id="account-new-password"
                                    type="password"
                                    autoComplete="new-password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="account-confirm-password">
                                    {t("settings.account.confirm.password")}
                                </Label>
                                <Input
                                    id="account-confirm-password"
                                    type="password"
                                    autoComplete="new-password"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                />
                            </div>
                        </div>
                        <div>
                            <Button
                                type="submit"
                                size="sm"
                                disabled={savingPassword || !currentPassword || !newPassword}
                            >
                                {savingPassword ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                {t("save.changes")}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </section>
    );
}
