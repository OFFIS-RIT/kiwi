"use client";

import type React from "react";

import { chatTemplates } from "@/components/chat/chat-templates";
import { ChatTemplateSidebar } from "@/components/chat/ChatTemplateSidebar";
import { ClarificationBlock } from "@/components/chat/ClarificationBlock";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSpeechSynthesis } from "@/hooks/use-speech-synthesis";
import { API_BASE_URL } from "@/lib/api/client";
import { deleteProjectChat, fetchProjectChat, fetchProjectChats } from "@/lib/api/projects";
import { useLanguage } from "@/providers/LanguageProvider";
import type { ChatMessage } from "@/types/chat";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useChat } from "@ai-sdk/react";
import { Check, Copy, FileText, Loader2, Mic, MicOff, RotateCcw, SendIcon, Volume2, VolumeX } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { MessageContent } from "./MessageContent";
import { ThinkingDropdown } from "./ThinkingDropdown";

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

type ChatSessionState = {
    id: string;
    messages: ChatMessage[];
};

type ClarificationState = {
    toolCallId: string;
    questions: string[];
    reason?: string;
    submittedAnswers?: string[];
    submitted: boolean;
};

function isToolPart(
    part: ChatMessage["parts"][number]
): part is Extract<ChatMessage["parts"][number], { toolCallId: string; state: string }> {
    return "toolCallId" in part && "state" in part;
}

