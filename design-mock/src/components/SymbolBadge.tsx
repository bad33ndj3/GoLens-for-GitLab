export type SymbolKind =
  | 'interface'
  | 'struct'
  | 'function'
  | 'method'
  | 'interfaceMethod'
  | 'type'
  | 'variable'
  | 'field'
  | 'constant'
  | 'parameter'
  | 'package'
  | 'external';

export interface SymbolBadgeProps {
  kind: SymbolKind;
}

const PRESENTATION: Record<SymbolKind, { badge: string; label: string; className: string }> = {
  interface: { badge: 'I', label: 'Interface', className: 'interface' },
  struct: { badge: 'S', label: 'Struct', className: 'struct' },
  function: { badge: 'F', label: 'Function', className: 'function' },
  method: { badge: 'M', label: 'Method', className: 'method' },
  interfaceMethod: { badge: 'IM', label: 'Interface method', className: 'interface-method' },
  type: { badge: 'T', label: 'Named type', className: 'type' },
  variable: { badge: 'V', label: 'Variable', className: 'variable' },
  field: { badge: 'FD', label: 'Field', className: 'field' },
  constant: { badge: 'C', label: 'Constant', className: 'constant' },
  parameter: { badge: 'P', label: 'Parameter', className: 'parameter' },
  package: { badge: 'PKG', label: 'Package', className: 'package' },
  external: { badge: 'Go', label: 'External Go documentation', className: 'external' },
};

/**
 * A compact badge naming a Go symbol's kind (interface, struct, function…), colored per kind —
 * shown in the Go intelligence popover's header next to the symbol's title.
 *
 * @example
 * <SymbolBadge kind="function" />
 */
export function SymbolBadge({ kind }: SymbolBadgeProps) {
  const presentation = PRESENTATION[kind] ?? PRESENTATION.external;
  return (
    <span
      className={`golens-symbol-badge golens-symbol-badge--${presentation.className}`}
      role="img"
      aria-label={presentation.label}
      title={presentation.label}
    >
      {presentation.badge}
    </span>
  );
}
