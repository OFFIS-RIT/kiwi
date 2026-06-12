"use client";

import { createContext, createElement, useCallback, useContext, type ReactNode } from "react";

type FlatMessages = Record<string, string>;

const AppMessagesContext = createContext<FlatMessages>({});

export function AppMessagesProvider({ children, messages }: { children: ReactNode; messages: FlatMessages }) {
    return createElement(AppMessagesContext.Provider, { value: messages }, children);
}

function interpolate(message: string, params?: Record<string, string | number>) {
    if (!params) return message;

    return message.replace(/\{(\w+)\}/g, (match, key: string) => {
        const value = params[key];
        return value === undefined ? match : String(value);
    });
}

export function useAppTranslations() {
    const messages = useContext(AppMessagesContext);

    return useCallback(
        (key: string, params?: Record<string, string | number>) => {
            const message = messages[key];
            return interpolate(typeof message === "string" ? message : key, params);
        },
        [messages]
    );
}
