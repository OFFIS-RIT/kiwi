import { getRequestConfig } from "next-intl/server";

// Stub für Phase 1 — wird in Phase 5 mit echter Cookie-Lese-Logik ersetzt
export default getRequestConfig(async () => ({
    locale: "de",
    messages: {},
}));
