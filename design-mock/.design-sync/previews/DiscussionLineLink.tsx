import { useState } from 'react';
import { DiscussionLineLink } from 'golens-design-mock';

/** Diff-line context wrapper for discussion link */
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
      <span style={{ color: '#6e7681', minWidth: 40, textAlign: 'right' }}>105</span>
      <span style={{ color: '#8b949e' }}>return result</span>
      {children}
    </div>
  );
}

export function WithCount() {
  return (
    <DiffLineContext>
      <DiscussionLineLink href="#discussions">2 comments</DiscussionLineLink>
    </DiffLineContext>
  );
}

export function WithViewLink() {
  return (
    <DiffLineContext>
      <DiscussionLineLink href="#discussions">View discussion</DiscussionLineLink>
    </DiffLineContext>
  );
}

export function Interactive() {
  const [clicked, setClicked] = useState(false);
  return (
    <DiffLineContext>
      <DiscussionLineLink
        href={clicked ? '#discussions' : undefined}
        onClick={() => setClicked(!clicked)}
      >
        3 comments
      </DiscussionLineLink>
      <span style={{ color: '#58a6ff', marginLeft: 8, fontSize: 11 }}>
        {clicked ? '(clicked)' : '(ready)'}
      </span>
    </DiffLineContext>
  );
}
