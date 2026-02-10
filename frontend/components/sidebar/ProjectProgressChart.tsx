"use client";

import { ChartConfig, ChartContainer } from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCountdown } from "@/hooks/use-countdown";
import { formatDuration } from "@/lib/utils";
import { useData } from "@/providers/DataProvider";
import { useLanguage } from "@/providers/LanguageProvider";
import type { Project } from "@/types";
import { PolarAngleAxis, RadialBar, RadialBarChart } from "recharts";

const chartConfig = {
  progress: {
    label: "Progress",
  },
} satisfies ChartConfig;

type ProjectProgressChartProps = {
  project: Project;
};

export function ProjectProgressChart({ project }: ProjectProgressChartProps) {
  const { t } = useLanguage();
  const { dataUpdatedAt } = useData();
  const percentage = project.processPercentage ?? 0;
  const step = project.processStep ?? "";
  const timeRemaining = useCountdown(
    project.processTimeRemaining,
    dataUpdatedAt
  );

  const chartData = [
    { name: "progress", value: percentage, fill: "var(--foreground)" },
  ];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="h-4 w-4 shrink-0 cursor-pointer pointer-events-auto">
          <ChartContainer config={chartConfig} className="h-4 w-4 !p-0">
            <RadialBarChart
              data={chartData}
              startAngle={90}
              endAngle={-270}
              innerRadius="60%"
              outerRadius="100%"
              barSize={2}
              cx="50%"
              cy="50%"
              margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
            >
              <PolarAngleAxis
                type="number"
                domain={[0, 100]}
                tick={false}
                axisLine={false}
              />
              <RadialBar
                dataKey="value"
                background={{ fill: "hsl(var(--muted))" }}
                cornerRadius={2}
              />
            </RadialBarChart>
          </ChartContainer>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" sideOffset={8}>
        <div className="flex flex-col gap-1 text-xs text-center">
          <div className="font-medium">{percentage}%</div>
          {step && (
            <div className="text-muted-foreground">
              {t(`process.${step}`) || step}
            </div>
          )}
          {timeRemaining !== undefined && timeRemaining > 0 && (
            <div className="text-muted-foreground">
              {t("process.remaining", { time: formatDuration(timeRemaining) })}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
