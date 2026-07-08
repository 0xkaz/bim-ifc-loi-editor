export type StepValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number; raw: string }
  | { kind: "reference"; id: number }
  | { kind: "enum"; value: string }
  | { kind: "null" }
  | { kind: "omitted" }
  | { kind: "list"; value: StepValue[] }
  | { kind: "typed"; type: string; args: StepValue[] }
  | { kind: "identifier"; value: string };

export interface StepEntity {
  id: number;
  type: string;
  args: StepValue[];
}

export interface StepDocument {
  schema?: string;
  entities: StepEntity[];
  entitiesById: Map<number, StepEntity>;
}

export class IfcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IfcParseError";
  }
}

export function parseStep(text: string): StepDocument {
  if (!/^\s*ISO-10303-21\s*;/i.test(text)) {
    throw new IfcParseError("missing ISO-10303-21 header");
  }

  const dataStart = /\bDATA\s*;/i.exec(text);
  if (!dataStart?.index && dataStart?.index !== 0) {
    throw new IfcParseError("missing DATA section");
  }

  const afterDataOffset = dataStart.index + dataStart[0].length;
  const afterData = text.slice(afterDataOffset);
  const dataEnd = /\bENDSEC\s*;/i.exec(afterData);
  if (!dataEnd?.index && dataEnd?.index !== 0) {
    throw new IfcParseError("missing DATA ENDSEC");
  }

  const afterEndsecOffset = afterDataOffset + dataEnd.index + dataEnd[0].length;
  if (!/\bEND-ISO-10303-21\s*;/i.test(text.slice(afterEndsecOffset))) {
    throw new IfcParseError("missing END-ISO-10303-21 footer");
  }

  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text)?.[1];
  const dataSection = text.slice(afterDataOffset, afterDataOffset + dataEnd.index);
  const entities = parseEntities(dataSection);
  const entitiesById = new Map<number, StepEntity>();

  for (const entity of entities) {
    if (entitiesById.has(entity.id)) {
      throw new IfcParseError(`duplicate entity id #${entity.id}`);
    }
    entitiesById.set(entity.id, entity);
  }

  return { schema, entities, entitiesById };
}

export function parseStepArguments(input: string): StepValue[] {
  const parser = new ValueParser(input);
  return parser.parseTopLevel();
}

function parseEntities(data: string): StepEntity[] {
  const entities: StepEntity[] = [];
  let cursor = 0;

  while (true) {
    cursor = skipWhitespace(data, cursor);
    if (cursor >= data.length) {
      break;
    }

    const entityStart = cursor;
    if (data[cursor] !== "#") {
      throw parseErrorAt(data, cursor, "expected entity id");
    }
    cursor++;

    const idStart = cursor;
    while (isDigit(data[cursor])) {
      cursor++;
    }
    if (idStart === cursor) {
      throw parseErrorAt(data, cursor, "expected numeric entity id");
    }
    const id = Number(data.slice(idStart, cursor));

    cursor = skipWhitespace(data, cursor);
    if (data[cursor] !== "=") {
      throw parseErrorAt(data, cursor, "expected '=' after entity id");
    }
    cursor++;

    cursor = skipWhitespace(data, cursor);
    const typeStart = cursor;
    while (isIdentifierChar(data[cursor])) {
      cursor++;
    }
    if (typeStart === cursor) {
      throw parseErrorAt(data, cursor, "expected entity type");
    }
    const type = data.slice(typeStart, cursor).toUpperCase();

    cursor = skipWhitespace(data, cursor);
    if (data[cursor] !== "(") {
      throw parseErrorAt(data, cursor, "expected '(' after entity type");
    }
    cursor++;

    const argsStart = cursor;
    let depth = 1;
    let inString = false;
    while (cursor < data.length && depth > 0) {
      const char = data[cursor];
      if (inString) {
        if (char === "'") {
          if (data[cursor + 1] === "'") {
            cursor += 2;
          } else {
            inString = false;
            cursor++;
          }
        } else {
          cursor++;
        }
        continue;
      }

      if (char === "'") {
        inString = true;
        cursor++;
      } else if (char === "(") {
        depth++;
        cursor++;
      } else if (char === ")") {
        depth--;
        if (depth === 0) {
          break;
        }
        cursor++;
      } else {
        cursor++;
      }
    }

    if (depth !== 0) {
      throw parseErrorAt(data, entityStart, "unterminated entity arguments");
    }

    const argsText = data.slice(argsStart, cursor);
    cursor++;
    cursor = skipWhitespace(data, cursor);
    if (data[cursor] !== ";") {
      throw parseErrorAt(data, cursor, "expected ';' after entity");
    }
    cursor++;

    entities.push({ id, type, args: parseStepArguments(argsText) });
  }

  return entities;
}

class ValueParser {
  private position = 0;

  constructor(private readonly input: string) {}

