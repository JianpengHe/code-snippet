export class Excel {
  /**
   * 解析从 .xlsx 文件解压出的文件 Map，返回工作表数据。
   * @param unZipFiles - 一个 Map，键为 zip 内的文件路径，值为文件 buffer。
   * @returns 一个对象，键为工作表名称，值为二维数组（表格数据）。
   */
  static parse(unZipFiles: Map<string, { fileBuffer: Uint8Array }>): Record<string, (string | number)[][]> {
    const textDecoder = new TextDecoder();
    const domParser = new DOMParser();

    // 1. 预先解析所有必要的 XML 文件，避免在循环中重复解析
    const sharedStrings = this._parseSharedStrings(unZipFiles, textDecoder, domParser);
    const workbook = this._getXmlDoc(unZipFiles, "xl/workbook.xml", textDecoder, domParser);

    const output: Record<string, (string | number)[][]> = {};
    const sheets = workbook.getElementsByTagName("sheet");

    for (const sheet of sheets) {
      const sheetName = sheet.getAttribute("name");
      const sheetId = sheet.getAttribute("sheetId");

      // 2. 增强健壮性，处理属性缺失的情况
      if (!sheetName || !sheetId) {
        console.warn("Workbook contains a sheet with missing name or sheetId, skipping.");
        continue;
      }

      const sheetXml = this._getXmlDoc(unZipFiles, `xl/worksheets/sheet${sheetId}.xml`, textDecoder, domParser);
      const rows: (string | number)[][] = [];
      output[sheetName] = rows;

      for (const cell of sheetXml.getElementsByTagName("c")) {
        const cellAddress = cell.getAttribute("r");
        if (!cellAddress) continue;

        const valueElement = cell.querySelector("v");
        if (!valueElement?.textContent) continue;

        // 3. 改进单元格解析逻辑，正确区分字符串和数字
        let cellValue: string | number;
        const cellType = cell.getAttribute("t");

        if (cellType === "s") {
          // 类型 "s" 代表共享字符串
          const sstIndex = Number(valueElement.textContent);
          cellValue = sharedStrings.get(sstIndex) ?? "";
        } else {
          // 无 "t" 属性或其他类型（如 "n"）通常为数字
          cellValue = Number(valueElement.textContent);
        }

        // 解析单元格地址 "A1" -> [0, 0]
        const match = cellAddress.match(/^([A-Z]+)(\d+)$/);
        if (!match) continue;

        const [, colLetters, rowNumStr] = match;
        const rowIndex = Number(rowNumStr) - 1;
        const colIndex = this._columnToNumber(colLetters);

        // 确保行数组存在
        rows[rowIndex] = rows[rowIndex] || [];
        rows[rowIndex][colIndex] = cellValue;
      }
    }
    return output;
  }

  /**
   * 从文件 Map 中获取并解析 XML 文档。
   * @private
   */
  private static _getXmlDoc(
    files: Map<string, { fileBuffer: Uint8Array }>,
    path: string,
    decoder: TextDecoder,
    parser: DOMParser
  ): XMLDocument {
    const file = files.get(path);
    if (!file) {
      throw new Error(`Required XML file not found in archive: ${path}`);
    }
    const xmlString = decoder.decode(file.fileBuffer);
    return parser.parseFromString(xmlString, "application/xml");
  }

  /**
   * 解析共享字符串表。
   * @private
   */
  private static _parseSharedStrings(
    files: Map<string, { fileBuffer: Uint8Array }>,
    decoder: TextDecoder,
    parser: DOMParser
  ): Map<number, string> {
    const sstXml = this._getXmlDoc(files, "xl/sharedStrings.xml", decoder, parser);
    const strings = new Map<number, string>();
    const stringItems = sstXml.getElementsByTagName("si");
    for (let i = 0; i < stringItems.length; i++) {
      // textContent 会自动拼接所有子文本节点，更可靠
      strings.set(i, stringItems[i].textContent ?? "");
    }
    return strings;
  }

  /**
   * 将 Excel 列名（如 'A', 'B', 'AA'）转换为 0-indexed 数字。
   * 'A' -> 0, 'B' -> 1, 'AA' -> 26
   * @private
   */
  private static _columnToNumber(column: string): number {
    let num = 0;
    const charCodeA = "A".charCodeAt(0);
    for (let i = 0; i < column.length; i++) {
      num = num * 26 + (column.charCodeAt(i) - charCodeA + 1);
    }
    return num - 1;
  }
}
