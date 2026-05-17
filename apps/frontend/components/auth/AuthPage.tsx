import { Image } from "@unpic/react";

import { useConfig } from "@/providers/ConfigProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import { LoginForm } from "./LoginForm";
import { RegisterForm } from "./RegisterForm";

type AuthPageProps = {
    view: "login" | "register";
    onViewChange: (view: "login" | "register") => void;
};

export function AuthPage({ view, onViewChange }: AuthPageProps) {
    const { authMode } = useConfig();
    const { t } = useLanguage();
    const showRegister = authMode === "credentials" && view === "register";

    return (
        <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-muted p-4">
            <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-lg">
                <div className="mb-6 flex flex-col items-center gap-2">
                    <Image
                        src="/KIWI.jpg"
                        alt="KIWI Logo"
                        width={64}
                        height={64}
                        layout="constrained"
                        className="rounded-full"
                    />
                    <h1 className="text-xl font-semibold">{t("auth.welcome")}</h1>
                    <p className="text-sm text-muted-foreground">{t("auth.welcome.subtitle")}</p>
                </div>
                {showRegister ? (
                    <RegisterForm onSwitchToLogin={() => onViewChange("login")} />
                ) : (
                    <LoginForm onSwitchToRegister={() => onViewChange("register")} />
                )}
            </div>
        </div>
    );
}
