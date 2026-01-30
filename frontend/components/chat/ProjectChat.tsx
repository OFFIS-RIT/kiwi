"use client";

import type React from "react";

import { ChatTemplateSidebar } from "@/components/chat/ChatTemplateSidebar";
import { chatTemplates } from "@/components/chat/chat-templates";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSpeechSynthesis } from "@/hooks/use-speech-synthesis";
import { queryProjectStream } from "@/lib/api/projects";
import { getChatStorageKey } from "@/lib/utils";
import { useLanguage } from "@/providers/LanguageProvider";
import type { ApiChatMessage, QueryMode, QueryStep } from "@/types";
import {
  Check,
  Copy,
  FileText,
  Loader2,
  Mic,
  MicOff,
  RotateCcw,
  SendIcon,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessageContent } from "./MessageContent";
import { ThinkingDropdown } from "./ThinkingDropdown";

import { v4 as uuidv4 } from "uuid";

// Lazy load dialog for better code splitting
const ResetChatDialog = lazy(() =>
  import("./ResetChatDialog").then((mod) => ({
    default: mod.ResetChatDialog,
  }))
);

const MAX_STORED_MESSAGES = 20;
const SILENCE_TIMEOUT_MS = 5000;

type Message = {
  id: string;
  content: string;
  reasoning?: string;
  role: "user" | "assistant";
  timestamp: Date;
  isLoading?: boolean;
  sourceFiles?: { id: string; name: string; key: string }[];
  metrics?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    duration_ms: number;
    tokens_per_second: number;
  };
};

interface StoredMessage extends Omit<Message, "timestamp"> {
  timestamp: string;
}

type ProjectChatProps = {
  projectName: string;
  groupName: string;
  projectId: string;
};

