import { type FC, type PointerEvent, type SVGProps, useCallback, useState } from 'react';
import { beginShapePlace } from '@/runtime/toolbar-place';
import { type ShapeVariant, selectShape, setShapeVariant, setShapeWidth, useDeviceUIStore } from '@/stores/device-ui-store';
import { IconShapeDiamond, IconShapeEllipse, IconShapeRect, IconShapeRoundedRect, IconShapeTriangle } from '../icons/ShapeVariantIcons';
import { SHAPE_WEIGHTS } from '../weights';
import { InspectorButton } from './InspectorButton';
import { WeightField } from './WeightField';
import './Inspector.css';

// Display order = inspector iteration order. `as const satisfies` narrows the
// readonly array to the union without a manual ShapeVariant[] cast.
const SHAPE_VARIANT_IDS = ['rectangle', 'ellipse', 'diamond', 'triangle', 'roundedRect'] as const satisfies readonly ShapeVariant[];

const VARIANT_LABELS: Record<ShapeVariant, string> = {
  rectangle: 'Rectangle',
  ellipse: 'Circle',
  diamond: 'Diamond',
  triangle: 'Triangle',
  roundedRect: 'Rounded square',
};

const VARIANT_ICONS: Record<ShapeVariant, FC<SVGProps<SVGSVGElement>>> = {
  rectangle: IconShapeRect,
  ellipse: IconShapeEllipse,
  diamond: IconShapeDiamond,
  triangle: IconShapeTriangle,
  roundedRect: IconShapeRoundedRect,
};

// Module-level handler table — references are stable across renders so the
// memoized InspectorButton keeps prop equality. The inspector only mounts
// when activeTool === 'shape' (Toolbar.tsx gate), so `setShapeVariant` alone
// is sufficient — atomicity with the tool switch lives on the keyboard path.
const VARIANT_HANDLERS: Record<ShapeVariant, () => void> = {
  rectangle: () => setShapeVariant('rectangle'),
  ellipse: () => setShapeVariant('ellipse'),
  diamond: () => setShapeVariant('diamond'),
  triangle: () => setShapeVariant('triangle'),
  roundedRect: () => setShapeVariant('roundedRect'),
};

// Drag-place entry — pointerdown applies the variant and starts a capture-retargeted
// placing gesture (runtime/toolbar-place.ts). The onClick above survives as the
// fallback for guard-refused presses (the captured click never reaches the button).
const VARIANT_DOWN_HANDLERS: Record<ShapeVariant, (e: PointerEvent<HTMLButtonElement>) => void> = {
  rectangle: (e) => beginShapePlace(e, 'rectangle'),
  ellipse: (e) => beginShapePlace(e, 'ellipse'),
  diamond: (e) => beginShapePlace(e, 'diamond'),
  triangle: (e) => beginShapePlace(e, 'triangle'),
  roundedRect: (e) => beginShapePlace(e, 'roundedRect'),
};

export function ShapeInspector() {
  // Single popout — boolean is enough (pen inspector pattern, not the
  // discriminated `OpenPicker` connector uses for its weight/color pair).
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // Cluster selector covers variant + width in one subscription.
  const { variant, width } = useDeviceUIStore(selectShape);

  const handleTogglePicker = useCallback(() => setIsPickerOpen((v) => !v), []);
  const handleClosePicker = useCallback(() => setIsPickerOpen(false), []);
  const handleChangeWidth = useCallback((w: number) => {
    setShapeWidth(w);
    setIsPickerOpen(false);
  }, []);

  return (
    <div className="inspector inspector-shape">
      {SHAPE_VARIANT_IDS.map((id) => {
        const Icon = VARIANT_ICONS[id];
        return (
          <InspectorButton
            key={id}
            isActive={id === variant}
            ariaLabel={VARIANT_LABELS[id]}
            onClick={VARIANT_HANDLERS[id]}
            onPointerDown={VARIANT_DOWN_HANDLERS[id]}
          >
            <Icon className="insp-icon" />
          </InspectorButton>
        );
      })}

      <div className="inspector-divider" />

      <WeightField
        presets={SHAPE_WEIGHTS}
        value={width}
        isPickerOpen={isPickerOpen}
        onTogglePicker={handleTogglePicker}
        onChangeWidth={handleChangeWidth}
        onClosePicker={handleClosePicker}
      />
    </div>
  );
}
