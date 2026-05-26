"use client";

import { chatTemplates } from "@/components/chat/chat-templates";
import { ChatInput, type ChatInputHandle } from "@/components/chat/ChatInput";
import { ChatTemplateSidebar } from "@/components/chat/ChatTemplateSidebar";
import { ClarificationBlock } from "@/components/chat/ClarificationBlock";
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
import { deleteProjectChat } from "@/lib/api/projects";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import { useProjectChatSession, type ProjectChatEntry } from "@/providers/ChatSessionsProvider";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { MessageContent } from "./MessageContent";

const ResetChatDialog = lazy(() =>
    import("./ResetChatDialog").then((mod) => ({
        default: mod.ResetChatDialog,
    }))
);

const SILENCE_TIMEOUT_MS = 5000;

type ProjectChatProps = {
    projectName: string;
    groupName: string;
    projectId: string;
};

type IntelligenceLevel = "default" | "high";

const intelligenceLevels: IntelligenceLevel[] = ["default", "high"];

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

/**
 * Auto-send trigger predicate for `useChat`.
 *
 * We only want to auto-continue when the user has JUST answered a client-side
 * clarification and the LLM has not responded to it yet. The AI SDK mutates
 * the last assistant message in place when a response streams in, appending
 * new parts after the existing ones. That means the answered clarification
 * tool part stays exactly where it was – as long as it is the very last part
 * of the message we know no follow-up response exists yet.
 *
 * Checking `.some()` (or the SDK built-in) instead fires repeatedly for every
 * completed tool result in the same message and causes an infinite loop of
 * assistant continuations.
 */
function shouldAutoContinue({ messages }: { messages: UIMessage[] }): boolean {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return false;

    const lastPart = last.parts.at(-1);
    if (!lastPart || !("type" in lastPart)) return false;
    if (lastPart.type !== "tool-ask_clarifying_questions") return false;
    if (!("state" in lastPart)) return false;
    return lastPart.state === "output-available";
}

/**
 * When `shouldAutoContinue` triggers a follow-up turn after the user has
 * answered a client-side tool call (e.g. `ask_clarifying_questions`), the AI
 * SDK seeds the streaming state of the new assistant bubble with a
 * `structuredClone` of the previous assistant message's parts (see
 * `createStreamingUIMessageState` in `ai/src/ui/process-ui-message-stream.ts`
 * together with `AbstractChat.makeRequest`). When the backend emits a fresh
 * `messageId` in its `start` event, the SDK pushes that cloned-and-renamed
 * object as a separate bubble — carrying the previous message's parts as a
 * phantom prefix.
 *
 * The SDK has no hook to reset those phantom parts, so we strip them at the
 * data boundary: only the very last message can ever carry a phantom prefix
 * (earlier messages either come from the DB or have already been finalized),
 * and only when its predecessor is an assistant message whose `finish` event
 * has already landed (`metadata` is populated).
 *
 * Result: upstream consumers (render loop, clarification detection, live tool
 * detection) see the stream the same way we persist it server-side – two
 * distinct bubbles with their own parts – without touching the SDK's internal
 * state.
 */
function stripPhantomPrefix(messages: ChatUIMessage[]): ChatUIMessage[] {
    if (messages.length < 2) return messages;

    const last = messages[messages.length - 1];
    const prev = messages[messages.length - 2];

    if (!last || !prev || last.role !== "assistant" || prev.role !== "assistant") {
        return messages;
    }

    if (!prev.metadata) return messages;

    const prefixLen = prev.parts.length;
    if (prefixLen === 0 || last.parts.length < prefixLen) return messages;

    for (let i = 0; i < prefixLen; i++) {
        if (JSON.stringify(last.parts[i]) !== JSON.stringify(prev.parts[i])) {
            return messages;
        }
    }

    const stripped: ChatUIMessage = { ...last, parts: last.parts.slice(prefixLen) };
    return [...messages.slice(0, -1), stripped];
}

