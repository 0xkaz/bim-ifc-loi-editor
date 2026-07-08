import sampleIfc from "../fixtures/golden-house.ifc?raw";
import rulesText from "../rules/space-basic.json?raw";
import { inspectDocument } from "./core/inspect";
import { buildIfcModel, type IfcModel, type IfcObjectInfo, type IfcPropertySetInfo } from "./core/ifc";
import { checkDocument, parseRules, type CheckResult, type RuleTargetResult } from "./core/rules";
import {
  IfcParseError,
  parseStep,
  serializeStepDocument,
  stepValueToDisplay,
  type StepDocument,
  type StepEntity,
  type StepValue
} from "./core/step";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import "./styles.css";

type LoadSource = {
  label: string;
  text: string;
};

type Selection = {
  globalId?: string;
  targetId?: number;
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("missing #app");
}

const sampleSource: LoadSource = { label: "golden-house.ifc", text: sampleIfc };
const bundledRulesSource: LoadSource = { label: "space-basic.json", text: rulesText };

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>bim-ifc-loi-editor</h1>
        <p>Drop an IFC file, inspect LOI coverage, and click failing targets to jump to them in the viewer.</p>
      </div>
      <div class="toolbar">
        <label class="file-button">
          <input id="ifc-file" type="file" accept=".ifc,.ifcXML,.ifcjson,text/plain" />
          Open IFC
        </label>
        <label class="file-button">
          <input id="rules-file" type="file" accept=".json,application/json,text/plain" />
          Load rules
        </label>
        <button id="load-sample" type="button">Open sample</button>
        <button id="download-ifc" type="button">Download IFC</button>
      </div>
    </header>

    <section class="workspace">
      <section class="panel viewer-panel">
        <div class="panel-head">
          <div>
            <h2>Viewer</h2>
            <p id="viewer-source">No model loaded</p>
            <p id="viewer-focus">Nothing selected</p>
          </div>
          <div id="viewer-status" class="status-badge neutral">Idle</div>
        </div>
        <div id="dropzone" class="dropzone" aria-label="IFC drop zone">
          <div id="viewer-selection" class="viewer-selection">Nothing selected</div>
          <div id="viewer-mount" class="viewer-mount"></div>
          <div class="drop-hint">Drop IFC here</div>
        </div>
      </section>

      <section class="panel check-panel">
        <div class="panel-head">
          <div>
            <h2>Checks</h2>
            <p id="check-summary">Load an IFC file to inspect target coverage.</p>
          </div>
          <div class="badge-row">
            <span id="pass-count" class="status-badge pass">0 pass</span>
            <span id="fail-count" class="status-badge fail">0 fail</span>
            <span id="missing-count" class="status-badge missing">0 missing</span>
          </div>
        </div>
        <div class="stats-grid">
          <div class="stat"><span>Entities</span><strong id="stat-entities">-</strong></div>
          <div class="stat"><span>Targets</span><strong id="stat-targets">-</strong></div>
          <div class="stat"><span>Rules</span><strong id="stat-rules">-</strong></div>
          <div class="stat"><span>Schema</span><strong id="stat-schema">-</strong></div>
        </div>
        <div class="lists">
          <section>
            <h3>Target results</h3>
            <div id="target-list" class="target-list"></div>
          </section>
          <section>
            <h3>Inspect stats</h3>
            <div id="inspect-stats" class="inspect-stats"></div>
          </section>
        </div>
      </section>

      <section class="panel property-panel">
        <div class="panel-head">
          <div>
            <h2>Properties</h2>
            <p id="selection-summary">Select a target from the check list.</p>
          </div>
        </div>
        <section class="property-group">
          <h3>Quick fixes</h3>
          <div id="fix-list" class="fix-list"></div>
        </section>
        <div id="property-list" class="property-list"></div>
      </section>
    </section>

    <footer id="error-banner" class="error-banner hidden" role="status"></footer>
  </main>
