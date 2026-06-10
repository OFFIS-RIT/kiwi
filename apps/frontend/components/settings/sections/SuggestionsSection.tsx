"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useManageableSuggestionProjects } from "@/hooks/use-suggestion-access";
import { ApiError, applyProjectSuggestion, deleteProjectSuggestion, fetchProjectSuggestions } from "@/lib/api";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useAuthClient } from "@/providers/AuthClientProvider";
import type { GraphSuggestionKind, GraphSuggestionRecord } from "@kiwi/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const APPLY_WARNING_TOAST_DURATION_MS = 10000;
// listMembers caps at the passed limit; submitters beyond it fall back to "unknown".
const ORGANIZATION_MEMBERS_LIMIT = 1000;
const ORGANIZATION_MEMBERS_STALE_TIME_MS = 60 * 1000;

const KIND_LABEL_KEYS: Record<GraphSuggestionKind, string> = {
    source_correction: "settings.suggestions.kind.source_correction",
    entity_addition: "settings.suggestions.kind.entity_addition",
};

type SuggestionTarget = {
    projectId: string;
    suggestionId: string;
};

function formatCreatedAt(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function sortNewestFirst(suggestions: GraphSuggestionRecord[]) {
    return [...suggestions].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function SuggestionsSection() {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const authClient = useAuthClient();
    const queryClient = useQueryClient();
    const { projects, isLoading: isLoadingProjects } = useManageableSuggestionProjects();
    const [dismissTarget, setDismissTarget] = useState<SuggestionTarget | null>(null);

    const suggestionQueries = useQueries({
        queries: projects.map((project) => ({
            queryKey: queryKeys.projectSuggestions(project.projectId),
            queryFn: () => fetchProjectSuggestions(apiClient, project.projectId),
        })),
    });

    const hasSuggestions = suggestionQueries.some((query) => (query.data?.length ?? 0) > 0);

    // One members lookup resolves all submitter ids; any failure (e.g. a role
    // without access) just leaves names on the "unknown" fallback.
    const membersQuery = useQuery({
        queryKey: queryKeys.organizationMembers,
        enabled: hasSuggestions,
        staleTime: ORGANIZATION_MEMBERS_STALE_TIME_MS,
        retry: false,
        queryFn: async () => {
            const { data, error } = await authClient.organization.listMembers({
                query: { limit: ORGANIZATION_MEMBERS_LIMIT },
            });
            if (error) throw new Error(error.message ?? "Failed to list organization members");
            return new Map(data.members.map((member) => [member.userId, member.user.name]));
        },
    });

    const submitterName = (userId: string) => membersQuery.data?.get(userId) || t("settings.suggestions.unknown.user");

    const invalidateSuggestions = (projectId: string) =>
        queryClient.invalidateQueries({ queryKey: queryKeys.projectSuggestions(projectId) });

    const handleMutationError = (error: unknown, fallbackKey: string) => {
        if (error instanceof ApiError && error.code === "SUGGESTION_NOT_FOUND") {
            toast.info(t("settings.suggestions.already.handled"));
            return;
        }
        toast.error(t(fallbackKey));
    };

    const applyMutation = useMutation({
        mutationFn: (target: SuggestionTarget) =>
            applyProjectSuggestion(apiClient, target.projectId, target.suggestionId),
        onSuccess: (result) => {
            const warnings = result.warnings ?? [];
            if (result.workflowRunId === null || warnings.length > 0) {
                toast.warning(t("settings.suggestions.applied.warning"), {
                    description: warnings.length > 0 ? warnings.join("\n") : undefined,
                    duration: APPLY_WARNING_TOAST_DURATION_MS,
                });
            } else {
                toast.success(t("settings.suggestions.applied"));
            }
        },
        onError: (error) => handleMutationError(error, "settings.suggestions.apply.error"),
        onSettled: (_result, _error, target) => invalidateSuggestions(target.projectId),
    });

    const dismissMutation = useMutation({
        mutationFn: (target: SuggestionTarget) =>
            deleteProjectSuggestion(apiClient, target.projectId, target.suggestionId),
        onSuccess: () => toast.success(t("settings.suggestions.dismissed")),
        onError: (error) => handleMutationError(error, "settings.suggestions.dismiss.error"),
        onSettled: (_result, _error, target) => {
            setDismissTarget(null);
            invalidateSuggestions(target.projectId);
        },
    });

    const isSuggestionBusy = (suggestionId: string) =>
        (applyMutation.isPending && applyMutation.variables?.suggestionId === suggestionId) ||
        (dismissMutation.isPending && dismissMutation.variables?.suggestionId === suggestionId);

    const projectLists = projects
        .map((project, index) => ({ project, query: suggestionQueries[index] }))
        .filter(({ query }) => query.isError || (query.data?.length ?? 0) > 0);

    const isLoading = isLoadingProjects || suggestionQueries.some((query) => query.isLoading);

    return (
        <section className="flex flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("settings.suggestions.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.suggestions.description")}</p>
            </div>

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            ) : projectLists.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">{t("settings.suggestions.empty")}</p>
            ) : (
                <div className="flex flex-col gap-8">
                    {projectLists.map(({ project, query }) => (
                        <div key={project.projectId} className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-baseline gap-2">
                                <h2 className="text-lg font-semibold">{project.projectName}</h2>
                                <span className="text-sm text-muted-foreground">{project.groupName}</span>
                                {(query.data?.length ?? 0) > 0 && (
                                    <Badge variant="secondary">{query.data?.length}</Badge>
                                )}
                            </div>

                            {query.isError ? (
                                <div className="flex items-center gap-3 rounded-md bg-destructive/15 px-4 py-2 text-sm text-destructive">
                                    <span className="flex-1">{t("settings.suggestions.load.error")}</span>
                                    <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                                        {t("settings.suggestions.reload")}
                                    </Button>
                                </div>
                            ) : (
                                sortNewestFirst(query.data ?? []).map((suggestion) => {
                                    const target = {
                                        projectId: project.projectId,
                                        suggestionId: suggestion.id,
                                    };
                                    const busy = isSuggestionBusy(suggestion.id);
                                    const isApplying =
                                        applyMutation.isPending &&
                                        applyMutation.variables?.suggestionId === suggestion.id;

                                    return (
                                        <div key={suggestion.id} className="flex flex-col gap-3 rounded-lg border p-4">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge variant="outline">{t(KIND_LABEL_KEYS[suggestion.kind])}</Badge>
                                                <span className="text-xs text-muted-foreground">
                                                    {t("settings.suggestions.submitted.by", {
                                                        name: submitterName(suggestion.suggested_by_user_id),
                                                    })}
                                                    {" · "}
                                                    {formatCreatedAt(suggestion.created_at)}
                                                </span>
                                                <div className="ml-auto flex gap-2">
                                                    <Button
                                                        size="sm"
                                                        onClick={() => applyMutation.mutate(target)}
                                                        disabled={busy}
                                                    >
                                                        {isApplying ? (
                                                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                                        ) : (
                                                            <Check className="mr-1 h-3.5 w-3.5" />
                                                        )}
                                                        {t("settings.suggestions.apply")}
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() => setDismissTarget(target)}
                                                        disabled={busy}
                                                    >
                                                        <X className="mr-1 h-3.5 w-3.5" />
                                                        {t("settings.suggestions.dismiss")}
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <span className="text-xs font-medium text-muted-foreground">
                                                    {t("settings.suggestions.reference")}
                                                </span>
                                                <p className="whitespace-pre-wrap text-sm">{suggestion.reference}</p>
                                            </div>
                                            <div className="flex flex-col gap-1">
                                                <span className="text-xs font-medium text-muted-foreground">
                                                    {t("settings.suggestions.suggestion")}
                                                </span>
                                                <p className="whitespace-pre-wrap text-sm">{suggestion.suggestion}</p>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    ))}
                </div>
            )}

            <Dialog
                open={dismissTarget !== null}
                onOpenChange={(open) => {
                    if (!open && !dismissMutation.isPending) setDismissTarget(null);
                }}
            >
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>{t("settings.suggestions.dismiss.confirm.title")}</DialogTitle>
                        <DialogDescription>{t("settings.suggestions.dismiss.confirm.description")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setDismissTarget(null)}
                            disabled={dismissMutation.isPending}
                        >
                            {t("cancel")}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => dismissTarget && dismissMutation.mutate(dismissTarget)}
                            disabled={dismissMutation.isPending}
                        >
                            {dismissMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            {t("settings.suggestions.dismiss")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
