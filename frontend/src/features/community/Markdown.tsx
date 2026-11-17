import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** User-written (or model-written) markdown. Raw HTML is never rendered (react-markdown's default); links open in a
 *  new tab without a referrer; images are shown as links so a post cannot embed tracking pixels. */
export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  return (
    <div className={`tt-md text-[13px] leading-relaxed text-ink-2 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline-offset-2 hover:underline">{c}</a>,
          img: ({ src, alt }) => <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer nofollow" className="text-accent">[image: {alt || 'link'}]</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
