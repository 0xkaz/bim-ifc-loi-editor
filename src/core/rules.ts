import {
  buildIfcModel,
  formatPrimitive,
  getAttributeValue,
  getEntitiesOfType,
  getGlobalId,
  getName,
  isPresentValue,
  primitiveType,
  type IfcModel
} from "./ifc";
import { type StepDocument, stepValueToPrimitive } from "./step";

export type RuleSeverity = "error" | "warning";
export type ValueTypeName = "string" | "number" | "boolean";

export interface ValueConstraint {
  valueType?: ValueTypeName;
  min?: number;
  max?: number;
  allowedValues?: unknown[];
  pattern?: string;
}

export interface RequirePropertyRule extends ValueConstraint {
  pset: string;
  name: string;
}

export interface RequireAttributeRule extends ValueConstraint {
  name: string;
}

export interface LoiRule {
  target: string;
  requireProperty?: RequirePropertyRule;
  requireAttribute?: RequireAttributeRule;
  severity?: RuleSeverity;
  description?: string;
}

export interface LoiRuleset {
  rules: LoiRule[];
}

export interface RuleViolation {
  severity: RuleSeverity;
  targetType: string;
  targetId: number;
  globalId?: string;
  name?: string;
  description?: string;
  requireProperty?: RequirePropertyRule;
  requireAttribute?: RequireAttributeRule;
  expected: string;
  actual: string;
}

export type TargetStatus = "pass" | "fail" | "missing";

export interface RuleTargetResult {
  targetId: number;
  targetType: string;
  globalId?: string;
  name?: string;
  status: TargetStatus;
  violations: RuleViolation[];
  matchedRules: number;
}

export interface CheckResult {
  passed: boolean;
  rulesChecked: number;
  targetCount: number;
  violations: RuleViolation[];
  targetResults: RuleTargetResult[];
}

export class RuleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleFormatError";
  }
}

export function parseRules(text: string): LoiRuleset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RuleFormatError(error instanceof Error ? error.message : "invalid JSON");
  }

  if (!isObject(parsed) || !Array.isArray(parsed.rules)) {
    throw new RuleFormatError("rules file must contain a rules array");
  }

  const rules = parsed.rules.map((rule, index) => parseRule(rule, index));
  return { rules };
}

export function checkDocument(document: StepDocument, ruleset: LoiRuleset): CheckResult {
  const model = buildIfcModel(document);
  const violations: RuleViolation[] = [];
  const targetResults = new Map<number, RuleTargetResult>();
  let targetCount = 0;

  for (const rule of ruleset.rules) {
    const targets = getEntitiesOfType(model, rule.target);
    targetCount += targets.length;

    for (const target of targets) {
      const current =
        targetResults.get(target.id) ??
        ({
          targetId: target.id,
          targetType: rule.target,
          globalId: getGlobalId(target),
          name: getName(target),
          status: "pass" as const,
          violations: [],
          matchedRules: 0
        } satisfies RuleTargetResult);

      current.matchedRules += 1;

      if (rule.requireAttribute) {
        const violation = checkAttributeRule(rule, model, target.id);
        if (violation) {
          current.violations.push(violation);
          violations.push(violation);
          current.status = violation.actual === "missing" ? "missing" : "fail";
        }
      }

      if (rule.requireProperty) {
        const violation = checkPropertyRule(rule, model, target.id);
        if (violation) {
          current.violations.push(violation);
          violations.push(violation);
          current.status = violation.actual.includes("missing") ? "missing" : "fail";
        }
      }

      targetResults.set(target.id, current);
    }
  }

  return {
    passed: violations.length === 0,
    rulesChecked: ruleset.rules.length,
    targetCount,
    violations,
    targetResults: [...targetResults.values()].sort((left, right) => {
      if (left.status === right.status) {
        return (left.name ?? "").localeCompare(right.name ?? "") || left.targetId - right.targetId;
      }
      const priority: Record<TargetStatus, number> = { missing: 0, fail: 1, pass: 2 };
      return priority[left.status] - priority[right.status];
    })
  };
}

export function formatCheckResult(result: CheckResult, filePath: string): string {
  if (result.passed) {
    return [
      `IFC LOI check passed: ${filePath}`,
      `Rules checked: ${result.rulesChecked}`,
      `Targets evaluated: ${result.targetCount}`,
      "Violations: 0"
    ].join("\n");
  }

  const lines = [
    `IFC LOI check failed: ${filePath}`,
    `Rules checked: ${result.rulesChecked}`,
    `Targets evaluated: ${result.targetCount}`,
    `Violations: ${result.violations.length}`
  ];

  for (const violation of result.violations) {
    lines.push("");
    lines.push(`- [${violation.severity}] ${violation.targetType} #${violation.targetId}`);
    lines.push(`  GlobalId: ${violation.globalId ?? "(missing)"}`);
    if (violation.name) {
      lines.push(`  Name: ${violation.name}`);
    }
    if (violation.description) {
      lines.push(`  Rule: ${violation.description}`);
    }
    lines.push(`  Expected: ${violation.expected}`);
    lines.push(`  Actual: ${violation.actual}`);
  }

  return lines.join("\n");
}

