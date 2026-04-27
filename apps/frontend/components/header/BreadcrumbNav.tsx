"use client";

import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useData } from "@/providers/DataProvider";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function BreadcrumbNav() {
    const pathname = usePathname();
    const { groups } = useData();
    const segments = pathname.split("/").filter(Boolean);
    const groupSlug = segments[0];
    const projectSlug = segments[1];

    const group = groupSlug ? groups.find((g) => g.name === decodeURIComponent(groupSlug)) : null;
    const project = projectSlug ? group?.projects.find((p) => p.name === decodeURIComponent(projectSlug)) : null;

    return (
        <Breadcrumb className="min-w-0 w-full overflow-hidden">
            <BreadcrumbList className="min-w-0 w-full flex-nowrap overflow-hidden">
                {!groupSlug ? (
                    <BreadcrumbItem className="shrink-0">
                        <BreadcrumbPage>KIWI</BreadcrumbPage>
                    </BreadcrumbItem>
                ) : (
                    <>
                        <BreadcrumbItem className="shrink-0">
                            <BreadcrumbLink asChild>
                                <Link href="/">KIWI</Link>
                            </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator className="shrink-0" />
                        <BreadcrumbItem className="min-w-0 shrink">
                            {project ? (
                                <BreadcrumbLink asChild>
                                    <Link
                                        href={`/${encodeURIComponent(group?.name ?? groupSlug)}`}
                                        className="block max-w-full truncate"
                                        title={group?.name}
                                    >
                                        {group?.name ?? groupSlug}
                                    </Link>
                                </BreadcrumbLink>
                            ) : (
                                <BreadcrumbPage className="block max-w-full truncate" title={group?.name}>
                                    {group?.name ?? groupSlug}
                                </BreadcrumbPage>
                            )}
                        </BreadcrumbItem>
                        {project && (
                            <>
                                <BreadcrumbSeparator className="shrink-0" />
                                <BreadcrumbItem className="min-w-0 shrink">
                                    <BreadcrumbPage className="block max-w-full truncate" title={project.name}>
                                        {project.name}
                                    </BreadcrumbPage>
                                </BreadcrumbItem>
                            </>
                        )}
                    </>
                )}
            </BreadcrumbList>
        </Breadcrumb>
    );
}
