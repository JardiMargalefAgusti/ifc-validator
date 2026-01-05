import streamlit as st
import streamlit.components.v1 as components
import ifcopenshell
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from io import BytesIO
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
import json
import tempfile
import os
import base64


# ============================================
# CONFIGURACIÓN DE LA PÁGINA
# ============================================
st.set_page_config(
    page_title="IFC Quality Validation Tool",
    page_icon="🏗️",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Estilos CSS personalizados
st.markdown("""
<style>
    .main-header {
        font-size: 2.5rem;
        color: #1976D2;
        text-align: center;
        margin-bottom: 1rem;
    }
    .metric-card {
        background-color: #f0f2f6;
        border-radius: 10px;
        padding: 1rem;
        margin: 0.5rem 0;
    }
    .success-text { color: #4CAF50; }
    .error-text { color: #F44336; }
    .warning-text { color: #FF9800; }
    .ifc-viewer-container {
        width: 100%;
        height: 600px;
        border: 1px solid #ddd;
        border-radius: 8px;
        overflow: hidden;
    }
</style>
""", unsafe_allow_html=True)


# ============================================
# VISOR 3D - MICROSERVICIO THAT OPEN COMPONENTS
# ============================================

# URL del microservicio del visor (desde el navegador del cliente)
# En desarrollo local: http://localhost:3000
# En producción Docker: usar la URL pública del servicio viewer
VIEWER_URL = os.environ.get("IFC_VIEWER_URL", "http://localhost:3000")


def render_ifc_viewer(ifc_file_bytes: bytes, filename: str, height: int = 650):
    """
    Renderiza el visor IFC usando el microservicio That Open Components.
    El archivo IFC se pasa al visor mediante postMessage.
    """
    # Codificar el archivo IFC en base64 para pasarlo al iframe
    ifc_base64 = base64.b64encode(ifc_file_bytes).decode('utf-8')

    # HTML que contiene el iframe y el script para comunicarse con el visor
    html_content = f'''
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            * {{
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }}
            body {{
                width: 100%;
                height: 100vh;
                overflow: hidden;
            }}
            #viewer-frame {{
                width: 100%;
                height: 100%;
                border: none;
            }}
            #loading-overlay {{
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(26, 29, 35, 0.9);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                color: white;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                z-index: 1000;
            }}
            .spinner {{
                width: 50px;
                height: 50px;
                border: 4px solid rgba(255,255,255,0.3);
                border-top-color: #4a90d9;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin-bottom: 15px;
            }}
            @keyframes spin {{
                to {{ transform: rotate(360deg); }}
            }}
            #status-text {{
                font-size: 14px;
                color: #888;
            }}
            .hidden {{
                display: none !important;
            }}
        </style>
    </head>
    <body>
        <div id="loading-overlay">
            <div class="spinner"></div>
            <div id="status-text">Conectando con el visor...</div>
        </div>
        <iframe id="viewer-frame" src="{VIEWER_URL}"></iframe>

        <script>
            const iframe = document.getElementById('viewer-frame');
            const loadingOverlay = document.getElementById('loading-overlay');
            const statusText = document.getElementById('status-text');

            const ifcData = "{ifc_base64}";
            const fileName = "{filename}";

            let viewerReady = false;

            // Escuchar mensajes del visor
            window.addEventListener('message', (event) => {{
                if (event.data.type === 'viewerReady') {{
                    viewerReady = true;
                    statusText.textContent = 'Cargando modelo IFC...';

                    // Enviar el archivo IFC al visor
                    iframe.contentWindow.postMessage({{
                        type: 'loadIFC',
                        data: ifcData,
                        fileName: fileName
                    }}, '*');
                }}

                if (event.data.type === 'ifcLoaded') {{
                    if (event.data.success) {{
                        loadingOverlay.classList.add('hidden');
                    }} else {{
                        statusText.textContent = 'Error: ' + (event.data.error || 'No se pudo cargar el modelo');
                        statusText.style.color = '#ff4444';
                    }}
                }}
            }});

            // Timeout si el visor no responde
            setTimeout(() => {{
                if (!viewerReady) {{
                    statusText.innerHTML = 'No se pudo conectar con el visor.<br><small>Asegurate de que el servidor del visor este ejecutandose en {VIEWER_URL}</small>';
                    statusText.style.color = '#ff9800';
                }}
            }}, 10000);
        </script>
    </body>
    </html>
    '''

    components.html(html_content, height=height, scrolling=False)


def render_ifc_viewer_standalone(height: int = 650):
    """
    Renderiza el visor IFC vacío (sin modelo precargado).
    El usuario puede cargar un archivo directamente desde el visor.
    """
    html_content = f'''
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            * {{
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }}
            body {{
                width: 100%;
                height: 100vh;
                overflow: hidden;
            }}
            #viewer-frame {{
                width: 100%;
                height: 100%;
                border: none;
            }}
        </style>
    </head>
    <body>
        <iframe id="viewer-frame" src="{VIEWER_URL}"></iframe>
    </body>
    </html>
    '''

    components.html(html_content, height=height, scrolling=False)


# ============================================
# FUNCIONES DE VALIDACIÓN (Misma lógica que VIKTOR)
# ============================================

def get_property_value(entity, property_set_name: str, property_name: str):
    """Obtiene el valor de una propiedad de una entidad IFC"""
    try:
        if hasattr(entity, 'IsDefinedBy'):
            for definition in entity.IsDefinedBy:
                if definition.is_a('IfcRelDefinesByProperties'):
                    property_set = definition.RelatingPropertyDefinition
                    if property_set.is_a('IfcPropertySet'):
                        if property_set.Name == property_set_name:
                            for prop in property_set.HasProperties:
                                if prop.Name == property_name:
                                    if hasattr(prop, 'NominalValue'):
                                        return prop.NominalValue.wrappedValue
    except Exception:
        pass
    return None


def get_entity_location(entity) -> str:
    """Obtiene la ubicación (piso) de una entidad"""
    try:
        if hasattr(entity, 'ContainedInStructure'):
            for rel in entity.ContainedInStructure:
                if rel.is_a('IfcRelContainedInSpatialStructure'):
                    spatial_element = rel.RelatingStructure
                    if spatial_element.is_a('IfcBuildingStorey'):
                        return getattr(spatial_element, 'Name', 'Unknown Storey')
    except Exception:
        pass
    return 'Unknown'


def validate_geometry(ifc_model) -> list:
    """Valida la presencia de geometría en entidades clave"""
    results = []
    entity_types = ['IfcWall', 'IfcDoor', 'IfcWindow', 'IfcSlab', 'IfcColumn', 'IfcBeam']

    for entity_type in entity_types:
        try:
            entities = ifc_model.by_type(entity_type)
            for entity in entities:
                has_geometry = hasattr(entity, 'Representation') and entity.Representation is not None

                results.append({
                    'entity_type': entity_type,
                    'global_id': getattr(entity, 'GlobalId', 'N/A'),
                    'element_name': getattr(entity, 'Name', 'Unnamed'),
                    'check_description': 'Geometry presence check',
                    'expected_value': 'Has valid geometry',
                    'actual_value': 'Geometry present' if has_geometry else 'No geometry',
                    'status': 'Pass' if has_geometry else 'Fail',
                    'error_level': 'Warning' if not has_geometry else 'Info',
                    'location': get_entity_location(entity)
                })
        except Exception:
            continue

    return results


def validate_spatial_structure(ifc_model) -> list:
    """Valida la estructura espacial jerárquica"""
    results = []

    try:
        sites = ifc_model.by_type('IfcSite')
        buildings = ifc_model.by_type('IfcBuilding')
        storeys = ifc_model.by_type('IfcBuildingStorey')

        results.append({
            'entity_type': 'IfcProject',
            'global_id': 'N/A',
            'element_name': 'Spatial Structure',
            'check_description': 'Site exists in model',
            'expected_value': 'At least 1 site',
            'actual_value': f'{len(sites)} site(s)',
            'status': 'Pass' if len(sites) > 0 else 'Fail',
            'error_level': 'Critical' if len(sites) == 0 else 'Info',
            'location': 'Project'
        })

        results.append({
            'entity_type': 'IfcProject',
            'global_id': 'N/A',
            'element_name': 'Spatial Structure',
            'check_description': 'Building exists in model',
            'expected_value': 'At least 1 building',
            'actual_value': f'{len(buildings)} building(s)',
            'status': 'Pass' if len(buildings) > 0 else 'Fail',
            'error_level': 'Critical' if len(buildings) == 0 else 'Info',
            'location': 'Project'
        })

        results.append({
            'entity_type': 'IfcProject',
            'global_id': 'N/A',
            'element_name': 'Spatial Structure',
            'check_description': 'Building storeys exist in model',
            'expected_value': 'At least 1 storey',
            'actual_value': f'{len(storeys)} storey(s)',
            'status': 'Pass' if len(storeys) > 0 else 'Fail',
            'error_level': 'Warning' if len(storeys) == 0 else 'Info',
            'location': 'Project'
        })
    except Exception:
        pass

    return results


def validate_classification(ifc_model) -> list:
    """Valida las referencias de clasificación"""
    results = []

    try:
        classifications = ifc_model.by_type('IfcClassification')

        results.append({
            'entity_type': 'IfcProject',
            'global_id': 'N/A',
            'element_name': 'Classification',
            'check_description': 'Classification system defined',
            'expected_value': 'At least 1 classification system',
            'actual_value': f'{len(classifications)} system(s)',
            'status': 'Pass' if len(classifications) > 0 else 'Fail',
            'error_level': 'Info',
            'location': 'Project'
        })

        entity_types = ['IfcWall', 'IfcDoor', 'IfcWindow']
        for entity_type in entity_types:
            try:
                entities = ifc_model.by_type(entity_type)
                classified_count = 0

                for entity in entities:
                    if hasattr(entity, 'HasAssociations'):
                        for assoc in entity.HasAssociations:
                            if assoc.is_a('IfcRelAssociatesClassification'):
                                classified_count += 1
                                break

                if len(entities) > 0:
                    percentage = (classified_count / len(entities)) * 100
                    results.append({
                        'entity_type': entity_type,
                        'global_id': 'N/A',
                        'element_name': 'Classification Coverage',
                        'check_description': f'{entity_type} classification coverage',
                        'expected_value': '100% classified',
                        'actual_value': f'{percentage:.1f}% classified ({classified_count}/{len(entities)})',
                        'status': 'Pass' if percentage == 100 else 'Fail',
                        'error_level': 'Info',
                        'location': 'Project'
                    })
            except Exception:
                continue
    except Exception:
        pass

    return results


def perform_validation(ifc_model, requirements_df: pd.DataFrame, options: dict) -> list:
    """Ejecuta todas las validaciones sobre el modelo IFC"""
    results = []

    for _, rule in requirements_df.iterrows():
        entity_type = rule['Entity_Type']
        property_set = rule['Property_Set']
        property_name = rule['Property_Name']
        required = str(rule.get('Required', 'No')).strip().lower() == 'yes'
        allowed_values = rule.get('Allowed_Values', '')
        min_value = rule.get('Min_Value', '')
        max_value = rule.get('Max_Value', '')
        error_level = rule.get('Error_Level', 'Warning')

        try:
            entities = ifc_model.by_type(entity_type)
        except Exception:
            continue

        for entity in entities:
            global_id = getattr(entity, 'GlobalId', 'N/A')
            element_name = getattr(entity, 'Name', 'Unnamed')
            location = get_entity_location(entity)

            property_value = get_property_value(entity, property_set, property_name)

            if property_value is None:
                if required:
                    results.append({
                        'entity_type': entity_type,
                        'global_id': global_id,
                        'element_name': element_name,
                        'check_description': f'Property {property_name} in {property_set}',
                        'expected_value': 'Property exists',
                        'actual_value': 'Property not found',
                        'status': 'Fail',
                        'error_level': error_level,
                        'location': location
                    })
                else:
                    results.append({
                        'entity_type': entity_type,
                        'global_id': global_id,
                        'element_name': element_name,
                        'check_description': f'Property {property_name} in {property_set}',
                        'expected_value': 'Optional property',
                        'actual_value': 'Property not found',
                        'status': 'Pass',
                        'error_level': 'Info',
                        'location': location
                    })
            else:
                validation_passed = True
                expected_value = ''
                actual_value = str(property_value)

                if allowed_values and str(allowed_values).strip():
                    allowed_list = [v.strip() for v in str(allowed_values).split(',')]
                    if str(property_value) not in allowed_list:
                        validation_passed = False
                        expected_value = f'One of: {allowed_values}'

                if min_value or max_value:
                    try:
                        numeric_value = float(property_value)
                        if min_value and numeric_value < float(min_value):
                            validation_passed = False
                            expected_value = f'>= {min_value}'
                        if max_value and numeric_value > float(max_value):
                            validation_passed = False
                            expected_value = f'<= {max_value}'
                    except (ValueError, TypeError):
                        pass

                if not expected_value:
                    expected_value = 'Valid value'

                results.append({
                    'entity_type': entity_type,
                    'global_id': global_id,
                    'element_name': element_name,
                    'check_description': f'Property {property_name} in {property_set}',
                    'expected_value': expected_value,
                    'actual_value': actual_value,
                    'status': 'Pass' if validation_passed else 'Fail',
                    'error_level': error_level if not validation_passed else 'Info',
                    'location': location
                })

    # Validaciones adicionales según opciones
    if options.get('validate_geometry', True):
        results.extend(validate_geometry(ifc_model))

    if options.get('validate_spatial', True):
        results.extend(validate_spatial_structure(ifc_model))

    if options.get('validate_classification', True):
        results.extend(validate_classification(ifc_model))

    return results


# ============================================
# FUNCIONES DE EXPORTACIÓN
# ============================================

def create_excel_template():
    """Genera la plantilla Excel de requisitos"""
    template_data = {
        'Entity_Type': ['IfcWall', 'IfcWall', 'IfcDoor', 'IfcSpace', 'IfcBuildingStorey'],
        'Property_Set': ['Pset_WallCommon', 'Pset_WallCommon', 'Pset_DoorCommon',
                        'Pset_SpaceCommon', 'Pset_BuildingStoreyCommon'],
        'Property_Name': ['IsExternal', 'FireRating', 'FireRating', 'GrossFloorArea', 'Elevation'],
        'Data_Type': ['Boolean', 'String', 'String', 'Double', 'Double'],
        'Required': ['Yes', 'Yes', 'Yes', 'No', 'Yes'],
        'Allowed_Values': ['True,False', 'REI60,REI90,REI120', '', '', ''],
        'Min_Value': ['', '', '', '0', ''],
        'Max_Value': ['', '', '', '1000', ''],
        'Validation_Rule': ['', '', '', '', ''],
        'Error_Level': ['Critical', 'Critical', 'Warning', 'Info', 'Critical']
    }

    df = pd.DataFrame(template_data)
    output = BytesIO()

    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, sheet_name='Validation Rules', index=False)

        instructions = pd.DataFrame({
            'Column Name': [
                'Entity_Type', 'Property_Set', 'Property_Name', 'Data_Type',
                'Required', 'Allowed_Values', 'Min_Value', 'Max_Value',
                'Validation_Rule', 'Error_Level'
            ],
            'Description': [
                'IFC entity type to validate (e.g., IfcWall, IfcDoor)',
                'PropertySet name containing the property',
                'Specific property name to check',
                'Expected data type (String, Integer, Double, Boolean, IfcLabel)',
                'Whether property is mandatory (Yes/No)',
                'Comma-separated list of valid values (optional)',
                'Minimum numeric value (optional)',
                'Maximum numeric value (optional)',
                'Custom validation expression (optional)',
                'Severity level (Critical, Warning, Info)'
            ]
        })
        instructions.to_excel(writer, sheet_name='Instructions', index=False)

    output.seek(0)
    return output