function parseRule(rule: unknown, index: number): LoiRule {
  if (!isObject(rule)) {
    throw new RuleFormatError(`rules[${index}] must be an object`);
  }
  if (typeof rule.target !== "string" || rule.target.trim().length === 0) {
    throw new RuleFormatError(`rules[${index}].target must be a non-empty string`);
  }

  const parsed: LoiRule = {
    target: rule.target,
    severity: parseSeverity(rule.severity, index),
    description: typeof rule.description === "string" ? rule.description : undefined
  };

  if (rule.requireProperty !== undefined) {
    parsed.requireProperty = parseRequireProperty(rule.requireProperty, index);
  }
  if (rule.requireAttribute !== undefined) {
    parsed.requireAttribute = parseRequireAttribute(rule.requireAttribute, index);
  }
  if (!parsed.requireProperty && !parsed.requireAttribute) {
    throw new RuleFormatError(`rules[${index}] must define requireProperty or requireAttribute`);
  }

  return parsed;
}

function parseSeverity(value: unknown, index: number): RuleSeverity {
  if (value === undefined) {
    return "error";
  }
  if (value === "error" || value === "warning") {
    return value;
  }
  throw new RuleFormatError(`rules[${index}].severity must be "error" or "warning"`);
}

function parseRequireProperty(value: unknown, index: number): RequirePropertyRule {
  if (!isObject(value)) {
    throw new RuleFormatError(`rules[${index}].requireProperty must be an object`);
  }
  if (typeof value.pset !== "string" || value.pset.trim().length === 0) {
    throw new RuleFormatError(`rules[${index}].requireProperty.pset must be a non-empty string`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new RuleFormatError(`rules[${index}].requireProperty.name must be a non-empty string`);
  }

  return {
    pset: value.pset,
    name: value.name,
    ...parseValueConstraint(value, `rules[${index}].requireProperty`)
  };
}

function parseRequireAttribute(value: unknown, index: number): RequireAttributeRule {
  if (!isObject(value)) {
    throw new RuleFormatError(`rules[${index}].requireAttribute must be an object`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new RuleFormatError(`rules[${index}].requireAttribute.name must be a non-empty string`);
  }

  return {
    name: value.name,
    ...parseValueConstraint(value, `rules[${index}].requireAttribute`)
  };
}

function parseValueConstraint(value: Record<string, unknown>, path: string): ValueConstraint {
  const constraint: ValueConstraint = {};
  if (value.valueType !== undefined) {
    if (value.valueType !== "string" && value.valueType !== "number" && value.valueType !== "boolean") {
      throw new RuleFormatError(`${path}.valueType must be "string", "number", or "boolean"`);
    }
    constraint.valueType = value.valueType;
  }
  if (value.min !== undefined) {
    if (typeof value.min !== "number") {
      throw new RuleFormatError(`${path}.min must be a number`);
    }
    constraint.min = value.min;
  }
  if (value.max !== undefined) {
    if (typeof value.max !== "number") {
      throw new RuleFormatError(`${path}.max must be a number`);
    }
    constraint.max = value.max;
  }
  if (value.allowedValues !== undefined) {
    if (!Array.isArray(value.allowedValues)) {
      throw new RuleFormatError(`${path}.allowedValues must be an array`);
    }
    constraint.allowedValues = value.allowedValues;
  }
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== "string") {
      throw new RuleFormatError(`${path}.pattern must be a string`);
    }
    constraint.pattern = value.pattern;
  }
  return constraint;
}

function checkAttributeRule(rule: LoiRule, model: IfcModel, targetId: number): RuleViolation | undefined {
  const target = model.document.entitiesById.get(targetId);
  if (!target || !rule.requireAttribute) {
    return undefined;
  }

  const attribute = getAttributeValue(target, rule.requireAttribute.name);
  const subject = makeSubject(rule, targetId, model);
  const expected = buildAttributeExpected(rule.requireAttribute);

  if (!isPresentValue(attribute)) {
    return {
      ...subject,
      expected,
      actual: "missing"
    };
  }

  const primitive = stepValueToPrimitive(attribute);
  const failure = evaluateConstraint(primitive, rule.requireAttribute);
  if (!failure) {
    return undefined;
  }

  return {
    ...subject,
    expected: `${expected}; ${failure.expected}`,
    actual: failure.actual
  };
}