`;

const viewerSource = requiredText("#viewer-source");
const viewerFocus = requiredText("#viewer-focus");
const viewerStatus = requiredText("#viewer-status");
const viewerSelection = requiredText("#viewer-selection");
const checkSummary = requiredText("#check-summary");
const passCount = requiredText("#pass-count");
const failCount = requiredText("#fail-count");
const missingCount = requiredText("#missing-count");
const statEntities = requiredText("#stat-entities");
const statTargets = requiredText("#stat-targets");
const statRules = requiredText("#stat-rules");
const statSchema = requiredText("#stat-schema");
const targetList = requiredText("#target-list");
const inspectStats = requiredText("#inspect-stats");
const propertyList = requiredText("#property-list");
const selectionSummary = requiredText("#selection-summary");
const errorBanner = requiredText("#error-banner");
const dropzone = requiredText("#dropzone");
const ifcFileInput = requiredText<HTMLInputElement>("#ifc-file");
const rulesFileInput = requiredText<HTMLInputElement>("#rules-file");
const loadSampleButton = requiredText<HTMLButtonElement>("#load-sample");
const downloadButton = requiredText<HTMLButtonElement>("#download-ifc");
const viewerMount = requiredText<HTMLDivElement>("#viewer-mount");
const fixList = requiredText<HTMLDivElement>("#fix-list");

let viewer: SchematicViewer;
const state = {
  currentDocument: undefined as StepDocument | undefined,
  currentModel: undefined as IfcModel | undefined,
  currentInspect: undefined as ReturnType<typeof inspectDocument> | undefined,
  currentCheck: undefined as CheckResult | undefined,
  currentRules: parseRules(bundledRulesSource.text),
  currentSourceLabel: "No model loaded",
  selection: undefined as Selection | undefined
};

loadSampleButton.addEventListener("click", () => {
  loadIfcSource(sampleSource).catch(reportError);
});

downloadButton.addEventListener("click", () => {
  downloadCurrentIfc().catch(reportError);
});

ifcFileInput.addEventListener("change", () => {
  const file = ifcFileInput.files?.[0];
  if (!file) {
    return;
  }
  file.text().then((text) => loadIfcSource({ label: file.name, text })).catch(reportError);
});

rulesFileInput.addEventListener("change", () => {
  const file = rulesFileInput.files?.[0];
  if (!file) {
    return;
  }
  file
    .text()
    .then((text) => {
      state.currentRules = parseRules(text);
      if (state.currentDocument) {
        updateResults();
      }
    })
    .catch(reportError);
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }
  file.text().then((text) => loadIfcSource({ label: file.name, text })).catch(reportError);
});

document.addEventListener("dragover", (event) => event.preventDefault());

async function loadIfcSource(source: LoadSource): Promise<void> {
  hideError();
  viewerSource.textContent = source.label;
  viewerStatus.textContent = "Loading";
  viewerStatus.className = "status-badge neutral";

  try {
    const document = parseStep(source.text);
    state.currentDocument = document;
    state.currentModel = buildIfcModel(document);
    state.currentInspect = inspectDocument(document);
    state.currentSourceLabel = source.label;
    updateDropzoneState(true);
    updateResults();
    viewer.render(state.currentModel, state.currentCheck, state.selection);
    viewerSource.textContent = source.label;
    viewerStatus.textContent = "Ready";
    viewerStatus.className = "status-badge pass";
  } catch (error) {
    state.currentDocument = undefined;
    state.currentModel = undefined;
    state.currentInspect = undefined;
    state.currentCheck = undefined;
    state.selection = undefined;
    updateDropzoneState(false);
    viewer.renderEmpty(source.label);
    viewerSource.textContent = source.label;
    viewerStatus.textContent = "Error";
    viewerStatus.className = "status-badge fail";
    reportError(error);
  }
}

function updateResults(): void {
  if (!state.currentDocument || !state.currentModel || !state.currentInspect) {
    return;
  }

  const check = checkDocument(state.currentDocument, state.currentRules);
  state.currentCheck = check;
  viewer.render(state.currentModel, check, state.selection);

  statEntities.textContent = String(state.currentInspect.entityTotal);
  statTargets.textContent = String(check.targetCount);
  statRules.textContent = String(check.rulesChecked);
  statSchema.textContent = state.currentInspect.schema ?? "unknown";

  const pass = check.targetResults.filter((item) => item.status === "pass").length;
  const fail = check.targetResults.filter((item) => item.status === "fail").length;
  const missing = check.targetResults.filter((item) => item.status === "missing").length;
  passCount.textContent = `${pass} pass`;
  failCount.textContent = `${fail} fail`;
  missingCount.textContent = `${missing} missing`;

  checkSummary.textContent = check.passed
    ? "All checked targets meet the active rules."
    : `${check.violations.length} violations across ${check.targetResults.length} targets.`;

  renderTargetList(check.targetResults);
  renderFixPanel(check.targetResults);
  renderInspectStats(state.currentInspect);
  renderSelection(state.selection);
}

function updateDropzoneState(loaded: boolean): void {
  dropzone.classList.toggle("loaded", loaded);
}

function renderTargetList(results: RuleTargetResult[]): void {
  targetList.replaceChildren();
  if (results.length === 0) {
    targetList.append(textRow("No targets matched the current rules."));
    return;
  }

  const table = document.createElement("table");
  table.className = "target-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Status", "Element", "Issue", "Current", "Edit", "Action", "ID"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const result of results) {
    const violations = result.violations.length > 0 ? result.violations : [undefined];
    const row = document.createElement("tr");
    row.className = `target-row status-${result.status}`;
    if (state.selection?.targetId === result.targetId) {
      row.classList.add("selected");
    }
    row.addEventListener("click", () => selectTarget(result));

    const statusCell = document.createElement("td");
    statusCell.dataset.label = "Status";
    const statusBadge = document.createElement("span");
    statusBadge.className = `status-badge ${result.status}`;
    statusBadge.textContent = result.status;
    statusCell.append(statusBadge);

    const elementCell = document.createElement("td");
    elementCell.dataset.label = "Element";
    elementCell.innerHTML = `<strong>${escapeHtml(result.name ?? result.targetType)}</strong><div>${escapeHtml(result.targetType)}</div>`;

    const issueCell = document.createElement("td");
    issueCell.dataset.label = "Issue";
    issueCell.textContent = violations[0]?.actual ?? "Compliant";

    const currentCell = buildTargetCurrentCell(result, violations[0]);
    const editCell = buildTargetEditCell(result, violations[0]);
    const actionCell = buildTargetActionCell(result, violations[0], editCell);

    const idCell = document.createElement("td");
    idCell.dataset.label = "ID";
    idCell.textContent = `#${result.targetId}`;

    row.append(statusCell, elementCell, issueCell, currentCell, editCell, actionCell, idCell);
    tbody.append(row);

    for (const violation of violations.slice(1)) {
      const detailRow = document.createElement("tr");
      detailRow.className = `target-row status-${result.status}`;
      if (state.selection?.targetId === result.targetId) {
        detailRow.classList.add("selected");
      }
      detailRow.addEventListener("click", () => selectTarget(result));

      const emptyStatus = document.createElement("td");
      emptyStatus.dataset.label = "Status";
      const emptyElement = document.createElement("td");
      emptyElement.dataset.label = "Element";
      emptyElement.textContent = result.name ?? result.targetType;

      const extraIssue = document.createElement("td");
      extraIssue.dataset.label = "Issue";
      extraIssue.textContent = violation.actual;

      const extraCurrent = buildTargetCurrentCell(result, violation);
      const extraEdit = buildTargetEditCell(result, violation);
      const extraAction = buildTargetActionCell(result, violation, extraEdit);

      const extraId = document.createElement("td");
      extraId.dataset.label = "ID";
      extraId.textContent = `#${result.targetId}`;

      detailRow.append(emptyStatus, emptyElement, extraIssue, extraCurrent, extraEdit, extraAction, extraId);
      tbody.append(detailRow);
    }
  }
  table.append(tbody);
  targetList.append(table);
}

