"use client";

import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useLanguage } from "@/providers/LanguageProvider";
import type { LucideIcon } from "lucide-react";
import { Edit } from "lucide-react";

type CardTemplateProps = {
  title: string;
  description?: string;
  badgeIcon: LucideIcon;
  badgeText: string;
  buttonText: string;
  onSelect: () => void;
  onEdit?: () => void;
  children?: React.ReactNode;
  disabled?: boolean;
};

export function CardTemplate({
  title,
  description,
  badgeIcon: BadgeIcon,
  badgeText,
  buttonText,
  onSelect,
  onEdit,
  children,
  disabled = false,
}: CardTemplateProps) {
  const { t } = useLanguage();

  return (
    <Card className="overflow-hidden transition-all hover:shadow-md">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
      <CardFooter className="flex items-center justify-between border-t bg-muted/50 px-6 py-3">
        <Badge variant="outline" className="bg-background">
          <BadgeIcon className="mr-1 h-3 w-3" />
          {badgeText}
        </Badge>
        <div className="flex gap-2">
          {onEdit && (
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Edit className="mr-1 h-3 w-3" />
              {t("edit")}
            </Button>
          )}
          <Button size="sm" onClick={onSelect} disabled={disabled}>
            {buttonText}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