function checkPropertyRule(rule: LoiRule, model: IfcModel, targetId: number): RuleViolation | undefined {
  const target = model.document.entitiesById.get(targetId);
  if (!target || !rule.requireProperty) {
    return undefined;
  }

  const subject = makeSubject(rule, targetId, model);
  const propertySets = model.propertySetsByObjectId.get(targetId) ?? [];
  const matchingPropertySets = propertySets.filter((propertySet) => propertySet.name === rule.requireProperty?.pset);
  const expected = buildPropertyExpected(rule.requireProperty);

  if (matchingPropertySets.length === 0) {
    return {
      ...subject,
      expected,
      actual: `property set ${rule.requireProperty.pset} missing`
    };
  }

  const property = matchingPropertySets
    .flatMap((propertySet) => propertySet.properties)
    .find((candidate) => candidate.name === rule.requireProperty?.name);

  if (!property || property.value === null || property.value === undefined || property.value === "") {
    return {
      ...subject,
      expected,
      actual: "property missing"
    };
  }

  const failure = evaluateConstraint(property.value, rule.requireProperty);
  if (!failure) {
    return undefined;
  }

  return {
    ...subject,
    expected: `${expected}; ${failure.expected}`,
    actual: failure.actual
  };
}

function makeSubject(rule: LoiRule, targetId: number, model: IfcModel): Omit<RuleViolation, "expected" | "actual"> {
  const target = model.document.entitiesById.get(targetId);
  return {
    severity: rule.severity ?? "error",
    targetType: rule.target,
    targetId,
    globalId: target ? getGlobalId(target) : undefined,
    name: target ? getName(target) : undefined,
    description: rule.description,
    requireProperty: rule.requireProperty,
    requireAttribute: rule.requireAttribute
  };
}

function buildAttributeExpected(rule: RequireAttributeRule): string {
  return `attribute ${rule.name} to be present${constraintSummary(rule)}`;
}

function buildPropertyExpected(rule: RequirePropertyRule): string {
  return `property ${rule.pset}.${rule.name} to be present${constraintSummary(rule)}`;
}

function constraintSummary(rule: ValueConstraint): string {
  const parts: string[] = [];
  if (rule.valueType) {
    parts.push(`type ${rule.valueType}`);
  }
  if (rule.min !== undefined) {
    parts.push(`>= ${rule.min}`);
  }
  if (rule.max !== undefined) {
    parts.push(`<= ${rule.max}`);
  }
  if (rule.allowedValues) {
    parts.push(`one of ${rule.allowedValues.map((value) => formatPrimitive(value)).join(", ")}`);
  }
  if (rule.pattern) {
    parts.push(`matching /${rule.pattern}/`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function evaluateConstraint(
  value: unknown,
  constraint: ValueConstraint
): { expected: string; actual: string } | undefined {
  if (constraint.valueType && primitiveType(value) !== constraint.valueType) {
    return {
      expected: `value type ${constraint.valueType}`,
      actual: `value type ${primitiveType(value)} (${formatPrimitive(value)})`
    };
  }

  if (constraint.min !== undefined || constraint.max !== undefined) {
    if (typeof value !== "number") {
      return {
        expected: "numeric value",
        actual: `value type ${primitiveType(value)} (${formatPrimitive(value)})`
      };
    }
    if (constraint.min !== undefined && value < constraint.min) {
      return {
        expected: `value >= ${constraint.min}`,
        actual: formatPrimitive(value)
      };
    }
    if (constraint.max !== undefined && value > constraint.max) {
      return {
        expected: `value <= ${constraint.max}`,
        actual: formatPrimitive(value)
      };
    }
  }

  if (constraint.allowedValues && !constraint.allowedValues.some((allowed) => Object.is(allowed, value))) {
    return {
      expected: `one of ${constraint.allowedValues.map((allowed) => formatPrimitive(allowed)).join(", ")}`,
      actual: formatPrimitive(value)
    };
  }

  if (constraint.pattern) {
    if (typeof value !== "string") {
      return {
        expected: `string matching /${constraint.pattern}/`,
        actual: `value type ${primitiveType(value)} (${formatPrimitive(value)})`
      };
    }
    const pattern = new RegExp(constraint.pattern);
    if (!pattern.test(value)) {
      return {
        expected: `string matching /${constraint.pattern}/`,
        actual: formatPrimitive(value)
      };
    }
  }

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
