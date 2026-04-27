"use client";

import { fetchProjectFiles } from "@/lib/api/projects";
import type { ApiProjectFile } from "@/types/api";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, type ReactNode } from "react";
import { projectFilesQueryKey } from "./ChatInput";
import { FileBadge, isMentionableFile } from "./FileBadge";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits the message `text` into alternating plain-text and `FileBadge`
 * segments by matching against the project's file list. The first matching
 * filename at every position wins, with longest filenames matched first so
 * that "report.pdf.bak" beats "report.pdf" when both exist.
 */
function buildSegments(text: string, files: ApiProjectFile[]): ReactNode[] {
    if (text.length === 0) return [];
    const sorted = [...files].sort((a, b) => b.name.length - a.name.length);
    if (sorted.length === 0) return [text];

    const pattern = new RegExp(`(${sorted.map((file) => escapeRegExp(file.name)).join("|")})`, "g");
    const parts = text.split(pattern);
    return parts.map((part, index) => {
        if (index % 2 === 1) {
            return <FileBadge key={index} label={part} />;
        }
        return <Fragment key={index}>{part}</Fragment>;
    });
}

export function UserMessageText({ projectId, text }: { projectId: string; text: string }) {
    const { data: files } = useQuery({
        queryKey: projectFilesQueryKey(projectId),
        queryFn: () => fetchProjectFiles(projectId),
        staleTime: 30_000,
    });

    const segments = useMemo(
        () => buildSegments(text, (files ?? []).filter(isMentionableFile)),
        [text, files]
    );

    return <p className="whitespace-pre-wrap">{segments}</p>;
}
