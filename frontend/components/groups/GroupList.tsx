"use client";

import { StateDisplay } from "@/components/common/StateDisplay";
import { useData } from "@/providers/DataProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import { useNavigation } from "@/providers/NavigationProvider";
import type { Group } from "@/types";
import { GroupCard } from "./GroupCard";

type GroupListProps = {
  onEditGroup: (group: Group) => void;
};

export function GroupList({ onEditGroup }: GroupListProps) {
  const { selectItem } = useNavigation();
  const { t } = useLanguage();
  const { groups, isLoading, error } = useData();

  if (isLoading || error || groups.length === 0) {
    return (
      <StateDisplay
        isLoading={isLoading}
        error={error}
        isEmpty={groups.length === 0}
        loadingMessage={t("loading")}
        errorMessage={t("error")}
        emptyMessage={t("no.groups")}
        emptyDescription={t("create.first.group")}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">KIWI</h1>
        <p className="text-muted-foreground">{t("select.group")}</p>
      </div>

      <div className="grid auto-rows-fr items-stretch gap-4 md:grid-cols-2 lg:grid-cols-3">
        {groups.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            onSelect={() => selectItem(group)}
            onEdit={() => onEditGroup(group)}
          />
        ))}
      </div>
    </div>
  );
}
