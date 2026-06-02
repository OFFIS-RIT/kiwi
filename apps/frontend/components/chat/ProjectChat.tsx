"use client";

import { chatTemplates } from "@/components/chat/chat-templates";
import { ChatInput, type ChatInputHandle } from "@/components/chat/ChatInput";
import { ChatTemplateSidebar } from "@/components/chat/ChatTemplateSidebar";
import { ClarificationBlock } from "@/components/chat/ClarificationBlock";
import { shouldAutoContinue, withDefaultAutoContinue } from "@/components/chat/chat-auto-continue";
import { stripPhantomPrefix } from "@/components/chat/chat-phantom-prefix";
import { hydrateProjectChatSession, projectChatQueryKey } from "@/components/chat/project-chat-session-query";
import { UserMessageText } from "@/components/chat/UserMessageText";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSpeechSynthesis } from "@/hooks/use-speech-synthesis";
import { ApiError } from "@/lib/api/client";
import { upsertProjectChatSummary } from "@/lib/chat-summaries";
import { deleteProjectChat } from "@/lib/api/projects";
import type { ChatLibraryItem } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useProjectChatSession, type ProjectChatEntry } from "@/providers/ChatSessionsProvider";
import type { Group, ProjectChatSummary } from "@/types";
import { splitTextWithCitationFences } from "@kiwi/ai/citation";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    AlertCircle,
    Brain,
    Check,
    ChevronDown,
    Copy,
    FileText,
    Loader2,
    Mic,
    MicOff,
    RotateCcw,
    SendIcon,
    Volume2,
    VolumeX,
    X,
} from "lucide-react";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useLocale } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { MessageContent } from "./MessageContent";

const ResetChatDialog = lazy(() =>
    import("./ResetChatDialog").then((mod) => ({
        default: mod.ResetChatDialog,
    }))
);

const SILENCE_TIMEOUT_MS = 5000;
const OPTIMISTIC_CHAT_TITLE_WORDS = 5;
const OPTIMISTIC_RECENT_CHAT_LIMIT = 6;

type ProjectChatProps = {
    projectName: string;
    groupName: string;
    projectId: string;
};

type IntelligenceLevel = "default" | "high";

const intelligenceLevels: IntelligenceLevel[] = ["default", "high"];

function isMissingChatError(error: unknown) {
    return error instanceof ApiError && (error.code === "CHAT_NOT_FOUND" || error.message.includes("CHAT_NOT_FOUND"));
}

function createOptimisticChatTitle(text: string) {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const title = words.slice(0, OPTIMISTIC_CHAT_TITLE_WORDS).join(" ");

    if (!title) return "...";
    return words.length > OPTIMISTIC_CHAT_TITLE_WORDS ? `${title}...` : title;
}

function getExistingOptimisticChatTitle(chats: ProjectChatSummary[] | undefined, chatId: string) {
    return chats?.find((chat) => chat.id === chatId)?.title;
}

function upsertOptimisticChat(chats: ProjectChatSummary[] = [], chat: ProjectChatSummary, limit?: number) {
    if (chat.isPinned) {
        return chats.filter((item) => item.id !== chat.id);
    }

    return upsertProjectChatSummary(chats, chat, { limit });
}

function upsertOptimisticProjectChat(groups: Group[] | undefined, projectId: string, chat: ProjectChatSummary) {
    if (!groups) return groups;

    return groups.map((group) => ({
        ...group,
        projects: group.projects.map((project) =>
            project.id === projectId
                ? {
                      ...project,
                      recentChats: upsertOptimisticChat(project.recentChats, chat, OPTIMISTIC_RECENT_CHAT_LIMIT),
                  }
                : project
        ),
    }));
}

function getCachedChatTitle(
    groups: Group[] | undefined,
    projectId: string,
    chatId: string,
    projectChats?: ProjectChatSummary[]
) {
    const groupChatTitle = groups
        ?.flatMap((group) => group.projects)
        .find((project) => project.id === projectId)
        ?.recentChats.find((chat) => chat.id === chatId)?.title;

    return groupChatTitle ?? getExistingOptimisticChatTitle(projectChats, chatId);
}

type ClarificationState = {
    toolCallId: string;
    questions: string[];
    reason?: string;
    submitted: boolean;
    submittedAnswers?: string[];
};

type ToolPart = Extract<ChatUIMessage["parts"][number], { toolCallId: string; state: string }>;

function isToolPart(part: ChatUIMessage["parts"][number]): part is ToolPart {
    return "toolCallId" in part && "state" in part;
}

