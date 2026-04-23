import "@testing-library/jest-dom/vitest";
import type React from "react";
import { vi } from "vitest";

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => false,
        }),
    });
}

if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") {
    const store: Record<string, string> = {};

    Object.defineProperty(globalThis, "localStorage", {
        value: {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => {
                store[key] = value;
            },
            removeItem: (key: string) => {
                delete store[key];
            },
            clear: () => {
                Object.keys(store).forEach((key) => delete store[key]);
            },
            get length() {
                return Object.keys(store).length;
            },
            key: (index: number) => Object.keys(store)[index] ?? null,
        },
        writable: true,
    });
}

vi.mock("next/image", () => ({
    default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
        const { unoptimized: _unoptimized, ...imgProps } = props as React.ImgHTMLAttributes<HTMLImageElement> & {
            unoptimized?: boolean;
        };

        return <img {...imgProps} />;
    },
}));
