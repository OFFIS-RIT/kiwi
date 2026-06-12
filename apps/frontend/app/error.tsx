"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => {
        console.error("Root error:", error);
    }, [error]);

    return (
        <html lang="en">
            <body className="flex min-h-screen items-center justify-center bg-background">
                <div className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
                    <h1 className="text-2xl font-semibold">Etwas ist schiefgelaufen</h1>
                    <p className="text-muted-foreground">
                        Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut.
                    </p>
                    <Button onClick={reset}>Erneut versuchen</Button>
                </div>
            </body>
        </html>
    );
}