def generate_pdf_report(validation_results, ifc_model, requirements_df, ifc_filename):
    """Genera el reporte PDF de validación"""
    total_checks = len(validation_results)
    passed_checks = sum(1 for r in validation_results if r['status'] == 'Pass')
    failed_checks = total_checks - passed_checks
    compliance_score = (passed_checks / total_checks * 100) if total_checks > 0 else 0

    critical_count = sum(1 for r in validation_results if r['status'] == 'Fail' and r['error_level'] == 'Critical')
    warning_count = sum(1 for r in validation_results if r['status'] == 'Fail' and r['error_level'] == 'Warning')

    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, topMargin=0.75*inch, bottomMargin=0.75*inch)
    story = []
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=colors.HexColor('#1976D2'),
        spaceAfter=30,
        alignment=TA_CENTER
    )

    heading_style = ParagraphStyle(
        'CustomHeading',
        parent=styles['Heading2'],
        fontSize=16,
        textColor=colors.HexColor('#1976D2'),
        spaceAfter=12,
        spaceBefore=12
    )

    # Título
    story.append(Paragraph("IFC Quality Validation Report", title_style))
    story.append(Spacer(1, 0.2*inch))

    # Información del proyecto
    story.append(Paragraph("Project Information", heading_style))
    project_data = [
        ['IFC File:', ifc_filename],
        ['IFC Schema:', ifc_model.schema],
        ['Report Date:', datetime.now().strftime('%Y-%m-%d %H:%M:%S')],
        ['Total Entities:', str(len(ifc_model.by_type("IfcRoot")))],
        ['Validation Rules:', str(len(requirements_df))]
    ]

    project_table = Table(project_data, colWidths=[2*inch, 4*inch])
    project_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#E3F2FD')),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey)
    ]))
    story.append(project_table)
    story.append(Spacer(1, 0.3*inch))

    # Resumen ejecutivo
    story.append(Paragraph("Executive Summary", heading_style))

    summary_data = [
        ['Metric', 'Value', 'Status'],
        ['Compliance Score', f'{compliance_score:.1f}%', 'PASS' if compliance_score >= 90 else 'FAIL'],
        ['Total Checks', str(total_checks), '-'],
        ['Passed Checks', str(passed_checks), 'PASS'],
        ['Failed Checks', str(failed_checks), 'FAIL' if failed_checks > 0 else 'PASS'],
        ['Critical Errors', str(critical_count), 'FAIL' if critical_count > 0 else 'PASS'],
        ['Warnings', str(warning_count), 'WARNING' if warning_count > 0 else 'PASS'],
    ]

    summary_table = Table(summary_data, colWidths=[2*inch, 1.5*inch, 1.5*inch])
    summary_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1976D2')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F5F5F5')])
    ]))
    story.append(summary_table)
    story.append(Spacer(1, 0.3*inch))

    # Hallazgos detallados
    story.append(PageBreak())
    story.append(Paragraph("Detailed Findings", heading_style))

    critical_failures = [r for r in validation_results if r['status'] == 'Fail' and r['error_level'] == 'Critical']
    warning_failures = [r for r in validation_results if r['status'] == 'Fail' and r['error_level'] == 'Warning']

    if critical_failures:
        story.append(Paragraph(f"Critical Errors ({len(critical_failures)})", styles['Heading3']))
        for i, failure in enumerate(critical_failures[:20], 1):
            story.append(Paragraph(
                f"{i}. {failure['entity_type']} - {failure['check_description']}: "
                f"Expected '{failure['expected_value']}', Got '{failure['actual_value']}'",
                styles['Normal']
            ))
        if len(critical_failures) > 20:
            story.append(Paragraph(f"... and {len(critical_failures) - 20} more", styles['Italic']))
        story.append(Spacer(1, 0.2*inch))

    if warning_failures:
        story.append(Paragraph(f"Warnings ({len(warning_failures)})", styles['Heading3']))
        for i, failure in enumerate(warning_failures[:20], 1):
            story.append(Paragraph(
                f"{i}. {failure['entity_type']} - {failure['check_description']}: "
                f"Expected '{failure['expected_value']}', Got '{failure['actual_value']}'",
                styles['Normal']
            ))
        if len(warning_failures) > 20:
            story.append(Paragraph(f"... and {len(warning_failures) - 20} more", styles['Italic']))

    doc.build(story)
    buffer.seek(0)
    return buffer


