import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Forbidden() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background">
            <div className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
                <h1 className="text-3xl font-semibold">403</h1>
                <p className="text-muted-foreground">
                    Du hast keine Berechtigung, diese Seite zu sehen.
                </p>
                <Button asChild>
                    <Link href="/">Zur Startseite</Link>
                </Button>
            </div>
        </div>
    );
}
