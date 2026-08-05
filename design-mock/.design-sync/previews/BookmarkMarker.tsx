import { useState } from 'react';
import { BookmarkMarker } from 'golens-design-mock';

/** Diff-line context wrapper for bookmark marker */
function DiffLineContext({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: '#0d1117',
      border: '1px solid #30363d',
      borderRadius: 6,
      padding: '8px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 1.5,
    }}>
      <span style={{ color: '#6e7681', minWidth: 40, textAlign: 'right' }}>42</span>
      <span style={{ color: '#8b949e' }}>func main() {'{'}</span>
      {children}
    </div>
  );
}

export function Unpressed() {
  return (
    <DiffLineContext>
      <BookmarkMarker pressed={false} onToggle={() => {}} label="Bookmark this line" />
    </DiffLineContext>
  );
}

export function Pressed() {
  return (
    <DiffLineContext>
      <BookmarkMarker pressed={true} onToggle={() => {}} label="Unbookmark this line" />
    </DiffLineContext>
  );
}

export function Interactive() {
  const [isBookmarked, setIsBookmarked] = useState(false);
  return (
    <DiffLineContext>
      <BookmarkMarker
        pressed={isBookmarked}
        onToggle={() => setIsBookmarked(!isBookmarked)}
        label={isBookmarked ? 'Unbookmark this line' : 'Bookmark this line'}
      />
      <span style={{ color: '#58a6ff', marginLeft: 8, fontSize: 11 }}>
        {isBookmarked ? '(bookmarked)' : '(not bookmarked)'}
      </span>
    </DiffLineContext>
  );
}