function selectTarget(result: RuleTargetResult): void {
  state.selection = { targetId: result.targetId, globalId: result.globalId };
  viewer.render(state.currentModel, state.currentCheck, state.selection);
  viewer.highlight(result.globalId);
  updateViewerFocus(state.selection);
  renderSelection(state.selection);
  renderFixPanel(state.currentCheck?.targetResults ?? []);
  renderTargetList(state.currentCheck?.targetResults ?? []);
}

function buildTargetCurrentCell(
  result: RuleTargetResult,
  violation: RuleTargetResult["violations"][number] | undefined
): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.dataset.label = "Current";
  cell.className = "target-current";
  cell.textContent = getViolationCurrentValue(result, violation) || (violation ? "(empty)" : "-");
  return cell;
}

function buildTargetEditCell(
  result: RuleTargetResult,
  violation: RuleTargetResult["violations"][number] | undefined
): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.dataset.label = "Edit";
  cell.addEventListener("click", (event) => event.stopPropagation());

  if (!violation) {
    cell.textContent = "-";
    return cell;
  }

  const inputKind = violation.requireAttribute?.valueType ?? violation.requireProperty?.valueType ?? "string";
  const field = createInputField(inputKind, getViolationCurrentValue(result, violation));
  cell.append(field.wrapper);
  return cell;
}

function buildTargetActionCell(
  result: RuleTargetResult,
  violation: RuleTargetResult["violations"][number] | undefined,
  editCell: HTMLTableCellElement
): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.dataset.label = "Action";
  cell.addEventListener("click", (event) => event.stopPropagation());

  if (!violation) {
    cell.textContent = "-";
    return cell;
  }

  const input = editCell.querySelector("input");
  const apply = createActionButton("Apply");
  apply.addEventListener("click", () => {
    if (!input) {
      return;
    }
    applyViolationEdit(result, violation, input.value);
  });
  cell.append(apply);
  return cell;
}

