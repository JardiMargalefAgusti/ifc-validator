import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as BUI from "@thatopen/ui";
import * as FRAGS from "@thatopen/fragments";

// ============================================
// INITIALIZATION
// ============================================

BUI.Manager.init();

const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);

const world = worlds.create<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBF.PostproductionRenderer
>();

world.name = "IFCViewer";
world.scene = new OBC.SimpleScene(components);
world.scene.setup();
world.scene.three.background = new THREE.Color(0x1a1d23);

// Create viewport
const viewport = BUI.Component.create<BUI.Viewport>(() => {
  return BUI.html`<bim-viewport></bim-viewport>`;
});

world.renderer = new OBF.PostproductionRenderer(components, viewport);
world.camera = new OBC.OrthoPerspectiveCamera(components);
world.camera.threePersp.near = 0.01;
world.camera.threePersp.updateProjectionMatrix();
world.camera.controls.restThreshold = 0.05;

// Grid setup
const grids = components.get(OBC.Grids);
const worldGrid = grids.create(world);
worldGrid.material.uniforms.uColor.value = new THREE.Color(0x494b50);
worldGrid.material.uniforms.uSize1.value = 2;
worldGrid.material.uniforms.uSize2.value = 8;

// Handle resize
const resizeWorld = () => {
  world.renderer?.resize();
  world.camera.updateAspect();
};

viewport.addEventListener("resize", resizeWorld);
window.addEventListener("resize", resizeWorld);

world.dynamicAnchor = false;

components.init();

// Raycasters
components.get(OBC.Raycasters).get(world);

// ============================================
// POSTPRODUCTION
// ============================================

const { postproduction } = world.renderer;
postproduction.enabled = true;
postproduction.style = OBF.PostproductionAspect.COLOR_SHADOWS;

const { aoPass, edgesPass } = world.renderer.postproduction;
edgesPass.color = new THREE.Color(0x494b50);

aoPass.updateGtaoMaterial({
  radius: 0.25,
  distanceExponent: 1,
  thickness: 1,
  scale: 1,
  samples: 16,
  distanceFallOff: 1,
  screenSpaceRadius: true,
});

aoPass.updatePdMaterial({
  lumaPhi: 10,
  depthPhi: 2,
  normalPhi: 3,
  radius: 4,
  radiusExponent: 1,
  rings: 2,
  samples: 16,
});

// ============================================
// FRAGMENTS MANAGER
// ============================================

const fragments = components.get(OBC.FragmentsManager);
fragments.init("/node_modules/@thatopen/fragments/dist/Worker/worker.mjs");

fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
  const isLod = "isLodMaterial" in material && material.isLodMaterial;
  if (isLod) {
    world.renderer!.postproduction.basePass.isolatedMaterials.push(material);
  }
});

world.camera.projection.onChanged.add(() => {
  for (const [, model] of fragments.list) {
    model.useCamera(world.camera.three);
  }
});

world.camera.controls.addEventListener("rest", () => {
  fragments.core.update(true);
});

// ============================================
// IFC LOADER
// ============================================

const ifcLoader = components.get(OBC.IfcLoader);
await ifcLoader.setup({
  autoSetWasm: false,
  wasm: { absolute: true, path: "https://unpkg.com/web-ifc@0.0.71/" },
});

// ============================================
// HIGHLIGHTER
// ============================================

const highlighter = components.get(OBF.Highlighter);
highlighter.setup({
  world,
  selectMaterialDefinition: {
    color: new THREE.Color("#bcf124"),
    renderedFaces: 1,
    opacity: 1,
    transparent: false,
  },
});

// ============================================
// HIDER
// ============================================

const hider = components.get(OBC.Hider);

// ============================================
// CLIPPER
// ============================================

const clipper = components.get(OBC.Clipper);
clipper.enabled = false;

// ============================================
// MEASUREMENTS
// ============================================

const lengthMeasurer = components.get(OBF.LengthMeasurement);
lengthMeasurer.world = world;
lengthMeasurer.color = new THREE.Color("#6528d7");
lengthMeasurer.enabled = false;

const areaMeasurer = components.get(OBF.AreaMeasurement);
areaMeasurer.world = world;
areaMeasurer.color = new THREE.Color("#d92856");
areaMeasurer.enabled = false;

// ============================================
// GHOST MODE
// ============================================

const originalColors = new Map<
  FRAGS.BIMMaterial,
  { color: number; transparent: boolean; opacity: number }
>();

let ghostModeEnabled = false;

