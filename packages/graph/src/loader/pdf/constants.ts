import type { Matrix2D } from "./types";

export const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
export const DEFAULT_LINE_WIDTH = 1;
export const EDGE_SNAP_TOLERANCE = 3;
export const EDGE_JOIN_TOLERANCE = 3;
export const EDGE_MIN_LENGTH = 6;
export const TABLE_MIN_CELLS = 4;
export const TABLE_MIN_ROWS = 2;
export const TABLE_MIN_COLS = 2;
export const TABLE_MAX_COLS = 12;
export const TABLE_MAX_ROWS = 40;
export const TABLE_DEFAULT_SNAP_TOLERANCE = 3;
export const TABLE_DEFAULT_JOIN_TOLERANCE = 3;
export const TABLE_DEFAULT_MIN_WORDS_VERTICAL = 3;
export const TABLE_DEFAULT_MIN_WORDS_HORIZONTAL = 1;
export const TABLE_DEFAULT_EDGE_MIN_LENGTH = 3;
export const TABLE_DEFAULT_EDGE_MIN_PREFILT = 1;
export const TABLE_DEFAULT_INTERSECTION_TOLERANCE = 3;
export const TABLE_DEFAULT_TEXT_TOLERANCE = 3;
export const TABLE_POINT_EQUALITY_TOLERANCE = 0.001;
export const TEXT_CHAR_DEDUPE_TOLERANCE = 1;
export const TEXT_DEFAULT_X_TOLERANCE = 3;
export const TEXT_DEFAULT_Y_TOLERANCE = 3;
export const TEXT_DEFAULT_X_TOLERANCE_RATIO = 0.15;
export const TEXT_DEFAULT_Y_TOLERANCE_RATIO = 0.35;
export const TEXT_SEGMENT_MIN_GAP = 12;
export const TEXT_SEGMENT_GAP_RATIO = 4;
export const DEFAULT_RASTER_SCALE = 1.5;
export const PNG_MIME_TYPE = "image/png";
export const JPEG_MIME_TYPE = "image/jpeg";
export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
export const LIGATURE_EXPANSIONS: Record<string, string> = {
    ﬀ: "ff",
    ﬃ: "ffi",
    ﬄ: "ffl",
    ﬁ: "fi",
    ﬂ: "fl",
    ﬆ: "st",
    ﬅ: "st",
};
export const WORD_BOUNDARY_PUNCTUATION = new Set([",", ";", "!", "?"]);
export const INLINE_TOKEN_CONNECTORS = new Set([".", "_", "/", "\\", "-", "+", "=", "^", "~", "*", ":"]);
