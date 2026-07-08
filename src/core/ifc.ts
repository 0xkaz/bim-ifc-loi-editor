import {
  extractReferenceIds,
  getNumberValue,
  getReferenceId,
  getStringValue,
  type StepDocument,
  type StepEntity,
  type StepValue,
  stepValueToDisplay,
  stepValueToJson,
  stepValueToPrimitive
} from "./step";

export interface IfcObjectInfo {
  id: number;
  type: string;
  globalId?: string;
  name?: string;
}

export interface IfcPropertyInfo {
  id: number;
  name: string;
  value: unknown;
  valueDisplay: string;
  valueRaw: unknown;
}

export interface IfcPropertySetInfo {
  id: number;
  globalId?: string;
  name: string;
  objects: IfcObjectInfo[];
  properties: IfcPropertyInfo[];
}

export interface IfcUnitInfo {
  id: number;
  type: string;
  unitType?: string;
  prefix?: string;
  name?: string;
  label: string;
  values: unknown[];
}

export interface IfcHierarchyNode {
  id: number;
  type: string;
  globalId?: string;
  name?: string;
  elevation?: number;
  containedCount: number;
  containedTypes: Record<string, number>;
  children: IfcHierarchyNode[];
}

export interface IfcModel {
  document: StepDocument;
  entitiesByType: Map<string, StepEntity[]>;
  propertySets: IfcPropertySetInfo[];
  propertySetsByObjectId: Map<number, IfcPropertySetInfo[]>;
  units: IfcUnitInfo[];
  hierarchy: IfcHierarchyNode[];
}

const COMMON_TYPE_NAMES: Record<string, string> = {
  IFCARBITRARYCLOSEDPROFILEDEF: "IfcArbitraryClosedProfileDef",
  IFCAXIS2PLACEMENT3D: "IfcAxis2Placement3D",
  IFCBUILDING: "IfcBuilding",
  IFCBUILDINGSTOREY: "IfcBuildingStorey",
  IFCCARTESIANPOINT: "IfcCartesianPoint",
  IFCCONVERSIONBASEDUNIT: "IfcConversionBasedUnit",
  IFCDIRECTION: "IfcDirection",
  IFCEXTRUDEDAREASOLID: "IfcExtrudedAreaSolid",
  IFCGEOMETRICREPRESENTATIONCONTEXT: "IfcGeometricRepresentationContext",
  IFCSIUNIT: "IfcSIUnit",
  IFCLOCALPLACEMENT: "IfcLocalPlacement",
  IFCPOLYLINE: "IfcPolyline",
  IFCPRODUCTDEFINITIONSHAPE: "IfcProductDefinitionShape",
  IFCPROPERTYSET: "IfcPropertySet",
  IFCPROJECT: "IfcProject",
  IFCRELAGGREGATES: "IfcRelAggregates",
  IFCRELCONTAINEDINSPATIALSTRUCTURE: "IfcRelContainedInSpatialStructure",
  IFCRELDEFINESBYPROPERTIES: "IfcRelDefinesByProperties",
  IFCSHAPEREPRESENTATION: "IfcShapeRepresentation",
  IFCSITE: "IfcSite",
  IFCSPACE: "IfcSpace",
  IFCUNITASSIGNMENT: "IfcUnitAssignment",
  IFCWALL: "IfcWall",
  IFCWALLSTANDARDCASE: "IfcWallStandardCase"
};

const COMMON_ATTRIBUTE_INDEX: Record<string, number> = {
  GLOBALID: 0,
  OWNERHISTORY: 1,
  NAME: 2,
  DESCRIPTION: 3,
  OBJECTTYPE: 4,
  OBJECTPLACEMENT: 5,
  REPRESENTATION: 6,
  LONGNAME: 7,
  COMPOSITIONTYPE: 8,
  ELEVATION: 9
};

export function buildIfcModel(document: StepDocument): IfcModel {
  const entitiesByType = groupEntitiesByType(document.entities);
  const propertySets = buildPropertySets(document);
  const propertySetsByObjectId = new Map<number, IfcPropertySetInfo[]>();

  for (const propertySet of propertySets) {
    for (const object of propertySet.objects) {
      const list = propertySetsByObjectId.get(object.id) ?? [];
      list.push(propertySet);
      propertySetsByObjectId.set(object.id, list);
    }
  }

  return {
    document,
    entitiesByType,
    propertySets,
    propertySetsByObjectId,
    units: buildUnits(document),
    hierarchy: buildHierarchy(document)
  };
}

