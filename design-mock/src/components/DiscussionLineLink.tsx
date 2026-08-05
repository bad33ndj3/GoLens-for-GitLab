import type { AnchorHTMLAttributes, ReactNode } from 'react';

export interface DiscussionLineLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'children'> {
  /** URL to navigate to; if omitted, acts as a button with preventDefault. */
  href?: string;
  /** Called when the link is clicked (or when preventDefault occurs). */
  onClick?: () => void;
  /** Link content, typically a count or label like "2 comments". */
  children: ReactNode;
}

/**
 * Inline discussion link rendered next to code lines in diff view.
 *
 * @example
 * <DiscussionLineLink href="/path/to/discussion" onClick={() => scrollToDiscussion()}>2 comments</DiscussionLineLink>
 */
export function DiscussionLineLink({
  href,
  onClick,
  children,
  className,
  ...rest
}: DiscussionLineLinkProps) {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) {
      event.preventDefault();
    }
    onClick?.();
  };

  return (
    <a
      className={['golens-discussion-line-link', className ?? ''].filter(Boolean).join(' ')}
      href={href ?? '#'}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </a>
  );
}
