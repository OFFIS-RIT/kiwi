export type ExcelSheetResult = {
    name: string;
    text: string;
    rowCount: number;
    colCount: number;
};

export type ExcelResult = {
    text: string;
    sheets: ExcelSheetResult[];
};