function getToolName(part: ToolPart): string {
    return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
}

/**
 * Returns the most recent tool name from the assistant's latest message,
 * ignoring the clarification tool (rendered separately). The label sticks to
 * the most recent tool – even after it has completed – so the live indicator
 * remains anchored on that step until the next tool starts, instead of
 * flickering back to a generic "thinking" label between calls.
 */
function getLiveToolName(messages: ChatUIMessage[]): string | null {
    for (let m = messages.length - 1; m >= 0; m--) {
        const message = messages[m];
        if (!message || message.role !== "assistant") continue;

        for (let p = message.parts.length - 1; p >= 0; p--) {
            const part = message.parts[p];
            if (!part || !isToolPart(part)) continue;
            const name = getToolName(part);
            if (name === "ask_clarifying_questions") continue;
            return name;
        }
        break;
    }
    return null;
}

function getMessageText(message: ChatUIMessage): string {
    return message.parts
        .filter((part): part is Extract<ChatUIMessage["parts"][number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
}

/**
 * Plain text for copy/TTS: for assistants, only text after the last
 * non-clarification tool call (i.e. the final answer); for user messages,
 * the entire text. Citation fences (`:::{...}:::`) are stripped.
 */
function getCopyableMessageText(message: ChatUIMessage): string {
    const textOnly = (raw: string) =>
        splitTextWithCitationFences(raw)
            .filter((segment) => segment.type === "text")
            .map((segment) => segment.text)
            .join("");

    if (message.role !== "assistant") {
        return message.parts
            .filter((part): part is Extract<ChatUIMessage["parts"][number], { type: "text" }> => part.type === "text")
            .map((part) => textOnly(part.text))
            .join("");
    }

    let lastToolIdx = -1;
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i];
        if (part && isToolPart(part) && getToolName(part) !== "ask_clarifying_questions") {
            lastToolIdx = i;
            break;
        }
    }

    let text = "";
    for (let i = lastToolIdx + 1; i < message.parts.length; i++) {
        const part = message.parts[i];
        if (!part || part.type !== "text") continue;
        text += textOnly(part.text);
    }
    return text;
}

const fallbackTimestamps = new WeakMap<ChatUIMessage, Date>();

function getMessageTimestamp(message: ChatUIMessage): Date {
    const createdAt = message.metadata?.createdAt;
    if (!createdAt) {
        let fallback = fallbackTimestamps.get(message);
        if (!fallback) {
            fallback = new Date();
            fallbackTimestamps.set(message, fallback);
        }
        return fallback;
    }

    const parsed = new Date(createdAt);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseClarificationOutput(output: unknown, questions: string[]): string[] | undefined {
    if (!output || typeof output !== "object") {
        return undefined;
    }

    const answersValue = (output as { answers?: unknown }).answers;
    if (Array.isArray(answersValue)) {
        const answers = answersValue.filter((value): value is string => typeof value === "string");
        return answers.length > 0 ? answers : undefined;
    }

    const messageValue = (output as { message?: unknown }).message;
    if (typeof messageValue !== "string") {
        return undefined;
    }

    const lines = messageValue
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return undefined;
    }

    return questions.map((question, index) => {
        const prefix = `${question}: `;
        const matchingLine = lines.find((line) => line.startsWith(prefix));
        if (matchingLine) {
            return matchingLine.slice(prefix.length);
        }

        const fallbackLine = lines[index] ?? "";
        const separatorIdx = fallbackLine.indexOf(": ");
        return separatorIdx >= 0 ? fallbackLine.slice(separatorIdx + 2) : fallbackLine;
    });
}

function getClarificationState(message: ChatUIMessage): ClarificationState | null {
    if (message.role !== "assistant") {
        return null;
    }

    const toolPart = message.parts.findLast(
        (part) => isToolPart(part) && part.type === "tool-ask_clarifying_questions"
    ) as ToolPart | undefined;
    if (!toolPart) {
        return null;
    }

    // Ignore terminal error states – there's nothing meaningful to render.
    if (toolPart.state === "output-error") {
        return null;
    }

    const input = "input" in toolPart ? toolPart.input : undefined;
    if (!input || typeof input !== "object") {
        return null;
    }

    const rawQuestions = (input as { questions?: unknown }).questions;
    const questions = Array.isArray(rawQuestions)
        ? rawQuestions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];

    if (questions.length === 0) {
        return null;
    }

    const rawReason = (input as { reason?: unknown }).reason;
    const submitted = toolPart.state === "output-available";

    return {
        toolCallId: toolPart.toolCallId,
        questions,
        reason: typeof rawReason === "string" ? rawReason : undefined,
        submitted,
        submittedAnswers: submitted
            ? parseClarificationOutput("output" in toolPart ? toolPart.output : undefined, questions)
            : undefined,
    };
}