def create_validation_charts(validation_results):
    """Crea los gráficos de validación con Plotly"""
    fig = make_subplots(
        rows=2, cols=2,
        subplot_titles=(
            'Pass/Fail Distribution',
            'Errors by Severity',
            'Errors by Entity Type',
            'Compliance Score'
        ),
        specs=[
            [{'type': 'pie'}, {'type': 'bar'}],
            [{'type': 'bar'}, {'type': 'indicator'}]
        ]
    )

    # 1. Pie Chart Pass/Fail
    passed = sum(1 for r in validation_results if r['status'] == 'Pass')
    failed = sum(1 for r in validation_results if r['status'] == 'Fail')

    fig.add_trace(
        go.Pie(
            labels=['Passed', 'Failed'],
            values=[passed, failed],
            marker=dict(colors=['#4CAF50', '#F44336']),
            hole=0.4
        ),
        row=1, col=1
    )

    # 2. Errores por severidad
    severity_counts = {}
    for result in validation_results:
        if result['status'] == 'Fail':
            level = result['error_level']
            severity_counts[level] = severity_counts.get(level, 0) + 1

    severity_colors = {'Critical': '#F44336', 'Warning': '#FF9800', 'Info': '#2196F3'}

    for severity in ['Critical', 'Warning', 'Info']:
        count = severity_counts.get(severity, 0)
        fig.add_trace(
            go.Bar(
                x=[severity],
                y=[count],
                name=severity,
                marker_color=severity_colors[severity],
                showlegend=False
            ),
            row=1, col=2
        )

    # 3. Errores por tipo de entidad
    entity_errors = {}
    for result in validation_results:
        if result['status'] == 'Fail':
            entity = result['entity_type']
            entity_errors[entity] = entity_errors.get(entity, 0) + 1

    sorted_entities = sorted(entity_errors.items(), key=lambda x: x[1], reverse=True)[:10]

    if sorted_entities:
        entities, counts = zip(*sorted_entities)
        fig.add_trace(
            go.Bar(
                x=list(counts),
                y=list(entities),
                orientation='h',
                marker_color='#9C27B0',
                showlegend=False
            ),
            row=2, col=1
        )

    # 4. Indicador de compliance
    total_checks = len(validation_results)
    compliance_score = (passed / total_checks * 100) if total_checks > 0 else 0

    fig.add_trace(
        go.Indicator(
            mode="gauge+number+delta",
            value=compliance_score,
            domain={'x': [0, 1], 'y': [0, 1]},
            title={'text': "Compliance %"},
            delta={'reference': 90},
            gauge={
                'axis': {'range': [None, 100]},
                'bar': {'color': '#2196F3'},
                'steps': [
                    {'range': [0, 70], 'color': '#FFEBEE'},
                    {'range': [70, 90], 'color': '#FFF3E0'},
                    {'range': [90, 100], 'color': '#E8F5E9'}
                ],
                'threshold': {
                    'line': {'color': '#F44336', 'width': 4},
                    'thickness': 0.75,
                    'value': 90
                }
            }
        ),
        row=2, col=2
    )

    fig.update_layout(
        height=700,
        showlegend=False,
        title_text="IFC Validation Dashboard",
        title_x=0.5
    )

    return fig