function getMessageText(message: ChatUIMessage): string {
    return message.parts
        .filter((part): part is Extract<ChatUIMessage["parts"][number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
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
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const chatId = searchParams.get("chatId");
    const { entry, ensureEntry, resetEntry } = useProjectChatSession(projectId);
    const queryKey = projectChatQueryKey(projectId, chatId);

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
        router.replace(pathname);
    }, [chatId, hydrationError, pathname, router]);

    // Create the Chat instance before paint once hydration data is available.
    // With visible-project prefetching this avoids flashing the shell skeleton
    // on normal internal project navigation.
    useLayoutEffect(() => {
        if (entry || !hydrated) return;
        ensureEntry({
            sessionId: hydrated.id,
            initialMessages: hydrated.messages,
            sendAutomaticallyWhen: shouldAutoContinue,
        });
    }, [entry, ensureEntry, hydrated]);

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
    const router = useRouter();
    const pathname = usePathname();
    const language = useLocale();
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<ChatInputHandle>(null);
    const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [speechSupported, setSpeechSupported] = useState(false);
    const recognitionRef = useRef<SpeechRecognition | null>(null);
    const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [interimTranscript, setInterimTranscript] = useState("");
    const [isTemplateSidebarOpen, setIsTemplateSidebarOpen] = useState(false);
    const { setStreamError, setCurrentStep, getNewChatDraft, setNewChatDraft, clearNewChatDraft } =
        useProjectChatSession(projectId);
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
        return t("thinking.processing");
    }, [liveToolName, currentStep, t]);

    useEffect(() => {
        stopSpeaking();
    }, [stopSpeaking, entry.sessionId]);

    useEffect(() => {
        if (displayedMessages.length === 0) {
            setInputValue(getNewChatDraft());
        } else {
            setInputValue("");
        }
    }, [displayedMessages.length, entry.sessionId, getNewChatDraft]);

    // Each time a different chat is opened, jump to the bottom without animation.
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }, [entry.sessionId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }, [displayedMessages, status]);

    useEffect(() => {
        if (status === "ready") {
            setCurrentStep(null);
        }
    }, [status, setCurrentStep]);

    useEffect(() => {
        inputRef.current?.focus();
    }, [projectName]);

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
        setStreamError(null);
        // Clear the input synchronously before awaiting sendMessage: the AI
        // SDK's promise only resolves once the stream is done, so leaving the
        // reset after the await leaves the original text visible for the whole
        // response.
        setInputValue("");
        clearNewChatDraft();
        if (!displayedMessages.length) {
            router.replace(`${pathname}?chatId=${encodeURIComponent(entry.sessionId)}`);
        }
        await sendMessage({ text }, { body: { deep: intelligenceLevel === "high" } });
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupsWithProjects });
    }, [
        clearNewChatDraft,
        displayedMessages.length,
        entry.sessionId,
        inputValue,
        intelligenceLevel,
        isRecording,
        pathname,
        pendingClarification,
        queryClient,
        router,
        sendMessage,
        setStreamError,
    ]);

    const handleInputChange = useCallback(
        (value: string) => {
            setInputValue(value);
            if (displayedMessages.length === 0) {
                setNewChatDraft(value);
            }
        },
        [displayedMessages.length, setNewChatDraft]
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
            const plainText = stripMarkdown(getMessageText(message));
            await navigator.clipboard.writeText(plainText);
            setCopiedMessageId(message.id);
            setTimeout(() => setCopiedMessageId(null), 2000);
        } catch (error) {
            console.error("Failed to copy message:", error);
        }
    }, []);

    const handlePlayMessage = useCallback(
        (message: ChatUIMessage) => {
            const plainText = stripMarkdown(getMessageText(message));

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
                    <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
                        <div className="mx-auto h-full w-full max-w-4xl space-y-4 p-4">
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
                                            <div className="group max-w-[80%]">
                                                <div>
                                                    <div
                                                        className={`rounded-lg p-3 ${
                                                            message.role === "user"
                                                                ? "bg-primary text-primary-foreground"
                                                                : "bg-muted"
                                                        }`}
                                                    >
                                                        {message.role === "assistant" ? (
                                                            <>
                                                                <MessageContent
                                                                    parts={message.parts}
                                                                    projectId={projectId}
                                                                    isStreaming={isStreamingMessage}
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
                                                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                                                        <span>
                                                            {timestamp.toLocaleTimeString([], {
                                                                hour: "2-digit",
                                                                minute: "2-digit",
                                                            })}
                                                        </span>
                                                        {message.role === "assistant" &&
                                                            message.metadata?.durationMs && (
                                                                <>
                                                                    <span>•</span>
                                                                    <span>
                                                                        {(message.metadata.durationMs / 1000).toFixed(
                                                                            1
                                                                        )}
                                                                        s
                                                                    </span>
                                                                </>
                                                            )}
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
                                                                <span className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
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
                                                                </span>
                                                            )}
                                                        <span className="opacity-0 transition-opacity group-hover:opacity-100">
                                                            •
                                                        </span>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-5 px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                                                            onClick={() => handleCopyMessage(message)}
                                                            aria-label={
                                                                copiedMessageId === message.id
                                                                    ? t("copied.message")
                                                                    : t("copy.message")
                                                            }
                                                        >
                                                            {copiedMessageId === message.id ? (
                                                                <>
                                                                    <Check className="mr-1 h-3 w-3" />
                                                                    {t("copied.message")}
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <Copy className="mr-1 h-3 w-3" />
                                                                    {t("copy.message")}
                                                                </>
                                                            )}
                                                        </Button>
                                                        {ttsSupported && (
                                                            <>
                                                                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                                                                    •
                                                                </span>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    className="h-5 px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                                                                    onClick={() => handlePlayMessage(message)}
                                                                    aria-label={
                                                                        speakingMessageId === message.id
                                                                            ? t("stop.speaking")
                                                                            : t("play.message")
                                                                    }
                                                                >
                                                                    {speakingMessageId === message.id ? (
                                                                        <>
                                                                            <VolumeX className="mr-1 h-3 w-3" />
                                                                            {t("stop.speaking")}
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <Volume2 className="mr-1 h-3 w-3" />
                                                                            {t("play.message")}
                                                                        </>
                                                                    )}
                                                                </Button>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}

                            {isAssistantTyping &&
                                displayedMessages[displayedMessages.length - 1]?.role !== "assistant" && (
                                    <div className="flex justify-start">
                                        <div className="w-full max-w-[80%] min-w-[200px] rounded-lg bg-muted p-3">
                                            <div className="flex w-full items-center gap-2 text-sm text-muted-foreground">
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                <span>{liveStepLabel}</span>
                                            </div>
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
                        <div className="mx-auto w-full max-w-4xl p-4 pt-3">
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
