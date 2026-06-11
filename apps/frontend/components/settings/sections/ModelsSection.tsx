"use client";

import { DeleteModelDialog } from "@/components/admin/DeleteModelDialog";
import { MODEL_ADAPTER_LABEL_KEYS, MODEL_TYPE_LABEL_KEYS, ModelFormDialog } from "@/components/admin/ModelFormDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchAdminModels, setDefaultModel } from "@/lib/api/models";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import type { AdminModelListItem, AiModelType } from "@kiwi/contracts";
import { AI_MODEL_TYPE_VALUES } from "@kiwi/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type FormTarget = {
    type: AiModelType;
    model: AdminModelListItem | null;
};

export function ModelsSection() {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<AdminModelListItem | null>(null);

    const modelsQuery = useQuery({
        queryKey: queryKeys.adminModels,
        queryFn: () => fetchAdminModels(apiClient),
    });

    const invalidateModels = () => queryClient.invalidateQueries({ queryKey: queryKeys.models });

    const makeDefaultMutation = useMutation({
        mutationFn: (modelId: string) => setDefaultModel(apiClient, modelId),
        onSuccess: invalidateModels,
        onError: () => toast.error(t("error.saving")),
    });

    const models = modelsQuery.data ?? [];
    const modelsByType = (type: AiModelType) => models.filter((model) => model.type === type);

    if (modelsQuery.isLoading) {
        return (
            <section className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </section>
        );
    }

    if (modelsQuery.isError) {
        return <section className="py-12 text-center text-sm text-muted-foreground">{t("error.loading.data")}</section>;
    }

    return (
        <section className="flex flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("settings.models.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.models.description")}</p>
            </div>
            {AI_MODEL_TYPE_VALUES.map((type) => {
                const typeModels = modelsByType(type);
                return (
                    <div key={type} className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-base font-semibold">{t(MODEL_TYPE_LABEL_KEYS[type])}</h2>
                            <Button variant="outline" size="sm" onClick={() => setFormTarget({ type, model: null })}>
                                <Plus className="mr-2 h-4 w-4" />
                                {t("settings.models.add")}
                            </Button>
                        </div>
                        {typeModels.length === 0 ? (
                            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                                {t("settings.models.type.empty")}
                            </p>
                        ) : (
                            <ul className="flex flex-col divide-y rounded-md border">
                                {typeModels.map((model) => (
                                    <li key={model.model_id} className="flex items-center justify-between gap-3 p-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="truncate font-medium">{model.display_name}</span>
                                                {model.is_default ? (
                                                    <Badge variant="secondary">
                                                        {t("settings.models.default.badge")}
                                                    </Badge>
                                                ) : null}
                                            </div>
                                            <p className="truncate text-xs text-muted-foreground">
                                                <span className="font-mono">{model.model_id}</span>
                                                {" · "}
                                                {t(MODEL_ADAPTER_LABEL_KEYS[model.adapter])}
                                                {" · "}
                                                <span className="font-mono">{model.provider_model}</span>
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            {!model.is_default ? (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    disabled={makeDefaultMutation.isPending}
                                                    onClick={() => makeDefaultMutation.mutate(model.model_id)}
                                                >
                                                    <Star className="mr-2 h-4 w-4" />
                                                    {t("settings.models.action.makeDefault")}
                                                </Button>
                                            ) : null}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("edit")}
                                                onClick={() => setFormTarget({ type, model })}
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("delete")}
                                                onClick={() => setDeleteTarget(model)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                );
            })}
            {formTarget ? (
                <ModelFormDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setFormTarget(null);
                    }}
                    type={formTarget.type}
                    model={formTarget.model}
                    onSaved={invalidateModels}
                />
            ) : null}
            {deleteTarget ? (
                <DeleteModelDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setDeleteTarget(null);
                    }}
                    model={deleteTarget}
                    siblings={models.filter(
                        (model) => model.type === deleteTarget.type && model.model_id !== deleteTarget.model_id
                    )}
                    onDeleted={invalidateModels}
                />
            ) : null}
        </section>
    );
}
