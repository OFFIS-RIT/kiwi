"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { fetchFileTypeConfigs, updateFileTypeConfig } from "@/lib/api/file-types";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { queryKeys } from "@/lib/query-keys";
import { useApiClient } from "@/providers/ApiClientProvider";
import {
    FILE_TYPE_CHUNK_SIZE_MAX,
    FILE_TYPE_CHUNK_SIZE_MIN,
    FILE_TYPE_DOCUMENT_MODE_VALUES,
    type FileTypeConfigPatchInput,
    type FileTypeConfigRecord,
    type FileTypeDocumentMode,
    type FileTypeValue,
} from "@kiwi/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RotateCcw, Save } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const DOCUMENT_MODE_LABEL_KEYS: Record<FileTypeDocumentMode, string> = {
    plain: "settings.systemConfig.fileProcessing.mode.plain",
    hybrid: "settings.systemConfig.fileProcessing.mode.hybrid",
    ocr: "settings.systemConfig.fileProcessing.mode.ocr",
};

const FILE_TYPE_META: Record<FileTypeValue, { labelKey: string; extensionsKey: string }> = {
    pdf: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.pdf",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.pdf",
    },
    doc: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.doc",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.doc",
    },
    sheet: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.sheet",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.sheet",
    },
    ppt: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.ppt",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.ppt",
    },
    image: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.image",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.image",
    },
    audio: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.audio",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.audio",
    },
    video: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.video",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.video",
    },
    html: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.html",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.html",
    },
    email: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.email",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.email",
    },
    calendar: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.calendar",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.calendar",
    },
    vcard: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.vcard",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.vcard",
    },
    json: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.json",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.json",
    },
    jsonl: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.jsonl",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.jsonl",
    },
    jsonc: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.jsonc",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.jsonc",
    },
    csv: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.csv",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.csv",
    },
    xml: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.xml",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.xml",
    },
    yaml: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.yaml",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.yaml",
    },
    toml: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.toml",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.toml",
    },
    text: {
        labelKey: "settings.systemConfig.fileProcessing.fileType.text",
        extensionsKey: "settings.systemConfig.fileProcessing.extensions.text",
    },
};

const FILE_TYPE_GROUPS = [
    {
        id: "documents",
        labelKey: "settings.systemConfig.fileProcessing.group.documents",
        fileTypes: ["pdf", "doc", "ppt", "sheet"],
    },
    {
        id: "media",
        labelKey: "settings.systemConfig.fileProcessing.group.media",
        fileTypes: ["image", "audio", "video"],
    },
    {
        id: "structured",
        labelKey: "settings.systemConfig.fileProcessing.group.structured",
        fileTypes: ["json", "jsonl", "jsonc", "csv", "xml", "yaml", "toml"],
    },
    {
        id: "communication",
        labelKey: "settings.systemConfig.fileProcessing.group.communication",
        fileTypes: ["html", "email", "calendar", "vcard"],
    },
    {
        id: "text",
        labelKey: "settings.systemConfig.fileProcessing.group.text",
        fileTypes: ["text"],
    },
] as const satisfies ReadonlyArray<{ id: string; labelKey: string; fileTypes: readonly FileTypeValue[] }>;

type SaveFileTypeConfigInput = {
    fileType: FileTypeValue;
    input: FileTypeConfigPatchInput;
};

type FileTypeConfigDraft = {
    chunkSizeValue: string;
    documentModeValue: FileTypeDocumentMode | "";
};

type FileTypeConfigDrafts = Partial<Record<FileTypeValue, FileTypeConfigDraft>>;

class SaveFileTypeConfigError extends Error {
    fileType: FileTypeValue;
    remainingFileTypes: FileTypeValue[];
    source: unknown;

    constructor(fileType: FileTypeValue, source: unknown, remainingFileTypes: FileTypeValue[]) {
        super("Failed to save file type configuration");
        this.fileType = fileType;
        this.remainingFileTypes = remainingFileTypes;
        this.source = source;
    }
}

function isDocumentMode(value: string): value is FileTypeDocumentMode {
    return FILE_TYPE_DOCUMENT_MODE_VALUES.includes(value as FileTypeDocumentMode);
}

