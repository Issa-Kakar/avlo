# How DrawingTool Gets Data Without Importing Zustand

## The Key Insight: Constructor Injection Pattern

DrawingTool doesn't import Zustand because it **receives the data through its constructor**.

## The Data Flow

### 1. DrawingTool.ts Imports

```typescript
import type { DeviceUIState } from './types'; // Just the TYPE/interface
// NO import from Zustand!
```

### 2. DrawingTool Constructor

```typescript
constructor(
  room: IRoomDocManager,
  deviceUI: DeviceUIState,  // Receives actual DATA as parameter
  userId: string,
  onInvalidate?: (bounds: [number, number, number, number]) => void,
) {
  this.deviceUI = deviceUI;  // Stores the data
}
```

### 3. Canvas.tsx Creates the Data

```typescript
// Canvas.tsx DOES import from Zustand
import { useDeviceUIStore } from '@/stores/device-ui-store';

// Reads from Zustand store
const { activeTool, pen, highlighter } = useDeviceUIStore();

// Creates deviceUI object from Zustand data
const deviceUI: DeviceUIState = useMemo(
  () => toolbarToDeviceUI(toolbar),
  [toolbar.tool, toolbar.color, toolbar.size, toolbar.opacity],
);

// Passes it to DrawingTool
const tool = new DrawingTool(
  roomDoc,
  deviceUI, // <-- Actual data passed here!
  userId,
  onInvalidate,
);
```

## The Complete Chain

```
1. Zustand Store (holds state)
        ↓
2. Canvas.tsx (reads via useDeviceUIStore)
        ↓
3. Creates deviceUI object
        ↓
4. Passes to DrawingTool constructor
        ↓
5. DrawingTool stores as this.deviceUI
```

## Why DrawingTool Uses the Data Correctly

When DrawingTool needs tool settings:

```typescript
startDrawing(pointerId: number, worldX: number, worldY: number): void {
  this.state = {
    config: {
      tool: this.deviceUI.tool,    // Uses data from constructor
      color: this.deviceUI.color,  // Not from Zustand directly!
      size: this.deviceUI.size,
      opacity: this.deviceUI.opacity,
    },
    // ...
  };
}
```

## Why This Architecture is Good

### 1. **Decoupling**

- DrawingTool doesn't know about Zustand
- Could switch to Redux/MobX without changing DrawingTool
- DrawingTool is testable with mock data

### 2. **Dependency Injection**

- Data is "injected" via constructor
- DrawingTool declares what it needs (DeviceUIState interface)
- Canvas.tsx provides the actual data

### 3. **Type Safety**

- DrawingTool imports the TYPE (interface) from './types'
- This gives TypeScript checking
- But no runtime dependency on state management

## The Confusion Source

You might expect:

```typescript
// DrawingTool.ts
import { useDeviceUIStore } from '@/stores/device-ui-store';

const { activeTool, pen } = useDeviceUIStore(); // Direct read
```

But that would:

- Make DrawingTool a React hook (bad for a class)
- Couple DrawingTool to Zustand
- Make testing harder
- Break if DrawingTool is used outside React

## The Import from './types' Explained

```typescript
import type { DeviceUIState } from './types';
```

This imports:

- **ONLY the TypeScript interface** (shape of data)
- **NOT the actual data**
- It's a compile-time type, removed at runtime
- Like a "contract" of what data DrawingTool expects

## Summary

**DrawingTool doesn't need to import Zustand because:**

1. Canvas.tsx reads from Zustand
2. Canvas.tsx creates a deviceUI object
3. Canvas.tsx passes it to DrawingTool constructor
4. DrawingTool stores and uses that passed data

The `import from './types'` is just for TypeScript to know the shape of the data, not to get the actual data. The actual data comes through the constructor parameter.

This is the **Dependency Injection** pattern - a fundamental OOP design pattern where dependencies are provided to an object rather than the object creating or fetching them itself.
