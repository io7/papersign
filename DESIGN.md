---
name: PaperSign
description: A restrained document workspace for reusable visual signatures.
colors:
  green: '#163f38'
  green-hover: '#22584d'
  focus: '#337e66'
  ink: '#243b32'
  muted: '#586a60'
  canvas: '#f4f6f3'
  paper: '#fff'
  soft: '#edf3ed'
  line: '#dce3dc'
  field-line: '#b9c8bc'
  button-line: '#c7d3c9'
  specimen: '#fafcf8'
  document-workspace: '#e7ece5'
  nav-text: '#d1dfd6'
  nav-hover: '#235247'
  nav-active: '#346053'
  red: '#a12f31'
  red-hover: '#852226'
  control-surface: '#edf1eb'
  control-text: '#536659'
  status-text: '#4c6251'
  pending-surface: '#f9efce'
  pending-text: '#73581b'
  signed-surface: '#e5f2e6'
  signed-text: '#30653b'
  revoked-surface: '#f3e7e5'
  revoked-text: '#8c4942'
  icon-hover: '#e7eee7'
  drawing-line: '#bbcabe'
  baseline: '#c4d0c3'
  drawing-placeholder: '#66796a'
  signature-black: '#182c3d'
  signature-blue: '#2555a4'
typography:
  display:
    fontFamily: DM Sans Variable, sans-serif
    fontSize: 54px
    fontWeight: 620
    lineHeight: 1.14
    letterSpacing: -0.04em
  headline:
    fontFamily: DM Sans Variable, sans-serif
    fontSize: 34px
    fontWeight: 620
    lineHeight: 1.2
    letterSpacing: -0.035em
  title:
    fontFamily: DM Sans Variable, sans-serif
    fontSize: 21px
    fontWeight: 620
    lineHeight: 1.35
    letterSpacing: -0.02em
  body:
    fontFamily: DM Sans Variable, sans-serif
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: normal
  label:
    fontFamily: DM Sans Variable, sans-serif
    fontSize: 13px
    fontWeight: 570
    lineHeight: 1.5
    letterSpacing: normal
  button:
    fontFamily: DM Sans Variable, sans-serif
    fontSize: 14px
    fontWeight: 570
    lineHeight: 1.5
    letterSpacing: normal
  metadata:
    fontFamily: DM Sans Variable, sans-serif
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: normal
  status:
    fontFamily: DM Sans Variable, sans-serif
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: normal
rounded:
  handle: 3px
  badge: 5px
  field: 7px
  control: 8px
  workspace: 10px
  panel: 12px
  empty: 14px
  circle: 50%
spacing:
  '4': 4px
  '7': 7px
  '8': 8px
  '10': 10px
  '12': 12px
  '14': 14px
  '16': 16px
  '18': 18px
  '20': 20px
  '22': 22px
  '24': 24px
  '25': 25px
  '28': 28px
  '32': 32px
  '36': 36px
  '40': 40px
  '44': 44px
  '48': 48px
components:
  button-primary:
    backgroundColor: '{colors.green}'
    textColor: '{colors.paper}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: 10px 16px
  button-primary-hover:
    backgroundColor: '{colors.green-hover}'
  button-secondary:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.green}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: 10px 16px
  button-secondary-hover:
    backgroundColor: '{colors.soft}'
  button-danger:
    backgroundColor: '{colors.red}'
    textColor: '{colors.paper}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: 10px 16px
  button-danger-hover:
    backgroundColor: '{colors.red-hover}'
  button-icon:
    backgroundColor: transparent
    rounded: '{rounded.field}'
    padding: 8px
  button-icon-hover:
    backgroundColor: '{colors.icon-hover}'
  button-text:
    backgroundColor: transparent
    textColor: '{colors.green}'
    typography: '{typography.label}'
    padding: 5px 0
  input:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.field}'
    padding: 10px 12px
  navigation-link:
    textColor: '{colors.nav-text}'
    rounded: '{rounded.control}'
    padding: 12px 14px
  navigation-link-hover:
    backgroundColor: '{colors.nav-hover}'
  navigation-link-active:
    backgroundColor: '{colors.nav-active}'
    textColor: '{colors.paper}'
  status:
    backgroundColor: '{colors.control-surface}'
    textColor: '{colors.status-text}'
    typography: '{typography.status}'
    rounded: '{rounded.badge}'
    padding: 4px 8px
  status-pending:
    backgroundColor: '{colors.pending-surface}'
    textColor: '{colors.pending-text}'
  status-signed:
    backgroundColor: '{colors.signed-surface}'
    textColor: '{colors.signed-text}'
  status-revoked:
    backgroundColor: '{colors.revoked-surface}'
    textColor: '{colors.revoked-text}'
  panel:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
    padding: 25px
  signature-card:
    backgroundColor: '{colors.paper}'
    rounded: '{rounded.panel}'
  signature-preview:
    backgroundColor: '{colors.specimen}'
    height: 180px
    padding: 35px 25px
  signature-input:
    backgroundColor: '{colors.paper}'
    rounded: '{rounded.control}'
    height: 202px
  segmented:
    backgroundColor: '{colors.control-surface}'
    rounded: '{rounded.control}'
    padding: 4px
  segmented-selected:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.green}'
    rounded: '{rounded.badge}'
    padding: 8px 10px
