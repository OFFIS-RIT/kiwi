import type React from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import { Toaster } from "sonner";
import "./app.css";
import "katex/dist/katex.min.css";

export async function loader() {
    return {
        config: {
            apiUrl: process.env.API_URL || "/api",
            authMode: process.env.AUTH_MODE || "credentials",
            buildLabel: import.meta.env.VITE_APP_BUILD_LABEL || "",
        },
    };
}

const themeScript = `(function(){try{var t=localStorage.getItem("ui-theme");if(t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})();`;

export function Layout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <meta charSet="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <link
                    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
                    rel="stylesheet"
                />
                <link rel="icon" type="image/png" href="/favicon.png" />
                <Meta />
                <Links />
            </head>
            <body className="font-sans" style={{ fontFamily: "'Inter', sans-serif" }}>
                <script suppressHydrationWarning>{themeScript}</script>
                {children}
                <Toaster richColors expand={true} position="bottom-center" duration={5000} />
                <ScrollRestoration />
                <Scripts />
            </body>
        </html>
    );
}

export default function Root({ loaderData }: Route.ComponentProps) {
    return <Outlet context={loaderData.config} />;
}
