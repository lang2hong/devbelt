import { replaceEscapedOctetsWithChar } from './common/utils.js';
import type { ChunksParser } from './streamParser.js';
import type { ResultSet } from './common/index.js';

/**
 * 解析 sqlite3 CLI 输出的 TCL 模式结果流。
 * 原样复用自原项目，属于纯逻辑，可独立测试。
 */
export class ResultSetParser implements ChunksParser<ResultSet | undefined> {
  private resultSet?: ResultSet;

  private isInStmt: boolean;
  private isInHeader: boolean;
  private isInString: boolean;
  private stringChar: string;
  private stmt: string;
  private row: string[];
  private lastChar: string;

  constructor() {
    this.isInStmt = true;
    this.isInHeader = false;
    this.isInString = false;
    this.stringChar = '';
    this.stmt = '';
    this.row = [];
    this.lastChar = '';
  }

  done() {
    return this.resultSet;
  }

  push(chunk: string) {
    if (!this.resultSet) {
      this.resultSet = [];
    }

    const last = <T>(arr: Array<T>): T => arr[arr.length - 1];

    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];
      const prevChar = (n?: number) => {
        n = Math.abs(n !== undefined ? n : 1);
        return i - n >= 0 ? chunk[i - n] : this.lastChar !== '' ? this.lastChar : '';
      };

      if (i === chunk.length - 1) {
        this.lastChar = char;
      }

      if (this.isInStmt) {
        // start of string
        if (!this.isInString && (char === '"' || char === "'")) {
          this.stmt += char;
          this.isInString = true;
          this.stringChar = char;
          continue;
        }
        // end of string
        if (this.isInString && char === this.stringChar) {
          this.stmt += char;
          this.isInString = false;
          this.stringChar = '';
          continue;
        }
        // end of stmt
        if (!this.isInString && char === ';') {
          this.stmt += char;
          this.isInStmt = false;

          this.resultSet.push({ stmt: this.stmt, header: [], rows: [] });

          this.stmt = '';
          this.isInHeader = true;
          continue;
        }

        this.stmt += char;
      } else {
        if (this.isInString) {
          // end of field
          const rowEnd = chunk[i + 1] && (chunk[i + 1] === '\r' || chunk[i + 1] === '\n');
          const columnEnd =
            chunk[i + 1] && chunk[i + 2] && chunk[i + 1] === ' ' && chunk[i + 2] === '"';
          if (char === '"' && (prevChar() !== '\\' || rowEnd || columnEnd)) {
            this.isInString = false;
            this.row[this.row.length - 1] = replaceEscapedOctetsWithChar(last(this.row));
            continue;
          }
          // escaped quote: remove backslash, add quote
          if (char === '"' && prevChar() === '\\') {
            this.row[this.row.length - 1] = last(this.row).slice(0, -1);
            this.row[this.row.length - 1] += char;
            continue;
          }
          // inside field
          this.row[this.row.length - 1] += char;
        } else {
          // end of rows and start of new stmt
          if (char !== '"' && prevChar() === '\n') {
            this.isInStmt = true;
            this.stmt = char;
            continue;
          }
          // end of row
          if ((char === '\n' || char === '\r') && prevChar() === '"') {
            if (this.isInHeader) {
              last(this.resultSet).header = this.row;
              this.row = [];
              this.isInHeader = false;
            } else {
              last(this.resultSet).rows.push(this.row);
              this.row = [];
            }
            continue;
          }
          // start of field
          if (char === '"') {
            this.isInString = true;
            this.row.push('');
            continue;
          }
        }
      }
    }
  }
}