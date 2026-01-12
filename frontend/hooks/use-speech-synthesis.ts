"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Return type for the useSpeechSynthesis hook.
 */
type UseSpeechSynthesisReturn = {
  /** Whether the browser supports SpeechSynthesis */
  isSupported: boolean;
  /** Whether any message is currently being spoken */
  isSpeaking: boolean;
  /** The ID of the message currently being spoken, or null */
  speakingMessageId: string | null;
  /** Speak the given text for a specific message */
  speak: (text: string, messageId: string) => void;
  /** Stop any ongoing speech */
  stop: () => void;
};

/**
 * Hook for browser-based text-to-speech using the Web Speech API.
 * Provides play/stop controls with message tracking for UI state management.
 *
 * NOTE: Automatically cancels speech on unmount to prevent orphaned audio.
 *
 * @param language - Language code ("en" or "de"), defaults to "en"
 * @returns Object with speech state and control functions
 */
export function useSpeechSynthesis(
  language: string = "en"
): UseSpeechSynthesisReturn {
  const [isSupported, setIsSupported] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      setIsSupported(true);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speak = useCallback(
    (text: string, messageId: string) => {
      if (!isSupported || !text.trim()) {
        return;
      }

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language === "de" ? "de-DE" : "en-US";
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

      utterance.onstart = () => {
        setIsSpeaking(true);
        setSpeakingMessageId(messageId);
      };

      utterance.onend = () => {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      };

      utterance.onerror = (event) => {
        // "interrupted" is not a real error, it happens when we cancel
        if (event.error !== "interrupted") {
          console.error("SpeechSynthesis error:", event.error);
        }
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      };

      window.speechSynthesis.speak(utterance);
    },
    [language, isSupported]
  );

  const stop = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      setSpeakingMessageId(null);
    }
  }, []);

  return {
    isSupported,
    isSpeaking,
    speakingMessageId,
    speak,
    stop,
  };
}
