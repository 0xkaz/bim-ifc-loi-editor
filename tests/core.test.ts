import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectDocument } from "../src/core/inspect";
import { buildIfcModel } from "../src/core/ifc";
import { checkDocument, parseRules, RuleFormatError } from "../src/core/rules";
import { IfcParseError, parseStep } from "../src/core/step";

const validIfc = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('demo.ifc','2026-07-07T00:00:00',('kaz'),('codex'),'','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('P1',$,'Project',$,$,$,$,$,$);
#2=IFCSPACE('S1',$,'Space 1',$,$,$,$,$,$,$);
#3=IFCPROPERTYSINGLEVALUE('CeilingHeight',$,IFCLENGTHMEASURE(2500),$);
#4=IFCPROPERTYSET('PS1',$,'Pset_SpaceCommon',$,(#3));
#5=IFCRELDEFINESBYPROPERTIES('R1',$,$,$,(#2),#4);
ENDSEC;
END-ISO-10303-21;`;

const missingPropertyIfc = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('P1',$,'Project',$,$,$,$,$,$);
#2=IFCSPACE('S1',$,'Space 1',$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const missingNameIfc = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('P1',$,'Project',$,$,$,$,$,$);
#2=IFCSPACE('S1',$,$,$,$,$,$,$,$,$);
#3=IFCPROPERTYSINGLEVALUE('CeilingHeight',$,IFCLENGTHMEASURE(2500),$);
#4=IFCPROPERTYSET('PS1',$,'Pset_SpaceCommon',$,(#3));
#5=IFCRELDEFINESBYPROPERTIES('R1',$,$,$,(#2),#4);
ENDSEC;
END-ISO-10303-21;`;

describe("step parser", () => {
  it("parses entity data", () => {
    const document = parseStep(validIfc);
    expect(document.schema).toBe("IFC4");
    expect(document.entities).toHaveLength(5);
    expect(document.entitiesById.get(2)?.type).toBe("IFCSPACE");
  });

  it("rejects missing headers", () => {
    expect(() => parseStep("DATA; ENDSEC; END-ISO-10303-21;")).toThrow(IfcParseError);
  });

  it("rejects duplicate entity ids", () => {
    const duplicate = validIfc.replace("#2=IFCSPACE", "#1=IFCSPACE");
    expect(() => parseStep(duplicate)).toThrow(/duplicate entity id/);
  });

  it("rejects broken entity syntax", () => {
    expect(() => parseStep("ISO-10303-21; HEADER; DATA; #1=IFCPROJECT('P1'); ENDSEC;")).toThrow(
      IfcParseError
    );
  });
});

describe("rules", () => {
  it("parses valid rule sets", () => {
    const rules = parseRules(readFileSync(new URL("../rules/space-basic.json", import.meta.url), "utf8"));
    expect(rules.rules).toHaveLength(2);
  });

  it("rejects malformed rule files", () => {
    expect(() => parseRules("{}")).toThrow(RuleFormatError);
  });
});

describe("inspection and checks", () => {
  it("passes a complete space", () => {
    const result = checkDocument(parseStep(validIfc), parseRules(readFileSync(new URL("../rules/space-basic.json", import.meta.url), "utf8")));
    expect(result.passed).toBe(true);
    expect(result.targetCount).toBe(2);
  });

  it("reports missing property data", () => {
    const result = checkDocument(
      parseStep(missingPropertyIfc),
      parseRules(readFileSync(new URL("../rules/space-basic.json", import.meta.url), "utf8"))
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((violation) => violation.actual.includes("missing"))).toBe(true);
    expect(result.targetResults[0]?.status).toBe("missing");
  });

  it("reports missing attributes", () => {
    const result = checkDocument(
      parseStep(missingNameIfc),
      parseRules(readFileSync(new URL("../rules/space-basic.json", import.meta.url), "utf8"))
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((violation) => violation.expected.includes("attribute Name"))).toBe(true);
  });

  it("inspects the bundled fixture", () => {
    const fixture = readFileSync(new URL("../fixtures/golden-house.ifc", import.meta.url), "utf8");
    const inspection = inspectDocument(parseStep(fixture));
    expect(inspection.entityTotal).toBeGreaterThan(0);
    expect(Object.keys(inspection.entityCounts).length).toBeGreaterThan(0);
    expect(inspection.units.length).toBeGreaterThan(0);
    expect(inspection.hierarchy.length).toBeGreaterThan(0);
  });

  it("finds the expected mismatch in the bundled fixture", () => {
    const fixture = readFileSync(new URL("../fixtures/golden-house.ifc", import.meta.url), "utf8");
    const result = checkDocument(parseStep(fixture), parseRules(readFileSync(new URL("../rules/space-basic.json", import.meta.url), "utf8")));
    expect(result.passed).toBe(false);
    expect(result.violations.some((violation) => violation.expected.includes("CeilingHeight"))).toBe(true);
  });

  it("builds an IFC model index", () => {
    const model = buildIfcModel(parseStep(validIfc));
    expect(model.propertySetsByObjectId.get(2)).toHaveLength(1);
    expect(model.units).toHaveLength(0);
  });
});
