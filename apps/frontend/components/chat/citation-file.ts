import { downloadProjectFile, getProjectFileUrl } from "@/lib/api/projects";
import type { KiwiApiClient } from "@/lib/api/client";
import type { ResolvedCitationFence } from "@kiwi/ai/citation";

function isPDFCitation(citation: ResolvedCitationFence): boolean {
    return citation.fileType === "pdf" || citation.fileName.toLowerCase().endsWith(".pdf");
}

export async function openCitationSourceFile(
    apiClient: KiwiApiClient,
    projectId: string,
    citation: ResolvedCitationFence
): Promise<void> {
    if (citation.fileId) {
        const isPdf = isPDFCitation(citation);
        const page = isPdf ? (citation.startPage ?? null) : null;
        window.open(
            getProjectFileUrl(apiClient, projectId, citation.fileId, { fileName: citation.fileName, page }),
            "_blank"
        );
        return;
    }

    if (!citation.fileKey) {
        throw new Error("Citation has no source file reference");
    }

    const downloadUrl = await downloadProjectFile(apiClient, projectId, citation.fileKey);
    window.open(downloadUrl, "_blank");
}
