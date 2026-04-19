"use client";

import { API_BASE_URL } from "@/lib/api/client";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";

type SendAutomaticallyWhen = (options: { messages: UIMessage[] }) => boolean | PromiseLike<boolean>;

type Listener = () => void;

type ProjectChatEntry = {
    projectId: string;
    sessionId: string;
    chat: Chat<ChatUIMessage>;
    currentStep: string | null;
    streamError: string | null;
};

type EnsureEntryInit = {
    sessionId: string;
    initialMessages: ChatUIMessage[];
    sendAutomaticallyWhen?: SendAutomaticallyWhen;
};

type ChatSessionsStore = {
    getEntry: (projectId: string) => ProjectChatEntry | undefined;
    ensureEntry: (projectId: string, init: EnsureEntryInit) => ProjectChatEntry;
    resetEntry: (projectId: string) => void;
    setCurrentStep: (projectId: string, step: string | null) => void;
    setStreamError: (projectId: string, error: string | null) => void;
    subscribe: (projectId: string, listener: Listener) => () => void;
};

const ChatSessionsContext = createContext<ChatSessionsStore | null>(null);

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
    // Instances and listeners are kept in refs so we don't re-render the whole tree
    // when a single project's stream progresses. Subscribers per projectId opt in
    // to their own updates via useSyncExternalStore below.
    const entriesRef = useRef<Map<string, ProjectChatEntry>>(new Map());
    const listenersRef = useRef<Map<string, Set<Listener>>>(new Map());

    const notify = useCallback((projectId: string) => {
        const listeners = listenersRef.current.get(projectId);
        if (!listeners) return;
        for (const listener of listeners) listener();
    }, []);

    const updateEntry = useCallback(
        (projectId: string, patch: Partial<Omit<ProjectChatEntry, "projectId" | "chat">>) => {
            const existing = entriesRef.current.get(projectId);
            if (!existing) return;
            entriesRef.current.set(projectId, { ...existing, ...patch });
            notify(projectId);
        },
        [notify]
    );

    const store = useMemo<ChatSessionsStore>(() => {
        return {
            getEntry: (projectId) => entriesRef.current.get(projectId),
            ensureEntry: (projectId, init) => {
                const existing = entriesRef.current.get(projectId);
                if (existing) return existing;

                const chat = new Chat<ChatUIMessage>({
                    id: init.sessionId,
                    messages: init.initialMessages,
                    transport: new DefaultChatTransport({
                        api: `${API_BASE_URL}/stream/${projectId}`,
                        credentials: "include",
                    }),
                    sendAutomaticallyWhen: init.sendAutomaticallyWhen,
                    onData: (part) => {
                        if (part.type === "data-step") {
                            const name =
                                part.data && typeof part.data === "object" && "name" in part.data
                                    ? part.data.name
                                    : null;
                            updateEntry(projectId, {
                                currentStep: typeof name === "string" ? name : null,
                            });
                        }
                    },
                    onError: (error) => {
                        console.error("Chat stream error:", error);
                        updateEntry(projectId, { streamError: error.message });
                    },
                    onFinish: () => {
                        updateEntry(projectId, { currentStep: null });
                    },
                });

                const entry: ProjectChatEntry = {
                    projectId,
                    sessionId: init.sessionId,
                    chat,
                    currentStep: null,
                    streamError: null,
                };
                entriesRef.current.set(projectId, entry);
                notify(projectId);
                return entry;
            },
            resetEntry: (projectId) => {
                const entry = entriesRef.current.get(projectId);
                if (entry) {
                    void entry.chat.stop().catch(() => undefined);
                }
                entriesRef.current.delete(projectId);
                notify(projectId);
            },
            setCurrentStep: (projectId, step) => updateEntry(projectId, { currentStep: step }),
            setStreamError: (projectId, error) => updateEntry(projectId, { streamError: error }),
            subscribe: (projectId, listener) => {
                let listeners = listenersRef.current.get(projectId);
                if (!listeners) {
                    listeners = new Set();
                    listenersRef.current.set(projectId, listeners);
                }
                listeners.add(listener);
                return () => {
                    listeners?.delete(listener);
                    if (listeners?.size === 0) {
                        listenersRef.current.delete(projectId);
                    }
                };
            },
        };
    }, [notify, updateEntry]);

    return <ChatSessionsContext.Provider value={store}>{children}</ChatSessionsContext.Provider>;
}

function useChatSessionsStore(): ChatSessionsStore {
    const store = useContext(ChatSessionsContext);
    if (!store) {
        throw new Error("useChatSessionsStore must be used within ChatSessionsProvider");
    }
    return store;
}

type UseProjectChatSessionResult = {
    entry: ProjectChatEntry | undefined;
    ensureEntry: (init: EnsureEntryInit) => ProjectChatEntry;
    resetEntry: () => void;
    setStreamError: (error: string | null) => void;
    setCurrentStep: (step: string | null) => void;
};

/**
 * Subscribes to the per-project chat entry so the calling component re-renders
 * when the stored Chat instance swaps, or when the per-project UI state
 * (currentStep / streamError) changes. Chat message updates are delivered by
 * `useChat({ chat })` separately and do not need to flow through this hook.
 */
export function useProjectChatSession(projectId: string): UseProjectChatSessionResult {
    const store = useChatSessionsStore();

    const subscribe = useCallback((listener: Listener) => store.subscribe(projectId, listener), [projectId, store]);
    const getSnapshot = useCallback(() => store.getEntry(projectId), [projectId, store]);

    const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const ensureEntry = useCallback((init: EnsureEntryInit) => store.ensureEntry(projectId, init), [projectId, store]);
    const resetEntry = useCallback(() => store.resetEntry(projectId), [projectId, store]);
    const setStreamError = useCallback(
        (error: string | null) => store.setStreamError(projectId, error),
        [projectId, store]
    );
    const setCurrentStep = useCallback(
        (step: string | null) => store.setCurrentStep(projectId, step),
        [projectId, store]
    );

    return { entry, ensureEntry, resetEntry, setStreamError, setCurrentStep };
}

export type { ProjectChatEntry, EnsureEntryInit };
// Helper re-export so callers don't need to import from `ai` directly.
export type ChatMessagesListener = (messages: UIMessage[]) => void;