function renderInspectStats(result: ReturnType<typeof inspectDocument>): void {
  inspectStats.replaceChildren();

  const sections: Array<[string, string[]]> = [
    ["Entity counts", Object.entries(result.entityCounts).map(([type, count]) => `${type}: ${count}`)],
    [
      "Property sets",
      result.propertySets.length === 0
        ? ["(none)"]
        : result.propertySets.map((propertySet) => formatPropertySet(propertySet))
    ],
    ["Units", result.units.length === 0 ? ["(none)"] : result.units.map((unit) => `${unit.type} ${unit.label}`)]
  ];

  for (const [title, items] of sections) {
    const group = document.createElement("section");
    group.className = "inspect-group";
    const heading = document.createElement("h4");
    heading.textContent = title;
    const list = document.createElement("ul");
    for (const item of items) {
      const entry = document.createElement("li");
      entry.textContent = item;
      list.append(entry);
    }
    group.append(heading, list);
    inspectStats.append(group);
  }
}

function renderSelection(selection: Selection | undefined): void {
  propertyList.replaceChildren();
  if (!state.currentModel || !state.currentDocument || !state.currentCheck) {
    selectionSummary.textContent = "Select a target from the check list.";
    propertyList.append(textRow("Load an IFC file to inspect properties."));
    return;
  }

  if (!selection) {
    selectionSummary.textContent = "Select a target from the check list.";
    updateViewerFocus(undefined);
    propertyList.append(textRow("Nothing selected."));
    return;
  }

  const entity = state.currentDocument.entitiesById.get(selection.targetId ?? -1);
  if (!entity) {
    selectionSummary.textContent = "Selected target is unavailable.";
    updateViewerFocus(selection);
    propertyList.append(textRow("The selected target no longer exists."));
    return;
  }

  selectionSummary.textContent = `${entity.type} ${entity.id}${selection.globalId ? ` / ${selection.globalId}` : ""}`;
  updateViewerFocus(selection);

  const sections: Array<[string, string[]]> = [
    ["Core", [`GlobalId: ${selection.globalId ?? "(missing)"}`, `Type: ${entity.type}`, `Name: ${entity.args[2] ? (entity.args[2].kind === "string" ? entity.args[2].value : "present") : "(missing)"}`]],
    [
      "Attributes",
      entity.args.map((arg, index) => `#${index + 1}: ${describeStepValue(arg)}`)
    ],
    ["Property sets", formatPropertySetsForSelection(state.currentModel, selection.targetId ?? -1)]
  ];

  for (const [title, items] of sections) {
    const section = document.createElement("section");
    section.className = "property-group";
    const heading = document.createElement("h4");
    heading.textContent = title;
    const list = document.createElement("dl");
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "(none)";
      section.append(heading, empty);
      propertyList.append(section);
      continue;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "property-row";
      const term = document.createElement("dt");
      const value = document.createElement("dd");
      if (item.includes(": ")) {
        const [termText, valueText] = item.split(": ", 2);
        term.textContent = termText;
        value.textContent = valueText;
      } else {
        term.textContent = "Value";
        value.textContent = item;
      }
      row.append(term, value);
      list.append(row);
    }
    section.append(heading, list);
    propertyList.append(section);
  }
}

function renderFixPanel(results: RuleTargetResult[]): void {
  fixList.replaceChildren();
  if (!state.currentDocument || !state.currentCheck) {
    fixList.append(textRow("Load an IFC file first."));
    return;
  }

  const selected =
    results.find((result) => result.targetId === state.selection?.targetId) ??
    results.find((result) => result.status !== "pass");

  if (!selected) {
    fixList.append(textRow("No fixes available."));
    return;
  }

  const target = state.currentDocument.entitiesById.get(selected.targetId);
  if (!target) {
    fixList.append(textRow("Selected target is unavailable."));
    return;
  }

  const heading = document.createElement("p");
  heading.className = "empty";
  heading.textContent = `${selected.name ?? selected.targetType} / ${selected.status}`;
  fixList.append(heading);

  const violations = selected.violations.length > 0 ? selected.violations : [];
  if (violations.length === 0) {
    fixList.append(textRow("Nothing to fix for the selected target."));
    return;
  }

  const table = document.createElement("table");
  table.className = "fix-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Field", "Current", "Edit", "Action"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const violation of violations) {
    if (violation.requireAttribute) {
      const row = buildFixRow({
        label: violation.requireAttribute.name,
        detail: violation.description ?? violation.expected,
        current: getAttributeText(target, violation.requireAttribute.name),
        inputKind: violation.requireAttribute.valueType ?? "string",
        onApply: (value) => {
          applyAttributeEdit(selected.targetId!, violation.requireAttribute!.name, value, violation.requireAttribute!);
        }
      });
      tbody.append(row);
    }

    if (violation.requireProperty) {
      const row = buildFixRow({
        label: `${violation.requireProperty.pset}.${violation.requireProperty.name}`,
        detail: violation.description ?? violation.expected,
        current: getPropertyText(state.currentDocument, selected.targetId, violation.requireProperty.pset, violation.requireProperty.name),
        inputKind: violation.requireProperty.valueType ?? "string",
        onApply: (value) => {
          applyPropertyEdit(
            selected.targetId!,
            violation.requireProperty!.pset,
            violation.requireProperty!.name,
            value,
            violation.requireProperty!
          );
        }
      });
      tbody.append(row);
    }
  }
  table.append(tbody);
  fixList.append(table);
}

