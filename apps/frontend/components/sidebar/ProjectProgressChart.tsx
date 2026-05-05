"use client";

import { ChartConfig, ChartContainer } from "@/components/ui/chart";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/utils";
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

export function ProjectProgressChart({ project }: ProjectProgressChartProps) {
    const { t } = useLanguage();
    const percentage = project.processPercentage ?? 0;
    const step = project.processStep ?? "";
    const timeRemaining =
        project.processTimeRemaining !== undefined && project.processTimeRemaining > 0
            ? formatRemaining(formatDuration(project.processTimeRemaining), t)
            : undefined;

    const chartData = [{ name: "progress", value: percentage, fill: "var(--foreground)" }];

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className="h-4 w-4 shrink-0 cursor-pointer pointer-events-auto">
                    <ChartContainer config={chartConfig} className="h-4 w-4 p-0!">
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
                            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
                            <RadialBar dataKey="value" background={{ fill: "hsl(var(--muted))" }} cornerRadius={2} />
                        </RadialBarChart>
                    </ChartContainer>
                </div>
            </TooltipTrigger>
            <TooltipContent side="top" align="center" sideOffset={8}>
                <div className="flex flex-col gap-1 text-xs text-center">
                    <div className="font-medium">{percentage}%</div>
                    {step && <div className="text-muted-foreground">{t(`process.${step}`) || step}</div>}
                    {timeRemaining !== undefined && (
                        <div className="text-muted-foreground">{t("process.remaining", { time: timeRemaining })}</div>
                    )}
                </div>
            </TooltipContent>
        </Tooltip>
    );
}
