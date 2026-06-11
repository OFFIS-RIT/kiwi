"use client";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchSelectableModels } from "@/lib/api/models";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import type { PublicModelListItem } from "@kiwi/contracts";
import { useQuery } from "@tanstack/react-query";
import { Brain, Check, ChevronDown, Cpu } from "lucide-react";

const SELECTABLE_MODELS_STALE_TIME_MS = 60 * 1000;

export type IntelligenceLevel = "default" | "high";

const INTELLIGENCE_LEVELS: IntelligenceLevel[] = ["default", "high"];

/**
 * The text AI Models the current user may pick in chat. Shared between the
 * selector and the empty-state guard so both read one cache entry.
 */
export function useSelectableModels() {
    const apiClient = useApiClient();
    return useQuery({
        queryKey: queryKeys.selectableModels,
        queryFn: () => fetchSelectableModels(apiClient),
        staleTime: SELECTABLE_MODELS_STALE_TIME_MS,
    });
}

type ChatModelMenuProps = {
    models: PublicModelListItem[];
    /** Selected AI Model id, or null for the organization default. */
    value: string | null;
    onChange: (modelId: string | null) => void;
    intelligenceLevel: IntelligenceLevel;
    onIntelligenceLevelChange: (level: IntelligenceLevel) => void;
    disabled?: boolean;
};

/**
 * Combined per-chat-session menu for model and intelligence level: models are
 * picked directly at the top level, the intelligence level lives in a hover
 * submenu. The top "default" model entry stands for omitting `modelId` from
 * the request, which lets the backend resolve the organization default; which
 * model that is stays opaque to regular members.
 */
export function ChatModelMenu({
    models,
    value,
    onChange,
    intelligenceLevel,
    onIntelligenceLevelChange,
    disabled,
}: ChatModelMenuProps) {
    const t = useAppTranslations();
    const selected = value ? models.find((model) => model.model_id === value) : undefined;
    const modelLabel = selected?.display_name ?? t("chat.model.default");

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={t("chat.model")}
                    className="h-9 shrink-0 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground"
                >
                    <Cpu className="h-4 w-4" />
                    <span className="max-w-40 truncate text-sm">{modelLabel}</span>
                    {intelligenceLevel !== "default" ? (
                        <span className="text-sm opacity-70">{t(`deep.mode.${intelligenceLevel}`)}</span>
                    ) : null}
                    <ChevronDown className="h-3.5 w-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-60 rounded-xl p-1.5">
                {models.length > 0 ? (
                    <>
                        <DropdownMenuLabel className="px-2.5 py-1.5 text-sm font-normal text-muted-foreground">
                            {t("chat.model")}
                        </DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => onChange(null)} className="min-h-9 rounded-lg px-2.5 text-sm">
                            <span>{t("chat.model.default")}</span>
                            {value === null && <Check className="ml-auto h-4 w-4" />}
                        </DropdownMenuItem>
                        {models.map((model) => (
                            <DropdownMenuItem
                                key={model.model_id}
                                onClick={() => onChange(model.model_id)}
                                className="min-h-9 rounded-lg px-2.5 text-sm"
                            >
                                <span className="truncate">{model.display_name}</span>
                                {value === model.model_id && <Check className="ml-auto h-4 w-4" />}
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="min-h-9 rounded-lg px-2.5 text-sm">
                        <Brain className="mr-2 h-4 w-4" />
                        <span>{t("deep.mode.intelligence")}</span>
                        <span className="ml-auto pl-4 text-muted-foreground">
                            {t(`deep.mode.${intelligenceLevel}`)}
                        </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-44 rounded-xl p-1.5">
                        {INTELLIGENCE_LEVELS.map((level) => (
                            <DropdownMenuItem
                                key={level}
                                onClick={() => onIntelligenceLevelChange(level)}
                                className="min-h-9 rounded-lg px-2.5 text-sm"
                            >
                                <span>{t(`deep.mode.${level}`)}</span>
                                {intelligenceLevel === level && <Check className="ml-auto h-4 w-4" />}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
