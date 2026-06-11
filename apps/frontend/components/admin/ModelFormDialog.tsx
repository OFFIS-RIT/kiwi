"use client";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import { createModel, updateModel } from "@/lib/api/models";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useApiClient } from "@/providers/ApiClientProvider";
import type {
    AdminModelListItem,
    AiModelAdapter,
    AiModelType,
    ModelCreateInput,
    ModelCredentialsPatchInput,
    ModelPatchInput,
} from "@kiwi/contracts";
import { AI_MODEL_ADAPTER_VALUES } from "@kiwi/contracts";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export const MODEL_TYPE_LABEL_KEYS: Record<AiModelType, string> = {
    text: "settings.models.type.text",
    subagent: "settings.models.type.subagent",
    extract: "settings.models.type.extract",
    embedding: "settings.models.type.embedding",
    image: "settings.models.type.image",
    audio: "settings.models.type.audio",
    video: "settings.models.type.video",
};

export const MODEL_ADAPTER_LABEL_KEYS: Record<AiModelAdapter, string> = {
    openai: "settings.models.adapter.openai",
    azure: "settings.models.adapter.azure",
    anthropic: "settings.models.adapter.anthropic",
    openaiAPI: "settings.models.adapter.openaiAPI",
};

// Anthropic offers no embedding or transcription models.
const ANTHROPIC_UNSUPPORTED_TYPES: AiModelType[] = ["embedding", "audio", "video"];
const DEFAULT_CONTEXT_WINDOW_TOKENS = 250_000;
const MIN_CONTEXT_WINDOW_TOKENS = 1_000;

function supportsContextWindow(type: AiModelType): boolean {
    return type === "text" || type === "subagent";
}

export function adapterOptionsForType(type: AiModelType): AiModelAdapter[] {
    return AI_MODEL_ADAPTER_VALUES.filter(
        (adapter) => adapter !== "anthropic" || !ANTHROPIC_UNSUPPORTED_TYPES.includes(type)
    );
}

// Mirrors the backend's normalizeModelId so the prefilled id matches what a
// create would produce (the backend response stays canonical either way).
export function slugifyModelId(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
}

type ModelFormDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Model type the dialog creates or edits; immutable after creation. */
    type: AiModelType;
    /** When set, the dialog edits this model instead of creating one. */
    model?: AdminModelListItem | null;
    onSaved: () => void;
};

