"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLanguage } from "@/providers/LanguageProvider";
import type { FileStatus } from "@/types";
import { cn } from "@/lib/utils";
import { AlertCircle, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";

type FileStatusIconProps = {
  status?: FileStatus;
  className?: string;
};

/**
 * Displays a status icon with tooltip for file processing state.
 * - processing: spinning loader
 * - processed: green checkmark
 * - failed: red error icon
 * - no_status/undefined: gray question mark
 */
export function FileStatusIcon({ status, className }: FileStatusIconProps) {
  const { t } = useLanguage();

  const normalizedStatus: FileStatus = status ?? "no_status";

  const config: Record<
    FileStatus,
    { icon: React.ReactNode; tooltipKey: string }
  > = {
    processing: {
      icon: (
        <Loader2
          className={cn("h-3.5 w-3.5 animate-spin text-blue-500", className)}
        />
      ),
      tooltipKey: "file.status.processing",
    },
    processed: {
      icon: (
        <CheckCircle2 className={cn("h-3.5 w-3.5 text-green-500", className)} />
      ),
      tooltipKey: "file.status.processed",
    },
    failed: {
      icon: (
        <AlertCircle
          className={cn("h-3.5 w-3.5 text-destructive", className)}
        />
      ),
      tooltipKey: "file.status.failed",
    },
    no_status: {
      icon: (
        <HelpCircle
          className={cn("h-3.5 w-3.5 text-muted-foreground", className)}
        />
      ),
      tooltipKey: "file.status.no_status",
    },
  };

  const { icon, tooltipKey } = config[normalizedStatus];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default">{icon}</span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span>{t(tooltipKey)}</span>
      </TooltipContent>
    </Tooltip>
  );
}
