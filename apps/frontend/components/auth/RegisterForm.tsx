"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@kiwi/auth/client";
import { useLanguage } from "@/providers/LanguageProvider";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";

type RegisterFormProps = {
    onSwitchToLogin: () => void;
};

export function RegisterForm({ onSwitchToLogin }: RegisterFormProps) {
    const { t } = useLanguage();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!name || !email || !password || !confirmPassword) {
            setError(t("auth.error.required.fields"));
            return;
        }

        if (password !== confirmPassword) {
            setError(t("auth.error.passwords.mismatch"));
            return;
        }

        setLoading(true);
        try {
            const { error: signUpError } = await authClient.signUp.email({
                email,
                password,
                name,
            });

            if (signUpError) {
                setError(signUpError.message ?? t("auth.error.sign.up"));
            }
        } catch {
            setError(t("auth.error.sign.up"));
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
                <Label htmlFor="name">{t("auth.name")}</Label>
                <Input
                    id="name"
                    type="text"
                    placeholder={t("auth.name.placeholder")}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor="email">{t("auth.email")}</Label>
                <Input
                    id="email"
                    type="email"
                    placeholder={t("auth.email.placeholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor="password">{t("auth.password")}</Label>
                <Input
                    id="password"
                    type="password"
                    placeholder={t("auth.password.placeholder")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t("auth.password.confirm")}</Label>
                <Input
                    id="confirmPassword"
                    type="password"
                    placeholder={t("auth.password.confirm.placeholder")}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
                type="submit"
                className="w-full bg-[var(--brand)] text-[var(--brand-foreground)] hover:bg-[var(--brand)]/90"
                disabled={loading}
            >
                {loading ? (
                    <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t("auth.signing.up")}
                    </>
                ) : (
                    t("auth.sign.up")
                )}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
                {t("auth.have.account")}{" "}
                <button type="button" onClick={onSwitchToLogin} className="text-primary underline hover:no-underline">
                    {t("auth.sign.in")}
                </button>
            </p>
        </form>
    );
}