const setModelTransparent = () => {
  const materials = [...fragments.core.models.materials.list.values()];
  for (const material of materials) {
    if (material.userData.customId) continue;
    let color: number;
    if ("color" in material) {
      color = material.color.getHex();
    } else {
      color = material.lodColor.getHex();
    }
    originalColors.set(material, {
      color,
      transparent: material.transparent,
      opacity: material.opacity,
    });
    material.transparent = true;
    material.opacity = 0.1;
    material.needsUpdate = true;
    if ("color" in material) {
      material.color.setColorName("white");
    } else {
      material.lodColor.setColorName("white");
    }
  }
  ghostModeEnabled = true;
};

const restoreModelMaterials = () => {
  for (const [material, data] of originalColors) {
    material.transparent = data.transparent;
    material.opacity = data.opacity;
    if ("color" in material) {
      material.color.setHex(data.color);
    } else {
      material.lodColor.setHex(data.color);
    }
    material.needsUpdate = true;
  }
  originalColors.clear();
  ghostModeEnabled = false;
};

// ============================================
// MODEL LOADING
// ============================================

const loadedModels: Map<string, FRAGS.FragmentsModel> = new Map();

fragments.list.onItemSet.add(async ({ value: model }) => {
  model.useCamera(world.camera.three);
  model.getClippingPlanesEvent = () => {
    return Array.from(world.renderer!.three.clippingPlanes) || [];
  };
  world.scene.three.add(model.object);
  await fragments.core.update(true);

  // Store model reference
  loadedModels.set(model.modelId, model);
  updateModelsList();

  // Fit camera
  const bbox = new THREE.Box3().setFromObject(model.object);
  const sphere = new THREE.Sphere();
  bbox.getBoundingSphere(sphere);
  world.camera.controls.fitToSphere(sphere, true);
});

// ============================================
// UI - MODELS LIST (Manual Implementation)
// ============================================

let modelsListContainer: HTMLElement | null = null;

const updateModelsList = () => {
  if (!modelsListContainer) return;

  const items: string[] = [];
  for (const [modelId] of loadedModels) {
    items.push(`
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; background: #2a2d33; border-radius: 4px; margin-bottom: 0.25rem;">
        <span style="color: #ccc; font-size: 12px; overflow: hidden; text-overflow: ellipsis;">${modelId}</span>
        <bim-button icon="mdi:delete" style="--bim-button--bgc: transparent;" data-model-id="${modelId}"></bim-button>
      </div>
    `);
  }

  modelsListContainer.innerHTML = items.length > 0
    ? items.join("")
    : '<span style="color: #666; font-size: 12px;">No hay modelos cargados</span>';

  // Add delete handlers
  modelsListContainer.querySelectorAll("bim-button[data-model-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const modelId = btn.getAttribute("data-model-id");
      if (modelId) {
        const model = loadedModels.get(modelId);
        if (model) {
          world.scene.three.remove(model.object);
          fragments.list.delete(modelId);
          loadedModels.delete(modelId);
          updateModelsList();
        }
      }
    });
  });
};

const onLoadIfc = async () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".ifc";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    await ifcLoader.load(bytes, true, file.name.replace(".ifc", ""));
  };
  input.click();
};

