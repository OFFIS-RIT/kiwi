import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
    return (
        <div className="flex h-screen">
            <aside className="w-64 border-r p-2">
                <div className="flex items-center gap-2 p-2">
                    <Skeleton className="size-8 rounded-lg" />
                    <div className="flex-1">
                        <Skeleton className="mb-1 h-3 w-12" />
                        <Skeleton className="h-2 w-16" />
                    </div>
                </div>
                <div className="mt-4 space-y-2">
                    {["60%", "75%", "55%", "70%"].map((width, i) => (
                        <div key={i} className="flex h-8 items-center gap-2 rounded-md px-2">
                            <Skeleton className="size-4 rounded-md" />
                            <Skeleton className="h-4 flex-1" style={{ maxWidth: width }} />
                        </div>
                    ))}
                </div>
            </aside>
            <main className="flex-1">
                <header className="flex h-16 items-center border-b px-4">
                    <Skeleton className="h-5 w-32" />
                </header>
                <div className="p-4">
                    <Skeleton className="h-32 w-full" />
                </div>
            </main>
        </div>
    );
}
