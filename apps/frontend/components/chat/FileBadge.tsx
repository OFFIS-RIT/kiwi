"use client";

import { Badge } from "@/components/ui/badge";
import type { ApiProjectFile } from "@/types/api";
import { FileText } from "lucide-react";

/**
 * Inline pill rendering a file reference. Shared between the chat input's
 * @-mention NodeView (where the user inserts it) and the rendered message
 * bubble (where the same filename is shown after the message has been sent).
 */
export function FileBadge({ label }: { label: string }) {
    return (
        <Badge variant="secondary" className="mx-0.5 gap-1 align-middle">
            <FileText className="h-3 w-3" />
            {label}
        </Badge>
    );
}

/**
 * A file is eligible to be mentioned (and re-rendered as a badge) only once
 * its content has finished processing — referencing pending or failed files
 * doesn't help the LLM. Used both by the @-mention picker and by message
 * rendering so the two stay in sync.
 */
export function isMentionableFile(file: ApiProjectFile): boolean {
    return file.status === "processed";
}