export function normalizeIfcType(type: string): string {
  return type.trim().toUpperCase();
}

export function displayIfcType(type: string): string {
  const normalized = normalizeIfcType(type);
  return COMMON_TYPE_NAMES[normalized] ?? `Ifc${toPascalFromIfcSuffix(normalized)}`;
}

export function getEntitiesOfType(model: IfcModel, type: string): StepEntity[] {
  return model.entitiesByType.get(normalizeIfcType(type)) ?? [];
}

export function getObjectInfo(entity: StepEntity): IfcObjectInfo {
  return {
    id: entity.id,
    type: displayIfcType(entity.type),
    globalId: getGlobalId(entity),
    name: getName(entity)
  };
}

export function getGlobalId(entity: StepEntity): string | undefined {
  return getStringValue(entity.args[0]);
}

export function getName(entity: StepEntity): string | undefined {
  return getStringValue(entity.args[2]);
}

export function getAttributeValue(entity: StepEntity, attributeName: string): StepValue | undefined {
  const key = attributeName.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const index = COMMON_ATTRIBUTE_INDEX[key];
  return index === undefined ? undefined : entity.args[index];
}

export function isPresentValue(value: StepValue | undefined): boolean {
  if (!value || value.kind === "null" || value.kind === "omitted") {
    return false;
  }
  if (value.kind === "string") {
    return value.value.trim().length > 0;
  }
  return true;
}

export function primitiveType(value: unknown): "string" | "number" | "boolean" | "array" | "null" | "object" {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return type;
  }
  return "object";
}

export function formatPrimitive(value: unknown): string {
  if (value === null || value === undefined) {
    return "missing";
  }
  if (typeof value === "string") {
    return value.length === 0 ? '""' : `"${value}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatPrimitive(item)).join(", ")}]`;
  }
  return String(value);
}

function groupEntitiesByType(entities: StepEntity[]): Map<string, StepEntity[]> {
  const grouped = new Map<string, StepEntity[]>();
  for (const entity of entities) {
    const list = grouped.get(entity.type) ?? [];
    list.push(entity);
    grouped.set(entity.type, list);
  }
  return grouped;
}

function buildPropertySets(document: StepDocument): IfcPropertySetInfo[] {
  const byId = document.entitiesById;
  const linkedObjectsByPropertySet = new Map<number, IfcObjectInfo[]>();

  for (const relation of document.entities) {
    if (relation.type !== "IFCRELDEFINESBYPROPERTIES") {
      continue;
    }
    const objectIds = extractReferenceIds(relation.args[4]);
    const propertySetId = getReferenceId(relation.args[5]);
    if (!propertySetId) {
      continue;
    }
    const objects = objectIds
      .map((id) => byId.get(id))
      .filter((entity): entity is StepEntity => entity !== undefined)
      .map((entity) => getObjectInfo(entity));
    linkedObjectsByPropertySet.set(propertySetId, [
      ...(linkedObjectsByPropertySet.get(propertySetId) ?? []),
      ...objects
    ]);
  }

  return document.entities
    .filter((entity) => entity.type === "IFCPROPERTYSET")
    .map((propertySet) => {
      const propertyIds = extractReferenceIds(propertySet.args[4]);
      const properties = propertyIds
        .map((id) => byId.get(id))
        .filter((entity): entity is StepEntity => entity?.type === "IFCPROPERTYSINGLEVALUE")
        .map((property) => toPropertyInfo(property));

      return {
        id: propertySet.id,
        globalId: getGlobalId(propertySet),
        name: getStringValue(propertySet.args[2]) ?? `#${propertySet.id}`,
        objects: linkedObjectsByPropertySet.get(propertySet.id) ?? [],
        properties
      };
    });
}

function toPropertyInfo(property: StepEntity): IfcPropertyInfo {
  const value = property.args[2];
  return {
    id: property.id,
    name: getStringValue(property.args[0]) ?? `#${property.id}`,
    value: stepValueToPrimitive(value),
    valueDisplay: stepValueToDisplay(value),
    valueRaw: stepValueToJson(value)
  };
}