  parseTopLevel(): StepValue[] {
    const values: StepValue[] = [];
    this.skipWhitespace();
    if (this.isDone()) {
      return values;
    }

    while (!this.isDone()) {
      values.push(this.parseValue());
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.position++;
        this.skipWhitespace();
        continue;
      }
      if (!this.isDone()) {
        this.fail("expected ',' between arguments");
      }
    }

    return values;
  }

  private parseValue(): StepValue {
    this.skipWhitespace();
    const char = this.peek();

    if (char === undefined) {
      this.fail("expected value");
    }
    if (char === "$") {
      this.position++;
      return { kind: "null" };
    }
    if (char === "*") {
      this.position++;
      return { kind: "omitted" };
    }
    if (char === "#") {
      return this.parseReference();
    }
    if (char === "'") {
      return this.parseString();
    }
    if (char === "(") {
      this.position++;
      return { kind: "list", value: this.parseDelimitedValues(")") };
    }
    if (char === "." && !isDigit(this.input[this.position + 1])) {
      return this.parseEnum();
    }
    if (isNumberStart(char, this.input[this.position + 1])) {
      return this.parseNumber();
    }
    if (isIdentifierStart(char)) {
      return this.parseIdentifierOrTypedValue();
    }

    this.fail(`unexpected value token '${char}'`);
  }

  private parseDelimitedValues(close: string): StepValue[] {
    const values: StepValue[] = [];
    this.skipWhitespace();
    if (this.peek() === close) {
      this.position++;
      return values;
    }

    while (true) {
      values.push(this.parseValue());
      this.skipWhitespace();
      const char = this.peek();
      if (char === ",") {
        this.position++;
        this.skipWhitespace();
        continue;
      }
      if (char === close) {
        this.position++;
        return values;
      }
      this.fail(`expected ',' or '${close}'`);
    }
  }

  private parseReference(): StepValue {
    this.position++;
    const start = this.position;
    while (isDigit(this.peek())) {
      this.position++;
    }
    if (start === this.position) {
      this.fail("expected reference id");
    }
    return { kind: "reference", id: Number(this.input.slice(start, this.position)) };
  }

  private parseString(): StepValue {
    this.position++;
    let value = "";
    while (!this.isDone()) {
      const char = this.peek();
      if (char === "'") {
        if (this.input[this.position + 1] === "'") {
          value += "'";
          this.position += 2;
          continue;
        }
        this.position++;
        return { kind: "string", value: decodeStepString(value) };
      }
      value += char;
      this.position++;
    }
    this.fail("unterminated string");
  }

  private parseEnum(): StepValue {
    this.position++;
    const start = this.position;
    while (!this.isDone() && this.peek() !== ".") {
      this.position++;
    }
    if (this.peek() !== ".") {
      this.fail("unterminated enum");
    }
    const value = this.input.slice(start, this.position).toUpperCase();
    this.position++;
    return { kind: "enum", value };
  }

  private parseNumber(): StepValue {
    const match = /^[+-]?(?:(?:\d+\.\d*)|(?:\d+)|(?:\.\d+))(?:[Ee][+-]?\d+)?/.exec(
      this.input.slice(this.position)
    );
    if (!match) {
      this.fail("expected number");
    }
    const raw = match[0];
    this.position += raw.length;
    return { kind: "number", value: Number(raw), raw };
  }

  private parseIdentifierOrTypedValue(): StepValue {
    const start = this.position;
    this.position++;
    while (isIdentifierChar(this.peek())) {
      this.position++;
    }
    const value = this.input.slice(start, this.position).toUpperCase();
    this.skipWhitespace();
    if (this.peek() === "(") {
      this.position++;
      return { kind: "typed", type: value, args: this.parseDelimitedValues(")") };
    }
    return { kind: "identifier", value };
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek() ?? "")) {
      this.position++;
    }
  }

  private isDone(): boolean {
    return this.position >= this.input.length;
  }

  private peek(): string | undefined {
    return this.input[this.position];
  }

  private fail(message: string): never {
    throw new IfcParseError(`${message} at argument offset ${this.position}`);
  }
}

export function extractReferenceIds(value: StepValue | undefined): number[] {
  if (!value) {
    return [];
  }
  if (value.kind === "reference") {
    return [value.id];
  }
  if (value.kind === "list") {
    return value.value.flatMap((item) => extractReferenceIds(item));
  }
  if (value.kind === "typed") {
    return value.args.flatMap((item) => extractReferenceIds(item));
  }
  return [];
}

export function getReferenceId(value: StepValue | undefined): number | undefined {
  return value?.kind === "reference" ? value.id : undefined;
}

export function getStringValue(value: StepValue | undefined): string | undefined {
  return value?.kind === "string" ? value.value : undefined;
}

export function getNumberValue(value: StepValue | undefined): number | undefined {
  return value?.kind === "number" ? value.value : undefined;
}

