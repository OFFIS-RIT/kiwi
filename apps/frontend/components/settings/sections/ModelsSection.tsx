"use client";

import { DeleteModelDialog } from "@/components/admin/DeleteModelDialog";
import { MODEL_ADAPTER_LABEL_KEYS, MODEL_TYPE_LABEL_KEYS, ModelFormDialog } from "@/components/admin/ModelFormDialog";
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
    const [defaultTarget, setDefaultTarget] = useState<AdminModelListItem | null>(null);

    const modelsQuery = useQuery({
        queryKey: queryKeys.adminModels,
        queryFn: () => fetchAdminModels(apiClient),
    });

    const invalidateModels = () => queryClient.invalidateQueries({ queryKey: queryKeys.models });

    const makeDefaultMutation = useMutation({
        mutationFn: (modelId: string) => setDefaultModel(apiClient, modelId),
        onSuccess: () => {
            setDefaultTarget(null);
            return invalidateModels();
        },
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

    const typeModels = [...modelsByType(selectedType)].sort((a, b) => Number(b.is_default) - Number(a.is_default));

    const modelActions = (model: AdminModelListItem) => (
        <div className="flex shrink-0 items-center gap-1">
            {!model.is_default ? (
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={makeDefaultMutation.isPending}
                    onClick={() => setDefaultTarget(model)}
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
            <div>
                <div role="tablist" className="flex flex-wrap border-b">
                    {AI_MODEL_TYPE_VALUES.map((type) => {
                        const count = modelsByType(type).length;
                        const isActive = type === selectedType;
                        return (
                            <button
                                key={type}
                                type="button"
                                role="tab"
                                aria-selected={isActive}
                                onClick={() => setSelectedType(type)}
                                className={cn(
                                    "-mb-px inline-flex items-center gap-2 border-b-2 px-3.5 py-2 text-sm",
                                    isActive
                                        ? "border-foreground font-medium text-foreground"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
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
                                <span className="text-xs text-muted-foreground">{count > 0 ? count : "–"}</span>
                            </button>
                        );
                    })}
                </div>
                <div className="min-w-0">
                    <div className="mt-4 flex items-center justify-between gap-3">
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
                    {typeModels.length === 0 ? (
                        <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                            {t("settings.models.detail.empty")}
                        </p>
                    ) : (
                        <ul className="mt-3 flex flex-col divide-y rounded-md border">
                            {typeModels.map((model) => (
                                <li key={model.model_id} className="flex items-center justify-between gap-3 px-4 py-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="truncate font-medium">{model.display_name}</span>
                                            {model.is_default ? (
                                                <Badge variant="secondary">{t("settings.models.default.badge")}</Badge>
                                            ) : null}
                                        </div>
                                        <ModelMeta model={model} />
                                    </div>
                                    {modelActions(model)}
                                </li>
                            ))}
                        </ul>
                    )}
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
            {defaultTarget ? (
                <Dialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setDefaultTarget(null);
                    }}
                >
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>{t("settings.models.makeDefault.title")}</DialogTitle>
                            <DialogDescription>
                                {(() => {
                                    const currentDefault = models.find(
                                        (model) => model.type === defaultTarget.type && model.is_default
                                    );
                                    const type = t(MODEL_TYPE_LABEL_KEYS[defaultTarget.type]);
                                    return currentDefault
                                        ? t("settings.models.makeDefault.confirm", {
                                              name: defaultTarget.display_name,
                                              type,
                                              current: currentDefault.display_name,
                                          })
                                        : t("settings.models.makeDefault.confirm.simple", {
                                              name: defaultTarget.display_name,
                                              type,
                                          });
                                })()}
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setDefaultTarget(null)}
                                disabled={makeDefaultMutation.isPending}
                            >
                                {t("cancel")}
                            </Button>
                            <Button
                                type="button"
                                disabled={makeDefaultMutation.isPending}
                                onClick={() => makeDefaultMutation.mutate(defaultTarget.model_id)}
                            >
                                {makeDefaultMutation.isPending ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : null}
                                {t("settings.models.action.makeDefault")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
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