function buildFixRow(options: {
  label: string;
  detail: string;
  current: string;
  inputKind: "string" | "number" | "boolean";
  onApply: (value: string) => void;
}): HTMLTableRowElement {
  const row = document.createElement("tr");

  const fieldCell = document.createElement("td");
  fieldCell.dataset.label = "Field";
  const fieldLabel = document.createElement("strong");
  fieldLabel.textContent = options.label;
  const fieldDetail = document.createElement("div");
  fieldDetail.className = "fix-detail";
  fieldDetail.textContent = options.detail;
  fieldCell.append(fieldLabel, fieldDetail);

  const currentCell = document.createElement("td");
  currentCell.dataset.label = "Current";
  currentCell.className = "fix-current";
  currentCell.textContent = options.current || "(empty)";

  const editCell = document.createElement("td");
  editCell.dataset.label = "Edit";
  const field = createInputField(options.inputKind, options.current);
  editCell.append(field.wrapper);

  const actionCell = document.createElement("td");
  actionCell.dataset.label = "Action";
  const apply = createActionButton("Apply");
  apply.addEventListener("click", () => {
    options.onApply(field.valueInput.value);
  });
  actionCell.append(apply);

  row.append(fieldCell, currentCell, editCell, actionCell);
  return row;
}

function updateViewerFocus(selection: Selection | undefined): void {
  if (!selection || !state.currentDocument) {
    viewerFocus.textContent = "Nothing selected";
    viewerSelection.textContent = "Nothing selected";
    return;
  }

  const entity = state.currentDocument.entitiesById.get(selection.targetId ?? -1);
  if (!entity) {
    viewerFocus.textContent = "Selected target unavailable";
    viewerSelection.textContent = "Selected target unavailable";
    return;
  }

  const label = `${entity.type} #${entity.id}${selection.globalId ? ` / ${selection.globalId}` : ""}`;
  viewerFocus.textContent = label;
  viewerSelection.textContent = `Editing ${label}`;
}

function getViolationCurrentValue(
  result: RuleTargetResult,
  violation: RuleTargetResult["violations"][number] | undefined
): string {
  if (!state.currentDocument || !violation) {
    return "";
  }

  const target = state.currentDocument.entitiesById.get(result.targetId);
  if (violation.requireAttribute && target) {
    return getAttributeText(target, violation.requireAttribute.name);
  }

  if (violation.requireProperty) {
    return getPropertyText(
      state.currentDocument,
      result.targetId,
      violation.requireProperty.pset,
      violation.requireProperty.name
    );
  }

  return "";
}

function applyViolationEdit(
  result: RuleTargetResult,
  violation: RuleTargetResult["violations"][number],
  value: string
): void {
  state.selection = { targetId: result.targetId, globalId: result.globalId };
  viewer.highlight(result.globalId);
  updateViewerFocus(state.selection);

  if (violation.requireAttribute) {
    applyAttributeEdit(result.targetId, violation.requireAttribute.name, value, violation.requireAttribute);
    return;
  }

  if (violation.requireProperty) {
    applyPropertyEdit(
      result.targetId,
      violation.requireProperty.pset,
      violation.requireProperty.name,
      value,
      violation.requireProperty
    );
  }
}

