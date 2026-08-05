import { SymbolBadge } from 'golens-design-mock';
import type { SymbolKind } from 'golens-design-mock';

const KINDS: SymbolKind[] = [
  'interface',
  'struct',
  'function',
  'method',
  'interfaceMethod',
  'type',
  'variable',
  'field',
  'constant',
  'parameter',
  'package',
  'external',
];

export function AllKinds() {
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', background: '#1d2126', padding: 16 }}>
      {KINDS.map((kind) => (
        <SymbolBadge key={kind} kind={kind} />
      ))}
    </div>
  );
}
