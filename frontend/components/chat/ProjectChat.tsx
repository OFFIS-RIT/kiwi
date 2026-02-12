"use client";

import type React from "react";

import { chatTemplates } from "@/components/chat/chat-templates";
import { ChatTemplateSidebar } from "@/components/chat/ChatTemplateSidebar";
import { ClarificationBlock } from "@/components/chat/ClarificationBlock";
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
import {
  deleteProjectChat,
  fetchProjectChat,
  fetchProjectChats,
  queryProjectStream,
} from "@/lib/api/projects";
import { useLanguage } from "@/providers/LanguageProvider";
import type {
  ApiChatHistoryMessage,
  ApiClientToolCall,
  ApiQueryMetrics,
  ApiResponseData,
  QueryMode,
  QueryStep,
} from "@/types";
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

const SILENCE_TIMEOUT_MS = 5000;

type Message = {
  id: string;
  content: string;
  reasoning?: string;
  role: "user" | "assistant";
  timestamp: Date;
  isLoading?: boolean;
  sourceFiles?: ApiResponseData[];
  metrics?: ApiQueryMetrics;
  consideredFileCount?: number;
  usedFileCount?: number;
  /** Pending client tool call on this assistant message. */
  pendingToolCall?: ApiClientToolCall;
  /** Answers the user submitted for clarification questions (per-question). */
  submittedAnswers?: string[];
};

type ProjectChatProps = {
  projectName: string;
  groupName: string;
  projectId: string;
};

function parseToolArguments(toolArguments: string): {
  questions: string[];
  reason?: string;
} {
  const trimmedToolArguments = toolArguments.trim();
  if (!trimmedToolArguments) {
    return {
      questions: [],
      reason: undefined,
    };
  }

  try {
    const parsed = JSON.parse(trimmedToolArguments) as {
      questions?: unknown;
      reason?: unknown;
    };
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .filter(
            (question): question is string => typeof question === "string"
          )
          .map((question) => question.trim())
          .filter(Boolean)
      : [];

    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : undefined;

    return {
      questions,
      reason,
    };
  } catch {
    if (
      (trimmedToolArguments.startsWith("{") &&
        trimmedToolArguments.endsWith("}")) ||
      (trimmedToolArguments.startsWith("[") &&
        trimmedToolArguments.endsWith("]"))
    ) {
      return {
        questions: [],
        reason: undefined,
      };
    }

    return {
      questions: [trimmedToolArguments],
      reason: undefined,
    };
  }
}

type ClarificationToolCall = {
  toolCall: ApiClientToolCall;
  questions: string[];
  reason?: string;
};

function getClarificationToolCall(
  toolCall?: ApiClientToolCall | null
): ClarificationToolCall | null {
  if (!toolCall) {
    return null;
  }

  if (toolCall.tool_name !== "ask_clarifying_questions") {
    return null;
  }

  const { questions, reason } = parseToolArguments(toolCall.tool_arguments);
  if (questions.length === 0) {
    return null;
  }

  return {
    toolCall,
    questions,
    reason,
  };
}

function parseSubmittedAnswers(
  submittedMessage: string | undefined,
  questions: string[]
): string[] | undefined {
  if (!submittedMessage?.trim()) {
    return undefined;
  }

  const lines = submittedMessage
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  if (questions.length === 0) {
    return lines.map((line) => {
      const separatorIdx = line.indexOf(": ");
      return separatorIdx >= 0 ? line.slice(separatorIdx + 2) : line;
    });
  }

  const orderedAnswers = questions.map((question, index) => {
    const prefixed = `${question}: `;
    const matchingLine = lines.find((line) => line.startsWith(prefixed));
    if (matchingLine) {
      return matchingLine.slice(prefixed.length);
    }

    const fallbackLine = lines[index] ?? "";
    const separatorIdx = fallbackLine.indexOf(": ");
    return separatorIdx >= 0
      ? fallbackLine.slice(separatorIdx + 2)
      : fallbackLine;
  });

  return orderedAnswers.some((answer) => answer.trim().length > 0)
    ? orderedAnswers
    : undefined;
}