---

# Design System: PaperSign

## Overview

**Creative North Star: "Restrained correspondence stationery"**

PaperSign is a quiet working space for documents and reusable visual signatures. Deep green navigation establishes the workspace, pale green-gray grounds separate work areas, and white paper carries the document itself. The signature is the distinctive visual content; the surrounding interface stays practical and legible.

The implementation uses one variable sans family, compact controls, restrained corners, and mostly flat surfaces. The same contained signature specimen appears in the private library and editor or recipient chooser. The interface supports both pointer and keyboard work, with visible focus, explicit consent, and a direct PDF review link before recipient signing.

**Key Characteristics:**
- Deep green navigation and action emphasis over pale work areas.
- White document paper and real user-supplied signature artwork.
- DM Sans hierarchy with compact, sentence-case controls.
- Flat bordered panels, with a soft shadow reserved for PDF paper.
- Responsive navigation that retains the signed-in account identity.

This is a code-led scan of `web/style.css`, `web/main.ts`, and the Vue components, under the direction in `.impeccable/surfaces/workspace.md` and product constraints in `PRODUCT.md`. No approved comp or QUALITY BAR card was supplied. The recorded finish verdict clears the mobile account identity and guest PDF review fixes; it is not a new whole-surface review, backend validation, deployment proof, or accessibility certification.

## Colors

The palette combines forest-green action surfaces, green-tinted neutrals, and white paper. The frontmatter owns exact primitive values; additional local shades remain in the stylesheet.

### Primary
- **Deep green** (`green`): the persistent navigation, primary actions, links, and checkbox accent. Its darker surface carries white text.
- **Green hover** (`green-hover`): the enabled primary button hover state.
- **Focus green** (`focus`): the shared visible keyboard outline.
- **Navigation states** (`nav-text`, `nav-hover`, `nav-active`): distinguish readable default links, hover, and the current location against the deep green shell.

### Neutral
- **Text ink and muted text** (`ink`, `muted`): primary reading and supporting explanations.
- **Workspace ground** (`canvas`): the application background; **paper** (`paper`) is reserved for forms, panels, and actual PDF surfaces.
- **Soft green** (`soft`) and **control surface** (`control-surface`): low-emphasis hover and segmented-control backgrounds.
- **Specimen ground** (`specimen`): the signature library preview and PNG upload surface.
- **Document work area** (`document-workspace`): the inset ground around PDF paper.
- **Rules and input edges** (`line`, `field-line`, `button-line`): structural separators and control boundaries. Borders are part of this visual language.

### Semantic and content colors
- **Destructive red** (`red`, `red-hover`): confirmed removal actions; errors also use restrained red text on a pale red notice.
- **Status pairs** (`pending-*`, `signed-*`, `revoked-*`): amber for waiting, green for completion, and muted red for revocation. Keep the written state beside its color.
- **Signature inks** (`signature-black`, `signature-blue`): choices for user-created signature strokes. Blue ink is document content, not a second interface accent.

### Named Rules
**The Paper First Rule.** Give actual documents white paper and a quiet green-gray surround; let the user's signature supply the expressive mark.

## Typography

**Display Font:** DM Sans Variable, with a sans-serif fallback.
**Body Font:** DM Sans Variable, with the same fallback.

**Character:** The locally bundled variable family carries the whole interface. Weight and size establish hierarchy without decorative labels or a competing display face. Signature images keep the user's handwriting rather than borrowing a UI font.