function applyAttributeEdit(
  targetId: number,
  attributeName: string,
  valueText: string,
  rule: NonNullable<RuleTargetResult["violations"][number]["requireAttribute"]>
): void {
  if (!state.currentDocument) {
    return;
  }
  const entity = state.currentDocument.entitiesById.get(targetId);
  if (!entity) {
    return;
  }

  const value = valueText.trim();
  if (rule.valueType === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid numeric value for ${attributeName}`);
    }
    entity.args[attributeIndex(attributeName)] = makeTypedNumber(parsed);
  } else if (rule.valueType === "boolean") {
    entity.args[attributeIndex(attributeName)] = makeEnum(value.toLowerCase() === "true" || value === "1" ? "T" : "F");
  } else {
    entity.args[attributeIndex(attributeName)] = { kind: "string", value };
  }
  refreshAfterEdit();
}

function applyPropertyEdit(
  targetId: number,
  psetName: string,
  propertyName: string,
  valueText: string,
  rule: NonNullable<RuleTargetResult["violations"][number]["requireProperty"]>
): void {
  if (!state.currentDocument) {
    return;
  }
  const value = valueText.trim();
  if (rule.valueType === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid numeric value for ${psetName}.${propertyName}`);
    }
    upsertPropertyValue(state.currentDocument, targetId, psetName, propertyName, makeTypedNumber(parsed));
  } else if (rule.valueType === "boolean") {
    upsertPropertyValue(
      state.currentDocument,
      targetId,
      psetName,
      propertyName,
      makeEnum(value.toLowerCase() === "true" || value === "1" ? "T" : "F")
    );
  } else {
    upsertPropertyValue(state.currentDocument, targetId, psetName, propertyName, { kind: "string", value });
  }
  refreshAfterEdit();
}

function refreshAfterEdit(): void {
  if (!state.currentDocument) {
    return;
  }
  state.currentModel = buildIfcModel(state.currentDocument);
  state.currentInspect = inspectDocument(state.currentDocument);
  updateResults();
  viewer.render(state.currentModel, state.currentCheck, state.selection);
}

function formatPropertySetsForSelection(model: IfcModel, targetId: number): string[] {
  const propertySets = model.propertySetsByObjectId.get(targetId) ?? [];
  if (propertySets.length === 0) {
    return ["(none)"];
  }

  const lines: string[] = [];
  for (const propertySet of propertySets) {
    lines.push(`${propertySet.name} (#${propertySet.id})`);
    for (const property of propertySet.properties) {
      lines.push(`  ${property.name}: ${property.valueDisplay}`);
    }
  }
  return lines;
}

function formatPropertySet(propertySet: IfcPropertySetInfo): string {
  const names = propertySet.objects.map((object) => object.globalId ?? object.name ?? `#${object.id}`);
  return `${propertySet.name} (${names.length > 0 ? names.join(", ") : "unassigned"})`;
}

function describeStepValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "missing";
  }
  if (typeof value === "object" && value !== null && "kind" in value) {
    return stepValueToDisplay(value as StepValue);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => describeStepValue(item)).join(", ")}]`;
  }
  return JSON.stringify(value);
}

function textRow(text: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = "empty";
  element.textContent = text;
  return element;
}

function requiredText<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing ${selector}`);
  }
  return element;
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");
}

