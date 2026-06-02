"use client";

import { Label } from "@/components/ui/label";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { CHAT_PROFILE_PROMPT_STORAGE_KEY } from "@/lib/settings/chat-profile";

const MAX_PROFILE_PROMPT_LENGTH = 4000;

export function SettingsProfile() {
    const t = useAppTranslations();
    const [profilePrompt, setProfilePrompt] = useLocalStorage(CHAT_PROFILE_PROMPT_STORAGE_KEY, "");
    const remainingCharacters = MAX_PROFILE_PROMPT_LENGTH - profilePrompt.length;

    return (
        <div className="overflow-hidden rounded-lg border">
            <div className="space-y-2 border-b p-4">
                <Label htmlFor="chat-profile-prompt">{t("settings.profile.prompt")}</Label>
                <p className="text-sm text-muted-foreground">{t("settings.profile.prompt.description")}</p>
            </div>
            <div className="space-y-2 p-4">
                <textarea
                    id="chat-profile-prompt"
                    value={profilePrompt}
                    onChange={(event) => setProfilePrompt(event.target.value.slice(0, MAX_PROFILE_PROMPT_LENGTH))}
                    className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-40 w-full resize-y rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder={t("settings.profile.prompt.placeholder")}
                />
                <p className="text-right text-xs text-muted-foreground">
                    {t("settings.profile.prompt.remaining", { count: remainingCharacters })}
                </p>
            </div>
        </div>
    );
}