const onExportFrags = async () => {
  for (const [modelId, model] of fragments.list) {
    const buffer = await model.getBuffer();
    const blob = new Blob([new Uint8Array(buffer)]);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${modelId}.frag`;
    link.click();
  }
};

const onDeleteAll = () => {
  // Delete all clipping planes
  clipper.deleteAll();

  // Delete all length measurements
  (lengthMeasurer as any).deleteAll?.() || lengthMeasurer.delete();

  // Delete all area measurements
  (areaMeasurer as any).deleteAll?.() || areaMeasurer.delete();
};

// ============================================
// TOOL MANAGEMENT
// ============================================

let activeTool: string | null = null;

const setTool = (tool: string | null) => {
  // Disable all tools first
  clipper.enabled = false;
  lengthMeasurer.enabled = false;
  areaMeasurer.enabled = false;

  // Re-enable highlighter when no tool is active
  highlighter.enabled = true;

  // Update button states
  updateToolButtons(null);

  if (tool === activeTool) {
    activeTool = null;
    return;
  }
  activeTool = tool;

  if (tool === "clipper") {
    clipper.enabled = true;
    highlighter.enabled = false; // Disable highlighter when clipper is active
  }
  if (tool === "length") {
    lengthMeasurer.enabled = true;
    highlighter.enabled = false;
  }
  if (tool === "area") {
    areaMeasurer.enabled = true;
    highlighter.enabled = false;
  }

  updateToolButtons(tool);
};

const updateToolButtons = (active: string | null) => {
  const buttons = document.querySelectorAll("[data-tool]");
  buttons.forEach(btn => {
    const toolName = btn.getAttribute("data-tool");
    if (toolName === active) {
      (btn as HTMLElement).style.background = "#bcf124";
      (btn as HTMLElement).style.color = "#1a1d23";
    } else {
      (btn as HTMLElement).style.background = "";
      (btn as HTMLElement).style.color = "";
    }
  });
};

viewport.ondblclick = () => {
  if (clipper.enabled) clipper.create(world);
  if (lengthMeasurer.enabled) lengthMeasurer.create();
  if (areaMeasurer.enabled) areaMeasurer.create();
};

window.addEventListener("keydown", (e) => {
  if (e.code === "Delete" || e.code === "Backspace") {
    if (clipper.enabled) clipper.delete(world);
    if (lengthMeasurer.enabled) lengthMeasurer.delete();
    if (areaMeasurer.enabled) areaMeasurer.delete();
  }
  if (e.code === "Enter") {
    if (areaMeasurer.enabled) areaMeasurer.endCreation();
  }
  if (e.code === "Escape") {
    setTool(null);
  }
});

// ============================================
// UI - LEFT PANEL
// ============================================

const leftPanel = BUI.Component.create(() => {
  return BUI.html`
    <bim-panel label="IFC Viewer">
      <bim-panel-section label="Modelos" icon="mdi:file-cad-box">
        <bim-button label="Cargar IFC" icon="mdi:folder-open" @click=${onLoadIfc}></bim-button>
        <bim-button label="Exportar .frag" icon="mdi:download" @click=${onExportFrags}></bim-button>
        <div id="models-list" style="margin-top: 0.5rem;"></div>
      </bim-panel-section>

      <bim-panel-section label="Herramientas" icon="mdi:tools" collapsed>
        <bim-button data-tool="clipper" label="Plano de Sección" icon="mdi:box-cutter" @click=${() => setTool("clipper")}></bim-button>
        <bim-button data-tool="length" label="Medir Longitud" icon="mdi:ruler" @click=${() => setTool("length")}></bim-button>
        <bim-button data-tool="area" label="Medir Área" icon="mdi:texture-box" @click=${() => setTool("area")}></bim-button>
        <bim-button label="Eliminar Todo" icon="mdi:delete" @click=${onDeleteAll}></bim-button>
      </bim-panel-section>
    </bim-panel>
  `;
});

// ============================================
// UI - RIGHT PANEL (Properties)
// ============================================

let propsContainer: HTMLElement | null = null;

// Helper function to extract value from IFC attribute
const extractValue = (attr: unknown): string | number | boolean | null => {
  if (!attr) return null;
  if (typeof attr === "object" && attr !== null && "value" in attr) {
    return (attr as { value: string | number | boolean }).value;
  }
  if (typeof attr === "string" || typeof attr === "number" || typeof attr === "boolean") {
    return attr;
  }
  return null;
};

// Helper function to determine unit from quantity type
const getQuantityUnit = (quantityType: string): string => {
  if (quantityType.includes("Volume")) return "m³";
  if (quantityType.includes("Area")) return "m²";
  if (quantityType.includes("Length") || quantityType.includes("Width") || quantityType.includes("Height") || quantityType.includes("Depth") || quantityType.includes("Perimeter")) return "m";
  if (quantityType.includes("Weight") || quantityType.includes("Mass")) return "kg";
  if (quantityType.includes("Count")) return "ud";
  if (quantityType.includes("Time")) return "s";
  return "";
};

// Helper function to format quantity sets (IfcElementQuantity)
const formatQuantitySets = (rawPsets: unknown[]): { [qsetName: string]: { [qName: string]: { value: number; unit: string } } } => {
  const result: { [qsetName: string]: { [qName: string]: { value: number; unit: string } } } = {};

  for (const pset of rawPsets) {
    if (!pset || typeof pset !== "object") continue;

    const psetObj = pset as { Name?: unknown; type?: string; Quantities?: unknown[] };

    // Only process IfcElementQuantity
    if (psetObj.type !== "IfcElementQuantity") continue;

    const qsetName = extractValue(psetObj.Name);
    if (!qsetName || typeof qsetName !== "string") continue;

    if (!psetObj.Quantities || !Array.isArray(psetObj.Quantities)) continue;

    const quantities: { [qName: string]: { value: number; unit: string } } = {};

    for (const q of psetObj.Quantities) {
      if (!q || typeof q !== "object") continue;
      const qObj = q as { Name?: unknown; type?: string; LengthValue?: unknown; AreaValue?: unknown; VolumeValue?: unknown; WeightValue?: unknown; CountValue?: unknown; TimeValue?: unknown };

      const qName = extractValue(qObj.Name);
      if (!qName || typeof qName !== "string") continue;

      // Get the quantity value based on type
      let value: number | null = null;
      let unit = "";

      if (qObj.LengthValue !== undefined) {
        value = extractValue(qObj.LengthValue) as number;
        unit = "m";
      } else if (qObj.AreaValue !== undefined) {
        value = extractValue(qObj.AreaValue) as number;
        unit = "m²";
      } else if (qObj.VolumeValue !== undefined) {
        value = extractValue(qObj.VolumeValue) as number;
        unit = "m³";
      } else if (qObj.WeightValue !== undefined) {
        value = extractValue(qObj.WeightValue) as number;
        unit = "kg";
      } else if (qObj.CountValue !== undefined) {
        value = extractValue(qObj.CountValue) as number;
        unit = "ud";
      } else if (qObj.TimeValue !== undefined) {
        value = extractValue(qObj.TimeValue) as number;
        unit = "s";
      }

      // If no specific value found, try to infer from type name
      if (value === null && qObj.type) {
        unit = getQuantityUnit(qObj.type);
      }

      if (value !== null && typeof value === "number") {
        quantities[qName] = { value, unit };
      }
    }

    if (Object.keys(quantities).length > 0) {
      result[qsetName] = quantities;
    }
  }

  return result;
};

// Helper function to format property sets
const formatPropertySets = (rawPsets: unknown[]): { [psetName: string]: { [propName: string]: unknown } } => {
  const result: { [psetName: string]: { [propName: string]: unknown } } = {};

  for (const pset of rawPsets) {
    if (!pset || typeof pset !== "object") continue;

    const psetObj = pset as Record<string, unknown>;

    // Skip IfcElementQuantity - handled separately
    if (psetObj.type === "IfcElementQuantity") continue;

    const psetName = extractValue(psetObj.Name) || psetObj.type || "PropertySet";
    if (typeof psetName !== "string") continue;

    const props: { [propName: string]: unknown } = {};

    // Try HasProperties first (standard PropertySet)
    if (psetObj.HasProperties && Array.isArray(psetObj.HasProperties)) {
      for (const prop of psetObj.HasProperties) {
        if (!prop || typeof prop !== "object") continue;
        const propObj = prop as Record<string, unknown>;
        const propName = extractValue(propObj.Name);
        const propValue = extractValue(propObj.NominalValue);

        if (propName && typeof propName === "string" && propValue !== undefined && propValue !== null) {
          props[propName] = propValue;
        }
      }
    }

    // Also check for direct properties (for TypeObjects)
    for (const [key, value] of Object.entries(psetObj)) {
      if (["Name", "type", "HasProperties", "GlobalId", "OwnerHistory", "Description"].includes(key)) continue;
      const extracted = extractValue(value);
      if (extracted !== null && typeof extracted !== "object") {
        props[key] = extracted;
      }
    }

    if (Object.keys(props).length > 0) {
      result[String(psetName)] = props;
    }
  }

  return result;
};

const updatePropertiesPanel = async (modelIdMap: OBC.ModelIdMap) => {
  if (!propsContainer) return;

  const isEmpty = Object.keys(modelIdMap).length === 0;

  if (isEmpty) {
    propsContainer.innerHTML = '<span style="color: #666; font-size: 12px;">Selecciona un elemento para ver sus propiedades</span>';
    return;
  }

  propsContainer.innerHTML = '<span style="color: #888; font-size: 12px;">Cargando propiedades...</span>';

  const propsHtml: string[] = [];

  for (const [modelId, idsSet] of Object.entries(modelIdMap)) {
    const model = fragments.list.get(modelId);
    if (!model) continue;

    const ids = Array.from(idsSet);

    for (const localId of ids) {
      try {
        // First, try to get basic properties
        let dataObj: Record<string, unknown> = {};

        // Try getItemsData with relations - attributesDefault MUST be false for PropertySets
        try {
          const itemsData = await model.getItemsData([localId], {
            attributesDefault: false, // CRITICAL: Must be false to get PropertySets
            attributes: [
              "Name", "GlobalId", "ObjectType", "Description", "Tag",
              "PredefinedType", "LongName", "NominalValue"
            ],
            relations: {
              IsDefinedBy: {
                attributes: true,
                relations: true,
              },
              IsTypedBy: {
                attributes: true,
                relations: true,
              },
              ContainedInStructure: {
                attributes: true,
                relations: true,
              },
              HasAssociations: {
                attributes: true,
                relations: true,
              },
              Decomposes: {
                attributes: true,
                relations: true,
              },
              IsNestedBy: {
                attributes: true,
                relations: true,
              },
            },
          });

          if (itemsData && itemsData[0]) {
            dataObj = itemsData[0] as Record<string, unknown>;
          }
        } catch (e) {
          console.warn("getItemsData failed", e);
        }

        // If still no data, create minimal entry
        if (Object.keys(dataObj).length === 0) {
          dataObj = { type: "Unknown" };
        }

        // Log data for debugging
        console.log(`Element ${localId} data:`, dataObj);

        const name = extractValue(dataObj.Name) || (dataObj.type as string) || `Element ${localId}`;
        const globalId = extractValue(dataObj.GlobalId);
        const objectType = extractValue(dataObj.ObjectType);
        const description = extractValue(dataObj.Description);
        const tag = extractValue(dataObj.Tag);
        const predefinedType = extractValue(dataObj.PredefinedType);
        const longName = extractValue(dataObj.LongName);

        // Collect all direct attributes (non-relation properties)
        const directAttributes: { [key: string]: unknown } = {};
        const skipKeys = ["IsDefinedBy", "IsTypedBy", "ContainedInStructure", "HasAssociations",
                         "Representation", "ObjectPlacement", "OwnerHistory", "type"];
        for (const [key, value] of Object.entries(dataObj)) {
          if (!skipKeys.includes(key) && value !== null && value !== undefined) {
            const extracted = extractValue(value);
            if (extracted !== null) {
              directAttributes[key] = extracted;
            }
          }
        }

        // Get type information and type properties
        let typeInfo = "";
        let typeProperties: { [key: string]: unknown } = {};
        if (dataObj.IsTypedBy && Array.isArray(dataObj.IsTypedBy)) {
          for (const rel of dataObj.IsTypedBy) {
            const relObj = rel as Record<string, unknown>;
            const typeName = extractValue(relObj.Name);
            if (typeName) {
              typeInfo = String(typeName);
            }
            // Extract type properties
            for (const [key, value] of Object.entries(relObj)) {
              if (["Name", "type", "GlobalId", "OwnerHistory", "Description", "HasPropertySets"].includes(key)) continue;
              const extracted = extractValue(value);
              if (extracted !== null && typeof extracted !== "object") {
                typeProperties[key] = extracted;
              }
            }
            // Also check HasPropertySets on type
            if (relObj.HasPropertySets && Array.isArray(relObj.HasPropertySets)) {
              const typePsets = formatPropertySets(relObj.HasPropertySets);
              for (const [psetName, props] of Object.entries(typePsets)) {
                typeProperties[`[${psetName}]`] = Object.entries(props).map(([k, v]) => `${k}: ${v}`).join(", ");
              }
            }
          }
        }

        // Get spatial containment
        let spatialContainer = "";
        if (dataObj.ContainedInStructure && Array.isArray(dataObj.ContainedInStructure)) {
          for (const rel of dataObj.ContainedInStructure) {
            const relObj = rel as Record<string, unknown>;
            const containerName = extractValue(relObj.Name);
            if (containerName) {
              spatialContainer = String(containerName);
              break;
            }
          }
        }

        // Get materials from HasAssociations
        const materials: string[] = [];
        if (dataObj.HasAssociations && Array.isArray(dataObj.HasAssociations)) {
          for (const assoc of dataObj.HasAssociations) {
            const assocObj = assoc as Record<string, unknown>;
            if (assocObj.type === "IfcRelAssociatesMaterial") {
              const matName = extractValue(assocObj.Name);
              if (matName) materials.push(String(matName));
            }
          }
        }

        // Build basic info HTML
        let html = `
          <div style="background: #2a2d33; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.75rem;">
            <div style="color: #bcf124; font-weight: bold; font-size: 14px; margin-bottom: 0.5rem; border-bottom: 1px solid #3a3d43; padding-bottom: 0.5rem;">
              ${name}
            </div>

            <!-- Identification Section -->
            <details open style="margin-bottom: 0.5rem;">
              <summary style="color: #7eb8da; font-size: 12px; cursor: pointer; padding: 0.25rem 0; font-weight: bold;">
                Identificación
              </summary>
              <div style="padding-left: 0.5rem; margin-top: 0.25rem; font-size: 11px; line-height: 1.8;">
                <div><span style="color: #666;">Express ID:</span> <span style="color: #aaa;">${localId}</span></div>
                ${globalId ? `<div><span style="color: #666;">GlobalId:</span> <span style="color: #aaa;">${globalId}</span></div>` : ""}
                ${dataObj.type ? `<div><span style="color: #666;">Clase IFC:</span> <span style="color: #aaa;">${dataObj.type}</span></div>` : ""}
                ${predefinedType ? `<div><span style="color: #666;">Tipo Predefinido:</span> <span style="color: #aaa;">${predefinedType}</span></div>` : ""}
                ${objectType ? `<div><span style="color: #666;">Tipo de Objeto:</span> <span style="color: #aaa;">${objectType}</span></div>` : ""}
                ${typeInfo ? `<div><span style="color: #666;">Tipo (IfcType):</span> <span style="color: #aaa;">${typeInfo}</span></div>` : ""}
                ${tag ? `<div><span style="color: #666;">Tag:</span> <span style="color: #aaa;">${tag}</span></div>` : ""}
              </div>
            </details>

            <!-- Description Section -->
            ${description || longName ? `
            <details style="margin-bottom: 0.5rem;">
              <summary style="color: #7eb8da; font-size: 12px; cursor: pointer; padding: 0.25rem 0; font-weight: bold;">
                Descripción
              </summary>
              <div style="padding-left: 0.5rem; margin-top: 0.25rem; font-size: 11px; line-height: 1.8;">
                ${description ? `<div><span style="color: #666;">Descripción:</span> <span style="color: #aaa;">${description}</span></div>` : ""}
                ${longName ? `<div><span style="color: #666;">Nombre Largo:</span> <span style="color: #aaa;">${longName}</span></div>` : ""}
              </div>
            </details>
            ` : ""}

            <!-- Location Section -->
            ${spatialContainer ? `
            <details style="margin-bottom: 0.5rem;">
              <summary style="color: #7eb8da; font-size: 12px; cursor: pointer; padding: 0.25rem 0; font-weight: bold;">
                Ubicación
              </summary>
              <div style="padding-left: 0.5rem; margin-top: 0.25rem; font-size: 11px; line-height: 1.8;">
                <div><span style="color: #666;">Contenedor:</span> <span style="color: #aaa;">${spatialContainer}</span></div>
              </div>
            </details>
            ` : ""}

            <!-- Materials Section -->
            ${materials.length > 0 ? `
            <details style="margin-bottom: 0.5rem;">
              <summary style="color: #7eb8da; font-size: 12px; cursor: pointer; padding: 0.25rem 0; font-weight: bold;">
                Materiales (${materials.length})
              </summary>
              <div style="padding-left: 0.5rem; margin-top: 0.25rem; font-size: 11px; line-height: 1.8;">
                ${materials.map(m => `<div style="color: #aaa;">• ${m}</div>`).join("")}
              </div>
            </details>
            ` : ""}

            <!-- Type Properties Section -->
            ${Object.keys(typeProperties).length > 0 ? `
            <details style="margin-bottom: 0.5rem;">
              <summary style="color: #7eb8da; font-size: 12px; cursor: pointer; padding: 0.25rem 0; font-weight: bold;">
                Propiedades del Tipo (${Object.keys(typeProperties).length})
              </summary>
              <div style="padding-left: 0.5rem; margin-top: 0.25rem; font-size: 11px; line-height: 1.6;">
                ${Object.entries(typeProperties).map(([k, v]) => {
                  let displayVal = v;
                  if (typeof v === "number" && !Number.isInteger(v)) {
                    displayVal = (v as number).toFixed(4);
                  } else if (typeof v === "boolean") {
                    displayVal = v ? "Sí" : "No";
                  }
                  return `<div style="display: flex; justify-content: space-between;">
                    <span style="color: #d98928;">${k}:</span>
                    <span style="color: #aaa; max-width: 60%; text-align: right; word-break: break-word;">${displayVal}</span>
                  </div>`;
                }).join("")}
              </div>
            </details>
            ` : ""}

            <!-- All Attributes Section -->
            ${Object.keys(directAttributes).length > 0 ? `
            <details style="margin-bottom: 0.5rem;">
              <summary style="color: #7eb8da; font-size: 12px; cursor: pointer; padding: 0.25rem 0; font-weight: bold;">
                Atributos (${Object.keys(directAttributes).length})
              </summary>
              <div style="padding-left: 0.5rem; margin-top: 0.25rem; font-size: 11px; line-height: 1.6;">
                ${Object.entries(directAttributes).map(([k, v]) => {
                  let displayVal = v;
                  if (typeof v === "number" && !Number.isInteger(v)) {
                    displayVal = (v as number).toFixed(4);
                  } else if (typeof v === "boolean") {
                    displayVal = v ? "Sí" : "No";
                  }
                  return `<div style="display: flex; justify-content: space-between;">
                    <span style="color: #666;">${k}:</span>
                    <span style="color: #aaa; max-width: 60%; text-align: right; word-break: break-word;">${displayVal}</span>
                  </div>`;
                }).join("")}
              </div>
            </details>
            ` : ""}
        `;

        // Process Property Sets
        if (dataObj.IsDefinedBy && Array.isArray(dataObj.IsDefinedBy) && dataObj.IsDefinedBy.length > 0) {
          const propertySets = formatPropertySets(dataObj.IsDefinedBy);
          const psetCount = Object.keys(propertySets).length;

          if (psetCount > 0) {
            html += `
            <details style="margin-bottom: 0.5rem;">
              <summary style="color: #7eb8da; font-size: 12px; cursor: pointer; padding: 0.25rem 0; font-weight: bold;">
                Property Sets (${psetCount})
              </summary>
              <div style="padding-left: 0.5rem; margin-top: 0.25rem;">
            `;

            for (const [psetName, props] of Object.entries(propertySets)) {
              html += `
                <details style="margin-bottom: 0.25rem;">
                  <summary style="color: #bcf124; font-size: 11px; cursor: pointer; padding: 0.15rem 0;">
                    ${psetName} (${Object.keys(props).length})
                  </summary>
                  <div style="padding-left: 0.5rem; margin-top: 0.15rem; border-left: 2px solid #3a3d43;">
              `;

              for (const [propName, propValue] of Object.entries(props)) {
                // Format value based on type
                let displayValue = propValue;
                if (typeof propValue === "number") {
                  displayValue = Number.isInteger(propValue) ? propValue : (propValue as number).toFixed(4);
                } else if (typeof propValue === "boolean") {
                  displayValue = propValue ? "Sí" : "No";
                }

                html += `
                  <div style="font-size: 10px; color: #888; padding: 0.1rem 0; display: flex; justify-content: space-between;">
                    <span style="color: #666;">${propName}:</span>
                    <span style="color: #aaa; text-align: right; max-width: 60%; word-break: break-word;">${displayValue}</span>
                  </div>
                `;
              }

              html += `</div></details>`;
            }

            html += `</div></details>`;
          }
        }

        // Process Quantity Sets (from IsDefinedBy - IfcElementQuantity)
        if (dataObj.IsDefinedBy && Array.isArray(dataObj.IsDefinedBy)) {
          const quantitySets = formatQuantitySets(dataObj.IsDefinedBy);
          const qsetCount = Object.keys(quantitySets).length;

          if (qsetCount > 0) {
            html += `
            <details style="margin-bottom: 0.5rem;">
              <summary style="color: #7eb8da; font-size: 12px; cursor: pointer; padding: 0.25rem 0; font-weight: bold;">
                Cantidades (${qsetCount})
              </summary>
              <div style="padding-left: 0.5rem; margin-top: 0.25rem;">
            `;

            for (const [qsetName, quantities] of Object.entries(quantitySets)) {
              html += `
                <details style="margin-bottom: 0.25rem;">
                  <summary style="color: #d98928; font-size: 11px; cursor: pointer; padding: 0.15rem 0;">
                    ${qsetName} (${Object.keys(quantities).length})
                  </summary>
                  <div style="padding-left: 0.5rem; margin-top: 0.15rem; border-left: 2px solid #d98928;">
              `;

              for (const [qName, qData] of Object.entries(quantities)) {
                const qInfo = qData as { value: number; unit: string };
                html += `
                  <div style="font-size: 10px; color: #888; padding: 0.1rem 0; display: flex; justify-content: space-between;">
                    <span style="color: #666;">${qName}:</span>
                    <span style="color: #d98928; font-weight: bold;">${qInfo.value.toFixed(3)} ${qInfo.unit}</span>
                  </div>
                `;
              }

              html += `</div></details>`;
            }

            html += `</div></details>`;
          }
        }

        html += `</div>`;
        propsHtml.push(html);

      } catch (e) {
        console.error("Error getting properties for element", localId, e);
      }
    }
  }

  propsContainer.innerHTML = propsHtml.length > 0
    ? propsHtml.join("")
    : '<span style="color: #666; font-size: 12px;">No se pudieron obtener propiedades</span>';
};

highlighter.events.select.onHighlight.add((modelIdMap) => {
  updatePropertiesPanel(modelIdMap);
});

highlighter.events.select.onClear.add(() => {
  updatePropertiesPanel({});
});

const rightPanel = BUI.Component.create(() => {
  return BUI.html`
    <bim-panel label="Propiedades">
      <bim-panel-section label="Elemento Seleccionado" icon="mdi:clipboard-text">
        <div id="props-container" style="max-height: calc(100vh - 150px); overflow-y: auto;">
          <span style="color: #666; font-size: 12px;">Selecciona un elemento para ver sus propiedades</span>
        </div>
      </bim-panel-section>
    </bim-panel>
  `;
});

// ============================================
// UI - VIEWPORT TOOLBAR
// ============================================

const onFocus = async () => {
  const selection = highlighter.selection.select;
  if (OBC.ModelIdMapUtils.isEmpty(selection)) {
    const bbox = new THREE.Box3();
    for (const [, model] of fragments.list) {
      bbox.expandByObject(model.object);
    }
    if (!bbox.isEmpty()) {
      const sphere = new THREE.Sphere();
      bbox.getBoundingSphere(sphere);
      world.camera.controls.fitToSphere(sphere, true);
    }
  } else {
    await world.camera.fitToItems(selection);
  }
};

const onHide = async () => {
  const selection = highlighter.selection.select;
  if (!OBC.ModelIdMapUtils.isEmpty(selection)) {
    await hider.set(false, selection);
  }
};

const onIsolate = async () => {
  const selection = highlighter.selection.select;
  if (!OBC.ModelIdMapUtils.isEmpty(selection)) {
    await hider.isolate(selection);
  }
};

const onShowAll = async () => {
  await hider.set(true);
};

const onGhost = () => {
  if (ghostModeEnabled) {
    restoreModelMaterials();
  } else {
    setModelTransparent();
  }
};

const viewportToolbar = BUI.Component.create(() => {
  return BUI.html`
    <bim-toolbar style="position: absolute; bottom: 1rem; left: 50%; transform: translateX(-50%); z-index: 100;">
      <bim-toolbar-section label="Vista">
        <bim-button icon="mdi:target" label="Enfocar" @click=${onFocus}></bim-button>
        <bim-button icon="mdi:ghost" label="Ghost" @click=${onGhost}></bim-button>
      </bim-toolbar-section>
      <bim-toolbar-section label="Selección">
        <bim-button icon="mdi:eye" label="Mostrar Todo" @click=${onShowAll}></bim-button>
        <bim-button icon="mdi:eye-off" label="Ocultar" @click=${onHide}></bim-button>
        <bim-button icon="mdi:selection" label="Aislar" @click=${onIsolate}></bim-button>
      </bim-toolbar-section>
    </bim-toolbar>
  `;
});

// ============================================
// UI - VIEWPORT SETTINGS
// ============================================

const viewportSettings = BUI.Component.create(() => {
  const onGridToggle = (e: Event) => {
    worldGrid.visible = (e.target as BUI.Checkbox).checked;
  };

  const onProjection = (e: Event) => {
    const [proj] = (e.target as BUI.Dropdown).value;
    if (proj) world.camera.projection.set(proj);
  };

  return BUI.html`
    <bim-button style="position: absolute; top: 0.5rem; right: 0.5rem; z-index: 100; background: transparent;" icon="mdi:cog">
      <bim-context-menu style="width: 12rem;">
        <bim-checkbox ?checked=${worldGrid.visible} label="Mostrar Grid" @change=${onGridToggle}></bim-checkbox>
        <bim-dropdown label="Proyección" @change=${onProjection}>
          <bim-option label="Perspective" ?checked=${world.camera.projection.current === "Perspective"}></bim-option>
          <bim-option label="Orthographic" ?checked=${world.camera.projection.current === "Orthographic"}></bim-option>
        </bim-dropdown>
      </bim-context-menu>
    </bim-button>
  `;
});

// Append to viewport
viewport.append(viewportToolbar);
viewport.append(viewportSettings);

// ============================================
// MAIN LAYOUT
// ============================================

const app = document.getElementById("app") as BUI.Grid;

app.layouts = {
  main: {
    template: `
      "leftPanel viewport rightPanel" 1fr
      / 280px 1fr 300px
    `,
    elements: {
      leftPanel,
      viewport,
      rightPanel,
    },
  },
};

(app as any).layout = "main";

// Get references to containers after layout is set
setTimeout(() => {
  modelsListContainer = document.getElementById("models-list");
  propsContainer = document.getElementById("props-container");
  updateModelsList();
}, 100);

// ============================================
// PARENT COMMUNICATION (Streamlit)
// ============================================

window.addEventListener("message", async (event) => {
  const { type, data, fileName } = event.data;
  if (type === "loadIFC") {
    try {
      const binaryString = atob(data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      await ifcLoader.load(bytes, true, fileName.replace(/\.(ifc|IFC)$/, ""));
      window.parent.postMessage({ type: "ifcLoaded", success: true }, "*");
    } catch (error) {
      console.error("Error loading IFC:", error);
      window.parent.postMessage({ type: "ifcLoaded", success: false, error: String(error) }, "*");
    }
  }
});

window.parent.postMessage({ type: "viewerReady" }, "*");

console.log("IFC Viewer initialized successfully");