# ============================================
# INTERFAZ DE USUARIO STREAMLIT
# ============================================

def main():
    st.markdown('<h1 class="main-header">🏗️ IFC Quality Validation Tool</h1>', unsafe_allow_html=True)

    st.markdown("""
    Upload your IFC file and Excel requirements to validate BIM deliverables against project-specific standards.
    This tool checks property existence, data types, value ranges, spatial structure, and classification references.
    """)

    # Sidebar - Configuración
    with st.sidebar:
        st.header("📁 File Upload")

        ifc_file = st.file_uploader("Upload IFC File", type=['ifc'], help="IFC2x3 or IFC4 schema")
        excel_file = st.file_uploader("Upload Excel Requirements", type=['xlsx'], help="Validation rules file")

        # Descargar plantilla
        st.subheader("📋 Template")
        template_buffer = create_excel_template()
        st.download_button(
            label="Download Excel Template",
            data=template_buffer,
            file_name="IFC_Validation_Template.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )

        st.divider()

        st.header("⚙️ Validation Options")
        validate_geometry = st.checkbox("Validate Geometry Presence", value=True)
        validate_spatial = st.checkbox("Validate Spatial Structure", value=True)
        validate_classification = st.checkbox("Validate Classification References", value=True)
        show_passed = st.checkbox("Show Passed Checks in Table", value=False)

    # Contenido principal
    if ifc_file is None:
        st.info("👆 Please upload an IFC file from the sidebar to begin.")

        # Mostrar ejemplo de la estructura esperada
        with st.expander("📖 Excel Requirements Format"):
            st.markdown("""
            Your Excel file should contain the following columns:

            | Column | Description |
            |--------|-------------|
            | `Entity_Type` | IFC entity type (e.g., IfcWall, IfcDoor) |
            | `Property_Set` | PropertySet name |
            | `Property_Name` | Property to validate |
            | `Required` | Yes/No |
            | `Error_Level` | Critical, Warning, or Info |
            | `Allowed_Values` | Comma-separated valid values (optional) |
            | `Min_Value` / `Max_Value` | Numeric bounds (optional) |
            """)
        return

    # Procesar archivo IFC
    try:
        # Guardar IFC temporalmente (ifcopenshell necesita un archivo)
        with tempfile.NamedTemporaryFile(delete=False, suffix='.ifc') as tmp_file:
            tmp_file.write(ifc_file.getvalue())
            tmp_path = tmp_file.name

        ifc_model = ifcopenshell.open(tmp_path)

        # Limpiar archivo temporal
        os.unlink(tmp_path)

        # ============================================
        # TABS DE RESULTADOS
        # ============================================

        # Si no hay Excel, mostrar solo el visor
        if excel_file is None:
            tab1, tab2 = st.tabs(["🏗️ 3D Viewer", "📊 Model Info"])

            with tab1:
                st.subheader("IFC 3D Viewer")
                st.caption("Use mouse to rotate (left click), pan (right click), and zoom (scroll)")

                # Renderizar visor 3D con That Open Components
                render_ifc_viewer(ifc_file.getvalue(), ifc_file.name, height=650)

            with tab2:
                st.subheader("Model Information")
                col1, col2, col3 = st.columns(3)

                with col1:
                    st.metric("IFC Schema", ifc_model.schema)
                with col2:
                    st.metric("Total Entities", len(ifc_model.by_type('IfcRoot')))
                with col3:
                    st.metric("Products", len(ifc_model.by_type('IfcProduct')))

                st.divider()

                # Resumen de entidades
                st.subheader("Entity Summary")
                entity_types = ['IfcWall', 'IfcDoor', 'IfcWindow', 'IfcSlab', 'IfcColumn', 'IfcBeam', 'IfcSpace']
                entity_counts = []

                for et in entity_types:
                    try:
                        count = len(ifc_model.by_type(et))
                        if count > 0:
                            entity_counts.append({'Entity Type': et, 'Count': count})
                    except:
                        pass

                if entity_counts:
                    st.dataframe(pd.DataFrame(entity_counts), use_container_width=True, hide_index=True)

                st.info("📋 Upload an Excel requirements file to run validation checks.")

            return

        # Con Excel - validación completa
        requirements_df = pd.read_excel(excel_file)

        # Validar estructura del Excel
        required_columns = ['Entity_Type', 'Property_Set', 'Property_Name', 'Required', 'Error_Level']
        missing_columns = [col for col in required_columns if col not in requirements_df.columns]

        if missing_columns:
            st.error(f"❌ Missing columns in Excel: {', '.join(missing_columns)}")
            return

        # Ejecutar validación
        options = {
            'validate_geometry': validate_geometry,
            'validate_spatial': validate_spatial,
            'validate_classification': validate_classification
        }

        with st.spinner("Running validation..."):
            validation_results = perform_validation(ifc_model, requirements_df, options)

        # Calcular estadísticas
        total_checks = len(validation_results)
        passed_checks = sum(1 for r in validation_results if r['status'] == 'Pass')
        failed_checks = total_checks - passed_checks
        compliance_score = (passed_checks / total_checks * 100) if total_checks > 0 else 0

        critical_count = sum(1 for r in validation_results if r['status'] == 'Fail' and r['error_level'] == 'Critical')
        warning_count = sum(1 for r in validation_results if r['status'] == 'Fail' and r['error_level'] == 'Warning')
        info_count = sum(1 for r in validation_results if r['status'] == 'Fail' and r['error_level'] == 'Info')

        # Tabs con visor 3D incluido
        tab1, tab2, tab3, tab4 = st.tabs(["📊 Summary", "🏗️ 3D Viewer", "📈 Charts", "📋 Detailed Results"])

        with tab1:
            st.subheader("Validation Summary")

            # Métricas principales
            col1, col2, col3, col4 = st.columns(4)

            with col1:
                st.metric(
                    "Compliance Score",
                    f"{compliance_score:.1f}%",
                    delta="Pass" if compliance_score >= 90 else "Needs Review"
                )

            with col2:
                st.metric("Total Checks", total_checks)

            with col3:
                st.metric("Passed", passed_checks, delta=None)

            with col4:
                st.metric("Failed", failed_checks, delta=None)

            st.divider()

            # Información del archivo
            col1, col2 = st.columns(2)

            with col1:
                st.subheader("📁 File Information")
                st.write(f"**IFC Schema:** {ifc_model.schema}")
                st.write(f"**Total Entities:** {len(ifc_model.by_type('IfcRoot'))}")
                st.write(f"**Validation Rules:** {len(requirements_df)}")

            with col2:
                st.subheader("⚠️ Error Breakdown")
                st.write(f"🔴 **Critical Errors:** {critical_count}")
                st.write(f"🟠 **Warnings:** {warning_count}")
                st.write(f"🔵 **Info:** {info_count}")

        with tab2:
            st.subheader("IFC 3D Viewer")
            st.caption("Controls: Left click + drag to rotate | Right click + drag to pan | Scroll to zoom")

            # Renderizar visor 3D con That Open Components
            render_ifc_viewer(ifc_file.getvalue(), ifc_file.name, height=650)

        with tab3:
            st.subheader("Validation Charts")
            fig = create_validation_charts(validation_results)
            st.plotly_chart(fig, use_container_width=True)

        with tab4:
            st.subheader("Detailed Validation Results")

            # Filtrar resultados
            display_results = validation_results if show_passed else [r for r in validation_results if r['status'] == 'Fail']

            if display_results:
                df = pd.DataFrame(display_results)

                # Filtros
                col1, col2 = st.columns(2)
                with col1:
                    entity_filter = st.multiselect(
                        "Filter by Entity Type",
                        options=df['entity_type'].unique(),
                        default=[]
                    )
                with col2:
                    status_filter = st.multiselect(
                        "Filter by Status",
                        options=df['status'].unique(),
                        default=[]
                    )

                # Aplicar filtros
                if entity_filter:
                    df = df[df['entity_type'].isin(entity_filter)]
                if status_filter:
                    df = df[df['status'].isin(status_filter)]

                st.dataframe(
                    df,
                    use_container_width=True,
                    hide_index=True,
                    column_config={
                        "status": st.column_config.TextColumn("Status"),
                        "error_level": st.column_config.TextColumn("Severity"),
                    }
                )
            else:
                st.success("✅ All validation checks passed!")

        # ============================================
        # BOTONES DE EXPORTACIÓN
        # ============================================
        st.divider()
        st.subheader("📥 Export Results")

        col1, col2, col3 = st.columns(3)

        with col1:
            # PDF Report
            pdf_buffer = generate_pdf_report(
                validation_results, ifc_model, requirements_df, ifc_file.name
            )
            st.download_button(
                label="📄 Download PDF Report",
                data=pdf_buffer,
                file_name=f"IFC_Validation_Report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf",
                mime="application/pdf"
            )

        with col2:
            # CSV Export
            csv_df = pd.DataFrame(validation_results)
            csv_buffer = BytesIO()
            csv_df.to_csv(csv_buffer, index=False)
            csv_buffer.seek(0)

            st.download_button(
                label="📊 Export to CSV",
                data=csv_buffer,
                file_name=f"IFC_Validation_Results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
                mime="text/csv"
            )

        with col3:
            # JSON Export
            summary = {
                'report_metadata': {
                    'generated_at': datetime.now().isoformat(),
                    'ifc_file': ifc_file.name,
                    'ifc_schema': ifc_model.schema,
                    'total_entities': len(ifc_model.by_type("IfcRoot")),
                    'validation_rules': len(requirements_df)
                },
                'validation_summary': {
                    'compliance_score': round(compliance_score, 2),
                    'total_checks': total_checks,
                    'passed_checks': passed_checks,
                    'failed_checks': failed_checks
                },
                'error_breakdown': {
                    'critical': critical_count,
                    'warning': warning_count,
                    'info': info_count
                },
                'failed_checks': [r for r in validation_results if r['status'] == 'Fail']
            }

            st.download_button(
                label="📋 Export to JSON",
                data=json.dumps(summary, indent=2),
                file_name=f"IFC_Validation_Summary_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json",
                mime="application/json"
            )

    except Exception as e:
        st.error(f"❌ Error processing files: {str(e)}")
        st.exception(e)


if __name__ == "__main__":
    main()
