"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/providers/LanguageProvider";
import { authClient } from "@kiwi/auth/client";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type React from "react";
import { useState } from "react";

type LoginFormProps = {
    authMode: string;
};

export function LoginForm({ authMode }: LoginFormProps) {
    const { t } = useLanguage();
    const router = useRouter();
    const isLdap = authMode === "ldap";
    const [identifier, setIdentifier] = useState("");
    const [password, setPassword] = useState("");
    const [rememberMe, setRememberMe] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!identifier || !password) {
            setError(t("auth.error.required.fields"));
            return;
        }

        setLoading(true);
        try {
            if (isLdap) {
                const { error: signInError } = await authClient.signIn.credentials({
                    credential: identifier,
                    password,
                    rememberMe,
                } as never);

                if (signInError) {
                    setError(signInError.message ?? t("auth.error.invalid.credentials"));
                } else {
                    router.push("/");
                }
            } else {
                const { error: signInError } = await authClient.signIn.email({
                    email: identifier,
                    password,
                    rememberMe,
                });

                if (signInError) {
                    setError(signInError.message ?? t("auth.error.invalid.credentials"));
                } else {
                    router.push("/");
                }
            }
        } catch {
            setError(t("auth.error.invalid.credentials"));
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
                <Label htmlFor="identifier">{isLdap ? t("auth.username") : t("auth.email")}</Label>
                <Input
                    id="identifier"
                    type={isLdap ? "text" : "email"}
                    placeholder={isLdap ? t("auth.username.placeholder") : t("auth.email.placeholder")}
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    autoComplete={isLdap ? "username" : "email"}
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
                    autoComplete="current-password"
                />
            </div>
            <div className="flex items-center gap-2">
                <input
                    id="rememberMe"
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 rounded border-input accent-[var(--brand)]"
                />
                <Label htmlFor="rememberMe" className="cursor-pointer text-sm font-normal">
                    {t("auth.remember.me")}
                </Label>
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
                        {t("auth.signing.in")}
                    </>
                ) : (
                    t("auth.sign.in")
                )}
            </Button>
            {!isLdap && (
                <p className="text-center text-sm text-muted-foreground">
                    {t("auth.no.account")}{" "}
                    <Link href="/register" className="text-primary underline hover:no-underline">
                        {t("auth.sign.up")}
                    </Link>
                </p>
            )}
        </form>
    );
}
