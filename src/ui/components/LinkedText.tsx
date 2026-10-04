import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import { useActions } from '../ui';

const QUESTION = /\b(Q-\d{1,4})\b/g;

/** A question id as a button-styled link that opens the question. It stays a link, since it navigates. */
export function QuestionLink({ id }: { id: string }) {
    const { goTo } = useActions();
    return (
        <a
            href={`#q-${id}`}
            className="q-link"
            onClick={(event) => {
                event.preventDefault();
                goTo(id);
            }}
        >
            {id}
        </a>
    );
}

/** Split plain text so every `Q-<n>` becomes a question link. The text is never parsed as markup. */
export function linkQuestions(text: string): ReactNode[] {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of text.matchAll(QUESTION)) {
        const index = match.index ?? 0;
        if (index > last) parts.push(text.slice(last, index));
        parts.push(<QuestionLink key={`${index}-${match[1]}`} id={match[1]!} />);
        last = index + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
}

/**
 * Link question ids in rendered children, descending into elements but leaving links and code alone. A link is
 * known by its `href`, since Markdown renders links through its own `a` component rather than a plain `<a>`.
 */
export function linkChildren(children: ReactNode): ReactNode {
    return Children.map(children, (child) => {
        if (typeof child === 'string') return linkQuestions(child);
        if (
            isValidElement<{ children?: ReactNode; href?: string }>(child) &&
            child.type !== 'a' &&
            !('href' in child.props) &&
            child.type !== 'code' &&
            child.props.children !== undefined
        ) {
            return cloneElement(child, undefined, linkChildren(child.props.children));
        }
        return child;
    });
}

/** Plain text with every `Q-<n>` as a question link. */
export function LinkedText({ text }: { text: string }) {
    return <>{linkQuestions(text)}</>;
}
