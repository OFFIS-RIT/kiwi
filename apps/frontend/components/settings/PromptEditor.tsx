"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fetchPrompts, savePromptText, type PromptScope } from "@/lib/api";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import { MAX_PROMPT_LENGTH } from "@kiwi/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

function promptScopeId(scope: PromptScope) {
    switch (scope.kind) {
        case "user":
            return scope.userId;
        case "organization":
            return scope.organizationId;
        case "team":
            return scope.teamId;
        case "graph":
            return scope.graphId;
    }
}

type PromptEditorProps = {
    scope: PromptScope;
    /** Optional accessible label rendered above the text field. */
    label?: string;
    placeholderKey?: string;
};

/**
 * The single text field + save button for one Prompt scope. The field is the
 * source of truth: saving an empty field deletes the stored Prompt.
 */
export function PromptEditor({ scope, label, placeholderKey = "prompts.placeholder" }: PromptEditorProps) {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const textareaId = useId();
    // null = untouched; the field then mirrors the server value.
    const [draft, setDraft] = useState<string | null>(null);

    const queryKey = queryKeys.prompts(scope.kind, promptScopeId(scope));
    const promptsQuery = useQuery({
        queryKey,
        queryFn: () => fetchPrompts(apiClient, scope),
    });

    const serverText = promptsQuery.data?.[0]?.prompt ?? "";
    const text = draft ?? serverText;
    const isDirty = draft !== null && draft.trim() !== serverText.trim();
    const isTooLong = text.length > MAX_PROMPT_LENGTH;

    const saveMutation = useMutation({
        mutationFn: (nextText: string) => savePromptText(apiClient, scope, promptsQuery.data ?? [], nextText),
        onSuccess: () => {
            setDraft(null);
            toast.success(t("prompts.saved"));
        },
        onError: () => toast.error(t("prompts.save.error")),
        onSettled: () => queryClient.invalidateQueries({ queryKey }),
    });

    if (promptsQuery.isLoading) {
        return (
            <div className="flex items-center justify-center rounded-md border py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (promptsQuery.isError) {
        return (
            <div className="flex items-center gap-3 rounded-md bg-destructive/15 px-4 py-2 text-sm text-destructive">
                <span className="flex-1">{t("prompts.load.error")}</span>
                <Button variant="outline" size="sm" onClick={() => void promptsQuery.refetch()}>
                    {t("prompts.reload")}
                </Button>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            {label ? (
                <label className="text-sm font-medium" htmlFor={textareaId}>
                    {label}
                </label>
            ) : null}
            <Textarea
                id={textareaId}
                value={text}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t(placeholderKey)}
                rows={5}
                aria-invalid={isTooLong || undefined}
                disabled={saveMutation.isPending}
            />
            <div className="flex items-center justify-end gap-3">
                <span className={`text-xs ${isTooLong ? "text-destructive" : "text-muted-foreground"}`}>
                    {t("prompts.length", {
                        length: text.length.toLocaleString(),
                        max: MAX_PROMPT_LENGTH.toLocaleString(),
                    })}
                </span>
                <Button
                    size="sm"
                    onClick={() => saveMutation.mutate(text)}
                    disabled={!isDirty || isTooLong || saveMutation.isPending}
                >
                    {saveMutation.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    {t("prompts.save")}
                </Button>
            </div>
        </div>
    );
}
