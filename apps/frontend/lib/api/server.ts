import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { transformGroupsWithGraphs } from "@/lib/api/transform";
import type { ApiGraph, ApiGroup, Group } from "@/types";
import type { SuccessfulResponse } from "@kiwi/api/types";

const API_URL = process.env.API_INTERNAL_URL;

type AuthSession = {
    user: {
        id: string;
        name: string;
        email: string;
        role: string;
    };
};

async function serverFetch<T>(endpoint: string): Promise<T> {
    const cookieStore = await cookies();
    const res = await fetch(`${API_URL}${endpoint}`, {
        headers: { cookie: cookieStore.toString() },
        cache: "no-store",
    });
    if (res.status === 401) redirect("/login");
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const json = (await res.json()) as SuccessfulResponse<T>;
    return json.data;
}

export async function fetchSession(): Promise<AuthSession | null> {
    const cookieStore = await cookies();
    const res = await fetch(`${API_URL}/auth/get-session`, {
        headers: { cookie: cookieStore.toString() },
        cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.session ?? json ?? null;
}

export async function fetchGroupsServer(): Promise<ApiGroup[]> {
    return serverFetch<ApiGroup[]>("/groups");
}

export async function fetchGraphsServer(): Promise<ApiGraph[]> {
    return serverFetch<ApiGraph[]>("/graphs");
}

export async function fetchGroupsWithProjects(): Promise<Group[]> {
    const [groups, graphs] = await Promise.all([fetchGroupsServer(), fetchGraphsServer()]);
    return transformGroupsWithGraphs(groups, graphs);
}
