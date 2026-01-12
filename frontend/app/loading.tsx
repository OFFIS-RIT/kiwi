import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex min-h-screen flex-col gap-4 p-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="grid flex-1 gap-4 md:grid-cols-[280px_1fr]">
        <Skeleton className="h-full rounded-lg" />
        <Skeleton className="h-full rounded-lg" />
      </div>
    </div>
  );
}