export function ModelFormDialog({ open, onOpenChange, type, model, onSaved }: ModelFormDialogProps) {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const isEdit = !!model;

    const [displayName, setDisplayName] = useState("");
    const [modelIdInput, setModelIdInput] = useState("");
    const [modelIdTouched, setModelIdTouched] = useState(false);
    const [adapter, setAdapter] = useState<AiModelAdapter>("openai");
    const [providerModel, setProviderModel] = useState("");
    const [contextWindow, setContextWindow] = useState(String(DEFAULT_CONTEXT_WINDOW_TOKENS));
    const [apiKey, setApiKey] = useState("");
    const [url, setUrl] = useState("");
    const [resourceName, setResourceName] = useState("");
    const [isDefault, setIsDefault] = useState(false);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) {
            return;
        }
        setDisplayName(model?.display_name ?? "");
        setModelIdInput("");
        setModelIdTouched(false);
        setAdapter(model?.adapter ?? adapterOptionsForType(type)[0] ?? "openai");
        setProviderModel(model?.provider_model ?? "");
        setContextWindow(String(model?.context_window ?? DEFAULT_CONTEXT_WINDOW_TOKENS));
        setApiKey("");
        setUrl(model?.url ?? "");
        setResourceName(model?.resource_name ?? "");
        setIsDefault(false);
    }, [open, model, type]);

    const adapterOptions = adapterOptionsForType(type);
    const modelId = modelIdTouched ? modelIdInput : slugifyModelId(displayName);
    const showContextWindow = supportsContextWindow(type);

    // Each connection field belongs to one adapter (URL → openaiAPI, resource
    // name → azure). Clearing them on switch hides the stale field and, via
    // the empty string, removes the stored value from the credentials blob.
    const handleAdapterChange = (next: AiModelAdapter) => {
        setAdapter(next);
        if (next !== "openaiAPI") setUrl("");
        if (next !== "azure") setResourceName("");
    };
    // URL and resource name are readable connection config; only the API key
    // is a write-only secret (empty on edit = keep the stored key).
    const requireApiKey = !isEdit;
    const requireUrl = adapter === "openaiAPI";
    const requireResourceName = adapter === "azure";

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            if (isEdit && model) {
                const patch: ModelPatchInput = {};
                if (displayName.trim() !== model.display_name) {
                    patch.display_name = displayName.trim();
                }
                if (adapter !== model.adapter) {
                    patch.adapter = adapter;
                }
                if (providerModel.trim() !== model.provider_model) {
                    patch.provider_model = providerModel.trim();
                }
                const contextWindowValue = showContextWindow ? Number(contextWindow) : null;
                if (contextWindowValue !== null && contextWindowValue !== model.context_window) {
                    patch.context_window = contextWindowValue;
                }
                const credentialsPatch: ModelCredentialsPatchInput = {
                    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                    ...(url.trim() !== (model.url ?? "") ? { url: url.trim() } : {}),
                    ...(resourceName.trim() !== (model.resource_name ?? "")
                        ? { resourceName: resourceName.trim() }
                        : {}),
                };
                if (Object.keys(credentialsPatch).length > 0) {
                    patch.credentials = credentialsPatch;
                }
                if (Object.keys(patch).length > 0) {
                    await updateModel(apiClient, model.model_id, patch);
                }
            } else {
                const input: ModelCreateInput = {
                    model_id: modelId,
                    display_name: displayName.trim(),
                    type,
                    adapter,
                    provider_model: providerModel.trim(),
                    ...(showContextWindow ? { context_window: Number(contextWindow) } : {}),
                    credentials: {
                        apiKey: apiKey.trim(),
                        ...(url.trim() ? { url: url.trim() } : {}),
                        ...(resourceName.trim() ? { resourceName: resourceName.trim() } : {}),
                    },
                    ...(isDefault ? { is_default: true } : {}),
                };
                const created = await createModel(apiClient, input);
                if (created.model_id !== modelId) {
                    toast.info(t("settings.models.created.renamed", { id: created.model_id }));
                }
            }
            onOpenChange(false);
            onSaved();
        } catch (error) {
            if (error instanceof ApiError && error.code === "INVALID_MODEL") {
                toast.error(t("settings.models.error.invalid"));
            } else {
                toast.error(t("error.saving"));
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {isEdit ? t("settings.models.dialog.edit.title") : t("settings.models.dialog.create.title")}
                    </DialogTitle>
                    <DialogDescription>
                        {t("settings.models.dialog.type", { type: t(MODEL_TYPE_LABEL_KEYS[type]) })}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="model-display-name">{t("settings.models.field.displayName")}</Label>
                        <Input
                            id="model-display-name"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            required
                        />
                    </div>
                    {!isEdit ? (
                        <div className="space-y-2">
                            <Label htmlFor="model-id">{t("settings.models.field.modelId")}</Label>
                            <Input
                                id="model-id"
                                value={modelId}
                                onChange={(e) => {
                                    setModelIdTouched(true);
                                    setModelIdInput(e.target.value);
                                }}
                                required
                            />
                            <p className="text-xs text-muted-foreground">{t("settings.models.field.modelId.hint")}</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <Label>{t("settings.models.field.modelId")}</Label>
                            <p className="text-sm text-muted-foreground font-mono">{model?.model_id}</p>
                        </div>
                    )}
                    <div className="space-y-2">
                        <Label htmlFor="model-adapter">{t("settings.models.field.adapter")}</Label>
                        <Select value={adapter} onValueChange={(value) => handleAdapterChange(value as AiModelAdapter)}>
                            <SelectTrigger id="model-adapter" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {adapterOptions.map((option) => (
                                    <SelectItem key={option} value={option}>
                                        {t(MODEL_ADAPTER_LABEL_KEYS[option])}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="model-provider-model">{t("settings.models.field.providerModel")}</Label>
                        <Input
                            id="model-provider-model"
                            value={providerModel}
                            onChange={(e) => setProviderModel(e.target.value)}
                            placeholder="gpt-5.5"
                            required
                        />
                    </div>
                    {showContextWindow ? (
                        <div className="space-y-2">
                            <Label htmlFor="model-context-window">{t("settings.models.field.contextWindow")}</Label>
                            <Input
                                id="model-context-window"
                                type="number"
                                min={MIN_CONTEXT_WINDOW_TOKENS}
                                step={1}
                                value={contextWindow}
                                onChange={(e) => setContextWindow(e.target.value)}
                                required
                            />
                        </div>
                    ) : null}
                    {adapter === "openaiAPI" || url ? (
                        <div className="space-y-2">
                            <Label htmlFor="model-url">{t("settings.models.field.url")}</Label>
                            <Input
                                id="model-url"
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                required={requireUrl}
                            />
                        </div>
                    ) : null}
                    {adapter === "azure" || resourceName ? (
                        <div className="space-y-2">
                            <Label htmlFor="model-resource-name">{t("settings.models.field.resourceName")}</Label>
                            <Input
                                id="model-resource-name"
                                value={resourceName}
                                onChange={(e) => setResourceName(e.target.value)}
                                required={requireResourceName}
                            />
                        </div>
                    ) : null}
                    <div className="space-y-4 border-t pt-4">
                        <div>
                            <p className="text-sm font-medium">{t("settings.models.credentials.title")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("settings.models.credentials.writeOnly")}
                            </p>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="model-api-key">{t("settings.models.field.apiKey")}</Label>
                            <Input
                                id="model-api-key"
                                type="password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder={isEdit ? t("settings.models.field.apiKey.keep") : undefined}
                                required={requireApiKey}
                            />
                        </div>
                    </div>
                    {!isEdit ? (
                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor="model-is-default">{t("settings.models.field.isDefault")}</Label>
                            <Switch id="model-is-default" checked={isDefault} onCheckedChange={setIsDefault} />
                        </div>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                            {t("cancel")}
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            {isEdit ? t("save.changes") : t("settings.models.add")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
