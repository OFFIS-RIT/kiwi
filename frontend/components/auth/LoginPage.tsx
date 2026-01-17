"use client";

import { useState } from "react";
import { useAuth } from "@/providers/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Loader2, AlertCircle } from "lucide-react";
import { useLanguage } from "@/providers/LanguageProvider";
import { LanguageSwitcher } from "@/components/header/LanguageSwitcher";

export function LoginPage() {
    const { signIn, signUp } = useAuth();
    const { t } = useLanguage();
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [name, setName] = useState("");

    // State für allgemeine Fehler (API) und Feld-Fehler
    const [generalError, setGeneralError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; name?: string }>({});

    const [loading, setLoading] = useState(false);

    const validate = () => {
        const errors: typeof fieldErrors = {};
        if (!email) errors.email = t("auth.error.email.required");
        else if (!/\S+@\S+\.\S+/.test(email)) errors.email = t("auth.error.email.invalid");

        if (!password) errors.password = t("auth.error.password.required");
        else if (password.length < 8) errors.password = t("auth.error.password.min");

        if (!isLogin && !name) errors.name = t("auth.error.name.required");

        setFieldErrors(errors);
        return Object.keys(errors).length === 0;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setGeneralError(null);

        if (!validate()) return;

        setLoading(true);
        try {
            if (isLogin) {
                const { error } = await signIn.email({ email, password });
                if (error) setGeneralError(error.message ?? t("auth.error.login.failed"));
            } else {
                const { error } = await signUp.email({ email, password, name });
                if (error) setGeneralError(error.message ?? t("auth.error.registration.failed"));
            }
        } catch {
            setGeneralError(t("auth.error.generic"));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen w-screen items-center justify-center bg-background">
            <div className="relative w-full max-w-sm space-y-6 rounded-lg border bg-card p-6 shadow-lg">
                <div className="absolute top-4 right-4">
                    <LanguageSwitcher />
                </div>
                <div className="space-y-2 text-center flex flex-col items-center">
                    <img
                        src="/KIWI.jpg"
                        alt="KIWI Logo"
                        className="h-24 w-24 rounded-full object-cover mb-4"
                    />
                    <h1 className="text-2xl font-bold tracking-tight">
                        {isLogin ? t("auth.welcome.back") : t("auth.create.account")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {isLogin
                            ? t("auth.signin.description")
                            : t("auth.signup.description")}
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                    {!isLogin && (
                        <div className="space-y-2">
                            <Label htmlFor="name">{t("auth.name")}</Label>
                            <Input
                                id="name"
                                placeholder={t("auth.username.placeholder")}
                                value={name}
                                onChange={(e) => {
                                    setName(e.target.value);
                                    if (fieldErrors.name) setFieldErrors({ ...fieldErrors, name: undefined });
                                }}
                                autoComplete="name"
                                className={fieldErrors.name ? "border-destructive focus-visible:ring-destructive" : ""}
                            />
                            {fieldErrors.name && (
                                <p className="text-xs text-destructive">{fieldErrors.name}</p>
                            )}
                        </div>
                    )}
                    <div className="space-y-2">
                        <Label htmlFor="email">{t("auth.email")}</Label>
                        <Input
                            id="email"
                            type="email"
                            placeholder={t("auth.email.placeholder")}
                            value={email}
                            onChange={(e) => {
                                setEmail(e.target.value);
                                if (fieldErrors.email) setFieldErrors({ ...fieldErrors, email: undefined });
                            }}
                            autoComplete="username"
                            className={fieldErrors.email ? "border-destructive focus-visible:ring-destructive" : ""}
                        />
                        {fieldErrors.email && (
                            <p className="text-xs text-destructive">{fieldErrors.email}</p>
                        )}
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="password">{t("auth.password")}</Label>
                        <div className="relative">
                            <Input
                                id="password"
                                type={showPassword ? "text" : "password"}
                                placeholder={t("auth.password.placeholder")}
                                value={password}
                                onChange={(e) => {
                                    setPassword(e.target.value);
                                    if (fieldErrors.password) setFieldErrors({ ...fieldErrors, password: undefined });
                                }}
                                autoComplete={isLogin ? "current-password" : "new-password"}
                                className={`pr-10 ${fieldErrors.password ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                                onClick={() => setShowPassword(!showPassword)}
                            >
                                {showPassword ? (
                                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                                ) : (
                                    <Eye className="h-4 w-4 text-muted-foreground" />
                                )}
                                <span className="sr-only">
                                    {showPassword ? t("auth.hide.password") : t("auth.show.password")}
                                </span>
                            </Button>
                        </div>
                        {fieldErrors.password ? (
                            <p className="text-xs text-destructive">{fieldErrors.password}</p>
                        ) : (
                            !isLogin && <p className="text-xs text-muted-foreground">{t("auth.password.min")}</p>
                        )}
                    </div>

                    {generalError && (
                        <div className="flex items-center gap-2 rounded-md bg-destructive/15 p-3 text-sm text-destructive">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            <p>{generalError}</p>
                        </div>
                    )}

                    <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                {isLogin ? t("auth.signing.in") : t("auth.signing.up")}
                            </>
                        ) : (
                            isLogin ? t("auth.signin") : t("auth.signup")
                        )}
                    </Button>

                    <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground">
                                {t("auth.or")}
                            </span>
                        </div>
                    </div>

                    <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={true}
                        title={t("auth.microsoft.not.configured")}
                    >
                        <svg className="mr-2 h-4 w-4" viewBox="0 0 23 23">
                            <path fill="#f35325" d="M1 1h10v10H1z" />
                            <path fill="#81bc06" d="M12 1h10v10H12z" />
                            <path fill="#05a6f0" d="M1 12h10v10H1z" />
                            <path fill="#ffba08" d="M12 12h10v10H12z" />
                        </svg>
                        {t("auth.microsoft")}
                    </Button>
                </form>

                <div className="text-center">
                    <button
                        type="button"
                        className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                        onClick={() => {
                            setIsLogin(!isLogin);
                            setGeneralError(null);
                            setFieldErrors({});
                        }}
                    >
                        {isLogin
                            ? t("auth.no.account")
                            : t("auth.has.account")}
                    </button>
                </div>
            </div>
        </div>
    );
}

