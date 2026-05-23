"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function AppError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("(app) error:", error);
    }, [error]);

    return (
        <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
            <div className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
                <h1 className="text-2xl font-semibold">Fehler in der App</h1>
                <p className="text-muted-foreground">Etwas ist schiefgelaufen. Versuche es erneut.</p>
                <Button onClick={reset}>Erneut versuchen</Button>
            </div>
        </div>
    );
}
