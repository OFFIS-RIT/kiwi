"use client";

import { CardTemplate } from "@/components/common/CardTemplate";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLanguage } from "@/providers/LanguageProvider";
import type { Project } from "@/types";
import { BookOpen, Calendar, Loader2 } from "lucide-react";

type ProjectCardProps = {
  project: Project;
  groupName: string;
  onSelect: () => void;
  onEdit: () => void;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return "< 1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function ProjectCard({
  project,
  groupName,
  onSelect,
  onEdit,
}: ProjectCardProps) {
  const { t } = useLanguage();
  const lastUpdated = project.lastUpdated;
  const sourcesCount = project.sourcesCount ?? 0;
  const isProcessing = project.processPercentage !== undefined;

  return (
    <CardTemplate
      title={project.name}
      description={groupName}
      badgeIcon={BookOpen}
      badgeText={t("knowledge.project")}
      buttonText={t("open")}
      onSelect={onSelect}
      onEdit={onEdit}
      disabled={project.state === "create" && !isProcessing}
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
                      return translated === stepKey
                        ? project.processStep
                        : translated;
                    })()}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="text-xs space-y-1">
                    {project.processProgress &&
                      Object.entries(project.processProgress)
                        .filter(([_, value]) => value) // Only show active steps
                        .map(([key, value]) => {
                          const labelKey = `process.${key === "pending" ? "queued" : key === "preprocessing" ? "processing_files" : key === "extracting" ? "graph_creation" : key === "indexing" ? "saving" : key}`;
                          const translatedLabel = t(labelKey);
                          return (
                            <div
                              key={key}
                              className="flex justify-between gap-4"
                            >
                              <span>
                                {translatedLabel === labelKey
                                  ? key
                                  : translatedLabel}
                                :
                              </span>
                              <span className="font-mono">{value}</span>
                            </div>
                          );
                        })}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span className="font-medium text-xs">
              {project.processPercentage}%
            </span>
          </div>
          <Progress value={project.processPercentage} className="h-2" />
          {project.processTimeRemaining !== undefined &&
            project.processTimeRemaining > 0 && (
              <div className="text-xs text-muted-foreground text-right">
                {t("process.remaining", {
                  time: formatDuration(project.processTimeRemaining),
                })}
              </div>
            )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Calendar className="h-4 w-4" />
            <span>
              {t("last.updated")}{" "}
              {lastUpdated ? lastUpdated.toLocaleDateString() : "-"}
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
