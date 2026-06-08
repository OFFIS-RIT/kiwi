"use client";

import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import type { FileStatus } from "@/types";
import type { ApiProjectFile } from "@/types/api";
import { cn } from "@/lib/utils";
import { AlertCircle, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";

type FileStatusIconProps = {
    status?: FileStatus;
    processErrorCode?: ApiProjectFile["process_error_code"];
    className?: string;
};

const FILE_PROCESS_ERROR_LABEL_KEYS = {
    UNSUPPORTED_FILE_TYPE: "file.process.error.unsupported_file_type",
    INVALID_FILE_FORMAT: "file.process.error.invalid_file_format",
    PASSWORD_PROTECTED_FILE: "file.process.error.password_protected_file",
    NO_READABLE_TEXT: "file.process.error.no_readable_text",
    FILE_TOO_LARGE_OR_COMPLEX: "file.process.error.file_too_large_or_complex",
    OCR_REQUIRED_UNAVAILABLE: "file.process.error.ocr_required_unavailable",
    EXTRACTION_FAILED: "file.process.error.extraction_failed",
    SOURCE_FILE_MISSING: "file.process.error.source_file_missing",
    INTERNAL_SERVER_ERROR: "file.process.error.internal_server_error",
} as const satisfies Record<NonNullable<ApiProjectFile["process_error_code"]>, string>;

export function FileStatusIcon({ status, processErrorCode, className }: FileStatusIconProps) {
    const t = useAppTranslations();

    const normalizedStatus: FileStatus = status ?? "no_status";

    const config: Record<FileStatus, { icon: React.ReactNode; tooltipKey: string }> = {
        processing: {
            icon: <Loader2 className={cn("h-3.5 w-3.5 animate-spin text-blue-500", className)} />,
            tooltipKey: "file.status.processing",
        },
        processed: {
            icon: <CheckCircle2 className={cn("h-3.5 w-3.5 text-green-500", className)} />,
            tooltipKey: "file.status.processed",
        },
        failed: {
            icon: <AlertCircle className={cn("h-3.5 w-3.5 text-destructive", className)} />,
            tooltipKey: "file.status.failed",
        },
        no_status: {
            icon: <HelpCircle className={cn("h-3.5 w-3.5 text-muted-foreground", className)} />,
            tooltipKey: "file.status.no_status",
        },
    };

    const { icon, tooltipKey } = config[normalizedStatus];
    const failureReason =
        normalizedStatus === "failed" && processErrorCode ? t(FILE_PROCESS_ERROR_LABEL_KEYS[processErrorCode]) : null;
    const tooltip = failureReason ? t("file.status.failed.with_reason", { reason: failureReason }) : t(tooltipKey);

    return (
        <span title={tooltip} className="inline-flex cursor-default">
            {icon}
        </span>
    );
}
