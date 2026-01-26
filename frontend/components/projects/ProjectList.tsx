"use client";

import { StateDisplay } from "@/components/common/StateDisplay";
import { queryKeys } from "@/hooks/use-data";
import { useData } from "@/providers/DataProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import { useNavigation } from "@/providers/NavigationProvider";
import type { ApiProjectFile, Project } from "@/types";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { ProjectCard } from "./ProjectCard";

type ProjectListProps = {
  onEditProject: (project: Project, groupId: string) => void;
};

export function ProjectList({ onEditProject }: ProjectListProps) {
  const { selectedGroup, selectItem } = useNavigation();
  const { t } = useLanguage();
  const { groups, isLoading, error } = useData();

  function parseApiTimestamp(input: unknown): Date | undefined {
    if (!input) return undefined;
    if (typeof input === "string") {
      const d = new Date(input);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
    if (typeof input === "object" && input !== null && "Time" in input) {
      const timeObj = input as { Time?: string };
      const v = timeObj.Time;
      if (!v) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
    return undefined;
  }

  const group = groups.find((g) => g.id === selectedGroup?.id);

  const projectFilesQueries = useQueries({
    queries: (group?.projects || []).map((project) => ({
      queryKey: queryKeys.projectFiles(project.id),
      queryFn: async () => {
        const { fetchProjectFiles } = await import("@/lib/api");
        return fetchProjectFiles(project.id);
      },
      staleTime: 30 * 1000,
    })),
  });

  const projectMeta = useMemo(() => {
    const meta: Record<string, { lastUpdated?: Date; sourcesCount: number }> =
      {};

    if (!group?.projects) return meta;

    group.projects.forEach((project, index) => {
      const queryResult = projectFilesQueries[index];
      const files = queryResult.data as ApiProjectFile[] | undefined;

      if (files) {
        const sourcesCount = files.length;
        let latest: Date | undefined;
        for (const f of files) {
          const d =
            parseApiTimestamp(f.created_at) || parseApiTimestamp(f.updated_at);
          if (d && (!latest || d > latest)) latest = d;
        }
        meta[project.id] = { lastUpdated: latest, sourcesCount };
      } else {
        meta[project.id] = { sourcesCount: 0 };
      }
    });

    return meta;
  }, [group?.projects, projectFilesQueries]);

  if (isLoading || error || !group) {
    return (
      <StateDisplay
        isLoading={isLoading}
        error={error}
        isEmpty={!group && !isLoading && !error}
        loadingMessage={t("loading")}
        errorMessage={t("error")}
        emptyMessage={t("group.not.found")}
        emptyDescription={t("select.another.group")}
      />
    );
  }

  if (group.projects.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{group.name}</h1>
          <p className="text-muted-foreground">{t("no.projects")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{group.name}</h1>
        <p className="text-muted-foreground">{t("select.knowledge.project")}</p>
      </div>

      <div className="grid auto-rows-fr items-stretch gap-4 md:grid-cols-2 lg:grid-cols-3">
        {group.projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={{
              id: project.id,
              name: project.name,
              state: project.state,
              lastUpdated: projectMeta[project.id]?.lastUpdated,
              sourcesCount: projectMeta[project.id]?.sourcesCount ?? 0,
              processStep: project.processStep,
              processProgress: project.processProgress,
              processPercentage: project.processPercentage,
              processEstimatedDuration: project.processEstimatedDuration,
              processTimeRemaining: project.processTimeRemaining,
            }}
            groupName={group.name}
            onSelect={() => selectItem(group, project)}
            onEdit={() => onEditProject(project, group.id)}
          />
        ))}
      </div>
    </div>
  );
}