function buildUnits(document: StepDocument): IfcUnitInfo[] {
  const units: IfcUnitInfo[] = [];
  const seen = new Set<number>();

  for (const assignment of document.entities) {
    if (assignment.type !== "IFCUNITASSIGNMENT") {
      continue;
    }
    for (const unitId of extractReferenceIds(assignment.args[0])) {
      if (seen.has(unitId)) {
        continue;
      }
      const unit = document.entitiesById.get(unitId);
      if (!unit) {
        continue;
      }
      units.push(toUnitInfo(unit));
      seen.add(unitId);
    }
  }

  return units;
}

function toUnitInfo(unit: StepEntity): IfcUnitInfo {
  const unitType = unit.args[1] ? stepValueToDisplay(unit.args[1]) : undefined;
  const prefix = unit.args[2] && unit.args[2].kind !== "omitted" ? stepValueToDisplay(unit.args[2]) : undefined;
  const name = unit.args[3] ? stepValueToDisplay(unit.args[3]) : undefined;
  const measure = [prefix, name].filter((part): part is string => Boolean(part)).join(" ");
  const label = unitType && measure ? `${unitType}: ${measure}` : unitType ?? measure;

  return {
    id: unit.id,
    type: displayIfcType(unit.type),
    unitType,
    prefix,
    name,
    label: label || displayIfcType(unit.type),
    values: unit.args.map((arg) => stepValueToJson(arg))
  };
}

function buildHierarchy(document: StepDocument): IfcHierarchyNode[] {
  const childrenByParent = new Map<number, number[]>();
  const childIds = new Set<number>();
  const containedByStructure = new Map<number, number[]>();

  for (const entity of document.entities) {
    if (entity.type === "IFCRELAGGREGATES") {
      const parentId = getReferenceId(entity.args[4]);
      if (!parentId) {
        continue;
      }
      const children = extractReferenceIds(entity.args[5]);
      childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), ...children]);
      for (const child of children) {
        childIds.add(child);
      }
    }

    if (entity.type === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
      const structureId = getReferenceId(entity.args[5]);
      if (!structureId) {
        continue;
      }
      containedByStructure.set(structureId, [
        ...(containedByStructure.get(structureId) ?? []),
        ...extractReferenceIds(entity.args[4])
      ]);
    }
  }

  const projectIds = document.entities
    .filter((entity) => entity.type === "IFCPROJECT")
    .map((entity) => entity.id);
  const roots = projectIds.length > 0 ? projectIds : [...childrenByParent.keys()].filter((id) => !childIds.has(id));

  return roots
    .map((id) => buildHierarchyNode(id, document, childrenByParent, containedByStructure, new Set<number>()))
    .filter((node): node is IfcHierarchyNode => node !== undefined);
}

function buildHierarchyNode(
  id: number,
  document: StepDocument,
  childrenByParent: Map<number, number[]>,
  containedByStructure: Map<number, number[]>,
  visited: Set<number>
): IfcHierarchyNode | undefined {
  const entity = document.entitiesById.get(id);
  if (!entity || visited.has(id)) {
    return undefined;
  }
  visited.add(id);

  const contained = containedByStructure.get(id) ?? [];
  const containedTypes: Record<string, number> = {};
  for (const containedId of contained) {
    const containedEntity = document.entitiesById.get(containedId);
    if (!containedEntity) {
      continue;
    }
    const type = displayIfcType(containedEntity.type);
    containedTypes[type] = (containedTypes[type] ?? 0) + 1;
  }

  const children = (childrenByParent.get(id) ?? [])
    .map((childId) => buildHierarchyNode(childId, document, childrenByParent, containedByStructure, new Set(visited)))
    .filter((node): node is IfcHierarchyNode => node !== undefined);

  return {
    id,
    type: displayIfcType(entity.type),
    globalId: getGlobalId(entity),
    name: getName(entity),
    elevation: getNumberValue(entity.args[9]),
    containedCount: contained.length,
    containedTypes,
    children
  };
}

function toPascalFromIfcSuffix(type: string): string {
  const suffix = type.startsWith("IFC") ? type.slice(3) : type;
  if (!suffix) {
    return "";
  }
  return suffix[0] + suffix.slice(1).toLowerCase();
}
