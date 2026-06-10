"use client";

import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
    SidebarSeparator,
} from "@/components/ui/sidebar";
import { useCanManageSuggestions } from "@/hooks/use-suggestion-access";
import { getLastAppPath } from "@/lib/last-app-path";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useAuth } from "@/providers/AuthProvider";
import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { useSettings } from "@/providers/SettingsProvider";
import { ArrowLeft } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

import { getVisibleSettingsCategories } from "./sections";

export function SettingsSidebar(props: ComponentProps<typeof Sidebar>) {
    const t = useAppTranslations();
    const router = useRouter();
    const { isSystemAdmin } = useAuth();
    const { authMode } = useRuntimeConfig();
    const { activeSection, setActiveSection } = useSettings();
    const { canManageSuggestions } = useCanManageSuggestions();

    const categories = getVisibleSettingsCategories({ isSystemAdmin, canManageSuggestions, authMode });

    const handleBackToApp = () => {
        router.push(getLastAppPath() ?? "/");
    };

    return (
        <Sidebar {...props}>
            <SidebarHeader>
                <div className="flex items-center justify-between p-2">
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton size="lg" onClick={() => router.push("/")}>
                                <div className="flex aspect-square size-8 items-center justify-center overflow-hidden rounded-lg">
                                    <Image
                                        src="/KIWI.jpg"
                                        alt="KIWI"
                                        width={48}
                                        height={48}
                                        unoptimized
                                        className="size-full object-cover"
                                    />
                                </div>
                                <div className="grid flex-1 text-left text-sm leading-tight">
                                    <span className="truncate font-semibold">KIWI</span>
                                    <span className="truncate text-xs">OFFIS e. V.</span>
                                </div>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </div>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton onClick={handleBackToApp}>
                            <ArrowLeft className="h-4 w-4" />
                            <span>{t("settings.back.to.app")}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
                <SidebarSeparator />
            </SidebarHeader>
            <SidebarContent>
                {categories.map((category) => (
                    <SidebarGroup key={category.id}>
                        <SidebarGroupLabel>{t(category.labelKey)}</SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                {category.sections.map((section) => {
                                    const Icon = section.icon;
                                    return (
                                        <SidebarMenuItem key={section.id}>
                                            <SidebarMenuButton
                                                isActive={section.id === activeSection}
                                                onClick={() => setActiveSection(section.id)}
                                            >
                                                <Icon className="h-4 w-4" />
                                                <span>{t(section.labelKey)}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    );
                                })}
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                ))}
            </SidebarContent>
            <SidebarRail />
        </Sidebar>
    );
}
