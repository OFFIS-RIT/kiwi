"use client";

import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
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
    isGenerating: boolean;
    hasUnreadUpdate: boolean;
};

type EnsureEntryInit = {
    sessionId: string;
    initialMessages: ChatUIMessage[];
    sendAutomaticallyWhen?: SendAutomaticallyWhen;
};
export function prepareLatestMessageRequest({
    id,
    messages,
    body,
}: {
    id: string;
    messages: UIMessage[];
    body?: Record<string, unknown>;
}) {
    const latestMessage = messages[messages.length - 1];
    if (!latestMessage) {
        throw new Error("Cannot send chat request without a latest message");
    }

    return {
        body: {
            ...(body ?? {}),
            id,
            message: latestMessage,
        },
    };
}

type ProjectChatSnapshot = {
    entry: ProjectChatEntry | undefined;
    entries: ProjectChatEntry[];
    version: number;
};

type ChatSessionsStore = {
    getSnapshot: (projectId: string) => ProjectChatSnapshot;
    ensureEntry: (projectId: string, init: EnsureEntryInit) => ProjectChatEntry;
    resetEntry: (projectId: string) => void;
    startNewEntry: (projectId: string, init: EnsureEntryInit) => ProjectChatEntry;
    requestNewEntry: (projectId: string, init: EnsureEntryInit) => void;
    consumeRequestedNewEntry: (projectId: string) => EnsureEntryInit | undefined;
    getNewChatDraft: () => string;
    setNewChatDraft: (draft: string) => void;
    clearNewChatDraft: () => void;
    setCurrentStep: (projectId: string, step: string | null) => void;
    setStreamError: (projectId: string, error: string | null) => void;
    setIsGenerating: (projectId: string, generating: boolean) => void;
    setHasUnreadUpdate: (projectId: string, sessionId: string, unread: boolean) => void;
    subscribe: (projectId: string, listener: Listener) => () => void;
};

const ChatSessionsContext = createContext<ChatSessionsStore | null>(null);

