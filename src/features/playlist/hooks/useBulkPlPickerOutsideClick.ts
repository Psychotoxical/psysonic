import React, { useEffect } from 'react';

export function useBulkPlPickerOutsideClick(
  showBulkPlPicker: boolean,
  setShowBulkPlPicker: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (!showBulkPlPicker) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.bulk-pl-picker-wrap')) setShowBulkPlPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBulkPlPicker, setShowBulkPlPicker]);
}