function buildToolReasoningChunk(msg: ApiChatHistoryMessage): string | null {
  if (msg.role !== "assistant_tool_call") {
    return null;
  }

  const reasoning = msg.reasoning?.trim();
  if (!reasoning) {
    return null;
  }

  const toolName = msg.tool_name?.trim() || "unknown_tool";
  return `Tool: ${toolName}\n\n${reasoning}`;
}

function hydrateMessage(
  msg: ApiChatHistoryMessage,
  latestConvId: string,
  idx: number
): Message | null {
  const timestamp = msg.created_at ? new Date(msg.created_at) : new Date();

  if (msg.role === "assistant_tool_call") {
    const toolCall: ApiClientToolCall = {
      tool_call_id: msg.tool_call_id ?? `hydrated-${latestConvId}-tool-${idx}`,
      tool_name: msg.tool_name ?? "",
      tool_arguments: msg.tool_arguments ?? "",
    };

    const clarification = getClarificationToolCall(toolCall);
    const submittedAnswers = clarification
      ? parseSubmittedAnswers(msg.tool_result?.message, clarification.questions)
      : undefined;

    if (!clarification && !msg.message.trim()) {
      return null;
    }

    return {
      id: `hydrated-${latestConvId}-${idx}`,
      content: msg.message,
      reasoning: msg.reasoning ?? undefined,
      role: "assistant",
      timestamp,
      pendingToolCall: clarification?.toolCall,
      submittedAnswers,
    };
  }

  return {
    id: `hydrated-${latestConvId}-${idx}`,
    content: msg.message,
    reasoning: msg.reasoning ?? undefined,
    role: msg.role,
    timestamp,
    metrics: msg.metrics ?? undefined,
    sourceFiles: msg.data ?? undefined,
  };
}

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

  // Conversation state (backend-managed) — use ref to avoid stale closures in callbacks
  const conversationIdRef = useRef<string | null>(null);
  const [isHydrating, setIsHydrating] = useState(false);

  // Client tool-call state
  const [pendingToolCall, setPendingToolCall] =
    useState<ApiClientToolCall | null>(null);

  // Text-to-speech for message playback
  const {
    isSupported: ttsSupported,
    speakingMessageId,
    speak: speakText,
    stop: stopSpeaking,
  } = useSpeechSynthesis(language);

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
    stopSpeaking();
    setPendingToolCall(null);
    setIsAssistantTyping(false);
    setInputValue("");
    conversationIdRef.current = null;

    let cancelled = false;

    async function hydrate() {
      setIsHydrating(true);
      try {
        const chats = await fetchProjectChats(projectId);
        if (cancelled) return;

        if (chats.length > 0) {
          // Pick the most recent conversation (first in list)
          const latestConvId = chats[0].conversation_id;
          const chatData = await fetchProjectChat(projectId, latestConvId);
          if (cancelled) return;

          conversationIdRef.current = latestConvId;

          if (chatData.messages.length > 0) {
            let lastUnsubmittedToolCall: ApiClientToolCall | null = null;
            const hydratedMessages: Message[] = [];
            let pendingToolReasoningChunks: string[] = [];

            chatData.messages.forEach((msg, idx) => {
              if (msg.role === "assistant_tool_call") {
                const toolCall: ApiClientToolCall = {
                  tool_call_id:
                    msg.tool_call_id ?? `hydrated-${latestConvId}-tool-${idx}`,
                  tool_name: msg.tool_name ?? "",
                  tool_arguments: msg.tool_arguments ?? "",
                };
                const clarification = getClarificationToolCall(toolCall);

                if (!clarification) {
                  const toolReasoningChunk = buildToolReasoningChunk(msg);
                  if (toolReasoningChunk) {
                    pendingToolReasoningChunks = [
                      ...pendingToolReasoningChunks,
                      toolReasoningChunk,
                    ];
                  }
                  return;
                }
              }

              const hydratedMessage = hydrateMessage(msg, latestConvId, idx);
              if (!hydratedMessage) {
                return;
              }

              if (
                hydratedMessage.role === "assistant" &&
                pendingToolReasoningChunks.length > 0
              ) {
                const prefixedReasoning =
                  pendingToolReasoningChunks.join("\n\n");
                hydratedMessage.reasoning = hydratedMessage.reasoning
                  ? `${prefixedReasoning}\n\n${hydratedMessage.reasoning}`
                  : prefixedReasoning;
                pendingToolReasoningChunks = [];
              }

              if (
                hydratedMessage.pendingToolCall &&
                !hydratedMessage.submittedAnswers
              ) {
                lastUnsubmittedToolCall = hydratedMessage.pendingToolCall;
              }

              hydratedMessages.push(hydratedMessage);
            });

            setMessages(hydratedMessages);
            setPendingToolCall(lastUnsubmittedToolCall);
          } else {
            setMessages([createWelcomeMessage()]);
            setPendingToolCall(null);
          }
        } else {
          // No conversations yet — show welcome message
          setMessages([createWelcomeMessage()]);
          setPendingToolCall(null);
        }
      } catch (err) {
        console.error("Failed to hydrate chat:", err);
        if (!cancelled) {
          setMessages([createWelcomeMessage()]);
          setPendingToolCall(null);
        }
      } finally {
        if (!cancelled) {
          setIsHydrating(false);
        }
      }
    }

    hydrate();

    return () => {
      cancelled = true;
    };
  }, [projectId, createWelcomeMessage, stopSpeaking]);

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

  // -------------------------------------------------------------------------
  // Shared send logic for normal prompts and tool-call follow-ups
  // -------------------------------------------------------------------------
  const sendStreamingQuery = useCallback(
    async (prompt: string, toolId?: string) => {
      const assistantMessageId = uuidv4();
      let assistantMessageCreated = false;
      let contentBuffer = "";
      let reasoningBuffer = "";
      let metricsResult: ApiQueryMetrics | undefined;
      let receivedToolCall: ApiClientToolCall | undefined;
      let receivedDone = false;

      setIsAssistantTyping(true);
      setThinkingStartTime(null);
      setStreamingReasoning("");
      setCurrentStep(null);
      thinkingStartedRef.current = false;
      setPendingToolCall(null);

      const createOrUpdateAssistantMessage = (updates: Partial<Message>) => {
        if (!assistantMessageCreated) {
          const initialMessage: Message = {
            id: assistantMessageId,
            content: contentBuffer,
            role: "assistant",
            timestamp: new Date(),
            ...updates,
          };
          setMessages((prev) => [...prev, initialMessage]);
          assistantMessageCreated = true;
        } else {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId ? { ...msg, ...updates } : msg
            )
          );
        }
      };

      try {
        await queryProjectStream(
          projectId,
          {
            prompt,
            conversation_id: conversationIdRef.current ?? undefined,
            mode: selectedMode,
            model: selectedModel.replace(" (Thinking)", ""),
            think: useThink,
            tool_id: toolId,
          },
          {
            onConversation: (data) => {
              conversationIdRef.current = data.conversation_id;
            },
            onStep: (data) => {
              setCurrentStep(data.name as QueryStep);
            },
            onReasoning: (data) => {
              if (!thinkingStartedRef.current) {
                thinkingStartedRef.current = true;
                setThinkingStartTime(Date.now());
              }
              reasoningBuffer += data.content;
              setStreamingReasoning(reasoningBuffer);
            },
            onContent: (data) => {
              contentBuffer += data.content;
              createOrUpdateAssistantMessage({
                content: contentBuffer,
                reasoning: reasoningBuffer || undefined,
              });
              setIsAssistantTyping(false);
              setCurrentStep(null);
              setThinkingStartTime(null);
              setStreamingReasoning("");
            },
            onCitation: (data) => {
              // Append [[id]] marker into the content buffer
              contentBuffer += `[[${data.id}]]`;
              if (assistantMessageCreated) {
                createOrUpdateAssistantMessage({ content: contentBuffer });
              }
            },
            onTool: (data) => {
              setCurrentStep(data.name as QueryStep);
            },
            onMetrics: (data) => {
              metricsResult = data;
              createOrUpdateAssistantMessage({ metrics: data });
            },
            onClientToolCall: (data) => {
              const clarification = getClarificationToolCall(data);
              if (clarification) {
                receivedToolCall = clarification.toolCall;
              }
            },
            onDone: (data) => {
              receivedDone = true;
              // Prefer done.reasoning as authoritative
              const finalReasoning =
                data.reasoning || reasoningBuffer || undefined;
              const resolvedToolCall = getClarificationToolCall(
                data.client_tool_call ?? receivedToolCall
              )?.toolCall;

              createOrUpdateAssistantMessage({
                content: data.message || contentBuffer,
                reasoning: finalReasoning,
                sourceFiles: data.data.length > 0 ? data.data : undefined,
                metrics: metricsResult,
                consideredFileCount: data.considered_file_count,
                usedFileCount: data.used_file_count,
                pendingToolCall: resolvedToolCall,
              });

              // If there's a pending tool call, set it in state
              if (resolvedToolCall) {
                setPendingToolCall(resolvedToolCall);
              }

              setIsAssistantTyping(false);
              setCurrentStep(null);
              setThinkingStartTime(null);
              setStreamingReasoning("");
            },
            onError: (data) => {
              console.error("SSE error event:", data.message);
              createOrUpdateAssistantMessage({
                content: data.message || t("error.chat.api"),
              });
              setIsAssistantTyping(false);
              setCurrentStep(null);
              setThinkingStartTime(null);
              setStreamingReasoning("");
            },
          },
          (error) => {
            console.error("Stream network error:", error);
            if (!receivedDone) {
              createOrUpdateAssistantMessage({
                content: contentBuffer || t("error.chat.api"),
              });
            }
            setIsAssistantTyping(false);
            setCurrentStep(null);
            setThinkingStartTime(null);
            setStreamingReasoning("");
          }
        );

        // Handle abrupt EOF without done
        if (!receivedDone && !assistantMessageCreated) {
          createOrUpdateAssistantMessage({
            content: contentBuffer || t("error.chat.api"),
          });
        }

        setIsAssistantTyping(false);
        setCurrentStep(null);
        setThinkingStartTime(null);
        setStreamingReasoning("");
      } catch (error) {
        console.error("Error in chat API:", error);
        createOrUpdateAssistantMessage({
          content: contentBuffer || t("error.chat.api"),
        });
        setIsAssistantTyping(false);
        setCurrentStep(null);
        setThinkingStartTime(null);
        setStreamingReasoning("");
      }
    },
    [projectId, selectedMode, selectedModel, useThink, t]
  );

  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || isRecording) return;

    const userMessageContent = inputValue;
    const userMessage: Message = {
      id: uuidv4(),
      content: userMessageContent,
      role: "user",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");

    await sendStreamingQuery(userMessageContent);
  }, [inputValue, isRecording, sendStreamingQuery]);

  const handleClarificationSubmit = useCallback(
    async (answer: string) => {
      if (!pendingToolCall) return;

      const toolId = pendingToolCall.tool_call_id;

      // Parse individual answers from the combined string so we can show them
      // read-only in the ClarificationBlock after submission.
      const perQuestion = answer.split("\n").map((line) => {
        const colonIdx = line.indexOf(": ");
        return colonIdx >= 0 ? line.slice(colonIdx + 2) : line;
      });

      // Keep the pendingToolCall on the message so the UI stays visible,
      // but mark it as submitted with the user's answers.
      setMessages((prev) =>
        prev.map((msg) =>
          msg.pendingToolCall?.tool_call_id === toolId
            ? { ...msg, submittedAnswers: perQuestion }
            : msg
        )
      );
      setPendingToolCall(null);

      await sendStreamingQuery(answer, toolId);
    },
    [pendingToolCall, sendStreamingQuery]
  );

  const handleResetChat = useCallback(async () => {
    // Delete conversation on backend if we have one
    if (conversationIdRef.current) {
      try {
        await deleteProjectChat(projectId, conversationIdRef.current);
      } catch (err) {
        console.error("Failed to delete conversation:", err);
      }
    }

    conversationIdRef.current = null;
    setPendingToolCall(null);
    setMessages([createWelcomeMessage()]);
  }, [createWelcomeMessage, projectId]);

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
    cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");

    // Remove links but keep text: [text](url) -> text
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

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
              {isHydrating && (
                <div className="flex justify-center py-8">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{t("loading")}</span>
                  </div>
                </div>
              )}
              {!isHydrating &&
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${
                      message.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`flex max-w-[80%] items-start gap-3 group ${
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
                                content={message.content}
                                reasoning={message.reasoning}
                                projectId={projectId}
                                sourceFiles={message.sourceFiles}
                              />
                              {message.pendingToolCall && (
                                <ClarificationBlockWrapper
                                  toolCall={message.pendingToolCall}
                                  onSubmit={handleClarificationSubmit}
                                  disabled={isAssistantTyping}
                                  submitted={!!message.submittedAnswers}
                                  submittedAnswers={message.submittedAnswers}
                                />
                              )}
                            </>
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
                              <span>
                                {(message.metrics.duration_ms / 1000).toFixed(
                                  1
                                )}
                                s
                              </span>
                            </>
                          )}
                          {message.role === "assistant" &&
                            (message.consideredFileCount !== undefined ||
                              message.usedFileCount !== undefined) && (
                              <>
                                {message.consideredFileCount !== undefined && (
                                  <>
                                    <span>•</span>
                                    <span>
                                      {t("files.considered", {
                                        count:
                                          message.consideredFileCount.toString(),
                                      })}
                                    </span>
                                  </>
                                )}
                                {message.usedFileCount !== undefined && (
                                  <>
                                    <span>•</span>
                                    <span>
                                      {t("files.used", {
                                        count: message.usedFileCount.toString(),
                                      })}
                                    </span>
                                  </>
                                )}
                              </>
                            )}
                          {message.role === "assistant" && message.metrics && (
                            <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2">
                              <span>•</span>
                              <span>{message.metrics.total_tokens} tokens</span>
                              <span>•</span>
                              <span>
                                {message.metrics.tokens_per_second.toFixed(1)}{" "}
                                t/s
                              </span>
                            </span>
                          )}
                          <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                            •
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() =>
                              handleCopyMessage(message.id, message.content)
                            }
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
                              <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                                •
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() =>
                                  handlePlayMessage(message.id, message.content)
                                }
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
                disabled={isRecording || !!pendingToolCall}
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
                  disabled={!!pendingToolCall}
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
                  !inputValue.trim() ||
                  isAssistantTyping ||
                  isRecording ||
                  !!pendingToolCall
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

// ---------------------------------------------------------------------------
// Helper component to parse tool_arguments and render ClarificationBlock
// ---------------------------------------------------------------------------

function ClarificationBlockWrapper({
  toolCall,
  onSubmit,
  disabled,
  submitted,
  submittedAnswers,
}: {
  toolCall: ApiClientToolCall;
  onSubmit: (answer: string) => void;
  disabled?: boolean;
  submitted?: boolean;
  submittedAnswers?: string[];
}) {
  const clarification = getClarificationToolCall(toolCall);
  if (!clarification) return null;

  return (
    <ClarificationBlock
      questions={clarification.questions}
      reason={clarification.reason}
      onSubmit={onSubmit}
      disabled={disabled}
      submitted={submitted}
      submittedAnswers={submittedAnswers}
    />
  );
}
