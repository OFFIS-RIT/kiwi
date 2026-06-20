"use client";

import { StateDisplay } from "@/components/common/StateDisplay";
import { useGroupsWithProjects } from "@/hooks/use-data";
import { canCreateTeam } from "@/lib/capabilities";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import type { Group } from "@/types";
import { useAuth } from "@/providers/AuthProvider";
import { useRouter } from "next/navigation";
import { GroupCard } from "./GroupCard";

type GroupListProps = {
    onEditGroup?: (group: Group) => void;
};

export function GroupList({ onEditGroup }: GroupListProps) {
    const router = useRouter();
    const t = useAppTranslations();
    const { isAdmin } = useAuth();
    const { data: groups = [], isLoading, error: queryError } = useGroupsWithProjects();
    const error = queryError ? t("error.loading.data") : null;

    if (error) {
        return <StateDisplay error={error} errorMessage={t("error")} />;
    }

    if (!isLoading && groups.length === 0) {
        return (
            <StateDisplay
                isEmpty
                emptyMessage={t("no.groups")}
                emptyDescription={canCreateTeam({ isAdmin }) ? t("create.first.group") : t("no.groups.member")}
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
                        onSelect={() => router.push(`/${group.id}`)}
                        onEdit={() => onEditGroup?.(group)}
                    />
                ))}
            </div>
        </div>
    );
}