export function stepValueToPrimitive(value: StepValue | undefined): unknown {
  if (!value) {
    return undefined;
  }

  switch (value.kind) {
    case "string":
      return value.value;
    case "number":
      return value.value;
    case "reference":
      return `#${value.id}`;
    case "enum":
      if (value.value === "T") {
        return true;
      }
      if (value.value === "F") {
        return false;
      }
      if (value.value === "U") {
        return null;
      }
      return value.value;
    case "null":
    case "omitted":
      return null;
    case "identifier":
      return value.value;
    case "list":
      return value.value.map((item) => stepValueToPrimitive(item));
    case "typed":
      if (value.args.length === 1) {
        return stepValueToPrimitive(value.args[0]);
      }
      return value.args.map((item) => stepValueToPrimitive(item));
  }
}

export function stepValueToJson(value: StepValue | undefined): unknown {
  if (!value) {
    return undefined;
  }

  switch (value.kind) {
    case "list":
      return value.value.map((item) => stepValueToJson(item));
    case "typed":
      return {
        type: value.type,
        value:
          value.args.length === 1
            ? stepValueToJson(value.args[0])
            : value.args.map((item) => stepValueToJson(item))
      };
    default:
      return stepValueToPrimitive(value);
  }
}

export function stepValueToDisplay(value: StepValue | undefined): string {
  if (!value) {
    return "missing";
  }

  switch (value.kind) {
    case "string":
      return value.value;
    case "number":
      return Number.isFinite(value.value) ? String(value.value) : value.raw;
    case "reference":
      return `#${value.id}`;
    case "enum":
      return value.value;
    case "null":
      return "$";
    case "omitted":
      return "*";
    case "identifier":
      return value.value;
    case "list":
      return `(${value.value.map((item) => stepValueToDisplay(item)).join(", ")})`;
    case "typed":
      return value.args.length === 1
        ? `${value.type}(${stepValueToDisplay(value.args[0])})`
        : `${value.type}(${value.args.map((item) => stepValueToDisplay(item)).join(", ")})`;
  }
}

export function serializeStepDocument(document: StepDocument): string {
  const schema = document.schema ?? "IFC4";
  const lines = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Edited by bim-ifc-loi-editor'),'2;1');",
    `FILE_NAME('edited.ifc','${new Date().toISOString()}',('kaz'),('bim-ifc-loi-editor'),'','');`,
    `FILE_SCHEMA(('${schema}'));`,
    "ENDSEC;",
    "DATA;"
  ];

  for (const entity of document.entities) {
    lines.push(serializeStepEntity(entity));
  }

  lines.push("ENDSEC;");
  lines.push("END-ISO-10303-21;");
  return `${lines.join("\n")}\n`;
}

export function serializeStepEntity(entity: StepEntity): string {
  return `#${entity.id}=${entity.type}(${entity.args.map((arg) => serializeStepValue(arg)).join(",")});`;
}

export function serializeStepValue(value: StepValue | undefined): string {
  if (!value) {
    return "$";
  }

  switch (value.kind) {
    case "string":
      return `'${value.value.replace(/'/g, "''")}'`;
    case "number":
      return Number.isFinite(value.value) ? value.raw : value.raw;
    case "reference":
      return `#${value.id}`;
    case "enum":
      return `.${value.value}.`;
    case "null":
      return "$";
    case "omitted":
      return "*";
    case "identifier":
      return value.value;
    case "list":
      return `(${value.value.map((item) => serializeStepValue(item)).join(",")})`;
    case "typed":
      return `${value.type}(${value.args.map((item) => serializeStepValue(item)).join(",")})`;
  }
}

function decodeStepString(value: string): string {
  return value
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_match, hex: string) => {
      const chars: string[] = [];
      for (let index = 0; index < hex.length; index += 4) {
        const code = Number.parseInt(hex.slice(index, index + 4), 16);
        if (Number.isFinite(code)) {
          chars.push(String.fromCharCode(code));
        }
      }
      return chars.join("");
    })
    .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_match, hex: string) => {
      const chars: string[] = [];
      for (let index = 0; index < hex.length; index += 8) {
        const code = Number.parseInt(hex.slice(index, index + 8), 16);
        if (Number.isFinite(code)) {
          chars.push(String.fromCodePoint(code));
        }
      }
      return chars.join("");
    });
}

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (/\s/.test(input[cursor] ?? "")) {
    cursor++;
  }
  return cursor;
}

function parseErrorAt(input: string, offset: number, message: string): IfcParseError {
  const before = input.slice(0, offset);
  const line = before.split(/\n/).length;
  const column = offset - before.lastIndexOf("\n");
  return new IfcParseError(`${message} at data line ${line}, column ${column}`);
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z_]/.test(value);
}

function isIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_\-]/.test(value);
}

function isNumberStart(current: string | undefined, next: string | undefined): boolean {
  return (
    (current !== undefined && current >= "0" && current <= "9") ||
    current === "+" ||
    current === "-" ||
    (current === "." && next !== undefined && next >= "0" && next <= "9")
  );
}
