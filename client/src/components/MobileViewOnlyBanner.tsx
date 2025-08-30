import React from 'react';

/**
 * Banner component that displays on mobile devices to inform users
 * that editing is disabled and they're in view-only mode.
 *
 * Phase 5: Mobile view-only enforcement UI feedback
 */
export function MobileViewOnlyBanner() {
  // CRITICAL FIX: Include maxTouchPoints check for iPadOS reliability
  const isMobile =
    /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

  if (!isMobile) return null;

  return (
    <div className="fixed top-0 left-0 right-0 bg-yellow-100 border-b border-yellow-200 p-2 text-center z-50">
      <p className="text-sm text-yellow-800">Mobile devices are view-only. Use desktop to edit.</p>
    </div>
  );
}