function getChunkSizeError(value: string): "required" | "integer" | "min" | "max" | null {
    const trimmed = value.trim();
    if (trimmed === "") {
        return "required";
    }

    if (!/^\d+$/u.test(trimmed)) {
        return "integer";
    }

    const numberValue = Number(trimmed);
    if (numberValue < FILE_TYPE_CHUNK_SIZE_MIN) {
        return "min";
    }

    if (numberValue > FILE_TYPE_CHUNK_SIZE_MAX) {
        return "max";
    }

    return null;
}

function chunkSizeErrorMessage(
    error: NonNullable<ReturnType<typeof getChunkSizeError>>,
    t: ReturnType<typeof useAppTranslations>
) {
    switch (error) {
        case "required":
            return t("settings.systemConfig.fileProcessing.chunkSize.error.required");
        case "integer":
            return t("settings.systemConfig.fileProcessing.chunkSize.error.integer");
        case "min":
            return t("settings.systemConfig.fileProcessing.chunkSize.error.min", { min: FILE_TYPE_CHUNK_SIZE_MIN });
        case "max":
            return t("settings.systemConfig.fileProcessing.chunkSize.error.max", { max: FILE_TYPE_CHUNK_SIZE_MAX });
    }
}

function apiErrorMessage(error: unknown, t: ReturnType<typeof useAppTranslations>) {
    if (error instanceof ApiError) {
        switch (error.code) {
            case "UNAUTHORIZED":
                return t("settings.systemConfig.fileProcessing.error.unauthorized");
            case "FORBIDDEN":
                return t("settings.systemConfig.fileProcessing.error.forbidden");
            case "FILE_TYPE_NOT_FOUND":
                return t("settings.systemConfig.fileProcessing.error.notFound");
            case "INVALID_FILE_TYPE_CONFIG":
                return t("settings.systemConfig.fileProcessing.error.invalid");
            case "NO_CHANGES":
                return t("settings.systemConfig.fileProcessing.error.noChanges");
        }
    }

    return t("settings.systemConfig.fileProcessing.error.generic");
}

function saveAllErrorMessage(error: unknown, t: ReturnType<typeof useAppTranslations>) {
    if (error instanceof SaveFileTypeConfigError) {
        return t("settings.systemConfig.fileProcessing.error.forType", {
            type: fileTypeLabel(error.fileType, t),
            message: apiErrorMessage(error.source, t),
        });
    }

    return apiErrorMessage(error, t);
}

function fileTypeLabel(fileType: FileTypeValue, t: ReturnType<typeof useAppTranslations>) {
    return t(FILE_TYPE_META[fileType].labelKey);
}

function draftFromRecord(record: FileTypeConfigRecord): FileTypeConfigDraft {
    return {
        chunkSizeValue: String(record.chunk_size ?? ""),
        documentModeValue: record.document_mode ?? "",
    };
}

function draftForRecord(drafts: FileTypeConfigDrafts, record: FileTypeConfigRecord): FileTypeConfigDraft {
    return drafts[record.file_type] ?? draftFromRecord(record);
}

function draftsFromRecords(records: FileTypeConfigRecord[]): FileTypeConfigDrafts {
    return Object.fromEntries(records.map((record) => [record.file_type, draftFromRecord(record)]));
}

function recordsSignature(records: FileTypeConfigRecord[] | undefined) {
    return (
        records
            ?.map((record) => `${record.file_type}:${record.chunk_size ?? ""}:${record.document_mode ?? ""}`)
            .join("|") ?? ""
    );
}

function buildPatchInput(
    record: FileTypeConfigRecord,
    chunkSizeValue: string,
    documentModeValue: FileTypeDocumentMode | ""
): FileTypeConfigPatchInput {
    const input: FileTypeConfigPatchInput = {};

    if (record.chunk_size_editable) {
        const trimmedChunkSize = chunkSizeValue.trim();
        if (getChunkSizeError(trimmedChunkSize) === null) {
            const nextChunkSize = Number(trimmedChunkSize);

            if (nextChunkSize !== record.chunk_size) {
                input.chunk_size = nextChunkSize;
            }
        }
    }

    if (
        record.document_mode_editable &&
        isDocumentMode(documentModeValue) &&
        documentModeValue !== record.document_mode
    ) {
        input.document_mode = documentModeValue;
    }

    return input;
}

function isPatchEmpty(input: FileTypeConfigPatchInput) {
    return input.chunk_size === undefined && input.document_mode === undefined;
}