export function ProjectChat({
  projectName,
  groupName,
  projectId,
}: ProjectChatProps) {
  const { t, language } = useLanguage();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isAssistantTyping, setIsAssistantTyping] = useState(false);
  const [selectedMode, setSelectedMode] = useState<QueryMode>("agentic");
  const [selectedModel, setSelectedModel] = useState("gpt-oss (Thinking)");
  const [useThink, setUseThink] = useState(true);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isTemplateSidebarOpen, setIsTemplateSidebarOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<QueryStep | null>(null);
  const [thinkingStartTime, setThinkingStartTime] = useState<number | null>(
    null
  );
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const thinkingStartedRef = useRef(false);

  // Text-to-speech for message playback
  const {
    isSupported: ttsSupported,
    speakingMessageId,
    speak: speakText,
    stop: stopSpeaking,
  } = useSpeechSynthesis(language);

  const CHAT_STORAGE_KEY = useMemo(
    () => getChatStorageKey(projectId),
    [projectId]
  );

  const createWelcomeMessage = useCallback(
    (): Message => ({
      id: uuidv4(),
      content: t("welcome.message", { projectName }),
      role: "assistant",
      timestamp: new Date(),
    }),
    [t, projectName]
  );

  useEffect(() => {
    // Stop TTS when switching projects
    stopSpeaking();

    const savedMessages = localStorage.getItem(CHAT_STORAGE_KEY);

    if (savedMessages) {
      try {
        const parsed = JSON.parse(savedMessages);
        const messagesWithDates = parsed.map((msg: StoredMessage) => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
        }));
        setMessages(messagesWithDates);
      } catch (e) {
        console.error("Error loading chat history:", e);
        setMessages([createWelcomeMessage()]);
      }
    } else {
      setMessages([createWelcomeMessage()]);
    }
    setInputValue("");
    setIsAssistantTyping(false);
  }, [projectId, CHAT_STORAGE_KEY, createWelcomeMessage, stopSpeaking]);

  useEffect(() => {
    if (messages.length > 0) {
      try {
        const messagesToSave = messages.slice(-MAX_STORED_MESSAGES);
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messagesToSave));
      } catch (e) {
        console.error("Error saving chat history:", e);
      }
    }
  }, [messages, CHAT_STORAGE_KEY]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [projectName]);

  useEffect(() => {
    if (!isAssistantTyping && messages.length > 1) {
      inputRef.current?.focus();
    }
  }, [isAssistantTyping, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Helper to reset silence timeout
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

  // Check for Web Speech API support and initialize
  useEffect(() => {
    const SpeechRecognitionAPI =
      typeof window !== "undefined"
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;

    if (SpeechRecognitionAPI) {
      setSpeechSupported(true);
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = language === "de" ? "de-DE" : "en-US";

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        // Reset silence timeout on any speech activity
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

        // Update interim transcript for live preview
        setInterimTranscript(currentInterim);

        if (finalTranscript) {
          setInputValue((prev) =>
            prev ? `${prev} ${finalTranscript}` : finalTranscript
          );
          // Clear interim after final result is added
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
      // Start the initial silence timeout
      resetSilenceTimeout();
    }
  }, [isRecording, clearSilenceTimeout, resetSilenceTimeout]);

  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || isRecording) return;

    const userMessageContent = inputValue;
    const userMessageForState: Message = {
      id: uuidv4(),
      content: userMessageContent,
      role: "user",
      timestamp: new Date(),
    };

    const apiMessages: ApiChatMessage[] = [
      ...messages.map((msg) => ({ role: msg.role, message: msg.content })),
      { role: "user", message: userMessageContent },
    ];

    if (
      apiMessages.length === 2 &&
      apiMessages[0].role === "assistant" &&
      apiMessages[0].message === t("welcome.message", { projectName })
    ) {
      apiMessages.shift();
    }

    setMessages((prev) => [...prev, userMessageForState]);
    setInputValue("");
    setIsAssistantTyping(true);
    setThinkingStartTime(null);
    setStreamingReasoning("");
    thinkingStartedRef.current = false;

    const assistantMessageId = uuidv4();
    let assistantMessageCreated = false;
    let accumulatedSourceFiles: { id: string; name: string; key: string }[] =
      [];
    let accumulatedReasoning = "";

    try {
      await queryProjectStream(
        projectId,
        apiMessages,
        (
          streamedMessage: string,
          data: { id: string; name: string; key: string }[],
          metrics,
          step,
          reasoning
        ) => {
          if (step) {
            setCurrentStep(step);
          }

          if (
            (step === "thinking" || reasoning) &&
            !thinkingStartedRef.current
          ) {
            thinkingStartedRef.current = true;
            setThinkingStartTime(Date.now());
          }

          if (data && data.length > 0) {
            accumulatedSourceFiles = [...accumulatedSourceFiles, ...data];
          }

          if (reasoning) {
            accumulatedReasoning = reasoning;
            setStreamingReasoning(reasoning);
          }

          if (streamedMessage && !assistantMessageCreated) {
            const initialAssistantMessage: Message = {
              id: assistantMessageId,
              content: streamedMessage,
              reasoning: accumulatedReasoning || undefined,
              role: "assistant",
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, initialAssistantMessage]);
            setIsAssistantTyping(false);
            setCurrentStep(null);
            setThinkingStartTime(null);
            setStreamingReasoning("");
            assistantMessageCreated = true;
          } else if (assistantMessageCreated) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      content: streamedMessage,
                      reasoning: accumulatedReasoning || msg.reasoning,
                      ...(metrics && { metrics }),
                    }
                  : msg
              )
            );
          }
        },
        selectedMode,
        selectedModel.replace(" (Thinking)", ""),
        useThink,
        (error) => {
          console.error("Fehler beim Chat-Streaming:", error);
          const errorMessage: Message = {
            id: assistantMessageId,
            content: t("error.chat.api"),
            role: "assistant",
            timestamp: new Date(),
          };
          if (assistantMessageCreated) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId ? errorMessage : msg
              )
            );
          } else {
            setMessages((prev) => [...prev, errorMessage]);
          }
          setIsAssistantTyping(false);
          setCurrentStep(null);
          setThinkingStartTime(null);
          setStreamingReasoning("");
        },
        () => {
          if (assistantMessageCreated) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      sourceFiles:
                        accumulatedSourceFiles.length > 0
                          ? accumulatedSourceFiles
                          : undefined,
                    }
                  : msg
              )
            );
          }
          setIsAssistantTyping(false);
          setCurrentStep(null);
          setThinkingStartTime(null);
          setStreamingReasoning("");
        }
      );
    } catch (error) {
      console.error("Fehler bei der Chat-API:", error);
      const errorMessage: Message = {
        id: assistantMessageId,
        content: t("error.chat.api"),
        role: "assistant",
        timestamp: new Date(),
      };
      if (assistantMessageCreated) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId ? errorMessage : msg
          )
        );
      } else {
        setMessages((prev) => [...prev, errorMessage]);
      }
      setIsAssistantTyping(false);
      setCurrentStep(null);
      setThinkingStartTime(null);
      setStreamingReasoning("");
    }
  }, [
    inputValue,
    isRecording,
    messages,
    projectId,
    selectedMode,
    selectedModel,
    useThink,
    t,
    projectName,
  ]);

  const handleResetChat = useCallback(() => {
    setMessages([createWelcomeMessage()]);
    localStorage.removeItem(CHAT_STORAGE_KEY);
  }, [createWelcomeMessage, CHAT_STORAGE_KEY]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    },
    [handleSendMessage]
  );

  const stripMarkdownAndReferences = useCallback((text: string): string => {
    let cleaned = text;

    // Remove reference IDs in double square brackets: [[...]] and surrounding spaces
    // Remove optional space before and after the reference
    cleaned = cleaned.replace(/\s?\[\[([a-zA-Z0-9_-]+)\]\]\s?/g, "");

    // Remove code blocks (```...```)
    cleaned = cleaned.replace(/```[\s\S]*?```/g, "");

    // Remove inline code (`...`)
    cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

    // Remove images: ![alt](url)
    cleaned = cleaned.replace(/!\[([^\]]*)\]\([^\)]+\)/g, "");

    // Remove links but keep text: [text](url) -> text
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");

    // Remove headers (# ## ### etc.)
    cleaned = cleaned.replace(/^#{1,6}\s+(.+)$/gm, "$1");

    // Remove bold (**text** or __text__)
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
    cleaned = cleaned.replace(/__([^_]+)__/g, "$1");

    // Remove italic (*text* or _text_)
    cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");
    cleaned = cleaned.replace(/_([^_]+)_/g, "$1");

    // Remove strikethrough (~~text~~)
    cleaned = cleaned.replace(/~~([^~]+)~~/g, "$1");

    // Remove blockquotes (> text)
    cleaned = cleaned.replace(/^>\s+(.+)$/gm, "$1");

    // Remove horizontal rules (--- or ***)
    cleaned = cleaned.replace(/^[-*]{3,}$/gm, "");

    // Remove list markers (-, *, 1., etc.)
    cleaned = cleaned.replace(/^[\s]*[-*+]\s+(.+)$/gm, "$1");
    cleaned = cleaned.replace(/^[\s]*\d+\.\s+(.+)$/gm, "$1");

    // Clean up extra whitespace
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
    // Remove double spaces (but keep single spaces)
    cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
    cleaned = cleaned.trim();

    return cleaned;
  }, []);

  const handleCopyMessage = useCallback(
    async (messageId: string, content: string) => {
      try {
        const plainText = stripMarkdownAndReferences(content);
        await navigator.clipboard.writeText(plainText);
        setCopiedMessageId(messageId);
        setTimeout(() => {
          setCopiedMessageId(null);
        }, 2000);
      } catch (error) {
        console.error("Failed to copy message:", error);
      }
    },
    [stripMarkdownAndReferences]
  );

  const handlePlayMessage = useCallback(
    (messageId: string, content: string) => {
      if (speakingMessageId === messageId) {
        // Currently speaking this message, stop it
        stopSpeaking();
      } else {
        // Speak this message (stops any other ongoing speech)
        const plainText = stripMarkdownAndReferences(content);
        speakText(plainText, messageId);
      }
    },
    [speakingMessageId, stopSpeaking, stripMarkdownAndReferences, speakText]
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

    const lineHeight =
      parseFloat(window.getComputedStyle(textarea).lineHeight || "0") || 24;
    const maxHeight = lineHeight * 15;

    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [displayedInputValue, adjustTextareaHeight]);

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col overflow-hidden">
      <div className="mb-4 flex-shrink-0">
        <div className="flex justify-between gap-2">
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{projectName}</h1>
            <p className="text-muted-foreground">
              {t("from.group")} {groupName} {t("group")}
            </p>
          </div>

          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-0.5">
              <Label className="text-xs text-muted-foreground">Mode</Label>
              <Select
                value={selectedMode}
                onValueChange={(value: QueryMode) => setSelectedMode(value)}
              >
                <SelectTrigger className="w-28 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="agentic">Agentic</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-0.5">
              <Label className="text-xs text-muted-foreground">Model</Label>
              <Select
                value={selectedModel}
                onValueChange={(value) => {
                  setSelectedModel(value);
                  setUseThink(value.includes("Thinking"));
                }}
              >
                <SelectTrigger className="w-56 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gpt-oss (Thinking)">
                    gpt-oss (Thinking)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

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

      <div
        className={`flex flex-1 overflow-hidden ${
          isTemplateSidebarOpen ? "lg:gap-4" : ""
        }`}
      >
        <Card className="flex min-w-0 flex-1 flex-col overflow-hidden py-0 gap-0">
          <div
            className="flex-1 overflow-y-auto"
            style={{ scrollbarWidth: "thin" }}
          >
            <div className="space-y-4 p-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`flex max-w-[80%] items-start gap-3 ${
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
                          <MessageContent
                            content={message.content}
                            reasoning={message.reasoning}
                            projectId={projectId}
                            sourceFiles={message.sourceFiles}
                          />
                        ) : (
                          <p>{message.content}</p>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          {message.timestamp.toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {message.role === "assistant" && message.metrics && (
                          <>
                            <span>•</span>
                            <span>{message.metrics.total_tokens} tokens</span>
                            <span>•</span>
                            <span>
                              {(message.metrics.duration_ms / 1000).toFixed(1)}s
                            </span>
                            <span>•</span>
                            <span>
                              {message.metrics.tokens_per_second.toFixed(1)} t/s
                            </span>
                          </>
                        )}
                        {message.role === "assistant" && (
                          <>
                            <span>•</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                              onClick={() =>
                                handleCopyMessage(message.id, message.content)
                              }
                              disabled={isAssistantTyping}
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
                                <span>•</span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                                  onClick={() =>
                                    handlePlayMessage(
                                      message.id,
                                      message.content
                                    )
                                  }
                                  disabled={isAssistantTyping}
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
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {isAssistantTyping && (
                <div className="flex justify-start">
                  <div className="flex max-w-[80%] items-start gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback>AI</AvatarFallback>
                    </Avatar>
                    <div className="w-full min-w-[200px] bg-muted rounded-lg p-3">
                      {thinkingStartTime ? (
                        <ThinkingDropdown
                          reasoning={streamingReasoning}
                          isLive={true}
                          startTime={thinkingStartTime}
                        />
                      ) : (
                        <div className="flex items-center gap-2 w-full text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>
                            {currentStep
                              ? t(`step.${currentStep}`)
                              : t("loading")}
                          </span>
                        </div>
                      )}
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
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className={`flex-1 resize-none overflow-hidden border-input min-h-[2.5rem] w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm ${isRecording && interimTranscript ? "text-muted-foreground" : ""}`}
                disabled={isRecording}
                rows={1}
              />
              {speechSupported && (
                <Button
                  size="icon"
                  variant={isRecording ? "destructive" : "outline"}
                  onClick={toggleRecording}
                  aria-label={
                    isRecording ? t("stop.recording") : t("start.recording")
                  }
                >
                  {isRecording ? (
                    <MicOff className="h-4 w-4" />
                  ) : (
                    <Mic className="h-4 w-4" />
                  )}
                </Button>
              )}
              <Button
                size="icon"
                onClick={handleSendMessage}
                disabled={
                  !inputValue.trim() || isAssistantTyping || isRecording
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
          onConfirm={handleResetChat}
          projectName={projectName}
        />
      </Suspense>
    </div>
  );
}
