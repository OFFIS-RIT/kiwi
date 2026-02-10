"use client";

import { Button } from "@/components/ui/button";
import { useLanguage } from "@/providers/LanguageProvider";
import { Check, SendIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

type ClarificationBlockProps = {
  questions: string[];
  reason?: string;
  onSubmit: (answer: string) => void;
  disabled?: boolean;
  /** When true the block is read-only and shows previously submitted answers. */
  submitted?: boolean;
  /** Pre-filled answers to display in submitted state. One entry per question. */
  submittedAnswers?: string[];
};

/**
 * Renders clarification questions from the AI and collects user answers.
 * After submission the block stays visible in a read-only state.
 */
export function ClarificationBlock({
  questions,
  reason,
  onSubmit,
  disabled = false,
  submitted = false,
  submittedAnswers,
}: ClarificationBlockProps) {
  const { t } = useLanguage();
  const [answers, setAnswers] = useState<string[]>(
    () => submittedAnswers ?? new Array(questions.length).fill("")
  );
  const inputRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  const handleSubmit = useCallback(() => {
    const combined = answers
      .map((a, i) => `${questions[i]}: ${a}`)
      .filter((_, i) => answers[i].trim())
      .join("\n");
    if (combined.trim()) {
      onSubmit(combined);
    }
  }, [answers, questions, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (index < questions.length - 1) {
          inputRefs.current[index + 1]?.focus();
        } else {
          handleSubmit();
        }
      }
    },
    [questions.length, handleSubmit]
  );

  const isDisabled = disabled || submitted;

  return (
    <div className="mt-3 space-y-3">
      {reason && (
        <p className="text-sm text-muted-foreground italic">{reason}</p>
      )}
      {questions.map((question, i) => (
        <div key={`clarification-q-${i}`} className="space-y-1">
          <label className="text-sm font-medium">{question}</label>
          <textarea
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-60"
            rows={1}
            value={submitted ? (submittedAnswers?.[i] ?? "") : answers[i]}
            onChange={(e) =>
              setAnswers((prev) => {
                const next = [...prev];
                next[i] = e.target.value;
                return next;
              })
            }
            onKeyDown={(e) => handleKeyDown(e, i)}
            disabled={isDisabled}
            placeholder={t("clarification.placeholder")}
          />
        </div>
      ))}
      <div className="flex justify-end">
        {submitted ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3 w-3" />
            {t("clarification.submitted")}
          </span>
        ) : (
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={disabled || answers.every((a) => !a.trim())}
          >
            <SendIcon className="mr-1 h-3 w-3" />
            {t("send.message")}
          </Button>
        )}
      </div>
    </div>
  );
}
