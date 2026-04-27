import { AuthPage } from "@/components/auth/AuthPage";

export default function LoginPage() {
    const authMode = process.env.AUTH_MODE ?? "credentials";

    return <AuthPage authMode={authMode} initialView="login" />;
}
