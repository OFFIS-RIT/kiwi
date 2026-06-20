import { Schema } from "effect";

export const asApiSchema = Schema.toStandardSchemaV1;
export const decodeApiSchemaSync = Schema.decodeUnknownSync;

export type MutableSchemaType<T> =
    T extends ReadonlyArray<infer TItem>
        ? MutableSchemaType<TItem>[]
        : T extends object
          ? { -readonly [TKey in keyof T]: MutableSchemaType<T[TKey]> }
          : T;

export const NonEmptyTrimmedStringSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)));

export const OptionalNonEmptyTrimmedStringSchema = Schema.optional(NonEmptyTrimmedStringSchema);

export const OptionalTrimmedStringSchema = Schema.optional(Schema.Trim);

export const UrlStringSchema = NonEmptyTrimmedStringSchema.pipe(
    Schema.refine(
        (value): value is string => {
            try {
                new URL(value);
                return true;
            } catch {
                return false;
            }
        },
        { message: "Expected a valid URL" }
    )
);