function hideError(): void {
  errorBanner.textContent = "";
  errorBanner.classList.add("hidden");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

class SchematicViewer {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer | undefined;
  private readonly controls: OrbitControls | undefined;
  private readonly root = new THREE.Group();
  private readonly meshByGlobalId = new Map<string, THREE.Mesh>();
  private readonly fallback = document.createElement("div");
  private readonly available: boolean;
  private animationFrame = 0;

  constructor(private readonly mount: HTMLElement) {
    this.fallback.className = "viewer-fallback";
    this.fallback.textContent = "No geometry yet.";
    this.mount.append(this.fallback);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.position.set(10, 10, 18);

    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setClearColor(0x0f141a, 1);

      controls = new OrbitControls(this.camera, renderer.domElement);
      controls.enableDamping = true;

      this.scene.background = new THREE.Color(0x0f141a);
      const ambient = new THREE.AmbientLight(0xffffff, 1.2);
      const directional = new THREE.DirectionalLight(0xffffff, 1.8);
      directional.position.set(10, 20, 10);
      this.scene.add(ambient, directional, this.root);
      this.scene.add(new THREE.GridHelper(30, 30, 0x61738a, 0x253142));

      window.addEventListener("resize", () => this.resize());
      this.available = true;
      this.renderer = renderer;
      this.controls = controls;
      this.resize();
      this.renderLoop();
    } catch {
      this.available = false;
      this.renderer = undefined;
      this.controls = undefined;
      this.fallback.textContent = "3D viewer unavailable; LOI checks still work.";
    }
  }

  render(model: IfcModel | undefined, check: CheckResult | undefined, selection: Selection | undefined): void {
    if (!this.available || !this.renderer) {
      return;
    }
    this.root.clear();
    this.meshByGlobalId.clear();
    this.root.position.set(0, 0, 0);

    if (!model) {
      this.renderEmpty("No model loaded");
      return;
    }

    this.mount.replaceChildren(this.renderer.domElement);

    const entities = model.hierarchy.length > 0 ? flattenHierarchy(model.hierarchy) : model.document.entities.map((entity) => ({
      id: entity.id,
      type: entity.type,
      globalId: entity.args[0] && typeof entity.args[0] === "object" && "kind" in entity.args[0] && entity.args[0].kind === "string" ? entity.args[0].value : undefined,
      name: entity.args[2] && typeof entity.args[2] === "object" && "kind" in entity.args[2] && entity.args[2].kind === "string" ? entity.args[2].value : undefined
    }));
    const focusEntities = entities.filter((entity) => Boolean(entity.globalId));
    const spacing = 2.1;
    const columns = Math.max(3, Math.ceil(Math.sqrt(Math.max(1, focusEntities.length))));
    const rows = Math.max(1, Math.ceil(focusEntities.length / columns));

    focusEntities.forEach((entity, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const level = entity.type.toUpperCase().includes("SPACE") ? 1.4 : entity.type.toUpperCase().includes("WALL") ? 0.9 : 0.5;
      const geometry = new THREE.BoxGeometry(1.2, level, 1.2);
      const status = selection?.globalId && selection.globalId === entity.globalId ? "selected" : lookupStatus(check, entity.globalId);
      const baseColor = colorForStatus(status);
      const material = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.6, metalness: 0.08 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        (column - (columns - 1) / 2) * spacing,
        level / 2,
        (row - (rows - 1) / 2) * spacing * 0.9
      );
      mesh.userData.globalId = entity.globalId;
      mesh.userData.baseColor = baseColor;
      if (status === "selected") {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry),
          new THREE.LineBasicMaterial({ color: 0xffd166 })
        );
        edges.scale.setScalar(1.06);
        mesh.add(edges);
        mesh.scale.setScalar(1.14);
      }
      this.root.add(mesh);
      if (entity.globalId) {
        this.meshByGlobalId.set(entity.globalId, mesh);
      }
    });

    const bounds = new THREE.Box3().setFromObject(this.root);
    if (!bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3());
      this.root.position.sub(center);
    }

    this.fitCamera();
  }

  renderEmpty(message: string): void {
    if (!this.available || !this.renderer) {
      this.mount.replaceChildren(this.fallback);
      this.fallback.textContent = message;
      this.meshByGlobalId.clear();
      this.root.clear();
      return;
    }
    this.mount.replaceChildren(this.fallback);
    this.fallback.textContent = message;
    this.meshByGlobalId.clear();
    this.root.clear();
  }

  highlight(globalId: string | undefined): void {
    for (const [id, mesh] of this.meshByGlobalId.entries()) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color.set(id === globalId ? 0x7aa2ff : mesh.userData.baseColor ?? 0x5d6a7b);
      material.emissive = new THREE.Color(id === globalId ? 0xffd166 : 0x000000);
      material.emissiveIntensity = id === globalId ? 1.1 : 0;
      mesh.scale.setScalar(id === globalId ? 1.16 : 1);
    }
  }

  private fitCamera(): void {
    if (!this.available || !this.controls) {
      return;
    }
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) {
      this.camera.position.set(10, 10, 18);
      this.controls.target.set(0, 0, 0);
      return;
    }

    const size = box.getSize(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z, 1);
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(maxDimension * 1.2, maxDimension * 0.8, maxDimension * 1.6);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = maxDimension / 100;
    this.camera.far = maxDimension * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private resize(): void {
    if (!this.available || !this.renderer) {
      return;
    }
    const rect = this.mount.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private renderLoop = (): void => {
    this.animationFrame = window.requestAnimationFrame(this.renderLoop);
    if (!this.available || !this.controls || !this.renderer) {
      return;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}

function flattenHierarchy(nodes: Array<{ id: number; type: string; globalId?: string; name?: string; children: Array<any> }>): Array<{ id: number; type: string; globalId?: string; name?: string }> {
  const result: Array<{ id: number; type: string; globalId?: string; name?: string }> = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }
    result.push(node);
    stack.unshift(...node.children);
  }
  return result;
}

function lookupStatus(check: CheckResult | undefined, globalId: string | undefined): "pass" | "fail" | "missing" | "neutral" {
  if (!check || !globalId) {
    return "neutral";
  }
  const target = check.targetResults.find((item) => item.globalId === globalId);
  return target?.status ?? "neutral";
}

function colorForStatus(status: "pass" | "fail" | "missing" | "neutral" | "selected"): number {
  switch (status) {
    case "pass":
      return 0x3bb273;
    case "fail":
      return 0xe45757;
    case "missing":
      return 0xd9a441;
    case "selected":
      return 0x7aa2ff;
    default:
      return 0x5d6a7b;
  }
}

