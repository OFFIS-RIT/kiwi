"use client";

import { CardTemplate } from "@/components/common/CardTemplate";
import { useLanguage } from "@/providers/LanguageProvider";
import type { Group } from "@/types";
import { FileText, Users } from "lucide-react";

type GroupCardProps = {
  group: Group;
  onSelect: () => void;
  onEdit: () => void;
};

export function GroupCard({ group, onSelect, onEdit }: GroupCardProps) {
  const { t } = useLanguage();

  return (
    <CardTemplate
      title={group.name}
      badgeIcon={Users}
      badgeText={t("group")}
      buttonText={t("open")}
      onSelect={onSelect}
      onEdit={onEdit}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <FileText className="h-4 w-4" />
        <span>
          {group.projects.length} {t("knowledge.projects")}
        </span>
      </div>
    </CardTemplate>
  );
}
