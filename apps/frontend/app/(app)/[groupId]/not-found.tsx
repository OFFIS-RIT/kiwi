import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function GroupNotFound() {
    return (
        <div className="flex h-screen items-center justify-center">
            <div className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
                <h1 className="text-2xl font-semibold">Gruppe nicht gefunden</h1>
                <p className="text-muted-foreground">Diese Gruppe existiert nicht oder wurde geloescht.</p>
                <Button asChild>
                    <Link href="/">Zur Uebersicht</Link>
                </Button>
            </div>
        </div>
    );
}