function stripMarkdown(text: string): string {
    let cleaned = text;

    cleaned = cleaned.replace(/```[\s\S]*?```/g, "");
    cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
    cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    cleaned = cleaned.replace(/^#{1,6}\s+(.+)$/gm, "$1");
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
    cleaned = cleaned.replace(/__([^_]+)__/g, "$1");
    cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");
    cleaned = cleaned.replace(/_([^_]+)_/g, "$1");
    cleaned = cleaned.replace(/~~([^~]+)~~/g, "$1");
    cleaned = cleaned.replace(/^>\s+(.+)$/gm, "$1");
    cleaned = cleaned.replace(/^[-*]{3,}$/gm, "");
    cleaned = cleaned.replace(/^[\s]*[-*+]\s+(.+)$/gm, "$1");
    cleaned = cleaned.replace(/^[\s]*\d+\.\s+(.+)$/gm, "$1");
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
    cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
    return cleaned.trim();
}

export function ProjectChat({ projectName, groupName, projectId }: ProjectChatProps) {
    const queryClient = useQueryClient();
    const apiClient = useApiClient();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const chatId = searchParams.get("chatId");
    const { entry, ensureEntry, resetEntry, startNewEntry, consumeRequestedNewEntry } =
        useProjectChatSession(projectId);
    const queryKey = projectChatQueryKey(projectId, chatId);
    const previousChatIdRef = useRef<string | null>(chatId);
    const skipNextBaseSessionRef = useRef(false);

    // Hydrate once per project from the server and cache it in React Query so
    // switching back to a previously opened project is instant (cache hit) and
    // the stored Chat instance in the provider survives the trip.
    const {
        data: hydrated,
        error: hydrationError,
        isLoading: isHydrating,
    } = useQuery({
        queryKey,
        queryFn: () => hydrateProjectChatSession(apiClient, projectId, chatId),
        enabled: !entry || (!!chatId && entry.sessionId !== chatId),
        retry: false,
        staleTime: Infinity,
    });

    useEffect(() => {
        if (!chatId || !hydrationError) return;
        if (isMissingChatError(hydrationError)) {
            startNewEntry({
                sessionId: uuidv4(),
                initialMessages: [],
                sendAutomaticallyWhen: shouldAutoContinue,
            });
            skipNextBaseSessionRef.current = true;
        } else {
            resetEntry();
        }
        window.history.replaceState(null, "", pathname);
    }, [chatId, hydrationError, pathname, resetEntry, startNewEntry]);

    useLayoutEffect(() => {
        if (chatId) return;
        const requestedEntry = consumeRequestedNewEntry();
        if (!requestedEntry) return;
        skipNextBaseSessionRef.current = true;
        startNewEntry(withDefaultAutoContinue(requestedEntry));
    }, [chatId, consumeRequestedNewEntry, startNewEntry]);

    useLayoutEffect(() => {
        const previousChatId = previousChatIdRef.current;
        previousChatIdRef.current = chatId;
        if (chatId || !previousChatId) return;
        if (skipNextBaseSessionRef.current) {
            skipNextBaseSessionRef.current = false;
            return;
        }
        startNewEntry({
            sessionId: uuidv4(),
            initialMessages: [],
            sendAutomaticallyWhen: shouldAutoContinue,
        });
    }, [chatId, startNewEntry]);

    // Create the Chat instance before paint once hydration data is available.
    // With visible-project prefetching this avoids flashing the shell skeleton
    // on normal internal project navigation.
    useLayoutEffect(() => {
        if (!hydrated || entry?.sessionId === hydrated.id) return;
        if (!chatId && entry) return;
        ensureEntry({
            sessionId: hydrated.id,
            initialMessages: hydrated.messages,
            sendAutomaticallyWhen: shouldAutoContinue,
        });
    }, [chatId, entry, ensureEntry, hydrated]);

    const handleReset = useCallback(
        async (chatId: string) => {
            try {
                await deleteProjectChat(apiClient, projectId, chatId);
            } catch (error) {
                console.error("Failed to delete conversation:", error);
            } finally {
                const nextSession = { id: uuidv4(), messages: [] };
                queryClient.setQueryData(queryKey, nextSession);
                resetEntry();
                ensureEntry({
                    sessionId: nextSession.id,
                    initialMessages: nextSession.messages,
                    sendAutomaticallyWhen: shouldAutoContinue,
                });
            }
        },
        [apiClient, ensureEntry, projectId, queryClient, queryKey, resetEntry]
    );

    if (!entry) {
        return null;
    }

    return (
        <ProjectChatSession
            projectName={projectName}
            groupName={groupName}
            projectId={projectId}
            entry={entry}
            isHydrating={isHydrating}
            onReset={handleReset}
        />
    );
}

function ProjectChatSession({
    projectName,
    projectId,
    entry,
    isHydrating,
    onReset,
}: ProjectChatProps & {
    entry: ProjectChatEntry;
    isHydrating: boolean;
    onReset: (chatId: string) => Promise<void>;
}) {
    const t = useAppTranslations();
    const queryClient = useQueryClient();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const chatId = searchParams.get("chatId");
    const language = useLocale();
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const isAtBottomRef = useRef(true);
    const inputRef = useRef<ChatInputHandle>(null);
    const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [speechSupported, setSpeechSupported] = useState(false);
    const recognitionRef = useRef<SpeechRecognition | null>(null);
    const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [interimTranscript, setInterimTranscript] = useState("");
    const [isTemplateSidebarOpen, setIsTemplateSidebarOpen] = useState(false);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const {
        setStreamError,
        setCurrentStep,
        setIsGenerating,
        setHasUnreadUpdate,
        getNewChatDraft,
        setNewChatDraft,
        clearNewChatDraft,
    } = useProjectChatSession(projectId);
    const currentStep = entry.currentStep;
    const streamError = entry.streamError;

    const {
        isSupported: ttsSupported,
        speakingMessageId,
        speak: speakText,
        stop: stopSpeaking,
    } = useSpeechSynthesis(language);
    const [inputValue, setInputValue] = useState("");
    const [intelligenceLevel, setIntelligenceLevel] = useState<IntelligenceLevel>("default");

    const { messages, sendMessage, status, addToolOutput } = useChat<ChatUIMessage>({
        chat: entry.chat,
    });

    const isAssistantTyping = status === "submitted" || status === "streaming";
    const displayedMessages = useMemo(() => {
        const visible = messages.filter((message) => message.role !== "system");
        return stripPhantomPrefix(visible);
    }, [messages]);
    const isEmptyChat = !isHydrating && displayedMessages.length === 0;
    const pendingClarification = useMemo(
        () =>
            displayedMessages
                .map(getClarificationState)
                .find((state): state is ClarificationState => !!state && !state.submitted) ?? null,
        [displayedMessages]
    );

    const liveToolName = useMemo(
        () => (isAssistantTyping ? getLiveToolName(displayedMessages) : null),
        [displayedMessages, isAssistantTyping]
    );
    const liveStepLabel = useMemo(() => {
        if (liveToolName) return t(`step.${liveToolName}`);
        if (currentStep) return t(`step.${currentStep}`);
        return t("worked.live");
    }, [liveToolName, currentStep, t]);

    useEffect(() => {
        stopSpeaking();
    }, [stopSpeaking, entry.sessionId]);

    useEffect(() => {
        if (!chatId && displayedMessages.length === 0) {
            setInputValue(getNewChatDraft());
        } else {
            setInputValue("");
        }
    }, [chatId, displayedMessages.length, entry.sessionId, getNewChatDraft]);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const handleScroll = () => {
            const threshold = 64;
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            const atBottom = distanceFromBottom <= threshold;
            isAtBottomRef.current = atBottom;
            setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom));
        };

        container.addEventListener("scroll", handleScroll, { passive: true });
        return () => container.removeEventListener("scroll", handleScroll);
    }, []);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        messagesEndRef.current?.scrollIntoView({ behavior });
        isAtBottomRef.current = true;
        setIsAtBottom(true);
    }, []);

    // Each time a different chat is opened, jump to the bottom without animation.
    useEffect(() => {
        scrollToBottom("instant");
    }, [entry.sessionId, scrollToBottom]);

    useEffect(() => {
        if (!isAtBottomRef.current) return;
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }, [displayedMessages, status]);

    useEffect(() => {
        if (status === "ready") {
            setCurrentStep(null);
        }
    }, [status, setCurrentStep]);

    useEffect(() => {
        setIsGenerating(isAssistantTyping);
    }, [isAssistantTyping, setIsGenerating]);

    useEffect(() => {
        if (!isAssistantTyping && chatId === entry.sessionId) {
            setHasUnreadUpdate(entry.sessionId, false);
        }
    }, [chatId, entry.sessionId, isAssistantTyping, setHasUnreadUpdate]);

    useEffect(() => {
        inputRef.current?.focus();
    }, [projectName]);

    useEffect(() => {
        if (pendingClarification || isRecording) return;
        inputRef.current?.focus();
    }, [entry.sessionId, isRecording, pendingClarification]);

    const resetSilenceTimeout = useCallback(() => {
        if (silenceTimeoutRef.current) {
            clearTimeout(silenceTimeoutRef.current);
        }
        silenceTimeoutRef.current = setTimeout(() => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
            }
        }, SILENCE_TIMEOUT_MS);
    }, []);

    const clearSilenceTimeout = useCallback(() => {
        if (silenceTimeoutRef.current) {
            clearTimeout(silenceTimeoutRef.current);
            silenceTimeoutRef.current = null;
        }
    }, []);

    useEffect(() => {
        const SpeechRecognitionAPI =
            typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

        if (SpeechRecognitionAPI) {
            setSpeechSupported(true);
            const recognition = new SpeechRecognitionAPI();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = language === "de" ? "de-DE" : "en-US";

            recognition.onresult = (event: SpeechRecognitionEvent) => {
                resetSilenceTimeout();

                let finalTranscript = "";
                let currentInterim = "";

                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript;
                    if (event.results[i].isFinal) {
                        finalTranscript += transcript;
                    } else {
                        currentInterim += transcript;
                    }
                }

                setInterimTranscript(currentInterim);

                if (finalTranscript) {
                    // Go through the editor's append API so file-mention atom
                    // nodes are preserved — `setInputValue` would round-trip
                    // through the value-sync effect and re-parse the doc as
                    // plain text, destroying any badges.
                    inputRef.current?.appendText(finalTranscript, { withSpace: true });
                    setInterimTranscript("");
                }
            };

            recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
                console.error("Speech recognition error:", event.error);
                clearSilenceTimeout();
                setInterimTranscript("");
                setIsRecording(false);
            };

            recognition.onend = () => {
                clearSilenceTimeout();
                setInterimTranscript("");
                setIsRecording(false);
            };

            recognitionRef.current = recognition;
        }

        return () => {
            clearSilenceTimeout();
            setInterimTranscript("");
            if (recognitionRef.current) {
                recognitionRef.current.abort();
                recognitionRef.current = null;
            }
        };
    }, [language, resetSilenceTimeout, clearSilenceTimeout]);

    const toggleRecording = useCallback(() => {
        if (!recognitionRef.current) return;

        if (isRecording) {
            clearSilenceTimeout();
            recognitionRef.current.stop();
            setIsRecording(false);
        } else {
            recognitionRef.current.start();
            setIsRecording(true);
            resetSilenceTimeout();
        }
    }, [clearSilenceTimeout, isRecording, resetSilenceTimeout]);

    const handleSendMessage = useCallback(async () => {
        const text = inputValue;
        if (!text.trim() || isRecording || pendingClarification) return;
        const isFirstMessage = displayedMessages.length === 0;
        const cachedGroups = queryClient.getQueryData<Group[]>(queryKeys.groupsWithProjects);
        const cachedProjectChats = queryClient.getQueryData<ProjectChatSummary[]>(queryKeys.projectChats(projectId));
        const cachedPinnedChats = queryClient.getQueryData<ChatLibraryItem[]>(queryKeys.pinnedChats);
        const optimisticChat = {
            id: entry.sessionId,
            title:
                getCachedChatTitle(cachedGroups, projectId, entry.sessionId, cachedProjectChats) ??
                createOptimisticChatTitle(text),
            isPinned:
                cachedGroups
                    ?.flatMap((group) => group.projects)
                    .find((project) => project.id === projectId)
                    ?.recentChats.find((chat) => chat.id === entry.sessionId)?.isPinned ??
                cachedProjectChats?.find((chat) => chat.id === entry.sessionId)?.isPinned ??
                cachedPinnedChats?.some((chat) => chat.id === entry.sessionId) ??
                false,
            updatedAt: new Date().toISOString(),
        };
        setStreamError(null);
        // Clear the input synchronously before awaiting sendMessage: the AI
        // SDK's promise only resolves once the stream is done, so leaving the
        // reset after the await leaves the original text visible for the whole
        // response.
        setInputValue("");
        clearNewChatDraft();
        queryClient.setQueryData<Group[]>(queryKeys.groupsWithProjects, (groups) =>
            upsertOptimisticProjectChat(groups, projectId, optimisticChat)
        );
        queryClient.setQueryData<ProjectChatSummary[]>(queryKeys.projectChats(projectId), (chats) =>
            upsertOptimisticChat(chats, optimisticChat)
        );
        if (isFirstMessage) {
            window.history.replaceState(null, "", `${pathname}?chatId=${encodeURIComponent(entry.sessionId)}`);
        }
        setIsGenerating(true);
        setHasUnreadUpdate(entry.sessionId, false);
        isAtBottomRef.current = true;
        setIsAtBottom(true);
        try {
            await sendMessage({ text }, { body: { deep: intelligenceLevel === "high" } });
        } finally {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects }),
                queryClient.invalidateQueries({ queryKey: queryKeys.projectChats(projectId) }),
            ]);
        }
    }, [
        clearNewChatDraft,
        displayedMessages.length,
        entry.sessionId,
        inputValue,
        intelligenceLevel,
        isRecording,
        pathname,
        pendingClarification,
        projectId,
        queryClient,
        sendMessage,
        setHasUnreadUpdate,
        setIsGenerating,
        setStreamError,
    ]);

    const handleInputChange = useCallback(
        (value: string) => {
            setInputValue(value);
            if (!chatId && displayedMessages.length === 0) {
                setNewChatDraft(value);
            }
        },
        [chatId, displayedMessages.length, setNewChatDraft]
    );

    const handleClarificationSubmit = useCallback(
        (toolCallId: string, questions: string[], answer: string) => {
            const answers = answer.split("\n").map((line) => {
                const colonIdx = line.indexOf(": ");
                return colonIdx >= 0 ? line.slice(colonIdx + 2) : line;
            });

            addToolOutput({
                tool: "ask_clarifying_questions",
                toolCallId,
                output: {
                    message: answer,
                    answers,
                    questions,
                },
            });
        },
        [addToolOutput]
    );

    const handleCopyMessage = useCallback(async (message: ChatUIMessage) => {
        try {
            const plainText = stripMarkdown(getCopyableMessageText(message));
            await navigator.clipboard.writeText(plainText);
            setCopiedMessageId(message.id);
            setTimeout(() => setCopiedMessageId(null), 2000);
        } catch (error) {
            console.error("Failed to copy message:", error);
        }
    }, []);

    const handlePlayMessage = useCallback(
        (message: ChatUIMessage) => {
            const plainText = stripMarkdown(getCopyableMessageText(message));

            if (speakingMessageId === message.id) {
                stopSpeaking();
            } else {
                speakText(plainText, message.id);
            }
        },
        [speakingMessageId, speakText, stopSpeaking]
    );

    const handleInsertTemplate = useCallback((templateBody: string) => {
        inputRef.current?.setText(templateBody);
        inputRef.current?.focus();
    }, []);

    const inputControls = (
        <div className="flex flex-col gap-2">
            <ChatInput
                ref={inputRef}
                value={inputValue}
                onChange={handleInputChange}
                onSubmit={() => void handleSendMessage()}
                disabled={isRecording || !!pendingClarification}
                placeholder={t("ask.question")}
                projectId={projectId}
                autoFocus={!pendingClarification && !isRecording}
                interimTranscript={isRecording ? interimTranscript : undefined}
                editorClassName={
                    isEmptyChat
                        ? "min-h-[calc(2lh+2rem)] rounded-xl border-0 bg-transparent px-4 py-4 shadow-none focus-visible:ring-0"
                        : "min-h-[calc(2lh+1rem)] rounded-xl border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
                }
            />
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setIsResetDialogOpen(true)}
                        disabled={isAssistantTyping || displayedMessages.length === 0}
                        aria-label={t("reset.chat")}
                        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                    >
                        <RotateCcw className="h-4 w-4" />
                    </Button>

                    <Button
                        variant={isTemplateSidebarOpen ? "secondary" : "ghost"}
                        size="icon"
                        onClick={() => setIsTemplateSidebarOpen((previous) => !previous)}
                        aria-pressed={isTemplateSidebarOpen}
                        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={t("chat.templates")}
                    >
                        <FileText className="h-4 w-4" />
                    </Button>
                </div>
                <div className="flex items-center gap-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={isAssistantTyping}
                            aria-label={t("deep.mode")}
                            className="h-9 shrink-0 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground"
                        >
                            <Brain className="h-4 w-4" />
                            <span className="text-sm">{t(`deep.mode.${intelligenceLevel}`)}</span>
                            <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-44 rounded-xl p-1.5">
                        <DropdownMenuLabel className="px-2.5 py-1.5 text-sm font-normal text-muted-foreground">
                            {t("deep.mode.intelligence")}
                        </DropdownMenuLabel>
                        {intelligenceLevels.map((level) => (
                            <DropdownMenuItem
                                key={level}
                                onClick={() => setIntelligenceLevel(level)}
                                className="min-h-9 rounded-lg px-2.5 text-sm"
                            >
                                <span>{t(`deep.mode.${level}`)}</span>
                                {intelligenceLevel === level && <Check className="ml-auto h-4 w-4" />}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                {speechSupported && (
                    <Button
                        size="icon"
                        variant={isRecording ? "destructive" : "outline"}
                        onClick={toggleRecording}
                        aria-label={isRecording ? t("stop.recording") : t("start.recording")}
                        disabled={!!pendingClarification}
                        className={isEmptyChat ? "h-10 w-10 shrink-0" : undefined}
                    >
                        {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    </Button>
                )}
                <Button
                    size="icon"
                    onClick={() => void handleSendMessage()}
                    disabled={!inputValue.trim() || isAssistantTyping || isRecording || !!pendingClarification}
                    className={isEmptyChat ? "h-10 w-10 shrink-0" : undefined}
                >
                    <SendIcon className="h-4 w-4" />
                    <span className="sr-only">{t("send.message")}</span>
                </Button>
                </div>
            </div>
        </div>
    );

    return (
        <div className="flex h-[calc(100vh-6rem)] min-w-0 flex-col overflow-hidden">
            <div className={`flex flex-1 overflow-hidden ${isTemplateSidebarOpen ? "lg:gap-4" : ""}`}>
                <Card
                    className="flex min-w-0 flex-1 flex-col gap-0 overflow-hidden border-0 bg-transparent py-0 shadow-none"
                >
                    <div
                        ref={scrollContainerRef}
                        className="flex-1 overflow-y-auto"
                        style={{ scrollbarWidth: "thin" }}
                    >
                        <div className="mx-auto h-full w-full max-w-4xl space-y-4 px-4 pt-4">
                            {isEmptyChat && (
                                <div className="flex min-h-full items-center justify-center pb-20">
                                    <div className="w-full max-w-4xl">
                                        <h2 className="mb-8 text-center text-3xl font-semibold tracking-normal text-foreground">
                                            {t("empty.chat.prompt", { projectName })}
                                        </h2>
                                        <div className="rounded-2xl border bg-card p-2 shadow-sm">{inputControls}</div>
                                    </div>
                                </div>
                            )}

                            {!isHydrating &&
                                displayedMessages.map((message, index) => {
                                    const clarification = getClarificationState(message);
                                    const timestamp = getMessageTimestamp(message);
                                    const isLastMessage = index === displayedMessages.length - 1;
                                    const isStreamingMessage =
                                        isAssistantTyping && isLastMessage && message.role === "assistant";

                                    return (
                                        <div
                                            key={message.id}
                                            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                                        >
                                            <div
                                                className={`group ${
                                                    message.role === "user" ? "max-w-[80%]" : "w-full"
                                                }`}
                                            >
                                                <div>
                                                    <div
                                                        className={
                                                            message.role === "user"
                                                                ? "rounded-lg bg-[#f3f3f4] px-4 py-2 dark:bg-[#242424]"
                                                                : ""
                                                        }
                                                    >
                                                        {message.role === "assistant" ? (
                                                            <>
                                                                <MessageContent
                                                                    parts={message.parts}
                                                                    projectId={projectId}
                                                                    isStreaming={isStreamingMessage}
                                                                    durationMs={message.metadata?.durationMs}
                                                                    startedAtMs={timestamp.getTime()}
                                                                />
                                                                {clarification && (
                                                                    <ClarificationBlock
                                                                        questions={clarification.questions}
                                                                        reason={clarification.reason}
                                                                        onSubmit={(answer) =>
                                                                            handleClarificationSubmit(
                                                                                clarification.toolCallId,
                                                                                clarification.questions,
                                                                                answer
                                                                            )
                                                                        }
                                                                        disabled={isAssistantTyping}
                                                                        submitted={clarification.submitted}
                                                                        submittedAnswers={
                                                                            clarification.submittedAnswers
                                                                        }
                                                                    />
                                                                )}
                                                            </>
                                                        ) : (
                                                            <UserMessageText
                                                                projectId={projectId}
                                                                text={getMessageText(message)}
                                                            />
                                                        )}
                                                    </div>
                                                    {!isStreamingMessage && (
                                                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                                                        <span>
                                                            {timestamp.toLocaleTimeString([], {
                                                                hour: "2-digit",
                                                                minute: "2-digit",
                                                            })}
                                                        </span>
                                                        {message.role === "assistant" &&
                                                            message.metadata?.consideredFileCount !== undefined && (
                                                                <>
                                                                    <span>•</span>
                                                                    <span>
                                                                        {t("files.considered", {
                                                                            count: message.metadata.consideredFileCount.toString(),
                                                                        })}
                                                                    </span>
                                                                </>
                                                            )}
                                                        {message.role === "assistant" &&
                                                            message.metadata?.usedFileCount !== undefined && (
                                                                <>
                                                                    <span>•</span>
                                                                    <span>
                                                                        {t("files.used", {
                                                                            count: message.metadata.usedFileCount.toString(),
                                                                        })}
                                                                    </span>
                                                                </>
                                                            )}
                                                        {message.role === "assistant" &&
                                                            message.metadata?.totalTokens && (
                                                                <>
                                                                    <span>•</span>
                                                                    <span>{message.metadata.totalTokens} tokens</span>
                                                                    {message.metadata.tokensPerSecond && (
                                                                        <>
                                                                            <span>•</span>
                                                                            <span>
                                                                                {message.metadata.tokensPerSecond.toFixed(
                                                                                    1
                                                                                )}{" "}
                                                                                t/s
                                                                            </span>
                                                                        </>
                                                                    )}
                                                                </>
                                                            )}
                                                        <span>•</span>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                                                            onClick={() => handleCopyMessage(message)}
                                                            aria-label={
                                                                copiedMessageId === message.id
                                                                    ? t("copied.message")
                                                                    : t("copy.message")
                                                            }
                                                        >
                                                            {copiedMessageId === message.id ? (
                                                                <Check className="h-3 w-3" />
                                                            ) : (
                                                                <Copy className="h-3 w-3" />
                                                            )}
                                                        </Button>
                                                        {ttsSupported && (
                                                            <>
                                                                <span>•</span>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                                                                    onClick={() => handlePlayMessage(message)}
                                                                    aria-label={
                                                                        speakingMessageId === message.id
                                                                            ? t("stop.speaking")
                                                                            : t("play.message")
                                                                    }
                                                                >
                                                                    {speakingMessageId === message.id ? (
                                                                        <VolumeX className="h-3 w-3" />
                                                                    ) : (
                                                                        <Volume2 className="h-3 w-3" />
                                                                    )}
                                                                </Button>
                                                            </>
                                                        )}
                                                    </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}

                            {isAssistantTyping &&
                                displayedMessages[displayedMessages.length - 1]?.role !== "assistant" && (
                                    <div className="flex justify-start">
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            <span>{liveStepLabel}</span>
                                        </div>
                                    </div>
                                )}

                            {streamError && (
                                <div className="flex justify-center">
                                    <div className="flex max-w-[80%] items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                        <div className="flex-1">
                                            <p className="font-medium">{t("error.chat.api")}</p>
                                            <p className="mt-0.5 break-words text-xs opacity-80">{streamError}</p>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 shrink-0"
                                            onClick={() => setStreamError(null)}
                                            aria-label="Dismiss error"
                                        >
                                            <X className="h-3 w-3" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            <div ref={messagesEndRef} />
                        </div>
                    </div>

                    {!isEmptyChat && (
                        <div className="relative mx-auto w-full max-w-4xl px-4 pb-4">
                            {!isAtBottom && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => scrollToBottom()}
                                    className="absolute -top-12 left-1/2 z-10 h-8 -translate-x-1/2 gap-1.5 rounded-full px-3 text-xs shadow-md"
                                >
                                    <ChevronDown className="h-3.5 w-3.5" />
                                    {t("scroll.to.bottom")}
                                </Button>
                            )}
                            <div className="rounded-2xl border bg-card p-2 shadow-sm">{inputControls}</div>
                        </div>
                    )}
                </Card>

                <ChatTemplateSidebar
                    templates={chatTemplates}
                    onInsert={handleInsertTemplate}
                    open={isTemplateSidebarOpen}
                    onOpenChange={setIsTemplateSidebarOpen}
                />
            </div>

            <Suspense fallback={null}>
                <ResetChatDialog
                    open={isResetDialogOpen}
                    onOpenChange={setIsResetDialogOpen}
                    onConfirm={() => onReset(entry.sessionId)}
                    projectName={projectName}
                />
            </Suspense>
        </div>
    );
}
