"use client";

import { useLanguage } from "@/providers/LanguageProvider";

type StateDisplayProps = {
  isLoading?: boolean;
  error?: string | null;
  isEmpty?: boolean;
  loadingMessage?: string;
  errorMessage?: string;
  emptyMessage?: string;
  emptyDescription?: string;
};

export function StateDisplay({
  isLoading,
  error,
  isEmpty,
  loadingMessage,
  errorMessage,
  emptyMessage,
  emptyDescription,
}: StateDisplayProps) {
  const { t } = useLanguage();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold">
            {loadingMessage || t("loading")}
          </h2>
          <p className="text-muted-foreground">{t("please.wait")}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-destructive">
            {errorMessage || t("error")}
          </h2>
          <p className="text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold">
            {emptyMessage || t("no.items")}
          </h2>
          {emptyDescription && (
            <p className="text-muted-foreground">{emptyDescription}</p>
          )}
        </div>
      </div>
    );
  }

  return null;
}
