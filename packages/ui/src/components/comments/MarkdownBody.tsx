import { Fragment, type ReactNode, useMemo } from 'react';
import '../../tokens/comments.css';
import { cx } from '../classes';
import { type Block, type Inline, parseMarkdown } from './markdown';
import styles from './MarkdownBody.module.css';
import type { ChipLink } from './types';

export interface MarkdownBodyProps {
  /** The comment body (Markdown). It may come from Claude or claude.ai, so it is only ever drawn as React elements. */
  source: string;
  /** Draws a `cite:n` or `web:n` link. Without it, a small chip button that calls `onChip`. */
  renderChip?: (link: ChipLink) => ReactNode;
  /** Called when the default chip is pressed: the viewer jumps to the cited passage or opens the web source. */
  onChip?: (link: ChipLink) => void;
  /** Drawn inline after the last word, such as the caret of a reply that is still streaming. */
  tail?: ReactNode;
  className?: string;
}

/**
 * A note or reply body: light Markdown drawn with React elements, never innerHTML. Links open in a new tab; citation
 * links (`[p. 4](cite:1)`, `[source](web:2)`) become chips through `renderChip` or `onChip`.
 */
export function MarkdownBody({ source, renderChip, onChip, tail, className }: MarkdownBodyProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const chip = (link: ChipLink, key: number) =>
    renderChip ? (
      <Fragment key={key}>{renderChip(link)}</Fragment>
    ) : (
      <CitationChip key={key} link={link} onClick={onChip} />
    );
  return (
    <div className={cx(styles.body, className)}>
      {blocks.map((block, i) => renderBlock(block, i, chip, i === blocks.length - 1 ? tail : undefined))}
      {blocks.length === 0 && tail}
    </div>
  );
}

type ChipRenderer = (link: ChipLink, key: number) => ReactNode;

function renderBlock(block: Block, key: number, chip: ChipRenderer, tail: ReactNode): ReactNode {
  switch (block.t) {
    case 'p':
      return (
        <p key={key} className={styles.p}>
          {renderInline(block.c, chip)}
          {tail}
        </p>
      );
    case 'h':
      return (
        <p key={key} className={cx(styles.p, styles.h)}>
          {renderInline(block.c, chip)}
          {tail}
        </p>
      );
    case 'ul':
    case 'ol': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          {renderInline(item, chip)}
          {i === block.items.length - 1 && tail}
        </li>
      ));
      return block.t === 'ul' ? (
        <ul key={key} className={styles.list}>
          {items}
        </ul>
      ) : (
        <ol key={key} className={styles.list} start={block.start}>
          {items}
        </ol>
      );
    }
    case 'quote':
      return (
        <blockquote key={key} className={styles.quote}>
          {block.c.map((inner, i) => renderBlock(inner, i, chip, i === block.c.length - 1 ? tail : undefined))}
        </blockquote>
      );
    case 'pre':
      return (
        <Fragment key={key}>
          <pre className={styles.pre}>
            <code>{block.v}</code>
          </pre>
          {tail}
        </Fragment>
      );
  }
}

function renderInline(nodes: Inline[], chip: ChipRenderer): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.t) {
      case 'text':
        return <Fragment key={i}>{node.v}</Fragment>;
      case 'br':
        return <br key={i} />;
      case 'strong':
        return <strong key={i}>{renderInline(node.c, chip)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(node.c, chip)}</em>;
      case 'del':
        return <del key={i}>{renderInline(node.c, chip)}</del>;
      case 'code':
        return (
          <code key={i} className={styles.code}>
            {node.v}
          </code>
        );
      case 'link':
        return (
          <a key={i} className={styles.link} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.c, chip)}
          </a>
        );
      case 'chip':
        return chip({ kind: node.kind, n: node.n, label: node.label }, i);
    }
  });
}

export interface CitationChipProps {
  link: ChipLink;
  onClick?: (link: ChipLink) => void;
}

/** The default chip for a citation: "p. 4" jumps to the passage, a web source opens it. */
export function CitationChip({ link, onClick }: CitationChipProps) {
  return (
    <button
      type="button"
      className={cx(styles.chip, link.kind === 'web' && styles.web)}
      aria-label={link.kind === 'cite' ? `Go to ${link.label}` : `Open source: ${link.label}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(link);
      }}
    >
      {link.label}
    </button>
  );
}