function createInputField(kind: "string" | "number" | "boolean", value: string): { wrapper: HTMLLabelElement; valueInput: HTMLInputElement } {
  const wrapper = document.createElement("label");
  wrapper.className = "fix-field";

  const caption = document.createElement("span");
  caption.textContent = kind === "number" ? "Number" : kind === "boolean" ? "Boolean" : "Text";

  const input = document.createElement("input");
  input.type = kind === "number" ? "number" : "text";
  input.value = value;
  input.spellcheck = false;

  wrapper.append(caption, input);
  return { wrapper, valueInput: input };
}

function createActionButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  return button;
}

function getAttributeText(entity: StepEntity, attributeName: string): string {
  const index = attributeIndex(attributeName);
  if (index < 0 || index >= entity.args.length) {
    return "";
  }
  return stepValueToDisplay(entity.args[index]);
}

function getPropertyText(document: StepDocument, targetId: number, psetName: string, propertyName: string): string {
  const model = buildIfcModel(document);
  const propertySets = model.propertySetsByObjectId.get(targetId) ?? [];
  for (const propertySet of propertySets) {
    if (propertySet.name !== psetName) {
      continue;
    }
    const property = propertySet.properties.find((item) => item.name === propertyName);
    if (property) {
      return property.valueDisplay;
    }
  }
  return "";
}

function attributeIndex(attributeName: string): number {
  const key = attributeName.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const indexMap: Record<string, number> = {
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
  return indexMap[key] ?? -1;
}

function makeTypedNumber(value: number): StepValue {
  return {
    kind: "typed",
    type: "IFCLENGTHMEASURE",
    args: [{ kind: "number", value, raw: String(value) }]
  };
}

function makeEnum(value: "T" | "F" | "U"): StepValue {
  return { kind: "enum", value };
}

function upsertPropertyValue(
  document: StepDocument,
  targetId: number,
  psetName: string,
  propertyName: string,
  value: StepValue
): void {
  const model = buildIfcModel(document);
  const propertySet = (model.propertySetsByObjectId.get(targetId) ?? []).find((item) => item.name === psetName);
  if (propertySet) {
    const propertyEntity = document.entitiesById.get(
      propertySet.properties.find((item) => item.name === propertyName)?.id ?? -1
    );
    if (propertyEntity) {
      propertyEntity.args[2] = value;
      return;
    }

    const newProperty = createEntity(document, "IFCPROPERTYSINGLEVALUE", [
      { kind: "string", value: propertyName },
      { kind: "omitted" },
      value,
      { kind: "omitted" }
    ]);
    const psetEntity = document.entitiesById.get(propertySet.id);
    if (psetEntity) {
      const refs = psetEntity.args[4];
      if (refs?.kind === "list") {
        refs.value.push({ kind: "reference", id: newProperty.id });
      } else {
        psetEntity.args[4] = { kind: "list", value: [{ kind: "reference", id: newProperty.id }] };
      }
    }
    return;
  }

  const property = createEntity(document, "IFCPROPERTYSINGLEVALUE", [
    { kind: "string", value: propertyName },
    { kind: "omitted" },
    value,
    { kind: "omitted" }
  ]);
  const newPropertySet = createEntity(document, "IFCPROPERTYSET", [
    { kind: "string", value: makeGlobalId() },
    { kind: "omitted" },
    { kind: "string", value: psetName },
    { kind: "omitted" },
    { kind: "list", value: [{ kind: "reference", id: property.id }] }
  ]);
  createEntity(document, "IFCRELDEFINESBYPROPERTIES", [
    { kind: "string", value: makeGlobalId() },
    { kind: "omitted" },
    { kind: "omitted" },
    { kind: "omitted" },
    { kind: "list", value: [{ kind: "reference", id: targetId }] },
    { kind: "reference", id: newPropertySet.id }
  ]);
}

function createEntity(document: StepDocument, type: string, args: StepValue[]): StepEntity {
  const id = nextEntityId(document);
  const entity: StepEntity = { id, type, args };
  document.entities.push(entity);
  document.entitiesById.set(id, entity);
  return entity;
}

function nextEntityId(document: StepDocument): number {
  let max = 0;
  for (const id of document.entitiesById.keys()) {
    if (id > max) {
      max = id;
    }
  }
  return max + 1;
}

function makeGlobalId(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  const bytes = new Uint8Array(22);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function downloadCurrentIfc(): void {
  if (!state.currentDocument) {
    throw new Error("Load an IFC file before downloading.");
  }
  const blob = new Blob([serializeStepDocument(state.currentDocument)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sanitizeFilename(state.currentSourceLabel || "edited")}.ifc`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sanitizeFilename(name: string): string {
  return name.replace(/\.(ifc|ifcxml|ifcjson)$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_");
}

viewer = new SchematicViewer(viewerMount);
updateViewerFocus(undefined);

void initialize();

async function initialize(): Promise<void> {
  await loadIfcSource(sampleSource);
}
