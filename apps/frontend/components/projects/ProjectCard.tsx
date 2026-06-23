"use client";

import { CardTemplate } from "@/components/common/CardTemplate";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { usePrefetchProjectChat } from "@/hooks/use-prefetch-project-chat";
import { formatDuration } from "@/lib/utils";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import type { Project } from "@/types";
import { BookOpen, Calendar, Loader2 } from "lucide-react";

type ProjectCardProps = {
    project: Project;
    groupId: string;
    groupName: string;
    canEdit: boolean;
    onSelect: () => void;
    onEdit: () => void;
};

function formatRemaining(parts: ReturnType<typeof formatDuration>, t: (key: string) => string) {
    if (parts.days > 0) {
        return parts.hours > 0
            ? `${parts.days}${t("duration.day.short")} ${parts.hours}${t("duration.hour.short")}`
            : `${parts.days}${t("duration.day.short")}`;
    }

    if (parts.hours > 0) {
        return parts.minutes > 0
            ? `${parts.hours}${t("duration.hour.short")} ${parts.minutes}${t("duration.minute.short")}`
            : `${parts.hours}${t("duration.hour.short")}`;
    }

    if (parts.minutes > 0) {
        return `${parts.minutes}${t("duration.minute.short")}`;
    }

    return `${Math.max(1, parts.seconds)}${t("duration.second.short")}`;
}

export function ProjectCard({ project, groupId, groupName, canEdit, onSelect, onEdit }: ProjectCardProps) {
    const t = useAppTranslations();
    const prefetchProjectChat = usePrefetchProjectChat(project.id);
    const lastUpdated = project.lastUpdated;
    const sourcesCount = project.sourcesCount ?? 0;
    const isProcessing = project.processPercentage !== undefined;
    const timeRemaining =
        project.processTimeRemaining !== undefined && project.processTimeRemaining > 0
            ? formatRemaining(formatDuration(project.processTimeRemaining), t)
            : undefined;

    return (
        <CardTemplate
            title={project.name}
            description={groupName}
            badgeIcon={BookOpen}
            badgeText={t("knowledge.project")}
            buttonText={t("open")}
            prefetchHref={`/${groupId}/${project.id}`}
            onPrefetchVisible={prefetchProjectChat}
            onSelect={onSelect}
            onEdit={canEdit ? onEdit : undefined}
        >
            {isProcessing ? (
                <div className="space-y-3 pt-1">
                    <div className="flex items-center justify-between text-sm">
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="text-muted-foreground flex items-center gap-2 cursor-help">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        {(() => {
                                            if (!project.processStep) return t("processing");
                                            const stepKey = `process.${project.processStep}`;
                                            const translated = t(stepKey);
                                            return translated === stepKey ? project.processStep : translated;
                                        })()}
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <div className="text-xs space-y-1">
                                        {project.processProgress &&
                                            Object.entries(project.processProgress)
                                                .filter(([, value]) => value) // Show all non-empty values
                                                .map(([key, value]) => {
                                                    const labelKey = `process.${key}`;
                                                    const translatedLabel = t(labelKey);
                                                    return (
                                                        <div key={key} className="flex justify-between gap-4">
                                                            <span>
                                                                {translatedLabel === labelKey ? key : translatedLabel}:
                                                            </span>
                                                            <span className="font-mono">{value}</span>
                                                        </div>
                                                    );
                                                })}
                                    </div>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <span className="font-medium text-xs">{project.processPercentage}%</span>
                    </div>
                    <Progress value={project.processPercentage} className="h-2" />
                    {timeRemaining !== undefined && (
                        <div className="text-xs text-muted-foreground text-right">
                            {t("process.remaining", { time: timeRemaining })}
                        </div>
                    )}
                </div>
            ) : (
                <>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Calendar className="h-4 w-4" />
                        <span>
                            {t("last.updated")} {lastUpdated ? lastUpdated.toLocaleDateString() : "-"}
                        </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                        <BookOpen className="h-4 w-4" />
                        <span>
                            {sourcesCount} {t("sources")}
                        </span>
                    </div>
                </>
            )}
        </CardTemplate>
    );
}