### Hierarchy
- **Display** (`typography.display`): the authentication introduction. Its default size changes to 62px at the wide breakpoint, then 46px, 40px, and 36px at the descending compact breakpoints; its measure is 12ch, widening to 15ch on mobile.
- **Headline** (`typography.headline`): the default page heading. Workspace headings become 28px at 900px and 29px at 680px; the editor uses a contextual 25px heading, reducing to 22px.
- **Title** (`typography.title`): section headings. Signature card titles use 17px and inspector sections use 16px; authentication form titles use 30px, reducing to 27px on mobile.
- **Body** (`typography.body`): the base reading style. Paragraphs are capped at 70ch unless a surface defines a narrower measure.
- **Label** (`typography.label`): field names and text actions. The input value returns to regular weight.
- **Button** (`typography.button`): main controls; the small variant and mobile breakpoint use 13px.
- **Metadata** (`typography.metadata`): dates, source labels, and secondary record detail. Date and PDF page controls use tabular numerals.
- **Status** (`typography.status`): compact written state chips.

### Named Rules
**The One Face Rule.** Use the bundled DM Sans family for interface copy; keep handwritten expression inside actual signature content.

The existing 10px default badge and 8px mobile recipient-field label are constrained local annotations, not new general-purpose text roles. Do not extend those small sizes to body text or form instructions.

## Layout

The desktop shell has a sticky, full-height navigation column and a flexible workspace. The column is 230px by default and 200px at widths of 1200px or less. General pages cap at 1450px with 44px by 48px padding; the editor caps at 1660px with a document-first grid and 320px inspector. The guest signing page caps at 1300px and pairs the PDF with a 370px signing panel.

The signature library uses auto-filled columns with a 270px minimum and 24px gaps. The standard panel has 25px internal padding; controls use denser 8–16px steps. The recorded spacing values describe an existing practical rhythm, not a strict uniform grid: 7px field gaps, 22px insets, and 25px panel padding are intentional facts of the current build.

| CSS breakpoint | Implemented behavior |
| --- | --- |
| `min-width: 1600px` | Increase page top padding and authentication introduction size. |
| `max-width: 1200px` | Narrow the shell and inspector; remove the document list's date column. |
| `max-width: 900px` | Replace the vertical sidebar with a horizontal header. Keep the account name and sign-out visible; hide the email line and avatar. |
| `max-width: 680px` | Put the two navigation links on a full-width second row; stack document and signing/editor controls, use one signature-library column, wrap actions, and reduce page insets. |

At the mobile breakpoint, the account name remains visible with a maximum width of 115px and ellipsis; its accessible label and title retain the full identity. Editor signature choices use two compact columns even when the library uses one. The document list becomes a stacked record with its written status beneath the title.

## Elevation & Depth

Panels and cards are flat, defined by white fill, restrained corners, and thin green-gray borders. The PDF sheet is the only surface with a box shadow. Dialogs are separated by a translucent dark green backdrop; selected placements use outlines and a translucent tint, not raised-card effects.

### Shadow Vocabulary
- **PDF paper:** `box-shadow: 0 4px 14px #23432a1a`. This anchors the rendered document on its work area. The exact shadow lives in the sidecar because frontmatter component tokens cannot hold shadows.

### Named Rules
**The Paper Depth Rule.** Reserve the existing soft shadow for PDF paper; keep ordinary controls, library cards, and inspector panels flat.

## Shapes

The shape language is softly squared. Fields and icon buttons use the field radius, ordinary buttons and drawing areas use the control radius, document work areas and inspectors use the workspace radius, and panels and signature cards use the panel radius. Status chips and segmented selections use the smaller badge radius. Empty states have a slightly gentler outline; avatars, ink dots, and the completion icon are circles.

Most boundaries are one-pixel solid rules. Dashed strokes signal an upload or empty area, the drawing baseline, and an unsigned recipient field. PDF paper itself stays rectangular. The signature image uses `object-fit: contain`; never crop its strokes to fill a thumbnail.

## Components

### Buttons

Compact and direct, with sentence-case labels and optional line icons.

