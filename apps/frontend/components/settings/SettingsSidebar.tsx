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
} from "@/components/ui/sidebar";
import { canAccessSystemAdmin } from "@/lib/capabilities";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useAuth } from "@/providers/AuthProvider";
import { ArrowLeft, Archive, KeyRound, Palette, ShieldCheck, User, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

const SETTINGS_SECTIONS = ["appearance", "profile", "mcp-keys", "admin", "group-management", "archived"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function getSettingsSection(value: string | null): SettingsSection {
    return SETTINGS_SECTIONS.includes(value as SettingsSection) ? (value as SettingsSection) : "appearance";
}

const settingsItems = [
    {
        section: "appearance",
        icon: Palette,
        labelKey: "appearance",
    },
    {
        section: "profile",
        icon: User,
        labelKey: "settings.profile.title",
    },
    {
        section: "mcp-keys",
        icon: KeyRound,
        labelKey: "settings.mcpKeys.title",
    },
    {
        section: "archived",
        icon: Archive,
        labelKey: "settings.archived.title",
    },
] satisfies Array<{
    section: SettingsSection;
    icon: typeof Palette;
    labelKey: string;
}>;

const adminItems = [
    {
        section: "admin",
        icon: ShieldCheck,
        labelKey: "admin.user.management",
    },
    {
        section: "group-management",
        icon: Users,
        labelKey: "settings.groupManagement.title",
    },
] satisfies Array<{
    section: SettingsSection;
    icon: typeof Palette;
    labelKey: string;
}>;

export function SettingsSidebar() {
    const t = useAppTranslations();
    const searchParams = useSearchParams();
    const { isSystemAdmin } = useAuth();
    const canOpenAdmin = canAccessSystemAdmin({ isSystemAdmin });
    const activeSection = getSettingsSection(searchParams.get("section"));

    return (
        <Sidebar>
            <SidebarHeader>
                <div className="flex items-center p-2">
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton asChild size="lg">
                                <Link href="/">
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
                                </Link>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </div>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton asChild className="text-xs">
                            <Link href="/">
                                <ArrowLeft />
                                <span>{t("settings.backToApp")}</span>
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>{t("settings")}</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {settingsItems.map((item) => {
                                const Icon = item.icon;

                                return (
                                    <SidebarMenuItem key={item.section}>
                                        <SidebarMenuButton
                                            asChild
                                            isActive={activeSection === item.section}
                                            className="text-xs"
                                        >
                                            <Link href={`/settings?section=${item.section}`}>
                                                <Icon />
                                                <span>{t(item.labelKey)}</span>
                                            </Link>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                );
                            })}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                {canOpenAdmin ? (
                    <SidebarGroup>
                        <SidebarGroupLabel>{t("admin.role.admin")}</SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                {adminItems.map((item) => {
                                    const Icon = item.icon;

                                    return (
                                        <SidebarMenuItem key={item.section}>
                                            <SidebarMenuButton
                                                asChild
                                                isActive={activeSection === item.section}
                                                className="text-xs"
                                            >
                                                <Link href={`/settings?section=${item.section}`}>
                                                    <Icon />
                                                    <span>{t(item.labelKey)}</span>
                                                </Link>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    );
                                })}
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                ) : null}
            </SidebarContent>
            <SidebarRail />
        </Sidebar>
    );
}
