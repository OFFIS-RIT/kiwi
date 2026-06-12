import { DEFAULT_FONT_SIZE_ID, FONT_SIZE_IDS, FONT_SIZE_STORAGE_KEY } from "@/lib/font-sizes";
import {
    DEFAULT_THEME_PRESET_ID,
    LEGACY_THEME_PRESET_ALIASES,
    THEME_PRESET_EXCLUDED_PATH_PREFIXES,
    THEME_PRESET_IDS,
    THEME_PRESET_STORAGE_KEY,
} from "@/lib/theme-presets";
import Script from "next/script";

export function ThemePresetScript() {
    const script = `
(() => {
  const storageKey = ${JSON.stringify(THEME_PRESET_STORAGE_KEY)};
  const defaultPreset = ${JSON.stringify(DEFAULT_THEME_PRESET_ID)};
  const allowedPresets = new Set(${JSON.stringify(THEME_PRESET_IDS)});
  const legacyAliases = ${JSON.stringify(LEGACY_THEME_PRESET_ALIASES)};
  const fontSizeStorageKey = ${JSON.stringify(FONT_SIZE_STORAGE_KEY)};
  const defaultFontSize = ${JSON.stringify(DEFAULT_FONT_SIZE_ID)};
  const allowedFontSizes = new Set(${JSON.stringify(FONT_SIZE_IDS)});
  const excludedPathPrefixes = ${JSON.stringify(THEME_PRESET_EXCLUDED_PATH_PREFIXES)};
  const pathname = window.location.pathname;

  if (excludedPathPrefixes.some((pathPrefix) => pathname === pathPrefix || pathname.startsWith(pathPrefix + "/"))) {
    delete document.documentElement.dataset.themePreset;
    delete document.documentElement.dataset.fontSize;
    return;
  }

  let themePreset = defaultPreset;
  try {
    const storedThemePreset = window.localStorage.getItem(storageKey);
    if (allowedPresets.has(storedThemePreset)) {
      themePreset = storedThemePreset;
    } else if (Object.prototype.hasOwnProperty.call(legacyAliases, storedThemePreset)) {
      themePreset = legacyAliases[storedThemePreset];
      try {
        window.localStorage.setItem(storageKey, themePreset);
      } catch {
        // Best-effort legacy normalisation; the preset is already resolved.
      }
    }
  } catch {
    themePreset = defaultPreset;
  }

  document.documentElement.dataset.themePreset = themePreset;

  let fontSize = defaultFontSize;
  try {
    const storedFontSize = window.localStorage.getItem(fontSizeStorageKey);
    if (allowedFontSizes.has(storedFontSize)) {
      fontSize = storedFontSize;
    }
  } catch {
    fontSize = defaultFontSize;
  }

  document.documentElement.dataset.fontSize = fontSize;
})();
`;

    // oxlint-disable-next-line next/no-before-interactive-script-outside-document -- App Router uses the root layout instead of pages/_document.
    return <Script id="kiwi-theme-preset-script" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: script }} />;
}
