import { buildIfcModel, displayIfcType, type IfcHierarchyNode, type IfcModel } from "./ifc";
import { type StepDocument } from "./step";

export interface InspectionResult {
  schema?: string;
  entityTotal: number;
  entityCounts: Record<string, number>;
  propertySets: IfcModel["propertySets"];
  units: IfcModel["units"];
  hierarchy: IfcHierarchyNode[];
}

export function inspectDocument(document: StepDocument): InspectionResult {
  const model = buildIfcModel(document);
  const entityCounts = Object.fromEntries(
    [...model.entitiesByType.entries()]
      .map(([type, entities]) => [displayIfcType(type), entities.length] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );

  return {
    schema: document.schema,
    entityTotal: document.entities.length,
    entityCounts,
    propertySets: model.propertySets,
    units: model.units,
    hierarchy: model.hierarchy
  };
}
