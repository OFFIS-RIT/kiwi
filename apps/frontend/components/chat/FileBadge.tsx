"use client";

import { Badge } from "@/components/ui/badge";
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
