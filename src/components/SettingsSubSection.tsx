import React, { useId } from 'react';
import { ChevronDown } from 'lucide-react';

interface SettingsSubSectionProps {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  description?: string;
  searchText?: string;
  // Rechts im Summary neben dem Chevron (z.B. Reset-Button). Clicks werden
  // gestoppt, damit sie das Accordion nicht togglen.
  action?: React.ReactNode;
  children: React.ReactNode;
}

// Wird innerhalb eines Settings-Tabs als Accordion-Gruppe genutzt. Natives
// <details> liefert Keyboard + ARIA gratis; der CSS-Stil setzt den Chevron
// im Summary mittels [open]-Selektor.
export default function SettingsSubSection({
  title,
  icon,
  defaultOpen = false,
  description,
  searchText,
  action,
  children,
}: SettingsSubSectionProps) {
  const headingId = useId();
  return (
    <details
      className="settings-sub-section"
      data-settings-search={searchText ?? title}
      open={defaultOpen}
    >
      <summary
        className="settings-sub-section-summary"
        aria-labelledby={headingId}
      >
        {icon && <span className="settings-sub-section-icon">{icon}</span>}
        <span id={headingId} className="settings-sub-section-title">{title}</span>
        {action && (
          <span
            className="settings-sub-section-action"
            onClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
          >
            {action}
          </span>
        )}
        <ChevronDown size={16} className="settings-sub-section-chevron" aria-hidden="true" />
      </summary>
      {description && (
        <p className="settings-sub-section-desc">{description}</p>
      )}
      <div className="settings-sub-section-content">
        {children}
      </div>
    </details>
  );
}