function getMessageText(message: ChatMessage): string {
    return message.parts
        .filter((part): part is Extract<ChatMessage["parts"][number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
}

function getMessageTimestamp(message: ChatMessage): Date {
    const createdAt = message.metadata?.createdAt;
    if (!createdAt) {
        return new Date();
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

function getClarificationState(message: ChatMessage): ClarificationState | null {
    if (message.role !== "assistant") {
        return null;
    }

    const toolPart = message.parts.find(
        (part): part is Extract<ChatMessage["parts"][number], { toolCallId: string; state: string }> =>
            isToolPart(part) && part.type === "tool-ask_clarifying_questions"
    );
    if (!toolPart) {
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
    const { t } = useLanguage();
    const [session, setSession] = useState<ChatSessionState | null>(null);
    const [isHydrating, setIsHydrating] = useState(false);

    const loadChat = useCallback(async () => {
        setIsHydrating(true);
        try {
            const chats = await fetchProjectChats(projectId);

            if (chats.length > 0) {
                const latest = await fetchProjectChat(projectId, chats[0].id);
                setSession({ id: latest.id, messages: latest.messages });
            } else {
                setSession({ id: uuidv4(), messages: [] });
            }
        } catch (error) {
            console.error("Failed to hydrate chat:", error);
            setSession({ id: uuidv4(), messages: [] });
        } finally {
            setIsHydrating(false);
        }
    }, [projectId]);

    useEffect(() => {
        void loadChat();
    }, [loadChat]);

    if (!session) {
        return (
            <div className="flex h-[calc(100vh-6rem)] items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    return (
        <ProjectChatSession
            key={session.id}
            projectName={projectName}
            groupName={groupName}
            projectId={projectId}
            initialSession={session}
            isHydrating={isHydrating}
            onReset={async (chatId) => {
                try {
                    await deleteProjectChat(projectId, chatId);
                } catch (error) {
                    console.error("Failed to delete conversation:", error);
                } finally {
                    setSession({ id: uuidv4(), messages: [] });
                }
            }}
        />
    );
}

function ProjectChatSession({
    projectName,
    groupName,
    projectId,
    initialSession,
    isHydrating,
    onReset,
}: ProjectChatProps & {
    initialSession: ChatSessionState;
    isHydrating: boolean;
    onReset: (chatId: string) => Promise<void>;
}) {
    const { t, language } = useLanguage();
    const groupDescription = `${t("from.group")} ${groupName} ${t("group")}`;
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [speechSupported, setSpeechSupported] = useState(false);
    const recognitionRef = useRef<SpeechRecognition | null>(null);
    const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [interimTranscript, setInterimTranscript] = useState("");
    const [isTemplateSidebarOpen, setIsTemplateSidebarOpen] = useState(false);
    const [currentStep, setCurrentStep] = useState<string | null>(null);

    const {
        isSupported: ttsSupported,
        speakingMessageId,
        speak: speakText,
        stop: stopSpeaking,
    } = useSpeechSynthesis(language);
    const [inputValue, setInputValue] = useState("");

    const { messages, sendMessage, status, addToolOutput } = useChat<ChatMessage>({
        id: initialSession.id,
        messages: initialSession.messages,
        transport: new DefaultChatTransport({
            api: `${API_BASE_URL}/stream/${projectId}`,
            credentials: "include",
        }),
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        onData: (part) => {
            if (part.type === "data-step") {
                const name = part.data && typeof part.data === "object" && "name" in part.data ? part.data.name : null;
                setCurrentStep(typeof name === "string" ? name : null);
            }
        },
        onError: (error) => {
            console.error("Chat stream error:", error);
        },
    });

    const isAssistantTyping = status === "submitted" || status === "streaming";
    const displayedMessages = useMemo(() => messages.filter((message) => message.role !== "system"), [messages]);
    const pendingClarification = useMemo(
        () =>
            displayedMessages
                .map(getClarificationState)
                .find((state): state is ClarificationState => !!state && !state.submitted) ?? null,
        [displayedMessages]
    );

    useEffect(() => {
        stopSpeaking();
    }, [stopSpeaking, initialSession.id]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [displayedMessages, status]);

    useEffect(() => {
        if (status === "ready") {
            setCurrentStep(null);
        }
    }, [status]);

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
                    setInputValue((previous) => (previous ? `${previous} ${finalTranscript}` : finalTranscript));
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
        if (!inputValue.trim() || isRecording || pendingClarification) return;
        await sendMessage({ text: inputValue });
        setInputValue("");
    }, [inputValue, isRecording, pendingClarification, sendMessage]);

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

    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSendMessage();
            }
        },
        [handleSendMessage]
    );

    const handleCopyMessage = useCallback(async (message: ChatMessage) => {
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
        (message: ChatMessage) => {
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
        setInputValue(templateBody);
        inputRef.current?.focus();
    }, []);

    const displayedInputValue =
        isRecording && interimTranscript
            ? inputValue
                ? `${inputValue} ${interimTranscript}`
                : interimTranscript
            : inputValue;

    const adjustTextareaHeight = useCallback(() => {
        const textarea = inputRef.current;
        if (!textarea) return;

        const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight || "0") || 24;
        const maxHeight = lineHeight * 15;

        textarea.style.height = "auto";
        const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
        textarea.style.height = `${nextHeight}px`;
        textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    }, []);

    useEffect(() => {
        adjustTextareaHeight();
    }, [adjustTextareaHeight, displayedInputValue]);

    return (
        <div className="flex h-[calc(100vh-6rem)] min-w-0 flex-col overflow-hidden">
            <div className="mb-4 min-w-0 shrink-0">
                <div className="flex min-w-0 items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 overflow-hidden">
                        <h1 className="max-w-full truncate text-2xl font-bold" title={projectName}>
                            {projectName}
                        </h1>
                        <p className="max-w-full truncate text-muted-foreground" title={groupDescription}>
                            {groupDescription}
                        </p>
                    </div>

                    <div className="flex shrink-0 items-end gap-2">
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setIsResetDialogOpen(true)}
                            disabled={isAssistantTyping}
                            aria-label={t("reset.chat")}
                            className="h-8 w-8"
                        >
                            <RotateCcw className="h-4 w-4" />
                        </Button>

                        <Button
                            variant={isTemplateSidebarOpen ? "default" : "outline"}
                            onClick={() => setIsTemplateSidebarOpen((previous) => !previous)}
                            aria-pressed={isTemplateSidebarOpen}
                            className="h-8 w-9 px-0"
                            aria-label="Vorlagen"
                        >
                            <FileText className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>

            <div className={`flex flex-1 overflow-hidden ${isTemplateSidebarOpen ? "lg:gap-4" : ""}`}>
                <Card className="flex min-w-0 flex-1 flex-col gap-0 overflow-hidden py-0">
                    <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
                        <div className="space-y-4 p-4">
                            {isHydrating && (
                                <div className="flex justify-center py-8">
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        <span>{t("loading")}</span>
                                    </div>
                                </div>
                            )}

                            {!isHydrating && displayedMessages.length === 0 && (
                                <div className="flex justify-start">
                                    <div className="flex max-w-[80%] items-start gap-3">
                                        <Avatar className="h-8 w-8">
                                            <AvatarFallback>AI</AvatarFallback>
                                        </Avatar>
                                        <div className="rounded-lg bg-muted p-3">
                                            <p>{t("welcome.message", { projectName })}</p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {!isHydrating &&
                                displayedMessages.map((message) => {
                                    const clarification = getClarificationState(message);
                                    const timestamp = getMessageTimestamp(message);

                                    return (
                                        <div
                                            key={message.id}
                                            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                                        >
                                            <div
                                                className={`group flex max-w-[80%] items-start gap-3 ${
                                                    message.role === "user" ? "flex-row-reverse" : ""
                                                }`}
                                            >
                                                <Avatar className="h-8 w-8">
                                                    {message.role === "assistant" ? (
                                                        <AvatarFallback>AI</AvatarFallback>
                                                    ) : (
                                                        <AvatarFallback>JD</AvatarFallback>
                                                    )}
                                                </Avatar>
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
                                                            <p>{getMessageText(message)}</p>
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
                                        <div className="flex max-w-[80%] items-start gap-3">
                                            <Avatar className="h-8 w-8">
                                                <AvatarFallback>AI</AvatarFallback>
                                            </Avatar>
                                            <div className="w-full min-w-[200px] rounded-lg bg-muted p-3">
                                                <div className="flex w-full items-center gap-2 text-sm text-muted-foreground">
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    <span>{currentStep ? t(`step.${currentStep}`) : t("loading")}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                            <div ref={messagesEndRef} />
                        </div>
                    </div>

                    <div className="border-t p-4">
                        <div className="flex items-center gap-2">
                            <textarea
                                ref={inputRef}
                                placeholder={t("ask.question")}
                                value={displayedInputValue}
                                onChange={(event) => setInputValue(event.target.value)}
                                onKeyDown={handleKeyDown}
                                className={`flex-1 resize-none overflow-hidden border-input min-h-10 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm ${
                                    isRecording && interimTranscript ? "text-muted-foreground" : ""
                                }`}
                                disabled={isRecording || !!pendingClarification}
                                rows={1}
                            />
                            {speechSupported && (
                                <Button
                                    size="icon"
                                    variant={isRecording ? "destructive" : "outline"}
                                    onClick={toggleRecording}
                                    aria-label={isRecording ? t("stop.recording") : t("start.recording")}
                                    disabled={!!pendingClarification}
                                >
                                    {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                                </Button>
                            )}
                            <Button
                                size="icon"
                                onClick={() => void handleSendMessage()}
                                disabled={
                                    !inputValue.trim() || isAssistantTyping || isRecording || !!pendingClarification
                                }
                            >
                                <SendIcon className="h-4 w-4" />
                                <span className="sr-only">{t("send.message")}</span>
                            </Button>
                        </div>
                    </div>
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
                    onConfirm={() => onReset(initialSession.id)}
                    projectName={projectName}
                />
            </Suspense>
        </div>
    );
}