function changedConfigsForRecords(
    records: FileTypeConfigRecord[],
    drafts: FileTypeConfigDrafts
): SaveFileTypeConfigInput[] {
    return records.flatMap((record) => {
        const draft = draftForRecord(drafts, record);
        const input = buildPatchInput(record, draft.chunkSizeValue, draft.documentModeValue);
        return isPatchEmpty(input) ? [] : [{ fileType: record.file_type, input }];
    });
}

function hasValidationErrors(records: FileTypeConfigRecord[], drafts: FileTypeConfigDrafts) {
    return records.some((record) => {
        const draft = draftForRecord(drafts, record);
        return record.chunk_size_editable && getChunkSizeError(draft.chunkSizeValue) !== null;
    });
}

function FileTypeConfigRow({
    record,
    draft,
    isDirty,
    isSaving,
    onDraftChange,
}: {
    record: FileTypeConfigRecord;
    draft: FileTypeConfigDraft;
    isDirty: boolean;
    isSaving: boolean;
    onDraftChange: (fileType: FileTypeValue, draft: Partial<FileTypeConfigDraft>) => void;
}) {
    const t = useAppTranslations();
    const label = fileTypeLabel(record.file_type, t);
    const chunkSizeError = record.chunk_size_editable ? getChunkSizeError(draft.chunkSizeValue) : null;

    return (
        <div
            data-file-type={record.file_type}
            className="relative grid gap-4 px-4 py-4 md:grid-cols-[minmax(220px,1.1fr)_minmax(360px,2fr)] md:items-start"
        >
            {isDirty ? <span aria-hidden className="absolute inset-y-3 left-0 w-0.5 rounded-r bg-primary" /> : null}

            <div className="min-w-0">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium leading-5">{label}</span>
                    <span className="truncate text-xs leading-5 text-muted-foreground">
                        {t(FILE_TYPE_META[record.file_type].extensionsKey)}
                    </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        {t("settings.systemConfig.fileProcessing.column.loader")}
                        <Badge variant="outline" className="font-mono">
                            {record.loader}
                        </Badge>
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        {t("settings.systemConfig.fileProcessing.column.chunker")}
                        <Badge variant="outline" className="font-mono">
                            {record.chunker}
                        </Badge>
                    </span>
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                        {t("settings.systemConfig.fileProcessing.column.chunkSize")}
                    </p>
                    {record.chunk_size_editable ? (
                        <div className="flex flex-col gap-1">
                            <Input
                                type="number"
                                min={FILE_TYPE_CHUNK_SIZE_MIN}
                                max={FILE_TYPE_CHUNK_SIZE_MAX}
                                step={1}
                                value={draft.chunkSizeValue}
                                disabled={isSaving}
                                onChange={(event) =>
                                    onDraftChange(record.file_type, { chunkSizeValue: event.target.value })
                                }
                                aria-label={t("settings.systemConfig.fileProcessing.chunkSize.aria", { type: label })}
                                aria-invalid={Boolean(chunkSizeError)}
                                className="h-8 w-full max-w-36"
                            />
                            {chunkSizeError ? (
                                <span className="max-w-44 text-xs text-destructive">
                                    {chunkSizeErrorMessage(chunkSizeError, t)}
                                </span>
                            ) : null}
                        </div>
                    ) : (
                        <p className="flex h-8 items-center text-sm text-muted-foreground">
                            {t("settings.systemConfig.fileProcessing.notApplicable")}
                        </p>
                    )}
                </div>

                <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                        {t("settings.systemConfig.fileProcessing.column.extractionMode")}
                    </p>
                    {record.document_mode_editable ? (
                        <Select
                            value={draft.documentModeValue}
                            disabled={isSaving}
                            onValueChange={(value) => {
                                if (isDocumentMode(value)) {
                                    onDraftChange(record.file_type, { documentModeValue: value });
                                }
                            }}
                        >
                            <SelectTrigger
                                className="h-8 w-full max-w-[170px]"
                                aria-label={t("settings.systemConfig.fileProcessing.extractionMode.aria", {
                                    type: label,
                                })}
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    {FILE_TYPE_DOCUMENT_MODE_VALUES.map((mode) => (
                                        <SelectItem key={mode} value={mode}>
                                            {t(DOCUMENT_MODE_LABEL_KEYS[mode])}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    ) : (
                        <p className="flex h-8 items-center text-sm text-muted-foreground">
                            {t("settings.systemConfig.fileProcessing.notApplicable")}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

function FileTypeConfigList({
    records,
    drafts,
    isSaving,
    onDraftChange,
}: {
    records: FileTypeConfigRecord[];
    drafts: FileTypeConfigDrafts;
    isSaving: boolean;
    onDraftChange: (fileType: FileTypeValue, draft: Partial<FileTypeConfigDraft>) => void;
}) {
    const t = useAppTranslations();
    const recordsByFileType = useMemo(
        () => new Map(records.map((record) => [record.file_type, record] as const)),
        [records]
    );

    return (
        <div className="border-t">
            {FILE_TYPE_GROUPS.map((group) => (
                <Fragment key={group.id}>
                    <div className="border-b bg-muted/30 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
                        {t(group.labelKey)}
                    </div>
                    <div className="divide-y">
                        {group.fileTypes.map((fileType) => {
                            const record = recordsByFileType.get(fileType);
                            if (!record) {
                                return null;
                            }

                            const draft = draftForRecord(drafts, record);
                            const isDirty = !isPatchEmpty(
                                buildPatchInput(record, draft.chunkSizeValue, draft.documentModeValue)
                            );

                            return (
                                <FileTypeConfigRow
                                    key={fileType}
                                    record={record}
                                    draft={draft}
                                    isDirty={isDirty}
                                    isSaving={isSaving}
                                    onDraftChange={onDraftChange}
                                />
                            );
                        })}
                    </div>
                </Fragment>
            ))}
        </div>
    );
}

function FileProcessingGuidance() {
    const t = useAppTranslations();

    return (
        <div className="border-t px-4 py-4">
            <div className="grid gap-3 md:grid-cols-3">
                {FILE_TYPE_DOCUMENT_MODE_VALUES.map((mode) => (
                    <div key={mode} className="rounded-md border bg-background p-3">
                        <p className="text-sm font-medium">{t(DOCUMENT_MODE_LABEL_KEYS[mode])}</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t(`settings.systemConfig.fileProcessing.mode.${mode}.description`)}
                        </p>
                    </div>
                ))}
            </div>

            <div className="mt-3 flex gap-3 rounded-md border border-highlight/30 bg-highlight/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-highlight" />
                <p>{t("settings.systemConfig.fileProcessing.futureOnly")}</p>
            </div>
        </div>
    );
}

export function SystemConfigurationSection() {
    const t = useAppTranslations();
    const apiClient = useApiClient();
    const queryClient = useQueryClient();
    const [drafts, setDrafts] = useState<FileTypeConfigDrafts>({});
    const draftsToPreserveAfterRefetchRef = useRef<FileTypeConfigDrafts | null>(null);
    const syncedRecordsSignatureRef = useRef("");

    const fileTypesQuery = useQuery({
        queryKey: queryKeys.fileTypeConfigs,
        queryFn: () => fetchFileTypeConfigs(apiClient),
    });
    const fileTypeRecords = useMemo(() => fileTypesQuery.data ?? [], [fileTypesQuery.data]);
    const fileTypeRecordsSignature = useMemo(() => recordsSignature(fileTypesQuery.data), [fileTypesQuery.data]);

    useEffect(() => {
        if (!fileTypesQuery.data || syncedRecordsSignatureRef.current === fileTypeRecordsSignature) {
            return;
        }

        syncedRecordsSignatureRef.current = fileTypeRecordsSignature;
        const nextDrafts = draftsFromRecords(fileTypesQuery.data);
        const preservedDrafts = draftsToPreserveAfterRefetchRef.current;
        draftsToPreserveAfterRefetchRef.current = null;

        setDrafts(preservedDrafts ? { ...nextDrafts, ...preservedDrafts } : nextDrafts);
    }, [fileTypesQuery.data, fileTypeRecordsSignature]);

    const changedConfigs = useMemo(() => changedConfigsForRecords(fileTypeRecords, drafts), [fileTypeRecords, drafts]);
    const hasInvalidDrafts = useMemo(() => hasValidationErrors(fileTypeRecords, drafts), [fileTypeRecords, drafts]);
    const hasChanges = changedConfigs.length > 0;

    const saveMutation = useMutation({
        mutationFn: async (changes: SaveFileTypeConfigInput[]) => {
            const updatedRecords: FileTypeConfigRecord[] = [];

            for (const [index, change] of changes.entries()) {
                try {
                    updatedRecords.push(await updateFileTypeConfig(apiClient, change.fileType, change.input));
                } catch (error) {
                    throw new SaveFileTypeConfigError(
                        change.fileType,
                        error,
                        changes.slice(index).map((remainingChange) => remainingChange.fileType)
                    );
                }
            }

            return updatedRecords;
        },
        onSuccess: (records) => {
            toast.success(
                t("settings.systemConfig.fileProcessing.savedAll", {
                    count: records.length,
                })
            );
        },
        onError: (error) => {
            if (error instanceof SaveFileTypeConfigError) {
                draftsToPreserveAfterRefetchRef.current = Object.fromEntries(
                    error.remainingFileTypes.flatMap((fileType) => {
                        const draft = drafts[fileType];
                        return draft ? [[fileType, draft]] : [];
                    })
                );
            }

            toast.error(saveAllErrorMessage(error, t));
        },
        onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.fileTypeConfigs }),
    });

    const saveAllChanges = () => {
        if (!hasChanges || hasInvalidDrafts || saveMutation.isPending) {
            return;
        }

        saveMutation.mutate(changedConfigs);
    };

    const resetAllChanges = () => {
        if (!fileTypesQuery.data || saveMutation.isPending) {
            return;
        }

        draftsToPreserveAfterRefetchRef.current = null;
        setDrafts(draftsFromRecords(fileTypesQuery.data));
    };

    const updateDraft = (fileType: FileTypeValue, draft: Partial<FileTypeConfigDraft>) => {
        setDrafts((currentDrafts) => ({
            ...currentDrafts,
            [fileType]: {
                ...(currentDrafts[fileType] ?? { chunkSizeValue: "", documentModeValue: "" }),
                ...draft,
            },
        }));
    };

    const bulkActions = fileTypesQuery.data ? (
        <div className="flex flex-col gap-3 border-t bg-muted/20 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
                <p className="text-sm font-medium">
                    {t("settings.systemConfig.fileProcessing.pendingChanges", {
                        count: changedConfigs.length,
                    })}
                </p>
                <p className="text-xs text-muted-foreground">
                    {hasInvalidDrafts
                        ? t("settings.systemConfig.fileProcessing.fixValidationBeforeSave")
                        : t("settings.systemConfig.fileProcessing.saveAll.description")}
                </p>
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!hasChanges || saveMutation.isPending}
                    onClick={resetAllChanges}
                    aria-label={t("settings.systemConfig.fileProcessing.resetAll.aria")}
                >
                    <RotateCcw className="h-4 w-4" />
                    {t("settings.systemConfig.fileProcessing.resetAll")}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    disabled={!hasChanges || hasInvalidDrafts || saveMutation.isPending}
                    onClick={saveAllChanges}
                    aria-label={t("settings.systemConfig.fileProcessing.saveAll.aria")}
                >
                    {saveMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Save className="h-4 w-4" />
                    )}
                    {t("settings.systemConfig.fileProcessing.saveAll")}
                </Button>
            </div>
        </div>
    ) : null;

    return (
        <section className="flex flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("settings.systemConfig.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.systemConfig.description")}</p>
            </div>

            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                            <CardTitle>{t("settings.systemConfig.fileProcessing.title")}</CardTitle>
                            <CardDescription>{t("settings.systemConfig.fileProcessing.description")}</CardDescription>
                        </div>
                        {fileTypesQuery.data ? (
                            <Badge variant="secondary">
                                {t("settings.systemConfig.fileProcessing.loaded", {
                                    count: fileTypesQuery.data.length,
                                })}
                            </Badge>
                        ) : null}
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {fileTypesQuery.isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                    ) : null}

                    {fileTypesQuery.isError ? (
                        <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
                            <p>{t("settings.systemConfig.fileProcessing.load.error")}</p>
                            <Button type="button" variant="outline" size="sm" onClick={() => fileTypesQuery.refetch()}>
                                {t("settings.systemConfig.fileProcessing.reload")}
                            </Button>
                        </div>
                    ) : null}

                    {fileTypesQuery.data ? (
                        <FileTypeConfigList
                            records={fileTypesQuery.data}
                            drafts={drafts}
                            isSaving={saveMutation.isPending}
                            onDraftChange={updateDraft}
                        />
                    ) : null}

                    {fileTypesQuery.data ? <FileProcessingGuidance /> : null}

                    {bulkActions}
                </CardContent>
            </Card>
        </section>
    );
}
