"use client";

import { useState } from "react";
import { useAuth } from "@/providers/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Loader2, AlertCircle } from "lucide-react";

export function LoginPage() {
    const { signIn, signUp } = useAuth();
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
        if (!email) errors.email = "E-Mail ist erforderlich";
        else if (!/\S+@\S+\.\S+/.test(email)) errors.email = "Ungültige E-Mail-Adresse";

        if (!password) errors.password = "Passwort ist erforderlich";
        else if (password.length < 8) errors.password = "Passwort muss mindestens 8 Zeichen lang sein";

        if (!isLogin && !name) errors.name = "Name ist erforderlich";

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
                if (error) setGeneralError(error.message ?? "Login fehlgeschlagen");
            } else {
                const { error } = await signUp.email({ email, password, name });
                if (error) setGeneralError(error.message ?? "Registrierung fehlgeschlagen");
            }
        } catch {
            setGeneralError("Ein Fehler ist aufgetreten");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen w-screen items-center justify-center bg-background">
            <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-6 shadow-lg">
                <div className="space-y-2 text-center flex flex-col items-center">
                    <img
                        src="/KIWI.jpg"
                        alt="KIWI Logo"
                        className="h-24 w-24 rounded-full object-cover mb-4"
                    />
                    <h1 className="text-2xl font-bold tracking-tight">
                        {isLogin ? "Willkommen zurück" : "Konto erstellen"}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {isLogin
                            ? "Melde dich an, um fortzufahren"
                            : "Gib deine Daten ein, um dich zu registrieren"}
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                    {!isLogin && (
                        <div className="space-y-2">
                            <Label htmlFor="name">Name</Label>
                            <Input
                                id="name"
                                placeholder="Max Mustermann"
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
                        <Label htmlFor="email">E-Mail</Label>
                        <Input
                            id="email"
                            type="email"
                            placeholder="mail@example.com"
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
                        <Label htmlFor="password">Passwort</Label>
                        <div className="relative">
                            <Input
                                id="password"
                                type={showPassword ? "text" : "password"}
                                placeholder="••••••••"
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
                                    {showPassword ? "Passwort verbergen" : "Passwort anzeigen"}
                                </span>
                            </Button>
                        </div>
                        {fieldErrors.password ? (
                            <p className="text-xs text-destructive">{fieldErrors.password}</p>
                        ) : (
                            !isLogin && <p className="text-xs text-muted-foreground">Mindestens 8 Zeichen</p>
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
                                {isLogin ? "Anmelden..." : "Registrieren..."}
                            </>
                        ) : (
                            isLogin ? "Anmelden" : "Registrieren"
                        )}
                    </Button>

                    <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground">
                                Oder
                            </span>
                        </div>
                    </div>

                    <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={true}
                        title="Microsoft Login noch nicht konfiguriert"
                    >
                        <svg className="mr-2 h-4 w-4" viewBox="0 0 23 23">
                            <path fill="#f35325" d="M1 1h10v10H1z" />
                            <path fill="#81bc06" d="M12 1h10v10H12z" />
                            <path fill="#05a6f0" d="M1 12h10v10H1z" />
                            <path fill="#ffba08" d="M12 12h10v10H12z" />
                        </svg>
                        Mit Microsoft anmelden
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
                            ? "Noch kein Konto? Registrieren"
                            : "Bereits registriert? Anmelden"}
                    </button>
                </div>
            </div>
        </div>
    );
}
