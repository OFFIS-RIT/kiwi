import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
    return (
        <div className="space-y-6">
            <div>
                <Skeleton className="mb-2 h-8 w-48" />
                <Skeleton className="h-4 w-72" />
            </div>
            <div className="grid auto-rows-fr gap-4 md:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                    <Skeleton key={index} className="h-36 rounded-lg" />
                ))}
            </div>
        </div>
    );
}
