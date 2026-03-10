"use client";

import { SidebarInset } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export function AppSidebarInset({
  className,
  ...props
}: React.ComponentProps<typeof SidebarInset>) {
  return <SidebarInset className={cn("min-w-0", className)} {...props} />;
}
