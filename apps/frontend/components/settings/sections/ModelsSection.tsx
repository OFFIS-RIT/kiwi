"use client";

import { DeleteModelDialog } from "@/components/admin/DeleteModelDialog";
import { MODEL_ADAPTER_LABEL_KEYS, MODEL_TYPE_LABEL_KEYS, ModelFormDialog } from "@/components/admin/ModelFormDialog";
import { Button } from "@/components/ui/button";
import { fetchAdminModels, setDefaultModel } from "@/lib/api/models";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
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

function ModelMeta({ model }: { model: AdminModelListItem }) {
    const t = useAppTranslations();
    return (
        <p className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{model.model_id}</span>
            {" · "}
            {t(MODEL_ADAPTER_LABEL_KEYS[model.adapter])}
            {" · "}
            <span className="font-mono">{model.provider_model}</span>
        </p>
    );
}

export function ModelsSection() {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const [selectedType, setSelectedType] = useState<AiModelType>("text");
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

    const typeModels = modelsByType(selectedType);
    const defaultModel = typeModels.find((model) => model.is_default);
    const otherModels = typeModels.filter((model) => !model.is_default);

    const modelActions = (model: AdminModelListItem) => (
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
                onClick={() => setFormTarget({ type: model.type, model })}
            >
                <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label={t("delete")} onClick={() => setDeleteTarget(model)}>
                <Trash2 className="h-4 w-4" />
            </Button>
        </div>
    );

    return (
        <section className="flex flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("settings.models.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.models.description")}</p>
            </div>
            <div className="flex flex-col gap-5 md:flex-row md:items-start">
                <nav className="w-full shrink-0 rounded-md border bg-card p-1.5 md:w-56">
                    {AI_MODEL_TYPE_VALUES.map((type) => {
                        const count = modelsByType(type).length;
                        return (
                            <button
                                key={type}
                                type="button"
                                onClick={() => setSelectedType(type)}
                                aria-current={type === selectedType ? "true" : undefined}
                                className={cn(
                                    "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm",
                                    type === selectedType
                                        ? "bg-secondary font-medium"
                                        : "text-muted-foreground hover:bg-secondary/50"
                                )}
                            >
                                <span
                                    aria-hidden
                                    className={cn(
                                        "h-2 w-2 rounded-full",
                                        count > 0 ? "bg-emerald-500" : "bg-muted-foreground/30"
                                    )}
                                />
                                {t(MODEL_TYPE_LABEL_KEYS[type])}
                                <span className="ml-auto text-xs text-muted-foreground">{count > 0 ? count : "–"}</span>
                            </button>
                        );
                    })}
                </nav>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                        <h2 className="text-base font-semibold">
                            {t("settings.models.detail.title", { type: t(MODEL_TYPE_LABEL_KEYS[selectedType]) })}
                        </h2>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setFormTarget({ type: selectedType, model: null })}
                        >
                            <Plus className="mr-2 h-4 w-4" />
                            {t("settings.models.add")}
                        </Button>
                    </div>
                    {defaultModel ? (
                        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-3">
                            <div className="min-w-0">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    {t("settings.models.default.badge")}
                                </p>
                                <p className="truncate font-medium">{defaultModel.display_name}</p>
                                <ModelMeta model={defaultModel} />
                            </div>
                            {modelActions(defaultModel)}
                        </div>
                    ) : (
                        <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                            {t("settings.models.detail.empty")}
                        </p>
                    )}
                    {otherModels.length > 0 ? (
                        <ul className="mt-3 flex flex-col divide-y rounded-md border">
                            {otherModels.map((model) => (
                                <li key={model.model_id} className="flex items-center justify-between gap-3 p-3">
                                    <div className="min-w-0">
                                        <p className="truncate font-medium">{model.display_name}</p>
                                        <ModelMeta model={model} />
                                    </div>
                                    {modelActions(model)}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            </div>
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