- **Primary / secondary / danger:** shared control radius and tokenized padding, an implemented minimum height of 43px, and 570 weight. Secondary buttons have a thin `button-line` border. The small variant has a 34px minimum height and 6px by 10px padding.
- **Icon:** transparent at rest, a field radius, 8px padding, and a 36px minimum width and height. Use a descriptive accessible name for actions without visible text.
- **Text:** transparent and compact; hover adds an underline. A red text variant marks destructive actions without filling the whole control.
- **Hover / focus:** enabled hover colors are variant-specific. Shared keyboard focus is a 3px solid `focus` outline offset by 4px. Background and text-color transitions take 0.16s with the browser's default ease; the reduced-motion query removes transitions.
- **Disabled:** opacity is 0.48 and the cursor indicates the unavailable action. Busy actions retain their label position and describe the current work.

### Inputs / Fields

White, compact fields have a thin `field-line` border and the field radius. Labels sit above values with a 7px gap. Field values use regular-weight body type; helper text uses muted color. The global focus treatment applies to inputs and selects. Errors are explicit notices with text and `role="alert"` in the sampled forms; do not assume an unimplemented red-border validation variant.

Checkboxes use a native 18px control with the deep green accent. Consent is written beside a real required checkbox and is distinct from the final action.

### Copy field

Every value people copy (signing links, invitation links, authenticator setup keys and API keys) uses `web/components/CopyField.vue`: a read-only box that selects its text on focus, a secondary **Copy** button beside it, and a status line below that confirms the copy or explains the failure (`role="alert"`). The button reads *Copying…* and then *Copied*. Use the `stacked` variant, a wrapping box with the button underneath, when people must read or type the value, and `small` inside compact side panels. Other actions on the same item go in their own row below.

### Navigation

The desktop navigation is vertical inside the deep green shell, with line icons, 520-weight labels, rounded selections, and distinct hover/current colors. On narrow screens it becomes horizontal and then wraps into a second row. Keep Documents, My signatures, account identity, and sign-out available through that change. The brand uses the same family, a feather icon, and a quiet pale-green dot.

### Status chips

Small softly squared chips carry written states. Pending/awaiting share the amber pair; signed/completed share green; revoked has muted red. These are passive labels, not interactive filter pills. Do not add fake hover behavior to them.

### Panels and signature cards

Standard panels use the `panel` primitive and a thin `line` border. A signature card contains a specimen surface above its details and actions. The specimen is 180px high on desktop and 170px on mobile; the contained image is capped at 110px high. The editor and recipient chooser reuse the contained-image approach in compact selectable rows. Default, rename, and remove controls remain attached to the saved signature; removal uses an explicit inline confirmation.

### Signature input

Draw and Upload PNG are a segmented choice with `aria-pressed`, a pale control background, and a white selected segment. Drawing uses a white, 202px outer surface, a 200px canvas, a dashed baseline, and plain ink choices. Undo and clear are explicit controls. Import offers a dashed specimen surface and preserves the transparent PNG. Keep resizing from discarding drawn strokes; the visual system must not obscure that interaction contract.

The sidecar's signature-input sample is a static visual preview of the real empty drawing state, not an implementation of drawing or mode switching.

### PDF work area and recipient signing

Conventional page controls sit above real PDF paper. Editable signature fields have visible selection outlines and a resize handle; arrow keys move them, Alt plus arrow keys resizes them, and Shift increases the step. Recipient fields use a dashed amber boundary and a written recipient label.

The PDF preview remains a canvas without a text layer. Recipient signing therefore includes the native **Open PDF in a new tab** link before the signing controls and explicit review consent. Preserve that alternative; this documentation does not claim that the canvas itself exposes document text.

## Do's and Don'ts

### Do:
- **Do** retain the deep green shell, white document paper, and quiet green-gray work areas.
- **Do** show actual signature artwork with containment and preserve the complete stroke shape.
- **Do** use the bundled DM Sans hierarchy and visible written status labels.
- **Do** keep keyboard focus, the signed-in identity, and the PDF review link visible through responsive changes.
- **Do** keep recipient consent and the final signing action explicit.
- **Do** use genuine empty states before the account has signatures or documents.

### Don't:
- **Don't** turn signature blue into a competing interface accent.
- **Don't** spread the PDF paper shadow to ordinary cards and controls.
- **Don't** replace real signature specimens with decorative mock handwriting or invented customer documents.
- **Don't** hide the current account identity on mobile.
- **Don't** treat the canvas-only PDF preview as an accessible text document.
- **Don't** promote constrained 8px or 10px annotations into reusable body or instruction styles.
