"use client";

import { CardTemplate } from "@/components/common/CardTemplate";
import { useLanguage } from "@/providers/LanguageProvider";
import type { Project } from "@/types";
import { BookOpen, Calendar } from "lucide-react";

type ProjectCardProps = {
  project: Project;
  groupName: string;
  onSelect: () => void;
  onEdit: () => void;
};

export function ProjectCard({
  project,
  groupName,
  onSelect,
  onEdit,
}: ProjectCardProps) {
  const { t } = useLanguage();
  const lastUpdated = project.lastUpdated;
  const sourcesCount = project.sourcesCount ?? 0;

  return (
    <CardTemplate
      title={project.name}
      description={groupName}
      badgeIcon={BookOpen}
      badgeText={t("knowledge.project")}
      buttonText={t("open")}
      onSelect={onSelect}
      onEdit={onEdit}
      disabled={project.state === "create"}
    >
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
    </CardTemplate>
  );
}
