import { Card } from "@/components/ui/card";

export default function ProjectLoading() {
    return (
        <div className="flex h-[calc(100vh-6rem)] min-w-0 flex-col overflow-hidden p-4">
            <div className="mb-4 min-w-0 shrink-0">
                <div className="h-8 w-48 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-5 w-32 animate-pulse rounded bg-muted" />
            </div>
            <Card className="flex min-w-0 flex-1 flex-col gap-0 overflow-hidden py-0">
                <div className="flex-1" />
                <div className="border-t p-4">
                    <div className="h-10 animate-pulse rounded bg-muted" />
                </div>
            </Card>
        </div>
    );
}