const entryKey = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
    const { apiUrl } = useRuntimeConfig();
    // Instances and listeners are kept in refs so we don't re-render the whole tree
    // when a single project's stream progresses. Subscribers per projectId opt in
    // to their own updates via useSyncExternalStore below.
    const entriesRef = useRef<Map<string, ProjectChatEntry>>(new Map());
    const activeSessionIdsRef = useRef<Map<string, string>>(new Map());
    const requestedNewEntriesRef = useRef<Map<string, EnsureEntryInit>>(new Map());
    const listenersRef = useRef<Map<string, Set<Listener>>>(new Map());
    const versionsRef = useRef<Map<string, number>>(new Map());
    const snapshotsRef = useRef<Map<string, ProjectChatSnapshot>>(new Map());
    const newChatDraftRef = useRef("");

    const notify = useCallback((projectId: string) => {
        versionsRef.current.set(projectId, (versionsRef.current.get(projectId) ?? 0) + 1);
        snapshotsRef.current.delete(projectId);
        const listeners = listenersRef.current.get(projectId);
        if (!listeners) return;
        for (const listener of listeners) listener();
    }, []);

    const updateEntry = useCallback(
        (projectId: string, sessionId: string, patch: Partial<Omit<ProjectChatEntry, "projectId" | "chat">>) => {
            const key = entryKey(projectId, sessionId);
            const existing = entriesRef.current.get(key);
            if (!existing) return;
            entriesRef.current.set(key, { ...existing, ...patch });
            notify(projectId);
        },
        [notify]
    );

    const store = useMemo<ChatSessionsStore>(() => {
        const getProjectEntries = (projectId: string) =>
            [...entriesRef.current.values()].filter((entry) => entry.projectId === projectId);

        const getActiveEntry = (projectId: string) => {
            const sessionId = activeSessionIdsRef.current.get(projectId);
            return sessionId ? entriesRef.current.get(entryKey(projectId, sessionId)) : undefined;
        };

        const setActiveEntry = (projectId: string, sessionId: string) => {
            activeSessionIdsRef.current.set(projectId, sessionId);
        };

        // Reclaim Chat instances (and their WebSocket resources) for entries that
        // are no longer needed: not the active session, not streaming, and already
        // read. Without this, background sessions accumulate without bound.
        const reclaimInertEntries = () => {
            for (const [key, entry] of entriesRef.current) {
                const isActive = activeSessionIdsRef.current.get(entry.projectId) === entry.sessionId;
                if (isActive || entry.isGenerating || entry.hasUnreadUpdate) continue;
                void entry.chat.stop().catch(() => undefined);
                entriesRef.current.delete(key);
                notify(entry.projectId);
            }
        };

        const getSnapshot = (projectId: string) => {
            const cached = snapshotsRef.current.get(projectId);
            if (cached) return cached;
            const snapshot = {
                entry: getActiveEntry(projectId),
                entries: getProjectEntries(projectId),
                version: versionsRef.current.get(projectId) ?? 0,
            };
            snapshotsRef.current.set(projectId, snapshot);
            return snapshot;
        };

        const createEntry = (projectId: string, init: EnsureEntryInit) => {
            const chat = new Chat<ChatUIMessage>({
                id: init.sessionId,
                messages: init.initialMessages,
                transport: new DefaultChatTransport({
                    api: `${apiUrl}/stream/${projectId}`,
                    credentials: "include",
                    prepareSendMessagesRequest: prepareLatestMessageRequest,
                }),
                sendAutomaticallyWhen: init.sendAutomaticallyWhen,
                onData: (part) => {
                    if (part.type === "data-step") {
                        const name =
                            part.data && typeof part.data === "object" && "name" in part.data ? part.data.name : null;
                        updateEntry(projectId, init.sessionId, {
                            currentStep: typeof name === "string" ? name : null,
                        });
                    }
                },
                onError: (error) => {
                    console.error("Chat stream error:", error);
                    updateEntry(projectId, init.sessionId, { streamError: error.message, isGenerating: false });
                },
                onFinish: () => {
                    updateEntry(projectId, init.sessionId, {
                        currentStep: null,
                        isGenerating: false,
                        hasUnreadUpdate: true,
                    });
                },
            });

            const entry: ProjectChatEntry = {
                projectId,
                sessionId: init.sessionId,
                chat,
                currentStep: null,
                streamError: null,
                isGenerating: false,
                hasUnreadUpdate: false,
            };
            entriesRef.current.set(entryKey(projectId, init.sessionId), entry);
            setActiveEntry(projectId, init.sessionId);
            reclaimInertEntries();
            notify(projectId);
            return entry;
        };

        return {
            getSnapshot,
            ensureEntry: (projectId, init) => {
                const key = entryKey(projectId, init.sessionId);
                const existing = entriesRef.current.get(key);
                if (existing) {
                    setActiveEntry(projectId, init.sessionId);
                    reclaimInertEntries();
                    notify(projectId);
                    return existing;
                }

                return createEntry(projectId, init);
            },
            resetEntry: (projectId) => {
                const entry = getActiveEntry(projectId);
                if (entry) {
                    void entry.chat.stop().catch(() => undefined);
                    entriesRef.current.delete(entryKey(projectId, entry.sessionId));
                }
                activeSessionIdsRef.current.delete(projectId);
                notify(projectId);
            },
            startNewEntry: (projectId, init) => {
                const key = entryKey(projectId, init.sessionId);
                const existing = entriesRef.current.get(key);
                if (existing) {
                    setActiveEntry(projectId, init.sessionId);
                    reclaimInertEntries();
                    notify(projectId);
                    return existing;
                }
                return createEntry(projectId, init);
            },
            requestNewEntry: (projectId, init) => {
                requestedNewEntriesRef.current.set(projectId, init);
                notify(projectId);
            },
            consumeRequestedNewEntry: (projectId) => {
                const init = requestedNewEntriesRef.current.get(projectId);
                requestedNewEntriesRef.current.delete(projectId);
                return init;
            },
            getNewChatDraft: () => newChatDraftRef.current,
            setNewChatDraft: (draft) => {
                newChatDraftRef.current = draft;
            },
            clearNewChatDraft: () => {
                newChatDraftRef.current = "";
            },
            setCurrentStep: (projectId, step) => {
                const entry = getActiveEntry(projectId);
                if (entry) updateEntry(projectId, entry.sessionId, { currentStep: step });
            },
            setStreamError: (projectId, error) => {
                const entry = getActiveEntry(projectId);
                if (entry) updateEntry(projectId, entry.sessionId, { streamError: error });
            },
            setIsGenerating: (projectId, generating) => {
                const entry = getActiveEntry(projectId);
                if (entry) updateEntry(projectId, entry.sessionId, { isGenerating: generating });
            },
            setHasUnreadUpdate: (projectId, sessionId, unread) => {
                updateEntry(projectId, sessionId, { hasUnreadUpdate: unread });
            },
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
    }, [notify, updateEntry, apiUrl]);

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
    entries: ProjectChatEntry[];
    ensureEntry: (init: EnsureEntryInit) => ProjectChatEntry;
    resetEntry: () => void;
    startNewEntry: (init: EnsureEntryInit) => ProjectChatEntry;
    requestNewEntry: (init: EnsureEntryInit) => void;
    consumeRequestedNewEntry: () => EnsureEntryInit | undefined;
    getNewChatDraft: () => string;
    setNewChatDraft: (draft: string) => void;
    clearNewChatDraft: () => void;
    setStreamError: (error: string | null) => void;
    setCurrentStep: (step: string | null) => void;
    setIsGenerating: (generating: boolean) => void;
    setHasUnreadUpdate: (sessionId: string, unread: boolean) => void;
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
    const getSnapshot = useCallback(() => store.getSnapshot(projectId), [projectId, store]);

    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const { entry, entries } = snapshot;

    const ensureEntry = useCallback((init: EnsureEntryInit) => store.ensureEntry(projectId, init), [projectId, store]);
    const resetEntry = useCallback(() => store.resetEntry(projectId), [projectId, store]);
    const startNewEntry = useCallback(
        (init: EnsureEntryInit) => store.startNewEntry(projectId, init),
        [projectId, store]
    );
    const requestNewEntry = useCallback(
        (init: EnsureEntryInit) => store.requestNewEntry(projectId, init),
        [projectId, store]
    );
    const consumeRequestedNewEntry = useCallback(
        () => store.consumeRequestedNewEntry(projectId),
        [projectId, store]
    );
    const setStreamError = useCallback(
        (error: string | null) => store.setStreamError(projectId, error),
        [projectId, store]
    );
    const setCurrentStep = useCallback(
        (step: string | null) => store.setCurrentStep(projectId, step),
        [projectId, store]
    );
    const setIsGenerating = useCallback(
        (generating: boolean) => store.setIsGenerating(projectId, generating),
        [projectId, store]
    );
    const setHasUnreadUpdate = useCallback(
        (sessionId: string, unread: boolean) => store.setHasUnreadUpdate(projectId, sessionId, unread),
        [projectId, store]
    );

    return {
        entry,
        entries,
        ensureEntry,
        resetEntry,
        startNewEntry,
        requestNewEntry,
        consumeRequestedNewEntry,
        getNewChatDraft: store.getNewChatDraft,
        setNewChatDraft: store.setNewChatDraft,
        clearNewChatDraft: store.clearNewChatDraft,
        setStreamError,
        setCurrentStep,
        setIsGenerating,
        setHasUnreadUpdate,
    };
}

export type { ProjectChatEntry, EnsureEntryInit };
// Helper re-export so callers don't need to import from `ai` directly.
export type ChatMessagesListener = (messages: UIMessage[]) => void;
